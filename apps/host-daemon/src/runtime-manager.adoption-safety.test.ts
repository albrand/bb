import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeProcessExitInfo } from "@bb/agent-runtime";
import { readProcessIdentity } from "@bb/agent-runtime";
import { createScriptedEchoLaunch } from "@bb/agent-runtime/test";
import type { ThreadEvent } from "@bb/domain";
import { PROVIDER_BRIDGE_PROTOCOL_VERSION } from "@bb/provider-bridge-protocol";
import {
  BRIDGE_SOCKET_TRANSPORT_VERSION,
  createBridgeSocketServer,
} from "@bb/provider-bridge-protocol/bridge-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "./runtime-manager.js";

const CONNECT_TIMEOUT_WITH_MARGIN_MS = 17_000;
const tempDirs: string[] = [];
const livePids: number[] = [];

afterEach(async () => {
  for (const pid of livePids.splice(0)) {
    if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
  }
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const runtimeOptions = {
  model: "test-model",
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

async function readOnlyRegistryEntry(
  dir: string,
): Promise<{ pid: number; socketPath: string }> {
  const names = (await fs.readdir(dir)).filter((name) =>
    name.endsWith(".json"),
  );
  expect(names).toHaveLength(1);
  return JSON.parse(await fs.readFile(path.join(dir, names[0] ?? ""), "utf8"));
}

async function registryFileNames(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
}

async function startTurnThenDetach(label: string) {
  const dataDir = await fs.mkdtemp(path.join("/tmp", "bbw-"));
  tempDirs.push(dataDir);
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), `bb-adopt-${label}-ws-`),
  );
  tempDirs.push(workspacePath);
  const bridgeLaunch = createScriptedEchoLaunch({
    modulePath: fileURLToPath(
      new URL(
        "../../../tests/scripted-echo-provider/src/provider-bridge.ts",
        import.meta.url,
      ),
    ),
  });
  const createManager = (
    events: ThreadEvent[],
    exits: AgentRuntimeProcessExitInfo[] = [],
  ) =>
    new RuntimeManager({
      dataDir,
      onEvent: ({ event, delivery }) => {
        events.push(event);
        delivery?.onSettled();
      },
      onProcessExit: (info) => exits.push(info),
    });
  const dir = path.join(dataDir, "bridge-workers");
  const events: ThreadEvent[] = [];
  const exiting = createManager(events);
  const entry = await exiting.ensureEnvironment({
    environmentId: "env-1",
    workspacePath,
  });
  await entry.runtime.startThread({
    bridgeLaunch,
    environmentId: "env-1",
    threadId: "t1",
    projectId: "p1",
    providerId: "fake",
    options: runtimeOptions,
  });
  await entry.runtime.runTurn({
    threadId: "t1",
    clientRequestId: "creq_777777777a",
    input: [{ type: "text", text: "delay:30000 stream:2", mentions: [] }],
    options: runtimeOptions,
  });
  await waitFor(() =>
    events.some((event) => JSON.stringify(event).includes("chunk1")),
  );
  await exiting.shutdownAll("detach");
  const registered = await readOnlyRegistryEntry(dir);
  livePids.push(registered.pid);
  return { createManager, dir, registered };
}

describe("bridge worker adoption safety", () => {
  it("review: pid reuse never signals an unrelated process", async () => {
    const { createManager, registered, dir } =
      await startTurnThenDetach("pid-reuse");
    process.kill(registered.pid, "SIGKILL");
    await waitFor(() => !isProcessAlive(registered.pid));
    const unrelated = spawn("sleep", ["60"], {
      detached: true,
      stdio: "ignore",
    });
    const unrelatedPid = unrelated.pid ?? 0;
    let unrelatedSignal: string | null = null;
    unrelated.on("exit", (_code, signal) => {
      unrelatedSignal = signal;
    });
    const name = (await fs.readdir(dir)).find((n) => n.endsWith(".json")) ?? "";
    const entry = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    await fs.writeFile(
      path.join(dir, name),
      JSON.stringify({ ...entry, pid: unrelatedPid }),
    );
    const staleSocketLeft = (await fs.readdir(dir)).some((n) =>
      n.endsWith(".sock"),
    );
    const adopting = createManager([]);
    try {
      await adopting.reconcileBridgeWorkers();
      const adopted = adopting.listAdoptedBridgeThreads();
      const deadline = Date.now() + 20_000;
      while (isProcessAlive(unrelatedPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.log(
        JSON.stringify({
          staleSocketLeft,
          adopted,
          unrelatedAlive: isProcessAlive(unrelatedPid),
          unrelatedSignal,
        }),
      );
      expect(isProcessAlive(unrelatedPid)).toBe(true);
      expect(unrelatedSignal).toBeNull();
      expect(await registryFileNames(dir)).toEqual([]);
    } finally {
      if (isProcessAlive(unrelatedPid)) process.kill(unrelatedPid, "SIGKILL");
      await adopting.shutdownAll("detach");
    }
  }, 60_000);

  it("retires a worker whose thread configs cannot be read, instead of leaving it unowned", async () => {
    const dataDir = await fs.mkdtemp(path.join("/tmp", "bbw-"));
    tempDirs.push(dataDir);
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-adopt-unreadable-ws-"),
    );
    tempDirs.push(workspacePath);
    const dir = path.join(dataDir, "bridge-workers");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const id = "aaaaaaaaaaaa";
    const socketPath = path.join(dir, `${id}.sock`);
    const shutdowns: string[] = [];
    const worker = createBridgeSocketServer({
      socketPath,
      spillPath: path.join(dir, `${id}.buf`),
      reattachTtlMs: 60_000,
      memoryCapBytes: 1024 * 1024,
      hardCapBytes: 16 * 1024 * 1024,
      onOverflow: () => undefined,
      onBackpressure: () => undefined,
    });
    await worker.listen({
      onLine: () => undefined,
      onShutdown: (reason) => shutdowns.push(reason),
    });
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        pid: process.pid,
        processIdentity: readProcessIdentity(process.pid),
        socketPath,
        pluginId: "provider-scripted-echo",
        providerId: "fake",
        processKey: "fake#bridge:0123456789abcdef",
        environmentId: "env-1",
        bridgeProtocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        transportVersion: BRIDGE_SOCKET_TRANSPORT_VERSION,
        startedAt: new Date().toISOString(),
        workspace: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
          personalWorkspaceRoot: null,
        },
        threads: {
          t1: {
            providerThreadId: null,
            activeTurnId: null,
            activeProviderTurnId: null,
            config: { unreadable: true },
          },
        },
      }),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const manager = new RuntimeManager({ dataDir, logger });
    try {
      await manager.reconcileBridgeWorkers();
    } finally {
      worker.close();
      await manager.shutdownAll("detach");
    }

    expect(shutdowns).toEqual(["requested"]);
    expect(manager.listAdoptedBridgeThreads()).toEqual([]);
    expect(await registryFileNames(dir)).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        adopted: [],
        retired: [
          expect.objectContaining({
            id,
            reason: "thread-configs-unreadable",
          }),
        ],
      }),
      "Reconciled provider bridge workers left by a previous host daemon",
    );
  });

  it("retires the older of two workers registered for the same provider process", async () => {
    const dataDir = await fs.mkdtemp(path.join("/tmp", "bbw-"));
    tempDirs.push(dataDir);
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-adopt-duplicate-ws-"),
    );
    tempDirs.push(workspacePath);
    const dir = path.join(dataDir, "bridge-workers");
    const bridgeLaunch = createScriptedEchoLaunch({
      modulePath: fileURLToPath(
        new URL(
          "../../../tests/scripted-echo-provider/src/provider-bridge.ts",
          import.meta.url,
        ),
      ),
    });
    const detachWorker = async (threadId: string): Promise<void> => {
      const manager = new RuntimeManager({ dataDir });
      const entry = await manager.ensureEnvironment({
        environmentId: "env-1",
        workspacePath,
      });
      await entry.runtime.startThread({
        bridgeLaunch,
        environmentId: "env-1",
        threadId,
        projectId: "p1",
        providerId: "fake",
        options: runtimeOptions,
      });
      await manager.shutdownAll("detach");
    };
    await detachWorker("t1");
    await detachWorker("t2");
    const registered = await Promise.all(
      (await registryFileNames(dir)).map(
        async (name) =>
          JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as {
            id: string;
            pid: number;
            processKey: string;
            startedAt: string;
          },
      ),
    );
    registered.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const [older, newer] = registered;
    if (older === undefined || newer === undefined) {
      throw new Error("expected two registered workers");
    }
    livePids.push(older.pid, newer.pid);
    expect(older.processKey).toBe(newer.processKey);
    const adopting = new RuntimeManager({ dataDir });
    try {
      await adopting.reconcileBridgeWorkers();
      await waitFor(() => !isProcessAlive(older.pid));

      expect(
        adopting.listAdoptedBridgeThreads().map((thread) => thread.threadId),
      ).toEqual(["t2"]);
      expect(isProcessAlive(newer.pid)).toBe(true);
      expect(await registryFileNames(dir)).toEqual([`${newer.id}.json`]);
    } finally {
      await adopting.shutdownAll("detach");
    }
  }, 60_000);

  it("retires an adopted worker it cannot reach, without signalling it", async () => {
    const { createManager, dir, registered } =
      await startTurnThenDetach("unreachable");
    await fs.rm(registered.socketPath);
    const exits: AgentRuntimeProcessExitInfo[] = [];
    const adopting = createManager([], exits);
    try {
      await adopting.reconcileBridgeWorkers();
      await waitFor(
        async () => (await registryFileNames(dir)).length === 0,
        CONNECT_TIMEOUT_WITH_MARGIN_MS + 5_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(isProcessAlive(registered.pid)).toBe(true);
      expect(exits).toEqual([
        expect.objectContaining({
          expected: true,
          bridgeWorker: { id: expect.any(String), pid: registered.pid },
        }),
      ]);
    } finally {
      await adopting.shutdownAll("detach");
    }
  }, 60_000);
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
