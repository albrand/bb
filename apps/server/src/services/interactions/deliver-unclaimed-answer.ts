import {
  getThread,
  getThreadRowState,
  isNativeTerminalThread,
  putThreadRowState,
} from "@bb/db";
import type { JsonValue, PendingInteraction } from "@bb/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { createQueuedMessageForThread } from "../threads/queued-messages.js";
import { requestQueuedMessageDispatch } from "../threads/queued-message-dispatch.js";
import { buildUnclaimedAnswerMessage } from "./unclaimed-answer-message.js";

export const UNDELIVERED_LATE_ANSWER_STATUS_KEY = "late-answer";
export const UNDELIVERED_LATE_ANSWER_STATUS = "Late answer not delivered";

export interface UnclaimedAnswerDelivery {
  threadId: string;
  text: string;
}

export function planUnclaimedAnswerDelivery(args: {
  interaction: Pick<PendingInteraction, "threadId" | "payload">;
  value: JsonValue;
}): UnclaimedAnswerDelivery | null {
  const text = buildUnclaimedAnswerMessage(
    args.interaction.payload,
    args.value,
  );
  if (text === null) return null;
  return { threadId: args.interaction.threadId, text };
}

function surfaceUndeliverableLateAnswer(
  deps: Pick<AppDeps, "db" | "hub">,
  threadId: string,
  projectId: string,
): void {
  const current = getThreadRowState(deps.db, threadId);
  if (
    Object.keys(current.statuses).length >= 8 &&
    current.statuses[UNDELIVERED_LATE_ANSWER_STATUS_KEY] === undefined
  ) {
    return;
  }
  putThreadRowState(deps.db, threadId, {
    ...current,
    statuses: {
      ...current.statuses,
      [UNDELIVERED_LATE_ANSWER_STATUS_KEY]: {
        value: UNDELIVERED_LATE_ANSWER_STATUS,
        color: "warning",
        priority: 100,
      },
    },
  });
  deps.hub.notifyThread(threadId, ["status-changed"]);
  deps.hub.notifyProject(projectId, ["threads-changed"]);
}

export function handleUnclaimedPluginAnswer(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    interaction: Pick<PendingInteraction, "threadId" | "payload">;
    value: JsonValue;
  },
): void {
  const delivery = planUnclaimedAnswerDelivery(args);
  if (delivery === null) return;
  const thread = getThread(deps.db, delivery.threadId);
  if (!thread) return;
  if (isNativeTerminalThread(deps.db, thread.id)) {
    deps.logger.warn(
      { threadId: thread.id },
      "An answer arrived after its tool call ended, and a native terminal thread cannot take queued messages",
    );
    surfaceUndeliverableLateAnswer(deps, thread.id, thread.projectId);
    return;
  }
  void createQueuedMessageForThread(deps, {
    payload: {
      input: [{ type: "text", text: delivery.text, mentions: [] }],
    } as never,
    thread,
  })
    .then(() => {
      requestQueuedMessageDispatch(deps, {
        kind: "interaction-settled",
        threadId: delivery.threadId,
      });
    })
    .catch((error: unknown) => {
      deps.logger.warn(
        { err: error, threadId: args.interaction.threadId },
        "Could not queue an answer that arrived after its tool call ended",
      );
    });
}
