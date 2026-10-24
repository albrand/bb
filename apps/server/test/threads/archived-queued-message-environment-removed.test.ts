import {
  archiveThread,
  environments,
  listEvents,
  listQueuedThreadMessages,
  SYSTEM_RELEASE_ACTOR,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
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
import { withTestHarness } from "../helpers/test-app.js";

describe("an unclaimed queued message on an archived thread whose environment is then removed", () => {
  it("is never run against the removed environment when the thread is unarchived: it fails visibly on the queue, with a reason", async () =>
    withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({ ok: true, result: { ok: true } }),
      });
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
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-1",
        threadId: thread.id,
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("run this later"),
      });
      archiveThread(harness.db, harness.hub, thread.id, SYSTEM_RELEASE_ACTOR);
      harness.db
        .update(environments)
        .set({ status: "destroyed", teardownStatus: "removed", path: null })
        .where(eq(environments.id, environment.id))
        .run();
      const turnRequestsBefore = listEvents(harness.db, {
        threadId: thread.id,
      }).filter((event) => event.type === "client/turn/requested").length;

      const unarchived = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      expect(unarchived.status).toBe(200);

      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      await expect
        .poll(() => listQueuedThreadMessages(harness.db, thread.id)[0]?.state)
        .toBe("failed_exhausted");
      expect(
        listQueuedThreadMessages(harness.db, thread.id)[0]?.failureReason,
      ).toContain("unavailable");
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "client/turn/requested",
        ),
      ).toHaveLength(turnRequestsBefore);
    }));
});
