import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { PROVIDER_BRIDGE_PROTOCOL_VERSION } from "@bb/provider-bridge-protocol";
import { BRIDGE_SOCKET_TRANSPORT_VERSION } from "@bb/provider-bridge-protocol/bridge-kit";
import {
  createBridgeSocketServer,
  decodeBridgeFrame,
  readBoundedLines,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type { BridgeLineDelivery } from "./bridge-line-ack-tracker.js";
import {
  BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
  readBridgeWorkerEntries,
  readProcessIdentity,
} from "./bridge-worker-registry.js";
import {
  privateSocketDirectory,
  SocketBridgeWorker,
} from "./bridge-worker-socket.js";
import type { AgentRuntimeProcessExitInfo } from "./types.js";
import { promptTextInput } from "./test/prompt-input.js";
import {
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadTurnCompleted,
} from "./test/runtime-test-harness.js";

function shortTempDir(): string {
  return mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "bbw-"),
  );
}

describe("socket bridge workers", () => {
  let workspacePath: string;
  let bridgeWorkerDir: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "bb-runtime-socket-"));
    bridgeWorkerDir = join(shortTempDir(), "bridge-workers");
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(join(bridgeWorkerDir, ".."), { recursive: true, force: true });
  });

  it("runs a turn through a worker that the runtime reaches over a socket", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers: {
          dir: bridgeWorkerDir,
          environmentId: "env-1",
          workspace: {
            workspacePath,
            workspaceProvisionType: "unmanaged",
            personalWorkspaceRoot: null,
          },
        },
        onEvent: (event) => events.push(event),
      },
    });
    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      expect(
        readdirSync(bridgeWorkerDir).some((name) => name.endsWith(".sock")),
      ).toBe(true);
      const { entries } = readBridgeWorkerEntries(bridgeWorkerDir);
      expect(entries).toEqual([
        expect.objectContaining({
          environmentId: "env-1",
          pluginId: "provider-scripted-echo",
          providerId: "fake",
          bridgeProtocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        }),
      ]);
      const [registered] = entries;
      expect(registered?.processKey).toMatch(/^fake#bridge:/u);
      expect(registered?.socketPath).toBe(
        join(bridgeWorkerDir, `${registered?.id}.sock`),
      );
      expect(() => process.kill(registered?.pid ?? -1, 0)).not.toThrow();

      await runtime.runTurn({
        clientRequestId: "creq_555555554a",
        threadId: "t1",
        input: [promptTextInput({ text: "hello over a socket" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({ events, threadId: "t1" });
    } finally {
      await runtime.shutdown();
    }
    expect(readdirSync(bridgeWorkerDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "places the socket in a private /tmp directory when the data dir is too long for one beside the registry",
    async () => {
      const longWorkerDir = join(
        dirname(bridgeWorkerDir),
        "d".repeat(120),
        "bridge-workers",
      );
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath,
          bridgeWorkers: {
            dir: longWorkerDir,
            environmentId: "env-1",
            workspace: {
              workspacePath,
              workspaceProvisionType: "unmanaged",
              personalWorkspaceRoot: null,
            },
          },
          onEvent: (event) => events.push(event),
        },
      });
      let socketDir: string | null = null;
      try {
        await runtime.startThread({
          environmentId: "env-1",
          threadId: "t1",
          projectId: "p1",
          providerId: "fake",
          options: fullRuntimeOptions,
        });
        const [registered] = readBridgeWorkerEntries(longWorkerDir).entries;
        if (registered === undefined) throw new Error("no registered worker");
        socketDir = dirname(registered.socketPath);
        const root = `/tmp/bb-${process.getuid?.()}`;
        expect(dirname(socketDir)).toBe(root);
        expect(registered.socketPath).toMatch(/\/[0-9a-f]{12}\.sock$/u);
        expect(Buffer.byteLength(registered.socketPath)).toBeLessThanOrEqual(
          103,
        );
        expect(lstatSync(root).mode & 0o777).toBe(0o700);
        expect(lstatSync(socketDir).mode & 0o777).toBe(0o700);
        expect(existsSync(registered.socketPath)).toBe(true);

        await runtime.runTurn({
          clientRequestId: "creq_555555554d",
          threadId: "t1",
          input: [promptTextInput({ text: "hello over a long data dir" })],
          options: fullRuntimeOptions,
        });
        await waitForThreadTurnCompleted({ events, threadId: "t1" });
      } finally {
        await runtime.shutdown();
        if (socketDir !== null) {
          expect(readdirSync(socketDir)).toEqual([]);
          rmSync(socketDir, { recursive: true, force: true });
        }
      }
      expect(readdirSync(longWorkerDir)).toEqual([]);
    },
  );

  it("reports the tail of a crashed socket worker's log as its stderr", async () => {
    const bridgeModulePath = join(workspacePath, "crashing-bridge.mjs");
    writeFileSync(
      bridgeModulePath,
      [
        "export const experimental_providerBridge = {",
        "  experimental_apiVersion: 1,",
        "  handleLine() {",
        "    process.stderr.write('socket bridge exploded: kaboom\\n');",
        "    process.exit(3);",
        "  },",
        "};",
      ].join("\n"),
    );
    const exits: AgentRuntimeProcessExitInfo[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers: {
          dir: bridgeWorkerDir,
          environmentId: "env-1",
          workspace: {
            workspacePath,
            workspaceProvisionType: "unmanaged",
            personalWorkspaceRoot: null,
          },
        },
        onEvent: () => undefined,
        onProcessExit: (info) => exits.push(info),
      },
      launch: { modulePath: bridgeModulePath },
    });
    try {
      await expect(
        runtime.startThread({
          environmentId: "env-1",
          threadId: "t1",
          projectId: "p1",
          providerId: "fake",
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow(/kaboom/u);
      await waitForRuntimeState({
        label: "socket worker exit reported",
        predicate: () => exits.length === 1,
      });
      expect(exits[0]?.code).toBe(3);
      expect(exits[0]?.stderr).toContain("socket bridge exploded: kaboom");
      expect(readdirSync(bridgeWorkerDir)).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("detaches from a worker without stopping it or the turn it is running", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers: {
          dir: bridgeWorkerDir,
          environmentId: "env-1",
          workspace: {
            workspacePath,
            workspaceProvisionType: "unmanaged",
            personalWorkspaceRoot: null,
          },
        },
        onEvent: (event, delivery) => {
          events.push(event);
          delivery?.onSettled();
        },
      },
    });
    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    const [registered] = readBridgeWorkerEntries(bridgeWorkerDir).entries;
    if (registered === undefined) throw new Error("no registered worker");
    try {
      await runtime.runTurn({
        clientRequestId: "creq_555555554b",
        threadId: "t1",
        input: [promptTextInput({ text: "delay:800 outlived-the-runtime" })],
        options: fullRuntimeOptions,
      });

      await runtime.detach();

      expect(() => process.kill(registered.pid, 0)).not.toThrow();
      const kept = readBridgeWorkerEntries(bridgeWorkerDir).entries;
      expect(kept.map((entry) => [entry.id, entry.pid])).toEqual([
        [registered.id, registered.pid],
      ]);
      expect(Object.keys(kept[0]?.threads ?? {})).toEqual(["t1"]);
      expect(
        events.some(
          (event) => event.type === "turn/completed" && event.threadId === "t1",
        ),
      ).toBe(false);

      const lines: string[] = [];
      const socket = connect(registered.socketPath);
      socket.on("error", () => undefined);
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "bridge/resume", params: { afterWseq: 0 } })}\n`,
      );
      const completed = new Promise<void>((resolve) => {
        readBoundedLines({
          input: socket,
          onLine: (line) => {
            lines.push(line);
            if (line.includes("Response to: delay:800 outlived-the-runtime")) {
              resolve();
            }
          },
          onOverflow: () => undefined,
        });
      });
      await completed;
      socket.end(
        `${JSON.stringify({ jsonrpc: "2.0", method: "bridge/shutdown" })}\n`,
      );
      await waitForRuntimeState({
        label: "retired worker exited",
        predicate: () => !isPidAlive(registered.pid),
      });
    } finally {
      if (isPidAlive(registered.pid)) process.kill(registered.pid, "SIGKILL");
    }
  });

  async function startStreamingTurn(options: { settle: boolean }) {
    const events: ThreadEvent[] = [];
    const deliveries: BridgeLineDelivery[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers: {
          dir: bridgeWorkerDir,
          environmentId: "env-1",
          workspace: {
            workspacePath,
            workspaceProvisionType: "unmanaged",
            personalWorkspaceRoot: null,
          },
        },
        onEvent: (event, delivery) => {
          events.push(event);
          if (delivery !== undefined) deliveries.push(delivery);
        },
      },
    });
    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    const [registered] = readBridgeWorkerEntries(bridgeWorkerDir).entries;
    if (registered === undefined) throw new Error("no registered worker");
    await runtime.runTurn({
      clientRequestId: "creq_555555554c",
      threadId: "t1",
      input: [promptTextInput({ text: "delay:4000 stream:3" })],
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "first streamed chunk",
      predicate: () => JSON.stringify(events).includes("chunk1"),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settleAll = (): void => {
      if (!options.settle) return;
      for (const delivery of deliveries.splice(0)) delivery.onSettled();
    };
    settleAll();
    return { events, registered, runtime, settleAll };
  }

  it("flushes held output before detaching and acknowledges only what the server accepted", async () => {
    const { events, registered, runtime, settleAll } = await startStreamingTurn(
      { settle: true },
    );
    try {
      expect(JSON.stringify(events)).not.toContain("chunk3");

      const detaching = runtime.detach();
      expect(JSON.stringify(events)).toContain("chunk2 chunk3 ");
      settleAll();
      await detaching;

      expect(await framesReplayedAfterResume(registered.socketPath, 0)).toEqual(
        [],
      );
    } finally {
      retire(registered);
    }
  });

  it("reconnects when its socket drops while the worker lives, and the turn completes with nothing lost or repeated", async () => {
    const { events, registered } = await startStreamingTurn({ settle: true });
    try {
      const rogue = connect(registered.socketPath);
      rogue.on("error", () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      rogue.destroy();

      await waitForRuntimeState({
        label: "turn completed after the reconnect",
        predicate: () =>
          events.some(
            (event) =>
              event.type === "turn/completed" && event.threadId === "t1",
          ),
        timeoutMs: 10_000,
      });
      const text = JSON.stringify(events);
      for (const chunk of ["chunk1", "chunk2", "chunk3"]) {
        expect(text.split(chunk).length - 1).toBeGreaterThan(0);
      }
      expect(
        events.filter(
          (event) => event.type === "turn/completed" && event.threadId === "t1",
        ),
      ).toHaveLength(1);
    } finally {
      retire(registered);
    }
  }, 20_000);

  it("keeps output the server has not accepted when it reconnects after a dropped socket", async () => {
    const { events, registered } = await startStreamingTurn({ settle: false });
    try {
      let unaccepted: { wseq: number; line: string } | undefined;
      const deadline = Date.now() + 10_000;
      while (unaccepted === undefined && Date.now() < deadline) {
        unaccepted = (
          await framesReplayedAfterResume(registered.socketPath, 0)
        ).at(0);
      }
      if (unaccepted === undefined) throw new Error("no unaccepted frame");
      await waitForRuntimeState({
        label: "streamed output after the reconnect",
        predicate: () => JSON.stringify(events).includes("chunk2"),
        timeoutMs: 10_000,
      });

      const afterReconnect = await framesReplayedAfterResume(
        registered.socketPath,
        0,
      );
      expect(afterReconnect.map((frame) => frame.wseq)).toContain(
        unaccepted.wseq,
      );
    } finally {
      retire(registered);
    }
  }, 20_000);

  it("keeps only an unanswered request for replay, not the output other threads produced after it", async () => {
    let requested = false;
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers: {
          dir: bridgeWorkerDir,
          environmentId: "env-1",
          workspace: {
            workspacePath,
            workspaceProvisionType: "unmanaged",
            personalWorkspaceRoot: null,
          },
        },
        onEvent: (event, delivery) => {
          events.push(event);
          delivery?.onSettled();
        },
        onInteractiveRequest: () => {
          requested = true;
          return new Promise(() => undefined);
        },
      },
    });
    for (const threadId of ["t1", "t2"]) {
      await runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
    }
    const [registered] = readBridgeWorkerEntries(bridgeWorkerDir).entries;
    if (registered === undefined) throw new Error("no registered worker");
    try {
      await runtime.runTurn({
        clientRequestId: "creq_555555555a",
        threadId: "t1",
        input: [promptTextInput({ text: "approve:command waiting" })],
        options: fullRuntimeOptions,
      });
      await waitForRuntimeState({
        label: "approval requested",
        predicate: () => requested,
      });
      await runtime.runTurn({
        clientRequestId: "creq_555555555b",
        threadId: "t2",
        input: [promptTextInput({ text: "stream:3 after the request" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({ events, threadId: "t2" });
      await new Promise((resolve) => setTimeout(resolve, 300));

      await runtime.detach();

      const replayed = await framesReplayedAfterResume(
        registered.socketPath,
        0,
      );
      expect(replayed).toHaveLength(1);
      expect(replayed[0]?.line).toContain("approval-");
    } finally {
      retire(registered);
    }
  }, 20_000);

  it("leaves lines unacknowledged, and so replayable, when the server never accepted their events", async () => {
    const { registered, runtime } = await startStreamingTurn({ settle: false });
    try {
      await runtime.detach();

      const replayed = await framesReplayedAfterResume(
        registered.socketPath,
        0,
      );
      expect(replayed.some((frame) => frame.line.includes("chunk3"))).toBe(
        true,
      );
    } finally {
      retire(registered);
    }
  }, 20_000);

  it("keeps an answered request replayable when the socket dies before the acknowledgement", async () => {
    const socketPath = join(bridgeWorkerDir, "answered.sock");
    mkdirSync(bridgeWorkerDir, { recursive: true, mode: 0o700 });
    const server = createBridgeSocketServer({
      socketPath,
      spillPath: join(bridgeWorkerDir, "answered.buf"),
      reattachTtlMs: 60_000,
      memoryCapBytes: 1024 * 1024,
      hardCapBytes: 16 * 1024 * 1024,
      onOverflow: () => undefined,
      onBackpressure: () => undefined,
    });
    await server.listen({
      onLine: () => undefined,
      onShutdown: () => undefined,
    });
    const standIn = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const worker = adoptedWorker({
      dir: bridgeWorkerDir,
      pid: standIn.pid ?? 0,
      socketPath,
      workspacePath,
    });
    const received: number[] = [];
    worker.setLineHandler((_line, wseq) => {
      if (wseq === null) return;
      received.push(wseq);
      worker.ackTracker.beginLine(wseq, wseq === 1 ? "req-1" : null);
      worker.ackTracker.endLine(false);
    });
    try {
      worker.resume();
      server.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "req-1", method: "session/request_permission" })}\n`,
      );
      server.write(`${JSON.stringify({ chunk: "after the request" })}\n`);
      await waitForRuntimeState({
        label: "everything but the unanswered request acknowledged",
        predicate: () =>
          received.length === 2 && server.replayStats().frames === 1,
      });

      worker.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: {} })}\n`,
      );
      const rogue = connect(socketPath);
      rogue.on("error", () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      rogue.destroy();
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(server.replayStats().frames).toBe(1);
      expect(received.filter((wseq) => wseq === 1)).toHaveLength(2);
    } finally {
      worker.release();
      await server.close();
      if (standIn.pid !== undefined && isPidAlive(standIn.pid)) {
        process.kill(standIn.pid, "SIGKILL");
      }
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "asks a worker that never opened its socket to stop before it kills it",
    async () => {
      const stopped = join(workspacePath, "stopped");
      const worker = new SocketBridgeWorker({
        kind: "spawn",
        command: "/bin/sh",
        args: [
          "-c",
          `echo 'startup problem: no socket' >&2; trap 'echo stopped > ${stopped}; exit 0' TERM; sleep 30 & wait`,
        ],
        cwd: workspacePath,
        env: {},
        workerDir: bridgeWorkerDir,
        connectTimeoutMs: 200,
        registration: {
          environmentId: "env-1",
          pluginId: "provider-scripted-echo",
          processKey: "fake#bridge:1",
          providerId: "fake",
        },
        workspace: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
          personalWorkspaceRoot: null,
        },
      });
      worker.on("error", () => undefined);
      let stderr = "";
      worker.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      try {
        await waitForRuntimeState({
          label: "worker asked to stop before the kill",
          predicate: () => existsSync(stopped),
          timeoutMs: 10_000,
        });
        await waitForRuntimeState({
          label: "the failed worker's log tail reported as stderr",
          predicate: () => stderr.includes("startup problem"),
          timeoutMs: 10_000,
        });
      } finally {
        if (worker.pid !== undefined && isPidAlive(worker.pid)) {
          process.kill(worker.pid, "SIGKILL");
        }
      }
    },
    20_000,
  );
});

describe.skipIf(process.platform === "win32")(
  "private socket directory",
  () => {
    let parent: string;
    let root: string;
    const uid = process.getuid?.() ?? -1;
    const workerDir = "/some/long/data/dir/bridge-workers";

    beforeEach(() => {
      parent = shortTempDir();
      root = join(parent, "bb-root");
    });

    afterEach(() => {
      rmSync(parent, { recursive: true, force: true });
    });

    it("creates the root and a per-data-dir directory, both 0700, and returns the same one for the same data dir", () => {
      const dir = privateSocketDirectory({ root, uid, workerDir });

      expect(dirname(dir)).toBe(root);
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(privateSocketDirectory({ root, uid, workerDir })).toBe(dir);
      expect(
        privateSocketDirectory({ root, uid, workerDir: `${workerDir}-2` }),
      ).not.toBe(dir);
    });

    it("refuses a root that is a symlink, even to a private directory the user owns", () => {
      const target = join(parent, "elsewhere");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, root);

      expect(() => privateSocketDirectory({ root, uid, workerDir })).toThrow(
        /symlink/u,
      );
      expect(readdirSync(target)).toEqual([]);
    });

    it("refuses a root that other users can reach", () => {
      mkdirSync(root, { mode: 0o700 });
      chmodSync(root, 0o755);

      expect(() => privateSocketDirectory({ root, uid, workerDir })).toThrow(
        /mode 755/u,
      );
      expect(readdirSync(root)).toEqual([]);
    });

    it("refuses a root owned by another user", () => {
      mkdirSync(root, { mode: 0o700 });

      expect(() =>
        privateSocketDirectory({ root, uid: uid + 1, workerDir }),
      ).toThrow(/owned by uid/u);
      expect(readdirSync(root)).toEqual([]);
    });

    it("refuses a per-data-dir directory replaced by a symlink", () => {
      const dir = privateSocketDirectory({ root, uid, workerDir });
      const target = join(parent, "elsewhere");
      mkdirSync(target, { mode: 0o700 });
      rmSync(dir, { recursive: true });
      symlinkSync(target, dir);

      expect(() => privateSocketDirectory({ root, uid, workerDir })).toThrow(
        /symlink/u,
      );
    });
  },
);

async function framesReplayedAfterResume(
  socketPath: string,
  afterWseq: number,
): Promise<{ wseq: number; line: string }[]> {
  const frames: { wseq: number; line: string }[] = [];
  const socket = connect(socketPath);
  socket.on("error", () => undefined);
  readBoundedLines({
    input: socket,
    onLine: (raw) => {
      const decoded = decodeBridgeFrame(raw);
      if (decoded !== null) frames.push(decoded);
    },
    onOverflow: () => undefined,
  });
  socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "bridge/resume", params: { afterWseq } })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  socket.destroy();
  return frames;
}

function adoptedWorker(args: {
  dir: string;
  pid: number;
  socketPath: string;
  workspacePath: string;
}): SocketBridgeWorker {
  return new SocketBridgeWorker({
    kind: "adopt",
    workerDir: args.dir,
    connectTimeoutMs: 5_000,
    entry: {
      id: "abcdef012345",
      formatVersion: BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
      pid: args.pid,
      processIdentity: readProcessIdentity(args.pid) ?? "",
      socketPath: args.socketPath,
      pluginId: "provider-scripted-echo",
      providerId: "fake",
      processKey: "fake#bridge:1",
      environmentId: "env-1",
      bridgeProtocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      transportVersion: BRIDGE_SOCKET_TRANSPORT_VERSION,
      startedAt: new Date().toISOString(),
      workspace: {
        workspacePath: args.workspacePath,
        workspaceProvisionType: "unmanaged",
        personalWorkspaceRoot: null,
      },
      threads: {},
    },
  });
}

function retire(entry: { pid: number; socketPath: string }): void {
  const socket = connect(entry.socketPath);
  socket.on("error", () => undefined);
  socket.end(
    `${JSON.stringify({ jsonrpc: "2.0", method: "bridge/shutdown" })}\n`,
  );
  setTimeout(() => {
    if (isPidAlive(entry.pid)) process.kill(entry.pid, "SIGKILL");
  }, 1_000).unref();
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
