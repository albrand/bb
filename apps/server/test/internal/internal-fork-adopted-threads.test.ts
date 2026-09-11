import { getActiveStoredTurnId, getThread, listEvents } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS } from "../../src/constants.js";
import { DETACHED_THREAD_ADOPTION_WINDOW_MS } from "../../src/internal/fork-adoption.js";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
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
