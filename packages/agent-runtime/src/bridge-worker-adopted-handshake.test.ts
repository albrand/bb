import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import {
  parseJsonRpcLine,
  settleJsonRpcResponse,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type { BridgeProtocolAdapter } from "./bridge-protocol-adapter.js";
import { readBridgeWorkerEntries } from "./bridge-worker-registry.js";
import { createProviderForId } from "./provider-registry.js";
import { RuntimeProviderProcessManager } from "./runtime-provider-process.js";
import { RuntimeThreadIdentityRegistry } from "./runtime-thread-identity.js";
import { promptTextInput } from "./test/prompt-input.js";
import {
  createScriptedEchoLaunch,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  scriptedEchoBridgeModulePath,
  scriptedEchoProcessEnv,
  waitForThreadTurnCompleted,
} from "./test/runtime-test-harness.js";
import type {
  AgentRuntimeBridgeLaunch,
  AgentRuntimeBridgeWorkers,
} from "./types.js";

const PROVIDER_ENFORCED_APPROVALS = scriptedEchoProcessEnv({
  approvalEnforcedBy: "provider",
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function observedCapabilities(adapter: BridgeProtocolAdapter) {
  const ref = { threadId: "t1", providerThreadId: "prov-t1" };
  const planKind = (build: () => { kind: string }): string => {
    try {
      return build().kind;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  return {
    approvalEnforcedBy: adapter.approvalEnforcedBy,
    forkAtCheckpoint: planKind(() =>
      adapter.buildCommandPlan({
        type: "thread/fork",
        threadId: "t2",
        cwd: "/tmp",
        sourceProviderThreadId: "prov-t1",
        sourceProviderCheckpointId: "checkpoint-1",
        options: { ...fullRuntimeOptions, providerOptions: {} },
        instructionMode: "append",
      }),
    ),
    threadRename: planKind(() =>
      adapter.buildCommandPlan({
        type: "thread/name/set",
        ...ref,
        title: "renamed",
      }),
    ),
    threadArchive: planKind(() =>
      adapter.buildCommandPlan({ type: "thread/archive", ...ref }),
    ),
    threadUnarchive: planKind(() =>
      adapter.buildCommandPlan({ type: "thread/unarchive", ...ref }),
    ),
    threadGoalClear: planKind(() =>
      adapter.buildCommandPlan({ type: "thread/goal/clear", ...ref }),
    ),
    skillsConfigure: planKind(() =>
      adapter.buildCommandPlan({
        type: "skills/configure",
        skillRoots: [],
      }),
    ),
  };
}

describe("an adopted bridge worker keeps its negotiated handshake", () => {
  let root: string;
  let workspacePath: string;
  let bridgeWorkers: AgentRuntimeBridgeWorkers;
  const startedPids: number[] = [];

  beforeEach(() => {
    root = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "bbh-"),
    );
    workspacePath = join(root, "ws");
    mkdirSync(workspacePath);
    bridgeWorkers = {
      dir: join(root, "bridge-workers"),
      environmentId: "env-1",
      workspace: {
        workspacePath,
        workspaceProvisionType: "unmanaged",
        personalWorkspaceRoot: null,
      },
    };
  });

  afterEach(() => {
    for (const pid of startedPids.splice(0)) {
      if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  });

  function createManager(adapters: BridgeProtocolAdapter[]) {
    const identityRegistry = new RuntimeThreadIdentityRegistry();
    let nextRequestId = 1;
    return new RuntimeProviderProcessManager({
      additionalWorkspaceWriteRoots: [],
      createAdapter: (providerId, options) => {
        const adapter = createProviderForId(providerId, options);
        adapters.push(adapter);
        return adapter;
      },
      bridgeBundleDir: dirname(scriptedEchoBridgeModulePath),
      bridgeWorkers,
      bridgeNodeExecutablePath: process.execPath,
      captureThreadExitState: (threadId) => ({
        activeTurnId: null,
        pendingTurnStart: false,
        providerThreadId: null,
        threadId,
      }),
      createProviderIdentityState: (providerId) =>
        identityRegistry.createProviderState({ providerId }),
      env: PROVIDER_ENFORCED_APPROVALS,
      getNextRequestId: () => nextRequestId++,
      handleStdoutLine: ({ line, providerProcess }) => {
        const parsed = parseJsonRpcLine(line);
        if (parsed.kind === "response") {
          settleJsonRpcResponse({
            id: parsed.parsedId,
            pending: providerProcess.pending,
            response: parsed.parsed,
          });
        }
      },
      onProcessExit: () => undefined,
      onProviderThreadDetached: () => undefined,
      onStderr: () => undefined,
      skillRoots: [],
      workspacePath,
    });
  }

  it("gives the adopted adapter every capability the spawned one negotiated", async () => {
    const bridgeLaunch: AgentRuntimeBridgeLaunch = createScriptedEchoLaunch();
    const spawnedAdapters: BridgeProtocolAdapter[] = [];
    const spawning = createManager(spawnedAdapters);
    await spawning.ensureProvider({
      bridgeLaunch,
      processKey: "fake#bridge:1",
      providerId: "fake",
    });
    const [entry] = readBridgeWorkerEntries(bridgeWorkers.dir).entries;
    if (entry === undefined) throw new Error("no registered worker");
    startedPids.push(entry.pid);
    const [spawned] = spawnedAdapters;
    if (spawned === undefined) throw new Error("no spawned adapter");
    const negotiated = observedCapabilities(spawned);
    expect(negotiated).toEqual({
      approvalEnforcedBy: "provider",
      forkAtCheckpoint: "request",
      threadRename: "request",
      threadArchive: "request",
      threadUnarchive: "request",
      threadGoalClear: "request",
      skillsConfigure: "request",
    });
    await spawning.detach();
    expect(isPidAlive(entry.pid)).toBe(true);

    const adoptedAdapters: BridgeProtocolAdapter[] = [];
    const adopting = createManager(adoptedAdapters);
    const [persisted] = readBridgeWorkerEntries(bridgeWorkers.dir).entries;
    if (persisted === undefined) throw new Error("registry entry vanished");
    expect(persisted.capabilities).toEqual(spawned.handshake);
    if (persisted.capabilities === null) throw new Error("no handshake");
    const adopted = adopting.adoptProviderProcess({
      bridgeLaunch,
      capabilities: persisted.capabilities,
      entry: persisted,
      processKey: persisted.processKey,
      providerId: persisted.providerId,
      workerDir: bridgeWorkers.dir,
    });

    expect(observedCapabilities(adopted.adapter)).toEqual(negotiated);
    await adopting.shutdown();
  });

  it("forks a thread served by an adopted worker", async () => {
    const events: ThreadEvent[] = [];
    const runtimeOptions = {
      workspacePath,
      bridgeWorkers,
      env: PROVIDER_ENFORCED_APPROVALS,
      onEvent: (event: ThreadEvent, delivery?: { onSettled(): void }) => {
        events.push(event);
        delivery?.onSettled();
      },
    };
    const before = createScriptedEchoRuntime({ runtime: runtimeOptions });
    const { providerThreadId } = await before.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    const [entry] = readBridgeWorkerEntries(bridgeWorkers.dir).entries;
    if (entry === undefined) throw new Error("no registered worker");
    startedPids.push(entry.pid);
    await before.runTurn({
      clientRequestId: "creq_555555556a",
      threadId: "t1",
      input: [promptTextInput({ text: "before the swap" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({ events, threadId: "t1" });
    await before.detach();

    const after = createScriptedEchoRuntime({ runtime: runtimeOptions });
    try {
      const adopted = after.adoptBridgeWorkers({
        dir: bridgeWorkers.dir,
        entries: readBridgeWorkerEntries(bridgeWorkers.dir).entries,
      });
      expect(adopted.map((thread) => thread.threadId)).toEqual(["t1"]);
      after.completeBridgeWorkerAdoption(new Map([["t1", null]]));

      const forked = await after.startThread({
        environmentId: "env-1",
        threadId: "t2",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
        fork: { sourceProviderThreadId: providerThreadId },
      });
      expect(forked.providerThreadId).not.toBe(providerThreadId);
      expect(readBridgeWorkerEntries(bridgeWorkers.dir).entries).toHaveLength(
        1,
      );
    } finally {
      await after.shutdown();
    }
  });
});
