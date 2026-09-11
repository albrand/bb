import { getActiveStoredTurnId, getThread } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADOPTED_THREAD_TURN_REPLAY_GRACE_MS } from "../../src/internal/fork-adoption.js";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { seedThreadFixture, seedTurnStarted } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

async function restartWithNullAdoption(
  status: "error" | "idle" | "active",
  options: { replayTurn?: boolean; report?: boolean } = {},
) {
  const report = options.report ?? true;
  let observed: string | undefined;
  let atSessionOpen: string | undefined;
  let activeTurn: string | null = "unset";
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await withTestHarness(async (harness) => {
    const { host, session, thread } = seedThreadFixture(harness, {
      thread: { status },
    });
    activeTurn = getActiveStoredTurnId(harness.deps.db, thread.id);
    handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
    const response = await harness.app.request("/internal/session/open", {
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
        dataDir: "/tmp/host-daemon-null-adoption",
        localApiPort: null,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [],
        ...(report
          ? { adoptedThreads: [{ threadId: thread.id, activeTurnId: null }] }
          : {}),
      }),
    });
    expect(response.status).toBe(201);
    atSessionOpen = getThread(harness.deps.db, thread.id)?.status;

    if (options.replayTurn === true) {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-replayed",
      });
    }
    await vi.advanceTimersByTimeAsync(ADOPTED_THREAD_TURN_REPLAY_GRACE_MS + 1);
    observed = getThread(harness.deps.db, thread.id)?.status;
  });
  return { atSessionOpen, observed, activeTurn };
}

describe("an adopted worker thread with no open turn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves an errored thread in error", async () => {
    const { observed, activeTurn } = await restartWithNullAdoption("error");
    expect(activeTurn).toBeNull();
    expect(observed).toBe("error");
  });

  it("leaves an idle thread idle", async () => {
    const { observed, activeTurn } = await restartWithNullAdoption("idle");
    expect(activeTurn).toBeNull();
    expect(observed).toBe("idle");
  });

  it("does not leave an active thread with no stored turn active", async () => {
    const { atSessionOpen, observed, activeTurn } =
      await restartWithNullAdoption("active");
    expect(activeTurn).toBeNull();
    expect(atSessionOpen).toBe("active");
    expect(observed).not.toBe("active");
  });

  it("leaves an active thread alone when its turn arrives before the check", async () => {
    const { observed } = await restartWithNullAdoption("active", {
      replayTurn: true,
    });
    expect(observed).toBe("active");
  });

  it("control: without an adoption report the same thread is interrupted", async () => {
    const { observed } = await restartWithNullAdoption("active", {
      report: false,
    });
    expect(observed).not.toBe("active");
  });
});
