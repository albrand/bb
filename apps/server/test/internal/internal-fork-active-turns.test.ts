import { turnScope } from "@bb/domain";
import { hostDaemonActiveTurnsResponseSchema } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("fork active-turns route", () => {
  it("reports the server's active turn for the session host's threads only", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-active-turns",
      });
      const other = seedHostSession(harness.deps, { id: "host-other" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const running = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const finished = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const { project: foreignProject } = seedProjectWithSource(harness.deps, {
        hostId: other.host.id,
      });
      const foreign = seedThread(harness.deps, {
        projectId: foreignProject.id,
        environmentId: seedEnvironment(harness.deps, {
          hostId: other.host.id,
          projectId: foreignProject.id,
        }).id,
        status: "active",
      });
      seedTurnStarted(harness.deps, {
        threadId: running.id,
        turnId: "turn-live",
      });
      seedTurnStarted(harness.deps, {
        threadId: finished.id,
        turnId: "turn-done",
      });
      seedEvent(harness.deps, {
        threadId: finished.id,
        type: "turn/completed",
        scope: turnScope("turn-done"),
        sequence: 100,
        providerThreadId: "provider-thread",
        data: { status: "completed" },
      });
      seedTurnStarted(harness.deps, {
        threadId: foreign.id,
        turnId: "turn-foreign",
      });

      const response = await harness.app.request(
        "/internal/session/fork/active-turns",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            threadIds: [running.id, finished.id, foreign.id, "thr_missing"],
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(
        hostDaemonActiveTurnsResponseSchema.parse(await response.json()),
      ).toEqual({
        threads: [
          { threadId: running.id, activeTurnId: "turn-live" },
          { threadId: finished.id, activeTurnId: null },
        ],
      });
    });
  });
});
