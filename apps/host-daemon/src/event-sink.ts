import { getThreadEventScopeTurnId, turnScope } from "@bb/domain";
import type { ThreadEvent } from "@bb/domain";
import type {
  HostDaemonEventBatchResponse,
  HostDaemonEventEnvelope,
  HostDaemonRejectedEvent,
} from "@bb/host-daemon-contract";
import { normalizeCaughtError, runtimeErrorLogFields } from "./error-utils.js";
import type { HostDaemonLogger } from "./logger.js";
import {
  ServerResponseError,
  type TurnStartPendingResponseDetails,
} from "./server-client.js";

const DEFAULT_DEBOUNCE_MS = 100;

const TURN_START_RETRY_INITIAL_MS = 250;
const TURN_START_RETRY_MAX_MS = 10_000;
const TURN_START_PENDING_GRACE_MS = 30_000;
const ABANDONED_TURN_KEYS_LIMIT = 1_000;

const QUEUE_DEPTH_WARN_THRESHOLD = 512;
const QUEUE_DEPTH_WARN_MIN_AGE_MS = 5_000;
const QUEUE_AGE_WARN_THRESHOLD_MS = 30_000;

export interface EventSinkDelivery {
  replayKey: string;
  onSettled: () => void;
}

export interface EventSinkInput {
  event: ThreadEvent;
  threadId: string;
  delivery?: EventSinkDelivery;
}

export interface EventPostResult {
  acceptedEvents: HostDaemonEventBatchResponse["acceptedEvents"];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
}

export interface CreateEventSinkOptions {
  isSessionOpen: () => boolean;
  logger: Pick<HostDaemonLogger, "debug" | "error" | "warn">;
  now?: () => number;
  postEvents: (events: HostDaemonEventEnvelope[]) => Promise<EventPostResult>;
}

export interface EventSink {
  emit(event: EventSinkInput): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

interface RejectedEventSummary {
  eventIndex: number;
  reason: HostDaemonRejectedEvent["reason"];
  threadId: string;
}

export class EventSinkDisposedError extends Error {
  constructor() {
    super("Cannot emit to disposed event sink");
    this.name = "EventSinkDisposedError";
  }
}

function isWaitingForApprovalItemEvent(event: ThreadEvent): boolean {
  if (event.type !== "item/started" && event.type !== "item/completed") {
    return false;
  }

  if (
    event.item.type !== "commandExecution" &&
    event.item.type !== "fileChange"
  ) {
    return false;
  }

  return event.item.approvalStatus === "waiting_for_approval";
}

function shouldFlushThreadEventImmediately(event: ThreadEvent): boolean {
  if (event.type === "turn/started" || event.type === "item/completed") {
    return true;
  }

  if (
    event.type === "turn/completed" ||
    event.type === "system/error" ||
    event.type === "system/thread/interrupted"
  ) {
    return true;
  }

  if (event.type === "provider/error") {
    return event.willRetry !== true;
  }

  return isWaitingForApprovalItemEvent(event);
}

function isPermanentPostRejection(error: Error): boolean {
  return (
    error instanceof ServerResponseError &&
    !error.retryable &&
    error.code === "invalid_request"
  );
}

function isTurnStartPendingRejection(error: Error): boolean {
  return (
    error instanceof ServerResponseError &&
    error.status === 503 &&
    error.code === "turn_start_pending"
  );
}

function buildTurnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function getEnvelopeTurnKey(envelope: HostDaemonEventEnvelope): string | null {
  const turnId = getThreadEventScopeTurnId(envelope.event.scope);
  return turnId === undefined ? null : buildTurnKey(envelope.threadId, turnId);
}

function getEventProviderThreadId(event: ThreadEvent): string | null {
  const providerThreadId =
    "providerThreadId" in event ? event.providerThreadId : null;
  return typeof providerThreadId === "string" && providerThreadId !== ""
    ? providerThreadId
    : null;
}

function summarizeRejectedEvents(
  events: readonly HostDaemonRejectedEvent[],
): RejectedEventSummary[] {
  return events.map((event) => ({
    eventIndex: event.eventIndex,
    reason: event.reason,
    threadId: event.threadId,
  }));
}

export function createEventSink(options: CreateEventSinkOptions): EventSink {
  const now = options.now ?? (() => Date.now());
  const queue: HostDaemonEventEnvelope[] = [];
  const deliveries: (EventSinkDelivery | null)[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushPromise: Promise<void> | null = null;
  let disposed = false;
  let backedUpSinceMs: number | null = null;
  let backpressureLogged = false;
  let turnStartRetryDelayMs = TURN_START_RETRY_INITIAL_MS;
  let turnStartRetryPending = false;
  let pendingTurnStart: { key: string; sinceMs: number } | null = null;
  let undetailedTurnStartSinceMs: number | null = null;
  let expiredTurnStart: TurnStartPendingResponseDetails | null = null;
  const abandonedTurnKeys = new Set<string>();

  function noteTurnStartPending(
    pending: TurnStartPendingResponseDetails | null,
  ): void {
    if (pending === null) {
      return;
    }
    const key = buildTurnKey(pending.threadId, pending.turnId);
    if (pendingTurnStart === null || pendingTurnStart.key !== key) {
      pendingTurnStart = { key, sinceMs: now() };
      return;
    }
    if (now() - pendingTurnStart.sinceMs >= TURN_START_PENDING_GRACE_MS) {
      expiredTurnStart = pending;
    }
  }

  function hasUndetailedTurnStartOutlivedGrace(error: Error): boolean {
    if (
      error instanceof ServerResponseError &&
      error.turnStartPending !== null
    ) {
      return false;
    }
    undetailedTurnStartSinceMs ??= now();
    return now() - undetailedTurnStartSinceMs >= TURN_START_PENDING_GRACE_MS;
  }

  function removeQueuedEntry(index: number): void {
    queue.splice(index, 1);
    const [delivery] = deliveries.splice(index, 1);
    delivery?.onSettled();
  }

  function abandonTurn(key: string): void {
    abandonedTurnKeys.add(key);
    if (abandonedTurnKeys.size > ABANDONED_TURN_KEYS_LIMIT) {
      const [oldest] = abandonedTurnKeys;
      if (oldest !== undefined) {
        abandonedTurnKeys.delete(oldest);
      }
    }
  }

  function repairMissingTurnStart(
    pending: TurnStartPendingResponseDetails,
  ): void {
    const key = buildTurnKey(pending.threadId, pending.turnId);
    const pendingForMs =
      pendingTurnStart === null ? null : now() - pendingTurnStart.sinceMs;
    pendingTurnStart = null;
    const firstIndex = queue.findIndex(
      (envelope) => getEnvelopeTurnKey(envelope) === key,
    );
    if (firstIndex === -1) {
      options.logger.warn(
        { threadId: pending.threadId, turnId: pending.turnId, pendingForMs },
        "Turn awaiting turn/started is no longer queued; retrying delivery",
      );
      return;
    }
    let providerThreadId: string | null = null;
    for (const envelope of queue) {
      if (getEnvelopeTurnKey(envelope) === key) {
        providerThreadId = getEventProviderThreadId(envelope.event);
        if (providerThreadId !== null) {
          break;
        }
      }
    }

    if (providerThreadId !== null) {
      queue.splice(firstIndex, 0, {
        threadId: pending.threadId,
        event: {
          type: "turn/started",
          threadId: pending.threadId,
          providerThreadId,
          scope: turnScope(pending.turnId),
        },
      });
      deliveries.splice(firstIndex, 0, null);
      options.logger.error(
        { threadId: pending.threadId, turnId: pending.turnId, pendingForMs },
        "turn/started never reached the server; synthesized it so the event queue can drain",
      );
      return;
    }

    let dropped = 0;
    for (let index = queue.length - 1; index >= firstIndex; index -= 1) {
      const envelope = queue[index];
      if (envelope !== undefined && getEnvelopeTurnKey(envelope) === key) {
        removeQueuedEntry(index);
        dropped += 1;
      }
    }
    abandonTurn(key);
    options.logger.error(
      {
        threadId: pending.threadId,
        turnId: pending.turnId,
        pendingForMs,
        dropped,
      },
      "Dropped daemon events for a turn whose turn/started never reached the server",
    );
  }

  function maybeLogQueuePressure(): void {
    if (backpressureLogged || backedUpSinceMs === null) {
      return;
    }
    const queueDepth = queue.length;
    const queueAgeMs = now() - backedUpSinceMs;
    if (
      queueAgeMs < QUEUE_AGE_WARN_THRESHOLD_MS &&
      (queueDepth < QUEUE_DEPTH_WARN_THRESHOLD ||
        queueAgeMs < QUEUE_DEPTH_WARN_MIN_AGE_MS)
    ) {
      return;
    }
    backpressureLogged = true;
    options.logger.warn(
      { queueDepth, queueAgeMs },
      "Daemon event queue is backing up; delivery may be stalled",
    );
  }

  function clearScheduledFlush(): void {
    if (flushTimer === null) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(delayMs: number): void {
    if (disposed || flushPromise !== null) {
      return;
    }
    if (flushTimer !== null) {
      if (delayMs > 0) {
        return;
      }
      clearScheduledFlush();
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch((error) => {
        options.logger.error(
          runtimeErrorLogFields(normalizeCaughtError(error)),
          "Daemon event delivery failed",
        );
      });
    }, delayMs);
  }

  async function deliverBatch(
    batch: readonly HostDaemonEventEnvelope[],
  ): Promise<number> {
    let response: EventPostResult;
    try {
      response = await options.postEvents([...batch]);
    } catch (error) {
      const normalized = normalizeCaughtError(error);
      const turnStartPending = isTurnStartPendingRejection(normalized);
      if (
        turnStartPending &&
        !hasUndetailedTurnStartOutlivedGrace(normalized)
      ) {
        turnStartRetryPending = true;
        noteTurnStartPending(
          normalized instanceof ServerResponseError
            ? normalized.turnStartPending
            : null,
        );
        options.logger.warn(
          {
            ...runtimeErrorLogFields(normalized),
            batchSize: batch.length,
            retryDelayMs: turnStartRetryDelayMs,
          },
          "Server has not stored turn/started yet; retaining batch for bounded retry",
        );
        return 0;
      }
      if (!turnStartPending && !isPermanentPostRejection(normalized)) {
        options.logger.error(
          runtimeErrorLogFields(normalized),
          "Failed to post daemon events; will retry on the next flush",
        );
        return 0;
      }

      const [offending] = batch;
      if (batch.length === 1 && offending !== undefined) {
        options.logger.error(
          {
            ...runtimeErrorLogFields(normalized),
            eventType: offending.event.type,
            threadId: offending.threadId,
          },
          "Dropped a daemon event the server will never accept",
        );
        return 1;
      }

      const midpoint = Math.floor(batch.length / 2);
      const deliveredFromFirstHalf = await deliverBatch(
        batch.slice(0, midpoint),
      );
      if (deliveredFromFirstHalf < midpoint) {
        return deliveredFromFirstHalf;
      }
      return midpoint + (await deliverBatch(batch.slice(midpoint)));
    }

    if (response.rejectedEvents.length > 0) {
      options.logger.warn(
        {
          rejectedEvents: summarizeRejectedEvents(response.rejectedEvents),
        },
        "Server rejected daemon events",
      );
    }
    turnStartRetryDelayMs = TURN_START_RETRY_INITIAL_MS;
    pendingTurnStart = null;
    return batch.length;
  }

  async function drainQueue(): Promise<void> {
    while (queue.length > 0 && !disposed && options.isSessionOpen()) {
      const batch = queue.slice();
      const delivered = await deliverBatch(batch);
      queue.splice(0, delivered);
      for (const delivery of deliveries.splice(0, delivered)) {
        delivery?.onSettled();
      }
      if (expiredTurnStart !== null) {
        const expired = expiredTurnStart;
        expiredTurnStart = null;
        repairMissingTurnStart(expired);
        turnStartRetryPending = false;
        turnStartRetryDelayMs = TURN_START_RETRY_INITIAL_MS;
        continue;
      }
      if (queue.length === 0) {
        undetailedTurnStartSinceMs = null;
        backedUpSinceMs = null;
        backpressureLogged = false;
      }
      if (delivered < batch.length) {
        return;
      }
    }
  }

  async function flush(): Promise<void> {
    clearScheduledFlush();
    if (flushPromise !== null) {
      await flushPromise;
      return;
    }

    flushPromise = drainQueue();
    try {
      await flushPromise;
    } finally {
      flushPromise = null;
      if (turnStartRetryPending) {
        turnStartRetryPending = false;
        if (queue.length > 0 && !disposed) {
          scheduleFlush(turnStartRetryDelayMs);
          turnStartRetryDelayMs = Math.min(
            turnStartRetryDelayMs * 2,
            TURN_START_RETRY_MAX_MS,
          );
        }
      }
    }
  }

  return {
    emit(input): void {
      if (disposed) {
        throw new EventSinkDisposedError();
      }
      if (abandonedTurnKeys.size > 0) {
        const turnId = getThreadEventScopeTurnId(input.event.scope);
        const key =
          turnId === undefined ? null : buildTurnKey(input.threadId, turnId);
        if (key !== null && abandonedTurnKeys.has(key)) {
          if (input.event.type !== "turn/started") {
            input.delivery?.onSettled();
            return;
          }
          abandonedTurnKeys.delete(key);
        }
      }
      if (backedUpSinceMs === null) {
        backedUpSinceMs = now();
      }
      queue.push({
        threadId: input.threadId,
        event: input.event,
        ...(input.delivery === undefined
          ? {}
          : { replayKey: input.delivery.replayKey }),
      });
      deliveries.push(input.delivery ?? null);
      maybeLogQueuePressure();
      scheduleFlush(
        shouldFlushThreadEventImmediately(input.event)
          ? 0
          : DEFAULT_DEBOUNCE_MS,
      );
    },
    flush,
    async dispose(): Promise<void> {
      disposed = true;
      clearScheduledFlush();
      if (flushPromise !== null) {
        await flushPromise.catch(() => undefined);
      }
      queue.length = 0;
      deliveries.length = 0;
    },
  };
}
