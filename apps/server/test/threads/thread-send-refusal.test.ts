import { getThread } from "@bb/db";
import { describe, expect, it } from "vitest";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import {
  type createTestAppHarness,
  withTestHarness,
} from "../helpers/test-app.js";

type Harness = Awaited<ReturnType<typeof createTestAppHarness>>;

function seedIdleThread(harness: Harness) {
  const { host } = seedHostSession(harness.deps, { id: "host-send-refusal" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/send-refusal-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/send-refusal-environment",
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-send-refusal",
    threadId: thread.id,
  });
  return thread;
}

function send(harness: Harness, thread: ReturnType<typeof seedIdleThread>) {
  return acceptThreadSendRequest(harness.deps, {
    payload: {
      input: textInput("follow-up"),
      mode: "queue-if-active",
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
    },
    thread,
  });
}

function nextSubmit(harness: Harness, threadId: string) {
  return waitForQueuedCommand(
    harness,
    (queued) =>
      queued.command.type === "turn.submit" &&
      queued.command.threadId === threadId,
  );
}

const REFUSAL =
  'Refusing to start a competing turn for thread "thr" while another turn is active or starting';

describe("a send the daemon refuses", () => {
  it("reports the refusal instead of a plain sent", async () => {
    await withTestHarness({ turnAcceptanceGraceMs: 2_000 }, async (harness) => {
      const thread = seedIdleThread(harness);
      const response = send(harness, thread);
      await reportQueuedCommandError(
        harness,
        await nextSubmit(harness, thread.id),
        { errorCode: "command_failed", errorMessage: REFUSAL },
      );

      expect(await response).toMatchObject({
        ok: true,
        delivery: "sent",
        refusal: { message: expect.stringContaining("competing turn") },
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
    });
  });

  it("reports a plain sent when the daemon accepts", async () => {
    await withTestHarness({ turnAcceptanceGraceMs: 2_000 }, async (harness) => {
      const thread = seedIdleThread(harness);
      const response = send(harness, thread);
      await reportQueuedCommandSuccess(
        harness,
        await nextSubmit(harness, thread.id),
        { appliedAs: "new-turn" },
      );

      expect(await response).toEqual({ ok: true, delivery: "sent" });
    });
  });

  it("stops waiting after the grace and reports sent", async () => {
    await withTestHarness({ turnAcceptanceGraceMs: 100 }, async (harness) => {
      const thread = seedIdleThread(harness);
      const startedAt = Date.now();

      expect(await send(harness, thread)).toEqual({
        ok: true,
        delivery: "sent",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      await nextSubmit(harness, thread.id);
    });
  });
});
