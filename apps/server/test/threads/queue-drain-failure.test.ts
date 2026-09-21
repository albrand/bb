import {
  archiveThread,
  claimQueuedThreadMessageGroup,
  getQueuedMessageDispatchRetry,
  getQueuedThreadMessage,
  listEvents,
  setQueuedThreadMessageFailureReason,
} from "@bb/db";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { noteDispatchRequeued } from "../../src/services/threads/dispatch-hooks.js";
import {
  QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS,
  recordQueuedMessageDrainFailure,
} from "../../src/services/threads/queue-drain-failure.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/queue-drain-failure-project";

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function seedQueuedRow(
  harness: TestAppHarness,
  args: { hostConnected: boolean; hostName: string; sendAt?: number },
) {
  const host = args.hostConnected
    ? seedHostSession(harness.deps, { name: args.hostName }).host
    : seedHost(harness.deps, { name: args.hostName });
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
    projectId: project.id,
    environmentId: environment.id,
  });
  const row = seedQueuedMessage(harness.deps, {
    threadId: thread.id,
    content: textInput("Capture the Safari trace"),
    waitingOn: { kind: "thread-busy" },
    ...(args.sendAt === undefined ? {} : { sendAt: args.sendAt }),
  });
  return { host, thread, row };
}

function rereadRow(harness: TestAppHarness, queuedMessageId: string) {
  const row = getQueuedThreadMessage(harness.db, queuedMessageId);
  if (row === null) throw new Error("the queued row vanished");
  return row;
}

function reread(harness: TestAppHarness, queuedMessageId: string) {
  return toThreadQueuedMessage(rereadRow(harness, queuedMessageId));
}

describe("host-connected queue dispatch", () => {
  it("dispatches only the returning machine's rows after its daemon connects", async () => {
    await withTestHarness(async (harness) => {
      const away = seedQueuedRow(harness, {
        hostConnected: false,
        hostName: "M4",
      });
      const otherAway = seedQueuedRow(harness, {
        hostConnected: false,
        hostName: "M2",
      });
      for (const seeded of [away, otherAway]) {
        recordQueuedMessageDrainFailure(harness.deps, {
          error: new ApiError(502, "host_unavailable", "Host is not connected"),
          now: Date.now(),
          row: seeded.row,
          thread: seeded.thread,
        });
      }

      await runQueuedMessageDispatch(harness.deps, {
        hostId: away.host.id,
        kind: "host-connected",
      });
      expect(reread(harness, away.row.id).waitingOn).toEqual({
        kind: "host-offline",
        hostName: "M4",
      });
      seedHostSession(harness.deps, { id: away.host.id, name: "M4" });
      seedThreadRuntimeState(harness.deps, {
        environmentId: away.thread.environmentId,
        providerThreadId: "returning-machine-thread",
        threadId: away.thread.id,
      });
      await runQueuedMessageDispatch(harness.deps, {
        hostId: away.host.id,
        kind: "host-connected",
      });
      expect(getQueuedThreadMessage(harness.db, away.row.id)).toBeNull();
      expect(reread(harness, otherAway.row.id).waitingOn).toEqual({
        kind: "host-offline",
        hostName: "M2",
      });
    });
  });
});

describe("recordQueuedMessageDrainFailure", () => {
  it("hides a failed row from the wakes that are not its booked retry", async () => {
    await withTestHarness(async (harness) => {
      let attempts = 0;
      const registry: HookRegistry = { "message.dispatch": [] };
      registry["message.dispatch"].push({
        pluginId: "rejector",
        handler: () => {
          attempts += 1;
          return { action: "reject", message: "Rejected for testing" } as const;
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

      try {
        const { row, thread } = seedQueuedRow(harness, {
          hostConnected: true,
          hostName: "M4",
        });

        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
        expect(reread(harness, row.id).failureReason).toBe(
          "Rejected for testing",
        );

        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });

        expect(attempts).toBe(1);
        expect(
          claimQueuedThreadMessageGroup(harness.db, harness.deps.hub, row.id, {
            kind: "explicit-send",
          }),
        ).not.toBeNull();
      } finally {
        setPluginHookProvider(undefined);
      }
    });
  });

  it("records a terminal failure from the turn-started wake", async () => {
    await withTestHarness(async (harness) => {
      const registry: HookRegistry = { "message.dispatch": [] };
      registry["message.dispatch"].push({
        pluginId: "rejector",
        handler: () =>
          ({ action: "reject", message: "Rejected on turn start" }) as const,
      });
      setPluginHookProvider({
        listHooks: (hook) => registry[hook],
        invokeHook: async (_pluginId, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });

      try {
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
          status: "active",
        });
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-turn-started",
          threadId: thread.id,
        });
        seedTurnStarted(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-turn-started",
          threadId: thread.id,
          turnId: "turn-started",
        });
        const row = seedQueuedMessage(harness.deps, {
          content: textInput("Wait for the turn"),
          threadId: thread.id,
          waitingOn: { kind: "turn-starting" },
        });
        noteDispatchRequeued(thread.id);

        await runQueuedMessageDispatch(harness.deps, {
          kind: "turn-started",
          threadId: thread.id,
        });

        expect(reread(harness, row.id).failureReason).toBe(
          "Rejected on turn start",
        );
      } finally {
        setPluginHookProvider(undefined);
      }
    });
  });

  it("re-queues on the named host when the machine is the thing that is missing", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: false,
        hostName: "M4",
        sendAt: Date.now() - 1_000,
      });

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new ApiError(502, "host_unavailable", "Host is not connected"),
        now: Date.now(),
        row,
        thread,
      });

      const queued = reread(harness, row.id);
      expect(queued.waitingOn).toEqual({
        kind: "host-offline",
        hostName: "M4",
      });
      expect(queued.sendAt).toBeNull();
      expect(queued.failureReason).toBeNull();
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual([]);
    });
  });

  it("records the reason and keeps the wait when the destination is gone", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: true,
        hostName: "M4",
      });
      archiveThread(harness.db, harness.deps.hub, thread.id);

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new ApiError(409, "thread_not_writable", "Thread is archived"),
        now: Date.now(),
        row,
        thread,
      });

      const queued = reread(harness, row.id);
      expect(queued.failureReason).toBe("Thread is archived");
      expect(getQueuedMessageDispatchRetry(harness.db, row.id)).toBeNull();
      expect(queued.waitingOn).toEqual({ kind: "thread-busy" });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual([]);
    });
  });

  it("retries the same error while the destination is still there", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: true,
        hostName: "M4",
      });

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new ApiError(409, "thread_not_writable", "Thread is archived"),
        now: Date.now(),
        row,
        thread,
      });

      expect(reread(harness, row.id).failureReason).toBeNull();
      expect(getQueuedMessageDispatchRetry(harness.db, row.id)?.attempt).toBe(1);
    });
  });

  it("does not leak an internal fault's wording onto the row", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: true,
        hostName: "M4",
      });

      for (let attempt = 1; attempt <= QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS; attempt += 1) {
        recordQueuedMessageDrainFailure(harness.deps, {
          error: new Error("Cannot read properties of undefined (reading 'id')"),
          now: Date.now(),
          row,
          thread,
        });
      }

      expect(reread(harness, row.id).failureReason).toBe(
        "The message could not be sent.",
      );
    });
  });

  it("lets a later successful queue clear a failure the row was showing", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: false,
        hostName: "M4",
      });

      setQueuedThreadMessageFailureReason(harness.db, harness.deps.hub, {
        id: row.id,
        threadId: row.threadId,
        failureReason: "Thread is archived",
        now: Date.now(),
        retryDelaysMs: [],
      });

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new ApiError(502, "host_unavailable", "Host is not connected"),
        now: Date.now(),
        row,
        thread,
      });

      const queued = reread(harness, row.id);
      expect(queued.waitingOn).toEqual({
        kind: "host-offline",
        hostName: "M4",
      });
      expect(queued.failureReason).toBeNull();
    });
  });
});
