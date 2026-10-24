import {
  createNativeTerminalThread,
  getThreadRowState,
  listQueuedThreadMessages,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import * as queuedMessages from "../../src/services/threads/queued-messages.js";
import {
  handleUnclaimedPluginAnswer,
  UNDELIVERED_LATE_ANSWER_STATUS,
  UNDELIVERED_LATE_ANSWER_STATUS_KEY,
} from "../../src/services/interactions/deliver-unclaimed-answer.js";
import { seedThread, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const payload = {
  kind: "plugin",
  title: "1 question",
  data: {
    questions: [
      {
        id: "q0",
        prompt: "Which layout?",
        options: [{ value: "q0o0", label: "Inner area" }],
      },
    ],
  },
};

describe("a plugin answer that arrives after its tool call ended", () => {
  it("is surfaced on the row of a native terminal thread, which cannot take queued messages", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment } = seedThreadFixture(harness, {});
      const native = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
        status: "active",
      });
      createNativeTerminalThread(harness.db, {
        threadId: native.id,
        providerId: "claude-code",
        nativeSessionId: null,
        initialPrompt: null,
        initialImages: [],
        model: null,
      });

      const queue = vi
        .spyOn(queuedMessages, "createQueuedMessageForThread")
        .mockRejectedValue(new Error("queue refused"));
      try {
        handleUnclaimedPluginAnswer(harness.deps, {
          interaction: { threadId: native.id, payload } as never,
          value: { answers: { q0: ["q0o0"] } },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(queue).not.toHaveBeenCalled();
      } finally {
        queue.mockRestore();
      }

      expect(
        getThreadRowState(harness.db, native.id).statuses[
          UNDELIVERED_LATE_ANSWER_STATUS_KEY
        ],
      ).toMatchObject({ value: UNDELIVERED_LATE_ANSWER_STATUS });
      expect(listQueuedThreadMessages(harness.db, native.id)).toEqual([]);
    });
  });

  it("is still queued for an ordinary thread, leaving its row alone", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      const queue = vi
        .spyOn(queuedMessages, "createQueuedMessageForThread")
        .mockRejectedValue(new Error("queue refused"));
      try {
        handleUnclaimedPluginAnswer(harness.deps, {
          interaction: { threadId: thread.id, payload } as never,
          value: { answers: { q0: ["q0o0"] } },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(queue).toHaveBeenCalledTimes(1);
        expect(getThreadRowState(harness.db, thread.id).statuses).toEqual({});
      } finally {
        queue.mockRestore();
      }
    });
  });
});
