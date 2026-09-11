import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  connectBridgeSocket,
  createShortSocketDir,
} from "./testing/bridge-socket-client.js";

const workerEntry = fileURLToPath(
  new URL("./bridge-worker-entry.ts", import.meta.url),
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createFixture(bridgeSource: string): Promise<{
  bridgeModulePath: string;
  dataDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "bb-bridge-bootstrap-"));
  tempDirs.push(dir);
  const bridgeModulePath = join(dir, "artifact.mjs");
  await writeFile(bridgeModulePath, bridgeSource);
  return { bridgeModulePath, dataDir: dir };
}

function runWorker(
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          import.meta.resolve("tsx"),
          workerEntry,
          ...args,
        ],
        { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin.end(stdin);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

it("starts an exported bridge with its plugin-scoped directories", async () => {
  const fixture = await createFixture(
    [
      "let context = null;",
      "export const experimental_providerBridge = {",
      "  experimental_apiVersion: 1,",
      "  start(value) { context = value; },",
      "  handleLine(line) {",
      "    process.stdout.write(JSON.stringify({ line, context }) + '\\n');",
      "  },",
      "};",
    ].join("\n"),
  );

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    '{"hello":true}\n',
  );

  expect(result.code).toBe(0);
  const reported = JSON.parse(result.stdout.trim()) as {
    line: string;
    context: { pluginId: string; dataDir: string; tempDir: string };
  };
  expect(reported.line).toBe('{"hello":true}');
  expect(reported.context.pluginId).toBe("provider-fixture");
  expect(reported.context.dataDir).toBe(fixture.dataDir);
  expect(reported.context.tempDir).toContain("provider-fixture");
  expect(existsSync(reported.context.tempDir)).toBe(false);
});

it("refuses an artifact with no bridge export, naming the plugin", async () => {
  const fixture = await createFixture("export default { notABridge: true };\n");

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    "",
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('plugin "provider-fixture"');
  expect(result.stderr).toContain("experimental_providerBridge");
});

it("refuses a bridge export from an unsupported api version", async () => {
  const fixture = await createFixture(
    "export const experimental_providerBridge = { experimental_apiVersion: 99, handleLine() {} };\n",
  );

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    "",
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("unsupported apiVersion 99");
});

it("reports a bridge module that fails to load", async () => {
  const fixture = await createFixture("throw new Error('boom at import');\n");

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    "",
  );

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    'plugin "provider-fixture" failed to load its provider bridge',
  );
  expect(result.stderr).toContain("boom at import");
});

it("hands a bridge only what it declares: no start hook, no context", async () => {
  const fixture = await createFixture(
    [
      "export const experimental_providerBridge = {",
      "  experimental_apiVersion: 1,",
      "  handleLine(line) { process.stdout.write(line + '\\n'); },",
      "  onClose() { process.stdout.write('closed\\n'); },",
      "};",
    ].join("\n"),
  );

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    "one\ntwo\n",
  );

  expect(result.stdout).toBe("one\ntwo\nclosed\n");
  expect(await readFile(fixture.bridgeModulePath, "utf8")).toContain(
    "experimental_providerBridge",
  );
});

it("tees both sides of the runtime wire when record mode is on", async () => {
  const fixture = await createFixture(
    [
      "export const experimental_providerBridge = {",
      "  experimental_apiVersion: 1,",
      "  handleLine(line) {",
      "    const request = JSON.parse(line);",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');",
      "  },",
      "};",
    ].join("\n"),
  );
  const recordDir = join(fixture.dataDir, "recordings");

  const result = await runWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"threadId":"thr_rec"}}\n',
    { BB_PROVIDER_BRIDGE_RECORD_DIR: recordDir },
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n',
  );
  const read = async (scope: string, direction: string) =>
    (await readFile(join(recordDir, scope, `${direction}.ndjson`), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { seq: number; dir: string; line: string },
      );
  expect((await read("_process", "runtime→bridge")).map((e) => e.line)).toEqual(
    ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'],
  );
  expect((await read("_process", "bridge→runtime")).map((e) => e.line)).toEqual(
    ['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'],
  );
  expect((await read("thr_rec", "runtime→bridge")).map((e) => e.line)).toEqual([
    '{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"threadId":"thr_rec"}}',
  ]);
  expect((await read("thr_rec", "bridge→runtime")).map((e) => e.dir)).toEqual([
    "bridge→runtime",
  ]);
});

const LONG_TURN_BRIDGE = [
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "let context = null;",
  "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
  "export const experimental_providerBridge = {",
  "  experimental_apiVersion: 1,",
  "  start(value) { context = value; },",
  "  handleLine(line) {",
  "    const request = JSON.parse(line);",
  "    if (request.method !== 'turn/start') return;",
  "    send({ id: request.id, result: { pid: process.pid } });",
  "    let n = 0;",
  "    const timer = setInterval(() => {",
  "      n += 1;",
  "      send({ method: 'turn/tick', params: { n } });",
  "      if (n === 30) { clearInterval(timer); send({ method: 'turn/completed', params: { n } }); }",
  "    }, 20);",
  "  },",
  "  onClose() {",
  "    writeFileSync(join(context.dataDir, 'closed'), 'closed');",
  "    process.exit(0);",
  "  },",
  "};",
].join("\n");

function spawnSocketWorker(args: string[], socketPath: string) {
  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      import.meta.resolve("tsx"),
      workerEntry,
      ...args,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, BB_BRIDGE_SOCKET: socketPath },
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return { child, exited, stderr: () => stderr };
}

function tickNumber(line: string): number | null {
  const message = JSON.parse(line) as {
    method?: string;
    params?: { n?: number };
  };
  return message.method === "turn/tick" ? (message.params?.n ?? null) : null;
}

it("keeps a turn running across a dropped runtime connection on a socket transport", async () => {
  const fixture = await createFixture(LONG_TURN_BRIDGE);
  const socketDir = await createShortSocketDir();
  tempDirs.push(socketDir);
  const socketPath = join(socketDir, "w.sock");
  const worker = spawnSocketWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    socketPath,
  );
  try {
    const first = await connectBridgeSocket(socketPath);
    first.send({ id: 1, method: "turn/start", params: {} });
    await first.waitForLine((line) => (tickNumber(line) ?? 0) >= 3);
    first.socket.destroy();
    await first.closed;
    const lastTickBeforeDrop = Math.max(
      ...first.lines.map((line) => tickNumber(line) ?? 0),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(worker.child.exitCode).toBeNull();
    expect(() => process.kill(worker.child.pid ?? -1, 0)).not.toThrow();

    const second = await connectBridgeSocket(socketPath);
    await second.waitForLine((line) => line.includes("turn/completed"));
    const ticksAfterReconnect = second.lines
      .map(tickNumber)
      .filter((n): n is number => n !== null);
    expect(ticksAfterReconnect.length).toBeGreaterThan(0);
    expect(Math.min(...ticksAfterReconnect)).toBeGreaterThan(
      lastTickBeforeDrop,
    );

    second.send({ method: "bridge/shutdown" });
    expect(await worker.exited).toBe(0);
    expect(await readFile(join(fixture.dataDir, "closed"), "utf8")).toBe(
      "closed",
    );
    expect(existsSync(socketPath)).toBe(false);
  } finally {
    worker.child.kill("SIGKILL");
  }
}, 20_000);

it("does not read the runtime from stdin on a socket transport", async () => {
  const fixture = await createFixture(LONG_TURN_BRIDGE);
  const socketDir = await createShortSocketDir();
  tempDirs.push(socketDir);
  const socketPath = join(socketDir, "w.sock");
  const worker = spawnSocketWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    socketPath,
  );
  try {
    const client = await connectBridgeSocket(socketPath);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(worker.child.exitCode).toBeNull();
    expect(existsSync(join(fixture.dataDir, "closed"))).toBe(false);
    client.socket.destroy();
  } finally {
    worker.child.kill("SIGKILL");
  }
}, 20_000);

it("exits after a requested shutdown even when the bridge's close never finishes", async () => {
  const fixture = await createFixture(
    [
      "export const experimental_providerBridge = {",
      "  experimental_apiVersion: 1,",
      "  handleLine() {},",
      "  onClose() { setInterval(() => undefined, 1000); },",
      "};",
    ].join("\n"),
  );
  const socketDir = await createShortSocketDir();
  tempDirs.push(socketDir);
  const socketPath = join(socketDir, "w.sock");
  const worker = spawnSocketWorker(
    [fixture.bridgeModulePath, "provider-fixture", fixture.dataDir],
    socketPath,
  );
  try {
    const client = await connectBridgeSocket(socketPath);
    client.send({ method: "bridge/shutdown" });
    expect(await worker.exited).toBe(0);
  } finally {
    worker.child.kill("SIGKILL");
  }
}, 20_000);
