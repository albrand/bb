import {
  archiveThread,
  claimQueuedThreadMessageGroup,
  environmentHasLiveThreads,
  listEnvironmentLiveThreadIds,
  machineHasLiveThreads,
  SYSTEM_RELEASE_ACTOR,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { requestEnvironmentRemoval } from "../../../src/services/environments/environment-engine.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
} from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

describe("an archived thread's queued work", () => {
  it("does not hold its environment while it is only queued, because a send to an archived thread is refused, but does once a send claimed it", async () =>
    withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      archiveThread(harness.db, harness.hub, thread.id, SYSTEM_RELEASE_ACTOR);

      expect(environmentHasLiveThreads(harness.db, environment.id)).toBe(false);
      expect(machineHasLiveThreads(harness.db, host.id)).toBe(false);

      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("do this later"),
      });

      expect(environmentHasLiveThreads(harness.db, environment.id)).toBe(false);
      expect(machineHasLiveThreads(harness.db, host.id)).toBe(false);

      claimQueuedThreadMessageGroup(harness.db, harness.hub, queued.id, {
        kind: "explicit-send",
      });

      expect(environmentHasLiveThreads(harness.db, environment.id)).toBe(true);
      expect(listEnvironmentLiveThreadIds(harness.db, environment.id)).toEqual([
        thread.id,
      ]);
      expect(machineHasLiveThreads(harness.db, host.id)).toBe(true);
      expect(requestEnvironmentRemoval(harness.deps, environment.id)).toBe(
        false,
      );
    }));
});
