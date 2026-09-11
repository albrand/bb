import { getActiveStoredTurnId, getThread } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

async function restartWithNullAdoption(
  status: "error" | "idle" | "active",
  report = true,
) {
  let observed: string | undefined;
  let activeTurn: string | null = "unset";
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
    observed = getThread(harness.deps.db, thread.id)?.status;
  });
  return { observed, activeTurn };
}

describe("an adopted worker thread with no open turn", () => {
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
    const { observed, activeTurn } = await restartWithNullAdoption("active");
    expect(activeTurn).toBeNull();
    expect(observed).not.toBe("active");
  });

  it("control: without an adoption report the same thread is interrupted", async () => {
    const { observed } = await restartWithNullAdoption("active", false);
    expect(observed).not.toBe("active");
  });
});
