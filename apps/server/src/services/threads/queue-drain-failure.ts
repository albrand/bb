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

/**
 * How many dispatch attempts a row gets before its failure is the answer.
 *
 * Five, spaced by {@link queuedMessageRetryDelayMs}, is a little under seven
 * minutes of trying. The shape is set by what actually went wrong on
 * 2026-09-11: an overloaded machine whose server stalled for seconds at a time
 * and whose daemons lost their sessions for a moment. That is a blip measured
 * in seconds to low minutes, so a budget of minutes covers it several times
 * over — while an unbounded retry on a genuinely broken send would hammer a
 * struggling machine, which is the state that produced the failure.
 *
 * A machine that is properly away is NOT spending this budget: an absent host
 * is a `host-offline` wait with no bound at all, cleared when it reconnects.
 */
export const QUEUED_MESSAGE_DISPATCH_MAX_ATTEMPTS = 5;

const QUEUED_MESSAGE_RETRY_BASE_DELAY_MS = 10_000;
const QUEUED_MESSAGE_RETRY_DELAY_FACTOR = 3;

/**
 * How long after the Nth failure the N+1th attempt is due: 10s, 30s, 90s, 270s.
 *
 * The first delay is the sweep cadence, not a shorter one that would round up
 * to it anyway — the retry sweep runs on the same ten-second tick as every
 * other periodic job, so anything below it is a number the server cannot
 * honour. Tripling from there reaches minutes in three steps without needing
 * jitter: rows are re-attempted one at a time on that tick, so a hundred rows
 * failing together do not become a hundred simultaneous re-sends.
 */
export function queuedMessageRetryDelayMs(attempt: number): number {
  return (
    QUEUED_MESSAGE_RETRY_BASE_DELAY_MS *
    QUEUED_MESSAGE_RETRY_DELAY_FACTOR ** (attempt - 1)
  );
}

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
    : `${message.slice(0, QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH - 1)}…`;
}

/**
 * A plugin's `reject` decision. It is a judgement about this payload rather
 * than a fault, so asking again gets the same answer: the one failure whose
 * terminality the world cannot be asked about, and therefore the one code
 * matched by name.
 */
const DISPATCH_REJECTED_CODE = "dispatch_rejected";

/**
 * Whether re-attempting this row could ever produce a different outcome.
 *
 * Decided by asking the world rather than by reading the error, in the style
 * the host check below already uses: a thread that has been archived or thrown
 * away, or an environment that is destroyed, is a destination that is not
 * coming back, and no amount of waiting changes that.
 *
 * Everything else retries, and the asymmetry is deliberate. The failure that
 * parked a message for two hours on 2026-09-11 was not an `ApiError` at all —
 * it arrived as the generic "The message could not be sent." — so a classifier
 * that defaults to terminal reproduces exactly the bug it is meant to fix. A
 * transient error wrongly called terminal loses the message; a terminal error
 * wrongly retried costs a few minutes and then lands in the same visible
 * failure it would have had immediately.
 */
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
    args.error.body.code === DISPATCH_REJECTED_CODE
  );
}

/**
 * Settles a DRAIN attempt that neither dispatched nor queued.
 *
 * A row leaves here in exactly one of three states, and none of them is
 * "parked forever after one bad moment":
 *
 * 1. Waiting on an absent machine. If the thread's host has no live daemon
 *    session *right now*, the attempt did not fail so much as arrive at a
 *    machine that is not there, and the row re-queues on a `host-offline` wait
 *    that the host-reconnect drain clears when the machine comes back. It
 *    spends no retry budget, because there is no bound on how long a laptop
 *    may be shut.
 * 2. Terminally failed, when {@link isTerminalDispatchFailure} says a
 *    re-attempt cannot help, or when the retry budget is spent. The row keeps
 *    its failure reason, renders it, and stays sendable by hand — the queue's
 *    explicit-send path ignores the failure the automatic drains refuse to
 *    look past.
 * 3. Retrying. One attempt is booked against the row's budget with the next
 *    attempt due after a backoff, and the row deliberately keeps a NULL
 *    failure reason: that column is what every automatic drain reads as "do
 *    not touch this row", so writing it is what made a transient error
 *    permanent.
 *
 * Only the drain calls this. An inline attempt has a caller still listening
 * and surfaces its error to them instead, which is why a queued row never
 * shows a failure the sender was already told about to their face.
 */
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
      // An offline host is not a schedule. Whatever instant this row carried
      // has already passed by the time a drain picked it up, and keeping it
      // would leave the due sweep re-claiming a row that cannot dispatch.
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
      // Booking leaves the row itself untouched and drainable, so the queue
      // renders it as what it is: a message still on its way. Nothing is
      // booked when the row is gone or another drain holds it, and in both
      // cases this attempt has nothing left to say about it.
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
