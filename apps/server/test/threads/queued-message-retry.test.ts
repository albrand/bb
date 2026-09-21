import {
  claimQueuedThreadMessageGroup,
  createConnection,
  getQueuedMessageDispatchRetry,
  getQueuedThreadMessage,
  listDueQueuedMessageDispatchRetries,
  listEvents,
  listQueuedThreadMessagesForApi,
  releaseQueuedMessageClaim,
  setQueuedThreadMessageWaitingOn,
} from "@bb/db";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { runStartupRecoverySweep } from "../../src/services/system/periodic-sweeps.js";
import {
  QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS,
  recordQueuedMessageDrainFailure,
} from "../../src/services/threads/queue-drain-failure.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/queued-message-retry-project";

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

afterEach(() => {
  setPluginHookProvider(undefined);
});

type GateDecision =
  | { action: "proceed" }
  | { action: "reject"; message: string }
  | { action: "wait"; reason: string };

function installDispatchGate(decide: (attempt: number) => GateDecision): {
  attempts: () => number;
} {
  let attempts = 0;
  const registry: HookRegistry = { "message.dispatch": [] };
  registry["message.dispatch"].push({
    pluginId: "gate",
    handler: () => {
      attempts += 1;
      return decide(attempts);
    },
  });
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: async (_pluginId, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
  return { attempts: () => attempts };
}

function throwOnAttempts(
  shouldThrow: (attempt: number) => boolean,
): { attempts: () => number } {
  return installDispatchGate((attempt) => {
    if (shouldThrow(attempt)) throw new Error("boom");
    return { action: "proceed" };
  });
}

function seedRunnableThreadWithQueuedRow(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { name: "M4" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-retry",
    threadId: thread.id,
  });
  const row = seedQueuedMessage(harness.deps, {
    content: textInput(QUEUED_TEXT),
    threadId: thread.id,
    waitingOn: { kind: "thread-busy" },
  });
  return { environment, host, row, thread };
}

function drain(harness: TestAppHarness, threadId: string): Promise<void> {
  return runQueuedMessageDispatch(harness.deps, {
    kind: "thread-ready",
    threadId,
  });
}

function drainDueRetries(harness: TestAppHarness, now: number): Promise<void> {
  return runQueuedMessageDispatch(harness.deps, { kind: "retry-due", now });
}

const QUEUED_TEXT = "Capture the Safari trace";

function dispatchCount(harness: TestAppHarness, threadId: string): number {
  return listEvents(harness.db, { threadId }).filter(
    (event) =>
      event.type === "client/turn/requested" &&
      JSON.stringify(event.data).includes(QUEUED_TEXT),
  ).length;
}

function reread(harness: TestAppHarness, queuedMessageId: string) {
  const row = getQueuedThreadMessage(harness.db, queuedMessageId);
  if (row === null) throw new Error("the queued row vanished");
  return row;
}

function pinClaimedAt(
  harness: TestAppHarness,
  queuedMessageId: string,
  claimedAt: number,
): void {
  harness.db.$client
    .prepare("UPDATE queued_thread_messages SET claimed_at = ? WHERE id = ?")
    .run(claimedAt, queuedMessageId);
}

function retryOf(harness: TestAppHarness, queuedMessageId: string) {
  return getQueuedMessageDispatchRetry(harness.db, queuedMessageId);
}

describe("queued message dispatch retry", () => {
  it("retries a transient dispatch failure and then dispatches it", async () => {
    await withTestHarness(async (harness) => {
      const gate = throwOnAttempts((attempt) => attempt === 1);
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);

      await drain(harness, thread.id);

      const afterFailure = getQueuedThreadMessage(harness.db, row.id);
      expect(afterFailure?.failureReason).toBeNull();
      const booked = retryOf(harness, row.id);
      expect(booked?.attempt).toBe(1);
      expect(booked?.nextAttemptAt).toBeGreaterThan(Date.now());
      expect(gate.attempts()).toBe(1);
      expect(dispatchCount(harness, thread.id)).toBe(0);

      await drainDueRetries(harness, booked!.nextAttemptAt);

      expect(gate.attempts()).toBe(2);
      expect(getQueuedThreadMessage(harness.db, row.id)).toBeNull();
      expect(dispatchCount(harness, thread.id)).toBe(1);
      expect(retryOf(harness, row.id)).toBeNull();
    });
  });

  it("holds the backoff against the drains that do not read a clock", async () => {
    await withTestHarness(async (harness) => {
      const gate = throwOnAttempts(() => true);
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);

      await drain(harness, thread.id);
      const booked = retryOf(harness, row.id);
      expect(gate.attempts()).toBe(1);

      await drain(harness, thread.id);
      await drain(harness, thread.id);
      expect(gate.attempts()).toBe(1);

      await drainDueRetries(harness, booked!.nextAttemptAt);
      expect(gate.attempts()).toBe(2);
    });
  });

  it("stops after the budget and leaves a failure that can still be sent by hand", async () => {
    await withTestHarness(async (harness) => {
      const gate = throwOnAttempts(() => true);
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);

      await drain(harness, thread.id);
      for (let attempt = 2; attempt <= QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS; attempt += 1) {
        const booked = retryOf(harness, row.id);
        expect(booked?.attempt).toBe(attempt - 1);
        await drainDueRetries(harness, booked!.nextAttemptAt);
      }

      expect(gate.attempts()).toBe(QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS);
      const failed = getQueuedThreadMessage(harness.db, row.id);
      expect(failed?.failureReason).toContain("boom");
      expect(retryOf(harness, row.id)).toBeNull();

      await drain(harness, thread.id);
      await drainDueRetries(harness, Date.now() + 60_000);
      expect(gate.attempts()).toBe(QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS);

      expect(
        claimQueuedThreadMessageGroup(harness.db, harness.deps.hub, row.id, {
          kind: "explicit-send",
        }),
      ).not.toBeNull();
    });
  });

  it("does not refund the budget when a re-attempt queues instead of failing", async () => {
    await withTestHarness(async (harness) => {
      const gate = installDispatchGate((attempt) => {
        if (attempt === 1) throw new Error("boom");
        return { action: "wait", reason: "holding" };
      });
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);

      await drain(harness, thread.id);
      const booked = retryOf(harness, row.id);
      expect(booked?.attempt).toBe(1);

      await drainDueRetries(harness, booked!.nextAttemptAt);

      expect(gate.attempts()).toBe(2);
      expect(reread(harness, row.id).failureReason).toBeNull();
      expect(retryOf(harness, row.id)?.attempt).toBe(1);

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new Error("boom"),
        now: Date.now(),
        row,
        thread,
      });
      expect(retryOf(harness, row.id)?.attempt).toBe(2);
    });
  });

  it("does not spend a retry on a decision that will not change", async () => {
    await withTestHarness(async (harness) => {
      const gate = installDispatchGate(() => ({
        action: "reject",
        message: "Rejected for testing",
      }));
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);

      await drain(harness, thread.id);

      expect(getQueuedThreadMessage(harness.db, row.id)?.failureReason).toBe(
        "Rejected for testing",
      );
      expect(retryOf(harness, row.id)).toBeNull();

      await drainDueRetries(harness, Date.now() + 60_000);
      expect(gate.attempts()).toBe(1);
    });
  });

  it("re-derives a pending retry from the database after a restart", async () => {
    await withTestHarness(async (harness) => {
      const gate = throwOnAttempts(() => true);
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);

      await drain(harness, thread.id);
      const booked = retryOf(harness, row.id);
      expect(booked?.attempt).toBe(1);
      expect(gate.attempts()).toBe(1);

      const restarted = createConnection(harness.db.$client.serialize());
      try {
        expect(
          listDueQueuedMessageDispatchRetries(restarted, booked!.nextAttemptAt),
        ).toEqual([{ id: row.id, threadId: thread.id }]);
        expect(getQueuedMessageDispatchRetry(restarted, row.id)?.attempt).toBe(
          1,
        );
      } finally {
        restarted.$client.close();
      }
    });
  });

  it("neither dispatches nor bills a retry that races a claim", async () => {
    await withTestHarness(async (harness) => {
      const gate = throwOnAttempts((attempt) => attempt === 1);
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);

      await drain(harness, thread.id);
      const booked = retryOf(harness, row.id);
      expect(booked?.attempt).toBe(1);

      const claimed = claimQueuedThreadMessageGroup(
        harness.db,
        harness.deps.hub,
        row.id,
        { kind: "explicit-send" },
      );
      expect(claimed).not.toBeNull();

      await drainDueRetries(harness, booked!.nextAttemptAt);

      expect(gate.attempts()).toBe(1);
      expect(dispatchCount(harness, thread.id)).toBe(0);
      expect(retryOf(harness, row.id)?.attempt).toBe(1);

      releaseQueuedMessageClaim(harness.db, harness.deps.hub, {
        id: row.id,
        claimToken: claimed![0]!.claimToken,
      });
      await drainDueRetries(harness, booked!.nextAttemptAt);

      expect(dispatchCount(harness, thread.id)).toBe(1);
      expect(getQueuedThreadMessage(harness.db, row.id)).toBeNull();
    });
  });

  it("hands back a claim the previous server died holding", async () => {
    await withTestHarness(async (harness) => {
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);
      const claimed = claimQueuedThreadMessageGroup(
        harness.db,
        harness.deps.hub,
        row.id,
        { kind: "explicit-send" },
      );
      expect(claimed).not.toBeNull();
      pinClaimedAt(harness, row.id, Date.now() + 60_000);

      expect(
        listQueuedThreadMessagesForApi(harness.db, { threadId: thread.id }),
      ).toEqual([]);

      await runStartupRecoverySweep(harness.deps);

      expect(getQueuedThreadMessage(harness.db, row.id)?.claimToken).toBeNull();
      expect(
        listQueuedThreadMessagesForApi(harness.db, {
          threadId: thread.id,
        }).map((queued) => queued.id),
      ).toEqual([row.id]);
    });
  });

  it("does not write down a lost claim as this attempt failing", async () => {
    await withTestHarness(async (harness) => {
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);
      setQueuedThreadMessageWaitingOn(harness.db, harness.deps.hub, {
        id: row.id,
        threadId: thread.id,
        waitingOn: { kind: "time" },
        sendAt: Date.now() - 1_000,
      });
      installDispatchGate(() => {
        const claimToken = getQueuedThreadMessage(harness.db, row.id)?.claimToken;
        if (claimToken) {
          releaseQueuedMessageClaim(harness.db, harness.deps.hub, {
            id: row.id,
            claimToken,
          });
        }
        return { action: "proceed" };
      });

      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: Date.now(),
      });

      const survivor = getQueuedThreadMessage(harness.db, row.id);
      expect(survivor).not.toBeNull();
      expect(survivor?.failureReason).toBeNull();
      expect(retryOf(harness, row.id)).toBeNull();
      expect(dispatchCount(harness, thread.id)).toBe(0);
    });
  });
});
