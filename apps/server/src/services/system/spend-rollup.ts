import {
  applySpendContribution,
  emptySpendCursorState,
  ensureSpendTables,
  foldTokenUsageObservation,
  getSpendCoverage,
  getSpendCursor,
  getSpendThreadLatestSequence,
  hasStoredTokenUsageEvents,
  hasThreadRewind,
  listCompletedTurnsByThreadIds,
  listSpendBackfillThreads,
  listSpendRollupRows,
  SPEND_PRUNE_SAFE_SEQUENCE,
  listStoredTokenUsageEvents,
  listThreadTurnSpend,
  recordThreadTurnSpendContribution,
  resolveSpendModel,
  saveSpendCursor,
  type SpendContribution,
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
  historyComplete: boolean | undefined;
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

function mergeContributions(
  contributions: readonly SpendContribution[],
): { contribution: SpendContribution; turns: number }[] {
  const merged = new Map<
    string,
    { contribution: SpendContribution; turns: number }
  >();
  for (const contribution of contributions) {
    const key = [
      contribution.day,
      contribution.threadId,
      contribution.providerId,
      contribution.model,
    ].join("|");
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        contribution: { ...contribution, usage: { ...contribution.usage } },
        turns: 1,
      });
      continue;
    }
    const usage = existing.contribution.usage;
    usage.inputTokens += contribution.usage.inputTokens;
    usage.cachedInputTokens += contribution.usage.cachedInputTokens;
    usage.outputTokens += contribution.usage.outputTokens;
    usage.reasoningOutputTokens += contribution.usage.reasoningOutputTokens;
    usage.totalTokens += contribution.usage.totalTokens;
    existing.contribution.weightedUnits += contribution.weightedUnits;
    existing.contribution.at = Math.max(
      existing.contribution.at,
      contribution.at,
    );
    existing.turns += 1;
  }
  return [...merged.values()];
}

function resolveHistoryComplete(
  db: DbQueryConnection,
  args: { threadId: string },
): boolean {
  if (hasThreadRewind(db, { threadId: args.threadId })) {
    return false;
  }
  const latestSequence = getSpendThreadLatestSequence(db, {
    threadId: args.threadId,
  });
  return latestSequence !== null && latestSequence <= SPEND_PRUNE_SAFE_SEQUENCE;
}

function rollUpObservations(
  db: DbConnection,
  observations: readonly TokenUsageObservation[],
): number {
  const tracked = new Map<string, TrackedCursorEntry>();
  const contributions: SpendContribution[] = [];

  for (const observation of observations) {
    const key = cursorKey(observation.threadId, observation.providerThreadId);
    let entry = tracked.get(key);
    if (entry === undefined) {
      const stored = getSpendCursor(db, {
        threadId: observation.threadId,
        providerThreadId: observation.providerThreadId,
      });
      const historyComplete =
        stored === null
          ? resolveHistoryComplete(db, { threadId: observation.threadId })
          : undefined;
      entry = {
        historyComplete,
        providerThreadId: observation.providerThreadId,
        threadId: observation.threadId,
        state: stored ?? emptySpendCursorState(observation.sequence),
      };
    }
    const model = modelForObservation(db, entry.state, observation);
    const { next, contribution } = foldTokenUsageObservation(
      entry.state,
      observation,
      model,
    );
    entry.state = next;
    tracked.set(key, entry);
    if (contribution !== null) {
      contributions.push(contribution);
      if (observation.turnId !== null) {
        recordThreadTurnSpendContribution(db, {
          at: observation.createdAt,
          providerThreadId: observation.providerThreadId,
          threadId: observation.threadId,
          turnId: observation.turnId,
          usage: {
            cachedInputTokens:
              observation.turnSpendUsage?.cachedInputTokens ?? null,
            inputTokens: contribution.usage.inputTokens,
            outputTokens: contribution.usage.outputTokens,
            reasoningOutputTokens:
              observation.turnSpendUsage?.reasoningOutputTokens ?? null,
            totalTokens: contribution.usage.totalTokens,
          },
        });
      }
    }
  }

  for (const merged of mergeContributions(contributions)) {
    applySpendContribution(db, merged.contribution, merged.turns);
  }

  for (const entry of tracked.values()) {
    saveSpendCursor(db, {
      threadId: entry.threadId,
      providerThreadId: entry.providerThreadId,
      state: entry.state,
      historyComplete: entry.historyComplete,
    });
  }

  return contributions.length;
}

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
    turnSpendUsage: {
      cachedInputTokens:
        source.event.tokenUsage.last.cacheReadInputTokens !== undefined ||
        source.event.tokenUsage.last.cacheWriteInputTokens !== undefined ||
        source.event.tokenUsage.last.cachedInputTokens > 0
          ? source.event.tokenUsage.last.cachedInputTokens
          : null,
      reasoningOutputTokens:
        source.event.tokenUsage.last.reasoningOutputTokens > 0
          ? source.event.tokenUsage.last.reasoningOutputTokens
          : null,
    },
  }));
  ensureSpendTables(db);
  return rollUpObservations(db, observations);
}

const TURN_SPEND_REPAIR_TABLE = "fork_thread_turn_spend_repair";
const THREAD_SPEND_REPAIR_TABLE = "fork_thread_spend_rollup_repair";

function repairThreadTurnSpendFromStoredEventsInTransaction(
  db: DbConnection,
  args: { providerId: string; threadId: string },
): void {
  const completedTurnIds = new Set(
    listCompletedTurnsByThreadIds(db, [args.threadId]).map((row) => row.turnId),
  );
  const repairedTurnIds = new Set(
    db.$client
      .prepare<[string], { turnId: string }>(
        `SELECT turn_id AS turnId FROM ${TURN_SPEND_REPAIR_TABLE} WHERE thread_id = ?`,
      )
      .all(args.threadId)
      .map((row) => row.turnId),
  );
  const existingTurnIds = new Set(
    listThreadTurnSpend(db, { threadId: args.threadId }).map(
      (row) => row.turnId,
    ),
  );
  const turnsToRepair = new Set(
    [...completedTurnIds].filter(
      (turnId) =>
        !existingTurnIds.has(turnId) && !repairedTurnIds.has(turnId),
    ),
  );
  const dailyRepairRecorded = db.$client
    .prepare<[string], { threadId: string }>(
      `SELECT thread_id AS threadId FROM ${THREAD_SPEND_REPAIR_TABLE} WHERE thread_id = ?`,
    )
    .get(args.threadId);
  const repairDailyRollup =
    dailyRepairRecorded === undefined &&
    listSpendRollupRows(db, { threadId: args.threadId }).length === 0 &&
    hasStoredTokenUsageEvents(db, { threadId: args.threadId }) &&
    resolveHistoryComplete(db, { threadId: args.threadId });
  if (turnsToRepair.size === 0 && !repairDailyRollup) return;
  const states = new Map<string, SpendCursorState>();
  const dailyContributions: SpendContribution[] = [];
  for (const row of listStoredTokenUsageEvents(db, { threadId: args.threadId })) {
    const record = JSON.parse(row.data) as Record<string, unknown>;
    const usage = (record.tokenUsage ?? {}) as Record<string, unknown>;
    const providerThreadId =
      row.providerThreadId ??
      (typeof record.providerThreadId === "string"
        ? record.providerThreadId
        : row.threadId);
    const state =
      states.get(providerThreadId) ?? emptySpendCursorState(row.sequence);
    const last = readStoredUsage(usage.last);
    const total = readStoredUsage(usage.total);
    const storedLast = (usage.last ?? {}) as Record<string, unknown>;
    const observation: TokenUsageObservation = {
      createdAt: row.createdAt,
      last,
      providerId: args.providerId,
      providerThreadId,
      sequence: row.sequence,
      threadId: row.threadId,
      total,
      turnId: row.turnId,
      turnSpendUsage: {
        cachedInputTokens:
          storedLast.cacheReadInputTokens !== undefined ||
          storedLast.cacheWriteInputTokens !== undefined ||
          last.cachedInputTokens > 0
            ? last.cachedInputTokens
            : null,
        reasoningOutputTokens:
          last.reasoningOutputTokens > 0 ? last.reasoningOutputTokens : null,
      },
    };
    const model = modelForObservation(db, state, observation);
    const folded = foldTokenUsageObservation(state, observation, model);
    states.set(providerThreadId, folded.next);
    if (folded.contribution !== null && repairDailyRollup) {
      dailyContributions.push(folded.contribution);
    }
    if (
      folded.contribution !== null &&
      row.turnId !== null &&
      turnsToRepair.has(row.turnId)
    ) {
      recordThreadTurnSpendContribution(db, {
        at: row.createdAt,
        providerThreadId,
        threadId: row.threadId,
        turnId: row.turnId,
        usage: {
          cachedInputTokens:
            observation.turnSpendUsage?.cachedInputTokens ?? null,
          inputTokens: folded.contribution.usage.inputTokens,
          outputTokens: folded.contribution.usage.outputTokens,
          reasoningOutputTokens:
            observation.turnSpendUsage?.reasoningOutputTokens ?? null,
          totalTokens: folded.contribution.usage.totalTokens,
        },
      });
    }
  }
  for (const merged of mergeContributions(dailyContributions)) {
    applySpendContribution(db, merged.contribution, merged.turns);
  }
  const markRepaired = db.$client.prepare<[string, string, number]>(
    `INSERT OR IGNORE INTO ${TURN_SPEND_REPAIR_TABLE} (thread_id, turn_id, repaired_at) VALUES (?, ?, ?)`,
  );
  for (const turnId of turnsToRepair) {
    markRepaired.run(args.threadId, turnId, Date.now());
  }
  if (repairDailyRollup) {
    db.$client
      .prepare<[string, number]>(
        `INSERT OR IGNORE INTO ${THREAD_SPEND_REPAIR_TABLE} (thread_id, repaired_at) VALUES (?, ?)`,
      )
      .run(args.threadId, Date.now());
  }
}

export function repairThreadTurnSpendFromStoredEvents(
  db: DbConnection,
  args: {
    completedTurnIds: ReadonlySet<string>;
    providerId: string;
    threadId: string;
  },
): void {
  const { completedTurnIds } = args;
  const repairedTurnIds = new Set(
    db.$client
      .prepare<[string], { turnId: string }>(
        `SELECT turn_id AS turnId FROM ${TURN_SPEND_REPAIR_TABLE} WHERE thread_id = ?`,
      )
      .all(args.threadId)
      .map((row) => row.turnId),
  );
  const existingTurnIds = new Set(
    listThreadTurnSpend(db, { threadId: args.threadId }).map(
      (row) => row.turnId,
    ),
  );
  const needsRepair = [...completedTurnIds].some(
    (turnId) => !existingTurnIds.has(turnId) && !repairedTurnIds.has(turnId),
  );
  const dailyRepairRecorded = db.$client
    .prepare<[string], { threadId: string }>(
      `SELECT thread_id AS threadId FROM ${THREAD_SPEND_REPAIR_TABLE} WHERE thread_id = ?`,
    )
    .get(args.threadId);
  const needsDailyRepair =
    dailyRepairRecorded === undefined &&
    listSpendRollupRows(db, { threadId: args.threadId }).length === 0 &&
    hasStoredTokenUsageEvents(db, { threadId: args.threadId }) &&
    resolveHistoryComplete(db, { threadId: args.threadId });
  if (!needsRepair && !needsDailyRepair) return;
  db.$client.transaction(() =>
    repairThreadTurnSpendFromStoredEventsInTransaction(db, args),
  )();
}

export function backfillSpend(db: DbConnection): SpendBackfillResult {
  ensureSpendTables(db);
  const threads = listSpendBackfillThreads(db);
  let usageEventsScanned = 0;
  let contributionsApplied = 0;

  for (const thread of threads) {
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
    contributionsApplied += rollUpObservations(db, observations);
  }

  const coverage = getSpendCoverage(db);

  return {
    threadsScanned: threads.length,
    usageEventsScanned,
    contributionsApplied,
    threadsHistoryComplete: coverage.historyComplete,
    threadsHistoryPartial: coverage.historyPartial,
  };
}
