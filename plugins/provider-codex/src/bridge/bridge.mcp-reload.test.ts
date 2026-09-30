import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { z } from "zod";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let rootDir: string;
let workspaceDir: string;
let codexHome: string;
let requestLogPath: string;
let threadId: string;
let threadCounter = 0;

function startHarness(script: Record<string, unknown>): void {
  const scriptPath = join(rootDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath, ...script }));
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "bb-codex-mcp-reload-"));
  workspaceDir = join(rootDir, "workspace");
  codexHome = join(rootDir, "codex-home");
  mkdirSync(workspaceDir);
  mkdirSync(codexHome);
  writeFileSync(
    join(codexHome, "config.toml"),
    '[mcp_servers.alpha]\ncommand = "alpha"\n',
  );
  requestLogPath = join(rootDir, "requests.jsonl");
  vi.stubEnv("CODEX_HOME", codexHome);
  threadCounter += 1;
  threadId = `thr_mcp_reload_${threadCounter}`;
});

afterEach(async () => {
  const cleanupId = 992_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId,
    providerThreadId: "mcp-reload-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(rootDir, { recursive: true, force: true });
});

function loggedMethods(): string[] {
  return readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) => z.object({ method: z.string() }).parse(JSON.parse(line)).method,
    )
    .filter(
      (method) =>
        method === "config/mcpServer/reload" || method === "turn/start",
    );
}

async function startThread(): Promise<string> {
  harness.sendRequest(1, "thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });
  const started = await harness.waitForResponse(1);
  return z.object({ providerThreadId: z.string() }).parse(started.result)
    .providerThreadId;
}

async function runTurn(id: number, providerThreadId: string): Promise<void> {
  harness.sendRequest(id, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: `creq_mcpreadyx${id}`,
    input: [{ type: "text", text: "say hello", mentions: [] }],
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });
  expect((await harness.waitForResponse(id)).error).toBeUndefined();
}

it("reloads Codex MCP servers before the first turn after the MCP config changes", async () => {
  startHarness({});
  const providerThreadId = await startThread();

  await runTurn(2, providerThreadId);
  expect(loggedMethods()).toEqual(["turn/start"]);

  writeFileSync(
    join(codexHome, "config.toml"),
    '[mcp_servers.alpha]\ncommand = "alpha"\n\n[mcp_servers.beta]\ncommand = "beta"\n',
  );
  await runTurn(3, providerThreadId);
  expect(loggedMethods()).toEqual([
    "turn/start",
    "config/mcpServer/reload",
    "turn/start",
  ]);

  await runTurn(4, providerThreadId);
  expect(loggedMethods()).toEqual([
    "turn/start",
    "config/mcpServer/reload",
    "turn/start",
    "turn/start",
  ]);

  mkdirSync(join(workspaceDir, ".codex"));
  writeFileSync(
    join(workspaceDir, ".codex", "config.toml"),
    '[mcp_servers.gamma]\ncommand = "gamma"\n',
  );
  await runTurn(5, providerThreadId);
  expect(loggedMethods().slice(4)).toEqual([
    "config/mcpServer/reload",
    "turn/start",
  ]);
});

it("reloads after an edit that keeps the config's inode, size, and modification time", async () => {
  const configPath = join(codexHome, "config.toml");
  utimesSync(configPath, 1_700_000_000, 1_700_000_000);
  startHarness({});
  const providerThreadId = await startThread();
  const before = statSync(configPath);

  writeFileSync(configPath, '[mcp_servers.alpha]\ncommand = "bravo"\n');
  utimesSync(configPath, 1_700_000_000, 1_700_000_000);
  const after = statSync(configPath);
  expect([after.ino, after.size, after.mtimeMs]).toEqual([
    before.ino,
    before.size,
    before.mtimeMs,
  ]);
  await runTurn(2, providerThreadId);

  expect(loggedMethods()).toEqual(["config/mcpServer/reload", "turn/start"]);
});

it("starts the turn when a watched config is replaced by a FIFO with no writer", async () => {
  startHarness({});
  const providerThreadId = await startThread();
  const configPath = join(codexHome, "config.toml");
  rmSync(configPath);
  execFileSync("mkfifo", [configPath]);

  await runTurn(2, providerThreadId);

  expect(loggedMethods()).toEqual(["config/mcpServer/reload", "turn/start"]);
});

it("still starts the turn and retries on the next turn when the reload fails", async () => {
  startHarness({ mcpReloadError: true });
  const providerThreadId = await startThread();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  rmSync(join(codexHome, "config.toml"));
  await runTurn(2, providerThreadId);
  await runTurn(3, providerThreadId);

  expect(loggedMethods()).toEqual([
    "config/mcpServer/reload",
    "turn/start",
    "config/mcpServer/reload",
    "turn/start",
  ]);
  expect(
    stderr.mock.calls.some(([chunk]) =>
      String(chunk).includes("reloading its MCP servers failed"),
    ),
  ).toBe(true);
  stderr.mockRestore();
});
