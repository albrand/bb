import { getActiveStoredTurnId, getThread, listEvents } from "@bb/db";
import { turnScope } from "@bb/domain";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS } from "../../src/constants.js";
import { DETACHED_THREAD_ADOPTION_WINDOW_MS } from "../../src/internal/fork-adoption.js";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedTwoActiveTurns(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, { thread: { status: "active" } });
  const other = seedThread(harness.deps, {
    projectId: fixture.project.id,
    environmentId: fixture.environment.id,
    status: "active",
  });
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    threadId: fixture.thread.id,
    turnId: "turn-adopted",
  });
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    threadId: other.id,
    turnId: "turn-orphaned",
  });
  return { ...fixture, adopted: fixture.thread, other };
}

function interruptionTypes(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.deps.db, { threadId })
    .filter((row) => row.type !== "turn/started")
    .map((row) => row.type);
}

function openRestartedSession(
  harness: TestAppHarness,
  host: { id: string; name: string; type: "persistent" },
  extra: Record<string, unknown>,
) {
  return harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, {
      hostId: host.id,
      hostType: host.type,
    }),
    body: JSON.stringify({
      hostId: host.id,
      instanceId: "instance-restarted",
      hostName: host.name,
      hostType: host.type,
      hasMachineCredential: false,
      platform: "darwin",
      dataDir: "/tmp/host-daemon-adopted-threads",
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: [],
      ...extra,
    }),
  });
}

describe("a restarted daemon that adopted threads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the adopted thread's turn active and still interrupts the threads it did not adopt", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, adopted, other } = seedTwoActiveTurns(harness);
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      const response = await openRestartedSession(harness, host, {
        adoptedThreads: [
          { threadId: adopted.id, activeTurnId: "turn-adopted" },
        ],
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.deps.db, adopted.id)?.status).toBe("active");
      expect(interruptionTypes(harness, adopted.id)).toEqual([]);
      expect(getThread(harness.deps.db, other.id)?.status).toBe("error");
      expect(interruptionTypes(harness, other.id)).toEqual([
        "turn/completed",
        "system/error",
        "system/thread/interrupted",
      ]);
    });
  });

  it("closes the items an adopted turn left open, since the adopting daemon continues them under new ids", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, adopted, environment } =
        seedTwoActiveTurns(harness);
      const commandItem = (id: string, status: string) => ({
        providerThreadId: "claude-session-1",
        item: {
          type: "commandExecution",
          id,
          command: "echo tick",
          cwd: "/tmp/test",
          status,
          approvalStatus: null,
        },
      });
      const seed = (
        sequence: number,
        type: "item/started" | "item/completed",
        itemId: string,
        itemKind: "commandExecution" | "backgroundTask",
        data: Record<string, unknown>,
      ) =>
        seedStoredEvent(harness.deps, {
          threadId: adopted.id,
          environmentId: environment.id,
          sequence,
          type,
          scope: turnScope("turn-adopted"),
          providerThreadId: "claude-session-1",
          itemId,
          itemKind,
          data,
        });
      seed(
        2,
        "item/started",
        "i-done",
        "commandExecution",
        commandItem("i-done", "pending"),
      );
      seed(
        3,
        "item/completed",
        "i-done",
        "commandExecution",
        commandItem("i-done", "completed"),
      );
      seed(
        4,
        "item/started",
        "i-open",
        "commandExecution",
        commandItem("i-open", "pending"),
      );
      seed(5, "item/started", "task:open", "backgroundTask", {
        providerThreadId: "claude-session-1",
        item: {
          id: "task:open",
          type: "backgroundTask",
          taskType: "local_bash",
          description: "fixture task",
          status: "pending",
          taskStatus: "running",
          skipTranscript: false,
        },
      });
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      await openRestartedSession(harness, host, {
        adoptedThreads: [
          { threadId: adopted.id, activeTurnId: "turn-adopted" },
        ],
      });

      const events = listEvents(harness.deps.db, { threadId: adopted.id });
      const completedItems = events
        .filter((row) => row.type === "item/completed")
        .map((row) => {
          const data = JSON.parse(row.data) as {
            item: { id: string; status: string };
          };
          return [data.item.id, data.item.status];
        });
      expect(completedItems).toEqual([
        ["i-done", "completed"],
        ["i-open", "interrupted"],
      ]);
      expect(
        events.filter((row) => row.type === "item/backgroundTask/completed"),
      ).toHaveLength(1);
      expect(getThread(harness.deps.db, adopted.id)?.status).toBe("active");
    });
  });

  it("revives an adopted thread that a command failed during the swap, because run.failed leaves its turn open", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, adopted } = seedTwoActiveTurns(harness);
      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.failed" },
        threadId: adopted.id,
      });
      expect(getThread(harness.deps.db, adopted.id)?.status).toBe("error");
      expect(getActiveStoredTurnId(harness.deps.db, adopted.id)).toBe(
        "turn-adopted",
      );
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      await openRestartedSession(harness, host, {
        adoptedThreads: [
          { threadId: adopted.id, activeTurnId: "turn-adopted" },
        ],
      });

      expect(getThread(harness.deps.db, adopted.id)?.status).toBe("active");
      expect(interruptionTypes(harness, adopted.id)).not.toContain(
        "system/thread/interrupted",
      );
    });
  });

  it("leaves an idle thread on an adopted worker idle across a restart", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });
      const eventsBefore = listEvents(harness.deps.db, { threadId: thread.id });
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      await openRestartedSession(harness, host, {
        adoptedThreads: [{ threadId: thread.id, activeTurnId: null }],
      });

      expect(getThread(harness.deps.db, thread.id)?.status).toBe("idle");
      expect(listEvents(harness.deps.db, { threadId: thread.id })).toEqual(
        eventsBefore,
      );
    });
  });

  it("interrupts a thread whose adopted worker reports no turn while the server still holds one, so it cannot stay active with no turn", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, adopted } = seedTwoActiveTurns(harness);
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      await openRestartedSession(harness, host, {
        adoptedThreads: [{ threadId: adopted.id, activeTurnId: null }],
      });

      expect(getThread(harness.deps.db, adopted.id)?.status).not.toBe("active");
      expect(getActiveStoredTurnId(harness.deps.db, adopted.id)).toBeNull();
      expect(interruptionTypes(harness, adopted.id)).toContain(
        "system/thread/interrupted",
      );
    });
  });

  it("interrupts an adopted thread whose turn the server no longer recognizes", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, adopted } = seedTwoActiveTurns(harness);
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      await openRestartedSession(harness, host, {
        adoptedThreads: [{ threadId: adopted.id, activeTurnId: "turn-stale" }],
      });

      expect(getThread(harness.deps.db, adopted.id)?.status).toBe("error");
    });
  });

  it("settles a detached thread's background tasks once the adoption window ends without a daemon", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, adopted, environment } =
        seedTwoActiveTurns(harness);
      seedStoredEvent(harness.deps, {
        threadId: adopted.id,
        environmentId: environment.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope("turn-adopted"),
        providerThreadId: "claude-session-1",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        data: {
          providerThreadId: "claude-session-1",
          item: {
            id: "task:wf-1",
            type: "backgroundTask",
            taskType: "local_workflow",
            description: "fixture workflow",
            status: "pending",
            taskStatus: "running",
            skipTranscript: false,
            workflowName: "fixture-mini",
            usage: { totalTokens: 100, toolUses: 2, durationMs: 1500 },
          },
        },
      });
      await harness.app.request("/internal/session/fork/detach-notice", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          threadIds: [adopted.id],
        }),
      });
      const settled = () =>
        listEvents(harness.deps.db, { threadId: adopted.id }).some(
          (row) => row.type === "item/backgroundTask/completed",
        );

      vi.useFakeTimers({ now: Date.now() });
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      await vi.advanceTimersByTimeAsync(
        DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS + 1,
      );
      expect(settled()).toBe(false);

      await vi.advanceTimersByTimeAsync(DETACHED_THREAD_ADOPTION_WINDOW_MS);
      expect(getThread(harness.deps.db, adopted.id)?.status).toBe("error");
      expect(settled()).toBe(true);
    });
  });

  it("holds the active-work grace for threads named in a detach notice, until the adoption window ends", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, adopted, other } = seedTwoActiveTurns(harness);
      const notice = await harness.app.request(
        "/internal/session/fork/detach-notice",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            threadIds: [adopted.id, "thr_not_on_this_host"],
          }),
        },
      );
      expect(notice.status).toBe(200);
      expect((await notice.json()) as unknown).toMatchObject({
        recordedThreadIds: [adopted.id],
      });

      vi.useFakeTimers({ now: Date.now() });
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      await vi.advanceTimersByTimeAsync(
        DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS + 1,
      );

      expect(getThread(harness.deps.db, other.id)?.status).toBe("error");
      expect(getThread(harness.deps.db, adopted.id)?.status).toBe("active");

      await vi.advanceTimersByTimeAsync(
        DETACHED_THREAD_ADOPTION_WINDOW_MS -
          DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
      );
      expect(getThread(harness.deps.db, adopted.id)?.status).toBe("error");
    });
  });
});
