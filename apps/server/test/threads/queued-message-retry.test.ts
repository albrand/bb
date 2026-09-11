import {
  claimQueuedThreadMessageGroup,
  createConnection,
  getQueuedMessageDispatchRetry,
  getQueuedThreadMessage,
  listDueQueuedMessageDispatchRetries,
  listEvents,
  releaseQueuedMessageClaim,
  setQueuedThreadMessageWaitingOn,
} from "@bb/db";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS } from "../../src/services/threads/queue-drain-failure.js";
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

/**
 * A dispatch gate the test drives directly.
 *
 * Hooks are the only way to make a real drain fail on demand, and a handler
 * that throws is exactly the shape of the failure that parked a message for two
 * hours on 2026-09-11: something behind the server broke for a moment, and
 * nothing about the message itself was wrong.
 */
function installDispatchGate(
  decide: (attempt: number) => { action: "proceed" } | { action: "reject"; message: string },
): { attempts: () => number } {
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

/**
 * Turn requests carrying THIS message. The runtime-state seed leaves a prior
 * turn request of its own behind, so counting the type alone would start every
 * assertion at one and read as a dispatch that never happened.
 */
function dispatchCount(harness: TestAppHarness, threadId: string): number {
  return listEvents(harness.db, { threadId }).filter(
    (event) =>
      event.type === "client/turn/requested" &&
      JSON.stringify(event.data).includes(QUEUED_TEXT),
  ).length;
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

      // The row stayed drainable. Writing a failure reason here is what made
      // one bad moment permanent: every automatic drain reads that column as
      // "never touch this row again".
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

      // The idle drain claims a `thread-busy` row on every sweep tick and never
      // looks at `sendAt`, so without the eligibility guard the backoff is not
      // a backoff — it is "retry as fast as the sweep runs".
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
      // The budget is spent, not still counting: nothing re-attempts this row
      // on its own again.
      expect(retryOf(harness, row.id)).toBeNull();

      await drain(harness, thread.id);
      await drainDueRetries(harness, Date.now() + 60_000);
      expect(gate.attempts()).toBe(QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS);

      // `bb thread queue send` and the card's Send now both take this path, so
      // a spent budget is a stop for the server and not for the user.
      expect(
        claimQueuedThreadMessageGroup(harness.db, harness.deps.hub, row.id, {
          kind: "explicit-send",
        }),
      ).not.toBeNull();
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

      // A plugin's reject is a judgement about this payload. Asking four more
      // times gets the same answer, so the row fails immediately and says so.
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

      // Everything a restart keeps: the bytes on disk. A backoff held in a
      // timer would not survive this, and the message would be parked again.
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

      // The claim is the exactly-once guarantee, and the retry sweep respects
      // it rather than sending a second copy of a message already on its way.
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

  it("does not write down a lost claim as this attempt failing", async () => {
    await withTestHarness(async (harness) => {
      const { row, thread } = seedRunnableThreadWithQueuedRow(harness);
      // Put the row on the clock, so the attempt runs on the due sweep. That
      // is the wake-driven path, which — unlike the idle drain, which swallows
      // a lost claim — used to write every outcome it caught onto the row as a
      // terminal failure.
      setQueuedThreadMessageWaitingOn(harness.db, harness.deps.hub, {
        id: row.id,
        threadId: thread.id,
        waitingOn: { kind: "time" },
        sendAt: Date.now() - 1_000,
      });
      // The production race this reproduces: a dispatch slow enough that the
      // stale-claim sweep hands its claim back underneath it, which is exactly
      // what a machine stalled for minutes produces. The consume then finds a
      // token that no longer matches and reports a lost claim.
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
      // Nobody's attempt failed here — another worker's claim won. Recording
      // it as a failure parked the row, and billing it to the budget would
      // spend attempts the message never made.
      expect(survivor?.failureReason).toBeNull();
      expect(retryOf(harness, row.id)).toBeNull();
      expect(dispatchCount(harness, thread.id)).toBe(0);
    });
  });
});
