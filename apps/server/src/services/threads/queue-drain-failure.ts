import {
  clearQueuedMessageDispatchRetry,
  getEnvironment,
  getQueuedMessageDispatchRetry,
  getThread,
  recordQueuedMessageDispatchRetry,
  setQueuedThreadMessageFailureReason,
  setQueuedThreadMessageWaitingOn,
} from "@bb/db";
import {
  QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH,
  type Thread,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { dispatchEnvironmentAndHost } from "./dispatch-hooks.js";

type QueueDrainFailureDeps = Pick<AppDeps, "db" | "hub">;

export const QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS = 5;

const QUEUED_MESSAGE_RETRY_BASE_DELAY_MS = 10_000;
const QUEUED_MESSAGE_RETRY_DELAY_FACTOR = 3;

export function queuedMessageRetryDelayMs(attempt: number): number {
  return (
    QUEUED_MESSAGE_RETRY_BASE_DELAY_MS *
    QUEUED_MESSAGE_RETRY_DELAY_FACTOR ** (attempt - 1)
  );
}

export function describeDispatchFailure(error: unknown): string {
  const message =
    error instanceof ApiError
      ? error.body.message
      : "The message could not be sent.";
  return message.length <= QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH
    ? message
    : `${message.slice(0, QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH - 1)}…`;
}

const TERMINAL_DISPATCH_FAILURE_CODES = new Set([
  "dispatch_rejected",
  "provider_session_unavailable",
]);

function isTerminalDispatchFailure(
  deps: QueueDrainFailureDeps,
  args: { error: unknown; thread: Thread },
): boolean {
  const thread = getThread(deps.db, args.thread.id);
  if (thread === null) return true;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return true;
  if (thread.environmentId !== null) {
    const environment = getEnvironment(deps.db, thread.environmentId);
    if (
      environment === null ||
      environment.teardownStatus !== null ||
      environment.status === "destroyed"
    ) {
      return true;
    }
  }
  return (
    args.error instanceof ApiError &&
    TERMINAL_DISPATCH_FAILURE_CODES.has(args.error.body.code)
  );
}

export function recordQueuedMessageDrainFailure(
  deps: QueueDrainFailureDeps,
  args: {
    error: unknown;
    row: { id: string; threadId: string };
    thread: Thread;
  },
): void {
  const { host } = dispatchEnvironmentAndHost(deps, args.thread.environmentId);
  if (host !== null && host.status === "disconnected") {
    setQueuedThreadMessageWaitingOn(deps.db, deps.hub, {
      id: args.row.id,
      threadId: args.row.threadId,
      waitingOn: { kind: "host-offline", hostName: host.name },
      sendAt: null,
    });
    clearQueuedMessageDispatchRetry(deps.db, args.row.id);
    return;
  }

  const failureReason = describeDispatchFailure(args.error);
  if (!isTerminalDispatchFailure(deps, args)) {
    const attempt =
      (getQueuedMessageDispatchRetry(deps.db, args.row.id)?.attempt ?? 0) + 1;
    if (attempt < QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS) {
      recordQueuedMessageDispatchRetry(deps.db, {
        attempt,
        lastError: failureReason,
        nextAttemptAt: Date.now() + queuedMessageRetryDelayMs(attempt),
        queuedMessageId: args.row.id,
        threadId: args.row.threadId,
      });
      return;
    }
  }

  setQueuedThreadMessageFailureReason(deps.db, deps.hub, {
    id: args.row.id,
    threadId: args.row.threadId,
    failureReason,
  });
  clearQueuedMessageDispatchRetry(deps.db, args.row.id);
}
