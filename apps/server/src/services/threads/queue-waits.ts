import {
  clearQueuedMessageDispatchRetry,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessageInTransaction,
  requeueClaimedQueuedThreadMessages,
  type ClaimedQueuedThreadMessageRow,
  type DbConnection,
  type DbNotifier,
  type DbQueryConnection,
  type QueuedThreadMessageRow,
} from "@bb/db";
import type {
  PromptInput,
  QueuedMessagePayload,
  QueuedMessageSystemNotice,
  QueuedMessageWaitingOn,
  ResolvedThreadExecutionOptions,
  StartedOnBehalfOf,
  Thread,
  ThreadCreateOrigin,
  ThreadQueuedMessage,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import {
  emitPluginMessageDispatched,
  emitPluginMessageQueued,
} from "../plugins/plugin-thread-events.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";

type QueueWaitDeps = { db: DbQueryConnection; hub: DbNotifier };

export const QUEUED_MESSAGE_CLAIM_LOST_CODE = "queued_message_claim_lost";
export const QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE =
  "queued_message_auto_send_paused";

export function createQueuedMessageClaimLostError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_CLAIM_LOST_CODE,
    "Queued message claim expired before it could be sent",
  );
}

export function createQueuedMessageAutoSendPausedError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
    "Queued message auto-send was paused by a manual stop",
  );
}

export interface SettleQueueRowArgs {
  row: QueuedThreadMessageRow;
}

export interface QueuedDispatchMessage {
  input: PromptInput[];
  execution: ResolvedThreadExecutionOptions;
  senderThreadId: string | null;
  /**
   * The provenance of the dispatch being queued, written onto the row so the
   * drain re-decides on what the first attempt saw rather than on null.
   */
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  requestedBy: StartedOnBehalfOf | null;
  payload: QueuedMessagePayload;
  systemNotice: QueuedMessageSystemNotice | null;
}

export interface RecordQueuedMessageWaitArgs {
  thread: Thread;
  message: QueuedDispatchMessage;
  waitingOn: QueuedMessageWaitingOn;
  sendAt: number | null;
  claimed: readonly ClaimedQueuedThreadMessageRow[] | null;
}

export function recordQueuedMessageWait(
  deps: QueueWaitDeps,
  args: RecordQueuedMessageWaitArgs,
): ThreadQueuedMessage | null {
  const claimed = args.claimed ?? [];
  const leadClaim = claimed[0];
  let row: QueuedThreadMessageRow | null;

  if (leadClaim === undefined) {
    row = deps.db.transaction(
      (tx) =>
        createQueuedThreadMessageInTransaction(tx, {
          threadId: args.thread.id,
          content: args.message.input,
          senderThreadId: args.message.senderThreadId,
          origin: args.message.origin,
          originPluginId: args.message.originPluginId,
          requestedBy: args.message.requestedBy,
          model: args.message.execution.model,
          reasoningLevel: args.message.execution.reasoningLevel,
          permissionMode: args.message.execution.permissionMode,
          serviceTier: args.message.execution.serviceTier,
          waitingOn: args.waitingOn,
          sendAt: args.sendAt,
          payload: args.message.payload,
          systemNotice: args.message.systemNotice,
        }),
      { behavior: "immediate" },
    );
  } else {
    row = requeueClaimedQueuedThreadMessages(deps.db, deps.hub, {
      claims: claimed.map((claim) => ({
        id: claim.id,
        claimToken: claim.claimToken,
      })),
      threadId: args.thread.id,
      waitingOn: args.waitingOn,
      sendAt: args.sendAt,
    });
  }

  if (row === null) {
    return null;
  }
  const entry = toThreadQueuedMessage(row);
  emitPluginMessageQueued(entry);
  deps.hub.notifyThread(args.thread.id, ["queue-changed"]);
  return entry;
}

export function settleQueueRowDispatched(args: SettleQueueRowArgs): void {
  emitPluginMessageDispatched(toThreadQueuedMessage(args.row));
}

export function clearQueuedMessageWait(
  deps: { db: DbConnection; hub: DbNotifier },
  args: { queuedMessageId: string; threadId: string },
): QueuedThreadMessageRow | null {
  const row = clearQueuedThreadMessageWaitingOn(deps.db, deps.hub, {
    id: args.queuedMessageId,
    threadId: args.threadId,
  });
  if (row !== null) {
    clearQueuedMessageDispatchRetry(deps.db, row.id);
  }
  return row;
}
