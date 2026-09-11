import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { connect } from "node:net";
import { PROVIDER_BRIDGE_PROTOCOL_VERSION } from "@bb/provider-bridge-protocol";
import {
  decodeBridgeFrame,
  readBoundedLines,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type { BridgeLineDelivery } from "./bridge-line-ack-tracker.js";
import { readBridgeWorkerEntries } from "./bridge-worker-registry.js";
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
        bridgeWorkers: { dir: bridgeWorkerDir, environmentId: "env-1" },
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
        bridgeWorkers: { dir: bridgeWorkerDir, environmentId: "env-1" },
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
        bridgeWorkers: { dir: bridgeWorkerDir, environmentId: "env-1" },
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
      expect(readBridgeWorkerEntries(bridgeWorkerDir).entries).toEqual([
        registered,
      ]);
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
        bridgeWorkers: { dir: bridgeWorkerDir, environmentId: "env-1" },
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
});

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
