import {
  applySpendContribution,
  emptySpendCursorState,
  ensureSpendTables,
  foldTokenUsageObservation,
  getSpendCursor,
  listSpendBackfillThreads,
  listStoredTokenUsageEvents,
  resolveSpendModel,
  saveSpendCursor,
  type SpendCursorState,
  type SpendUsageBreakdown,
  type TokenUsageObservation,
} from "@bb/db";
import type { DbConnection, DbQueryConnection } from "@bb/db";
import type { ThreadEvent } from "@bb/domain";

export interface SpendRollupObservationSource {
  createdAt: number;
  event: Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }>;
  providerId: string;
  sequence: number;
  threadId: string;
  turnId: string | null;
}

export interface SpendBackfillResult {
  threadsScanned: number;
  usageEventsScanned: number;
  contributionsApplied: number;
  threadsHistoryComplete: number;
  threadsHistoryPartial: number;
}

interface TrackedCursorEntry {
  providerThreadId: string;
  state: SpendCursorState;
  threadId: string;
}

const UNKNOWN_MODEL = "";

function toBreakdown(usage: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}): SpendUsageBreakdown {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
  };
}

function readStoredUsage(raw: unknown): SpendUsageBreakdown {
  const record = (raw ?? {}) as Record<string, unknown>;
  const read = (key: string): number =>
    typeof record[key] === "number" ? (record[key] as number) : 0;
  return {
    inputTokens: read("inputTokens"),
    cachedInputTokens: read("cachedInputTokens"),
    outputTokens: read("outputTokens"),
    reasoningOutputTokens: read("reasoningOutputTokens"),
    totalTokens: read("totalTokens"),
  };
}

function cursorKey(threadId: string, providerThreadId: string): string {
  return `${threadId}|${providerThreadId}`;
}

/**
 * The model for an observation, reusing the cursor's answer while the turn is
 * the same one.
 *
 * Codex emits thousands of usage events against a few hundred turns, so the
 * lookup is per turn and the cursor carries the answer between them.
 */
function modelForObservation(
  db: DbQueryConnection,
  state: SpendCursorState,
  observation: TokenUsageObservation,
): string {
  if (
    observation.turnId !== null &&
    observation.turnId === state.lastTurnId &&
    state.lastModel !== null
  ) {
    return state.lastModel;
  }
  return (
    resolveSpendModel(db, {
      threadId: observation.threadId,
      sequence: observation.sequence,
    }) ??
    state.lastModel ??
    UNKNOWN_MODEL
  );
}

function rollUpObservations(
  db: DbQueryConnection,
  observations: readonly TokenUsageObservation[],
  historyCompleteByThreadId: ReadonlyMap<string, boolean> | null,
): number {
  const tracked = new Map<string, TrackedCursorEntry>();
  let applied = 0;

  for (const observation of observations) {
    const key = cursorKey(observation.threadId, observation.providerThreadId);
    const entry: TrackedCursorEntry = tracked.get(key) ?? {
      providerThreadId: observation.providerThreadId,
      threadId: observation.threadId,
      state:
        getSpendCursor(db, {
          threadId: observation.threadId,
          providerThreadId: observation.providerThreadId,
        }) ?? emptySpendCursorState(observation.sequence),
    };
    const model = modelForObservation(db, entry.state, observation);
    const { next, contribution } = foldTokenUsageObservation(
      entry.state,
      observation,
      model,
    );
    entry.state = next;
    tracked.set(key, entry);
    if (contribution !== null) {
      applySpendContribution(db, contribution);
      applied += 1;
    }
  }

  for (const entry of tracked.values()) {
    saveSpendCursor(db, {
      threadId: entry.threadId,
      providerThreadId: entry.providerThreadId,
      state: entry.state,
      historyComplete: historyCompleteByThreadId?.get(entry.threadId),
    });
  }

  return applied;
}

/**
 * Record the spend in a batch of daemon events that were just stored.
 *
 * Called inside the append transaction, from the indexes the append reported as
 * INSERTED. Four things follow from that placement and none of them hold
 * anywhere else:
 *
 *   * it is atomic with the append, so no crash can leave an event stored but
 *     unaccounted, or accounted but unstored;
 *   * it is exactly-once against the #3143 replay path. An adopted worker
 *     replays unacked lines, so the server is re-sent events it already stored;
 *     replay-key dedup and the `(thread_id, sequence)` high-water mark drop
 *     those at the append and they never reach `insertedInputIndexes`. The
 *     sequence guard inside the fold is a second line of defence for the same
 *     case, and the reason a backfill can run alongside live traffic;
 *   * the events are typed and validated, so nothing here reparses stored JSON
 *     or casts through `unknown`;
 *   * it runs BEFORE the pruner, which is the only reason a complete record is
 *     possible at all.
 *
 * It OBSERVES and does not consume. `storeExecutionReports` in the same append
 * path removes its event from the batch, which is right for a report that is
 * not meant to be stored and would be wrong here: the fleet plugin reads usage
 * by polling `events.list`, so filtering the event out would silently zero its
 * numbers while this table filled up.
 */
export function recordSpendForInsertedEvents(
  db: DbConnection,
  sources: readonly SpendRollupObservationSource[],
): number {
  if (sources.length === 0) {
    return 0;
  }
  const observations: TokenUsageObservation[] = sources.map((source) => ({
    createdAt: source.createdAt,
    last: toBreakdown(source.event.tokenUsage.last),
    providerId: source.providerId,
    providerThreadId: source.event.providerThreadId,
    sequence: source.sequence,
    threadId: source.threadId,
    total: toBreakdown(source.event.tokenUsage.total),
    turnId: source.turnId,
  }));
  ensureSpendTables(db);
  return rollUpObservations(db, observations, null);
}

/**
 * Replay the usage events the pruner has not yet deleted.
 *
 * Runs the same fold as the live path over the same shape of input, which is
 * what makes their agreement a property rather than a coincidence, and is safe
 * to run repeatedly: the fold ignores anything at or below the cursor, so a
 * second run is a no-op and the order of backfill and live traffic does not
 * matter.
 *
 * A thread whose earliest surviving usage event is not its earliest surviving
 * event had usage pruned out from under it, and is marked incomplete rather
 * than topped up from the one cumulative `total` the pruner left behind. That
 * snapshot carries a single timestamp, so any per-day bucket derived from it is
 * invented; codex resets mean a final `total` is not the session's truth; and
 * mixing `total`-derived rows with `last`-derived deltas double counts the
 * moment the thread emits again.
 */
export function backfillSpend(db: DbConnection): SpendBackfillResult {
  ensureSpendTables(db);
  const threads = listSpendBackfillThreads(db);
  let usageEventsScanned = 0;
  let contributionsApplied = 0;
  let threadsHistoryComplete = 0;

  for (const thread of threads) {
    const historyComplete =
      thread.earliestUsageSequence <= thread.earliestSequence;
    if (historyComplete) {
      threadsHistoryComplete += 1;
    }
    const rows = listStoredTokenUsageEvents(db, { threadId: thread.threadId });
    const observations: TokenUsageObservation[] = [];
    for (const row of rows) {
      usageEventsScanned += 1;
      const parsed: unknown = JSON.parse(row.data);
      const record = (parsed ?? {}) as Record<string, unknown>;
      const usage = (record.tokenUsage ?? {}) as Record<string, unknown>;
      const announced = record.providerThreadId;
      observations.push({
        createdAt: row.createdAt,
        last: readStoredUsage(usage.last),
        providerId: thread.providerId,
        providerThreadId:
          row.providerThreadId ??
          (typeof announced === "string" ? announced : row.threadId),
        sequence: row.sequence,
        threadId: row.threadId,
        total: readStoredUsage(usage.total),
        turnId: row.turnId,
      });
    }
    contributionsApplied += rollUpObservations(
      db,
      observations,
      new Map([[thread.threadId, historyComplete]]),
    );
  }

  return {
    threadsScanned: threads.length,
    usageEventsScanned,
    contributionsApplied,
    threadsHistoryComplete,
    threadsHistoryPartial: threads.length - threadsHistoryComplete,
  };
}
