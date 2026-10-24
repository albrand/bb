import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCompleteEnv,
  completeClaudeInference,
} from "./claude-complete.js";
import { claudeExecutable } from "../bridge/provider-maintenance.js";
import { claudeAiCompleteInputSchema } from "./host-contract.js";

const tempDirs: string[] = [];

const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
const mode = fs.readFileSync(__dirname + "/mode", "utf8");
fs.writeFileSync(__dirname + "/call.json", JSON.stringify({ argv: process.argv.slice(2), prompt, env: process.env }));
const result = (body) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", ...body }));
if (mode === "ok") result({ is_error: false, result: "The user is ready." });
else if (mode === "rate") result({ is_error: true, api_error_status: 429, result: "Rate limited" });
else if (mode === "outage") result({ is_error: true, api_error_status: 529, result: "Overloaded" });
else if (mode === "denied") result({ is_error: true, api_error_status: 401, result: "Invalid credentials" });
else if (mode === "signed-out") { process.stdout.write("Not logged in · Please run /login\\n"); process.exit(1); }
else if (mode === "crash") { process.stderr.write("boom\\n"); process.exit(2); }
else if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "multibyte-over") result({ is_error: false, result: "\u00e9".repeat(600000) });
else if (mode === "multibyte-under") result({ is_error: false, result: "\u00e9".repeat(500000) });
`;

async function fakeCli(mode: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-claude-cli-"));
  tempDirs.push(dir);
  const executable = path.join(dir, "claude");
  const log = path.join(dir, "call.json");
  await fs.writeFile(executable, FAKE_CLI, { mode: 0o755 });
  await fs.writeFile(path.join(dir, "mode"), mode);
  const env = {
    PATH: process.env.PATH,
    HOME: "/home/u",
    ANTHROPIC_BASE_URL: "https://attacker.example",
    ANTHROPIC_API_KEY: "sk-ant-api-key",
    ANTHROPIC_AUTH_TOKEN: "proxy-token",
    ANTHROPIC_MODEL: "other-model",
    CLAUDE_CODE_USE_BEDROCK: "1",
    NODE_OPTIONS: "--require /tmp/hook.js",
    https_proxy: "http://proxy.internal:3128",
    HTTP_PROXY: "http://proxy.internal:3128",
    NO_PROXY: "localhost",
    NODE_EXTRA_CA_CERTS: "/tmp/intercept-ca.pem",
    SSL_CERT_FILE: "/tmp/intercept-ca.pem",
    SSL_CERT_DIR: "/tmp/intercept-certs",
    LC_ALL: "en_US.UTF-8",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "parent-session",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
  };
  const readCall = async () =>
    JSON.parse(await fs.readFile(log, "utf8")) as {
      argv: string[];
      prompt: string;
      env: Record<string, string>;
    };
  return { deps: { executable, env }, readCall };
}

function run(
  deps: { executable: string; env: NodeJS.ProcessEnv },
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return completeClaudeInference(
    {
      model: "claude-haiku-5-5",
      prompt: "Correct: The user are ready.",
      timeoutMs: options.timeoutMs ?? 10_000,
    },
    options.signal ?? new AbortController().signal,
    deps,
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("completeClaudeInference", () => {
  it("returns the CLI result and sends the prompt on stdin without tools or settings", async () => {
    const cli = await fakeCli("ok");
    await expect(run(cli.deps)).resolves.toEqual({
      ok: true,
      text: "The user is ready.",
    });
    const call = await cli.readCall();
    expect(call.prompt).toBe("Correct: The user are ready.");
    expect(call.argv).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-haiku-5-5",
      "--tools",
      "",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--system-prompt",
      "Follow the instructions in the user message exactly. Reply with only the requested text.",
    ]);
  });

  it("passes only the allowlisted environment, so endpoint, credential, proxy and CA overrides cannot redirect or intercept the prompt", async () => {
    const cli = await fakeCli("ok");
    await run(cli.deps);
    const { env } = await cli.readCall();
    const passed = Object.keys(env).filter(
      (key) => !["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(key),
    );
    expect(passed.sort()).toEqual(
      [
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "HOME",
        "LC_ALL",
        "PATH",
      ].sort(),
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(
      claudeCompleteEnv({
        ANTHROPIC_BASE_URL: "https://attacker.example",
        ANTHROPIC_API_KEY: "sk-ant-api-key",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        Path: "C:\\Windows",
        HOME: "/home/u",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
      }),
    ).toEqual({
      HOME: "/home/u",
      Path: "C:\\Windows",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });

  it.each([
    ["rate", "rate_limited", "Rate limited"],
    ["outage", "service_unavailable", "Overloaded"],
    ["denied", "auth_required", "Invalid credentials"],
    [
      "signed-out",
      "auth_required",
      "Run `claude auth login` on the primary machine",
    ],
    ["crash", "request_failed", "boom"],
  ])("maps the %s answer to %s", async (mode, code, message) => {
    const cli = await fakeCli(mode);
    await expect(run(cli.deps)).resolves.toEqual({ ok: false, code, message });
  });

  it("rejects output over 1 MiB of bytes even when it is under 1 Mi characters", async () => {
    const cli = await fakeCli("multibyte-over");
    await expect(run(cli.deps)).resolves.toEqual({
      ok: false,
      code: "invalid_response",
      message: "Claude Code output was too large",
    });
  });

  it("accepts multibyte output just under 1 MiB of bytes", async () => {
    const cli = await fakeCli("multibyte-under");
    const result = await run(cli.deps);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.text.length : 0).toBe(500_000);
  });

  it("kills a CLI that does not answer in time", async () => {
    const cli = await fakeCli("hang");
    const started = Date.now();
    await expect(run(cli.deps, { timeoutMs: 400 })).resolves.toEqual({
      ok: false,
      code: "timeout",
      message: "Claude did not answer within 400ms",
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stops when the caller cancels", async () => {
    const cli = await fakeCli("hang");
    const controller = new AbortController();
    const pending = run(cli.deps, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).resolves.toEqual({
      ok: false,
      code: "timeout",
      message: "The request was cancelled",
    });
  });

  it("explains how to install Claude Code when the CLI is missing", async () => {
    const result = await run({
      executable: path.join(os.tmpdir(), "bb-no-such-claude-cli"),
      env: { PATH: process.env.PATH },
    });
    expect(result).toMatchObject({ ok: false, code: "request_failed" });
    expect(result.ok ? "" : result.message).toContain("Install Claude Code");
  });
});

describe("the Claude CLI that writing assistance runs", () => {
  it("is chosen only by the host process environment, never by the request", async () => {
    const request = { model: "haiku", prompt: "Fix this.", timeoutMs: 1_000 };
    expect(claudeAiCompleteInputSchema.safeParse(request).success).toBe(true);
    for (const extra of [
      { executable: "/tmp/other-cli" },
      { env: { BB_CLAUDE_CODE_EXECUTABLE: "/tmp/other-cli" } },
    ]) {
      expect(
        claudeAiCompleteInputSchema.safeParse({ ...request, ...extra }).success,
      ).toBe(false);
    }
    const previous = process.env.BB_CLAUDE_CODE_EXECUTABLE;
    try {
      process.env.BB_CLAUDE_CODE_EXECUTABLE = "  /opt/claude/bin/claude  ";
      expect(await claudeExecutable()).toBe("/opt/claude/bin/claude");
      delete process.env.BB_CLAUDE_CODE_EXECUTABLE;
      if (process.platform !== "win32") {
        expect(await claudeExecutable()).toBe("claude");
      }
    } finally {
      if (previous === undefined) delete process.env.BB_CLAUDE_CODE_EXECUTABLE;
      else process.env.BB_CLAUDE_CODE_EXECUTABLE = previous;
    }
  });
});
