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
import { sliceUtf16Head } from "@bb/text-utils";
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

export const QUEUED_MESSAGE_RETRY_DELAYS_MS: readonly number[] = Array.from(
  { length: QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS - 1 },
  (_, index) => queuedMessageRetryDelayMs(index + 1),
);

/**
 * What a failed dispatch says to the person whose message did not go.
 *
 * `ApiError` messages are already written for a caller, so they pass through.
 * Anything else is an internal fault whose message was written for a log, so
 * the row gets a sentence that is true without pretending to diagnose.
 */
export function describeDispatchFailure(error: unknown): string {
  const message =
    error instanceof ApiError
      ? error.body.message
      : "The message could not be sent.";
  return message.length <= QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH
    ? message
    : `${sliceUtf16Head(message, QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH - 1)}…`;
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

/**
 * Settles a DRAIN attempt that neither dispatched nor queued.
 *
 * Two outcomes, and which one applies is decided by asking the world rather
 * than by pattern-matching the error: if the thread's host has no live daemon
 * session *right now*, the attempt did not fail so much as arrive at a machine
 * that is not there, and the row re-queues on a `host-offline` wait that the
 * host-reconnect drain clears when the machine comes back. Any other failure
 * is recorded as the row's failure reason, leaving its existing wait alone —
 * the row is still waiting on whatever it was waiting on, and what went wrong
 * last time is a different fact from what it is waiting for — and spends one
 * of the row's attempts, booking the next on
 * {@link QUEUED_MESSAGE_RETRY_DELAYS_MS}. The row gives up only once that
 * budget runs out.
 *
 * Only the drain calls this. An inline attempt has a caller still listening
 * and surfaces its error to them instead, which is why a queued row never
 * shows a failure the sender was already told about to their face.
 */
export function recordQueuedMessageDrainFailure(
  deps: QueueDrainFailureDeps,
  args: {
    error: unknown;
    now: number;
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
        nextAttemptAt: args.now + queuedMessageRetryDelayMs(attempt),
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
    now: args.now,
    retryDelaysMs: [],
  });
  clearQueuedMessageDispatchRetry(deps.db, args.row.id);
}
