import { sql } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";

/**
 * Fork (albrand/bb): the spend ledger.
 *
 * `thread/tokenUsage/updated` is a prunable event type. The pruner keeps at
 * most two of them per thread below its cutoff — the latest root one and the
 * latest carrying a model context window — so the event store is a window onto
 * recent usage, not a record of it. Measured on a live database: 8,363
 * `client/turn/requested` events against 1,291 surviving usage events, and 350
 * of the 567 threads that still had any were down to a single one.
 *
 * Anything outside the server that wants spend has to poll, and polling races
 * the pruner: a thread that emits a thousand events between two reads has had
 * its usage history deleted before the second one. The server is the only place
 * that sees a usage event before it is pruned, which is why this table exists
 * here rather than in the plugin that draws the panels.
 *
 * Deliberately not a drizzle migration. bb validates its applied-migration
 * history, so a fork-numbered migration collides with upstream's next one and
 * can stop the official app from starting after a rollback. A table created
 * here is invisible to that history and an official build ignores it.
 */
const DAILY_TABLE = "fork_thread_spend_daily";
const CURSOR_TABLE = "fork_thread_spend_cursor";
const PRICES_TABLE = "fork_spend_prices";

export interface SpendUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface SpendCursorState {
  lastSequence: number;
  lastTotalTokens: number;
  firstSequence: number;
  lastTurnId: string | null;
  lastModel: string | null;
}

export interface TokenUsageObservation {
  createdAt: number;
  last: SpendUsageBreakdown;
  providerId: string;
  providerThreadId: string;
  sequence: number;
  threadId: string;
  total: SpendUsageBreakdown;
  turnId: string | null;
}

export interface SpendContribution {
  day: string;
  model: string;
  providerId: string;
  threadId: string;
  usage: SpendUsageBreakdown;
  weightedUnits: number;
  at: number;
}

export interface SpendRollupRow {
  day: string;
  threadId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  weightedUnits: number;
  turns: number;
  firstEventAt: number;
  lastEventAt: number;
}

export interface SpendCoverage {
  threads: number;
  historyComplete: number;
  historyPartial: number;
}

const ZERO_USAGE: SpendUsageBreakdown = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

/**
 * Published price ratios, normalised so fresh input is 1.
 *
 * These are RATIOS, not money. Both providers in use here are on flat
 * subscriptions, so a dollar figure derived from them would be invented. What
 * they buy is comparability: 34M tokens that are 99% cache reads and 34M tokens
 * that are all fresh input are the same number and wildly different burn, and
 * only the weighted view separates them. Dollars, if they are ever wanted, come
 * from `fork_spend_prices` at query time and stay absent until it is populated.
 */
export const SPEND_WEIGHTS = {
  input: 1,
  cachedInput: 0.1,
  output: 5,
} as const;

export function spendWeightedUnits(usage: SpendUsageBreakdown): number {
  return (
    usage.inputTokens * SPEND_WEIGHTS.input +
    usage.cachedInputTokens * SPEND_WEIGHTS.cachedInput +
    usage.outputTokens * SPEND_WEIGHTS.output
  );
}

/**
 * Providers disagree about whether cached input is part of the input count or
 * beside it, and reading one convention as the other doubles a bill.
 *
 * Anthropic reports them disjointly — `inputTokens` is fresh only, cache reads
 * arrive separately, and `total = input + cached + output`. OpenAI/codex reports
 * `inputTokens` as the whole prompt with `cachedInputTokens` as the subset of it
 * served from cache, so `total = input + output`. Verified on live rows of each:
 * a claude-code turn at 8,295 + 2,065,773 + 11,062 = 2,085,130, and a codex turn
 * at 19,164,271 + 37,264 = 19,201,535.
 *
 * This table's contract is DISJOINT — `input_tokens` means fresh input and
 * nothing else — so the codex convention is normalised to it here, at the one
 * place a row is built. `totalTokens` is left as the provider reported it: it is
 * the arbiter that decides which convention a row is in, so adjusting it would
 * destroy the evidence.
 *
 * Which convention fits is decided by comparing the two residuals against that
 * total rather than by a tolerance. A tolerance reads correctly for a large
 * cached prefix and silently fails for a small one — a normalised row whose
 * cached part is under the tolerance still satisfies the inclusive test, so a
 * second pass subtracts the prefix again. Comparing residuals has no constant to
 * get wrong and is idempotent by construction: once a row is normalised it
 * satisfies the disjoint identity exactly and can never match again.
 */
export function normalizeSpendUsage(
  usage: SpendUsageBreakdown,
  providerId: string,
): SpendUsageBreakdown {
  if (providerId !== "codex") {
    return usage;
  }
  if (usage.cachedInputTokens <= 0) {
    return usage;
  }
  const asInclusive = Math.abs(
    usage.totalTokens - usage.inputTokens - usage.outputTokens,
  );
  const asDisjoint = Math.abs(
    usage.totalTokens -
      usage.inputTokens -
      usage.cachedInputTokens -
      usage.outputTokens,
  );
  if (asInclusive >= asDisjoint) {
    return usage;
  }
  return {
    ...usage,
    inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
  };
}

/**
 * The calendar day an event belongs to, on the machine running the server.
 *
 * Local rather than UTC because the person reading "today" reads it in their own
 * timezone, and a UTC key files late-evening work under tomorrow. The cost is
 * that a row cannot be re-bucketed into another timezone exactly — for that the
 * consumer needs `first_event_at`/`last_event_at`, which bound the row's real
 * time span and say whether it straddles a boundary at all.
 */
export function spendLocalDay(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function emptySpendCursorState(sequence: number): SpendCursorState {
  return {
    lastSequence: 0,
    lastTotalTokens: 0,
    firstSequence: sequence,
    lastTurnId: null,
    lastModel: null,
  };
}

/**
 * Fold one usage observation into a cursor, returning what it contributes.
 *
 * The live append path and the backfill both call this and nothing else does
 * the arithmetic, which is what makes "the backfill agrees with the live path"
 * a property rather than a coincidence.
 *
 * Three rules, each of which is a trap that has cost real accuracy:
 *
 *   * An event at or below the cursor's sequence contributes nothing. That is
 *     what makes a backfill idempotent, and what makes backfill-then-live and
 *     live-then-backfill produce the same table.
 *   * A re-emission contributes nothing. Codex repeats a usage event whose
 *     running total has not advanced — 509 of 6,342 in one measured session,
 *     +8.7% if counted. The comparison is against the LAST TOTAL RECORDED FOR
 *     THIS PROVIDER CONVERSATION, persisted in the cursor, so it holds across
 *     page boundaries, across daemon batches and across a server restart.
 *   * A total that moves BACKWARDS is a process restart, not a repeat. Codex's
 *     running total restarts at zero when its app-server process does — eight
 *     times in one session — so the guard is equality and never `<=`. Written as
 *     `<=` it would swallow every turn after a reset. The lower value simply
 *     becomes the new baseline, and the turn counts, because `last` is a
 *     per-turn delta and stays correct across the reset. Summing `last` rather
 *     than reading `total` is the whole reason resets are survivable.
 */
export function foldTokenUsageObservation(
  state: SpendCursorState,
  observation: TokenUsageObservation,
  model: string,
): { next: SpendCursorState; contribution: SpendContribution | null } {
  if (observation.sequence <= state.lastSequence) {
    return { next: state, contribution: null };
  }

  const total = normalizeSpendUsage(observation.total, observation.providerId);
  const last = normalizeSpendUsage(observation.last, observation.providerId);

  const advanced: SpendCursorState = {
    lastSequence: observation.sequence,
    lastTotalTokens:
      total.totalTokens > 0 ? total.totalTokens : state.lastTotalTokens,
    firstSequence:
      state.firstSequence === 0
        ? observation.sequence
        : Math.min(state.firstSequence, observation.sequence),
    lastTurnId: observation.turnId,
    lastModel: model,
  };

  const isRepeat =
    total.totalTokens > 0 && total.totalTokens === state.lastTotalTokens;
  if (isRepeat || last.totalTokens <= 0) {
    return { next: advanced, contribution: null };
  }

  return {
    next: advanced,
    contribution: {
      day: spendLocalDay(observation.createdAt),
      model,
      providerId: observation.providerId,
      threadId: observation.threadId,
      usage: last,
      weightedUnits: spendWeightedUnits(last),
      at: observation.createdAt,
    },
  };
}

const spendTablesReady = new WeakSet<object>();

export function ensureSpendTables(db: DbConnection): void {
  if (spendTablesReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${DAILY_TABLE} (
      day TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      weighted_units REAL NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      first_event_at INTEGER NOT NULL,
      last_event_at INTEGER NOT NULL,
      PRIMARY KEY (day, thread_id, provider_id, model)
    )
  `);
  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS fork_thread_spend_daily_day_idx
      ON ${DAILY_TABLE} (day)
  `);
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      last_total_tokens INTEGER NOT NULL,
      first_sequence INTEGER NOT NULL,
      history_complete INTEGER NOT NULL DEFAULT 0,
      last_turn_id TEXT,
      last_model TEXT,
      PRIMARY KEY (thread_id, provider_thread_id)
    )
  `);
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${PRICES_TABLE} (
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_usd_per_mtok REAL NOT NULL,
      cached_input_usd_per_mtok REAL NOT NULL,
      output_usd_per_mtok REAL NOT NULL,
      PRIMARY KEY (provider_id, model)
    )
  `);
  spendTablesReady.add(db.$client);
}

export function getSpendCursor(
  db: DbQueryConnection,
  args: { threadId: string; providerThreadId: string },
): SpendCursorState | null {
  const row = db.get<{
    lastSequence: number;
    lastTotalTokens: number;
    firstSequence: number;
    lastTurnId: string | null;
    lastModel: string | null;
  }>(
    sql`SELECT last_sequence AS lastSequence,
               last_total_tokens AS lastTotalTokens,
               first_sequence AS firstSequence,
               last_turn_id AS lastTurnId,
               last_model AS lastModel
        FROM ${sql.raw(CURSOR_TABLE)}
        WHERE thread_id = ${args.threadId}
          AND provider_thread_id = ${args.providerThreadId}`,
  );
  return row ?? null;
}

export function saveSpendCursor(
  db: DbQueryConnection,
  args: {
    threadId: string;
    providerThreadId: string;
    state: SpendCursorState;
    historyComplete?: boolean;
  },
): void {
  const historyComplete = args.historyComplete === true ? 1 : 0;
  db.run(
    sql`INSERT INTO ${sql.raw(CURSOR_TABLE)} (thread_id, provider_thread_id,
          last_sequence, last_total_tokens, first_sequence, history_complete,
          last_turn_id, last_model)
        VALUES (${args.threadId}, ${args.providerThreadId},
          ${args.state.lastSequence}, ${args.state.lastTotalTokens},
          ${args.state.firstSequence}, ${historyComplete},
          ${args.state.lastTurnId}, ${args.state.lastModel})
        ON CONFLICT (thread_id, provider_thread_id) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          last_total_tokens = excluded.last_total_tokens,
          first_sequence = MIN(${sql.raw(CURSOR_TABLE)}.first_sequence,
            excluded.first_sequence),
          history_complete = excluded.history_complete,
          last_turn_id = excluded.last_turn_id,
          last_model = excluded.last_model`,
  );
}

export function applySpendContribution(
  db: DbQueryConnection,
  contribution: SpendContribution,
): void {
  db.run(
    sql`INSERT INTO ${sql.raw(DAILY_TABLE)} (day, thread_id, provider_id, model,
          input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, total_tokens, weighted_units, turns,
          first_event_at, last_event_at)
        VALUES (${contribution.day}, ${contribution.threadId},
          ${contribution.providerId}, ${contribution.model},
          ${contribution.usage.inputTokens},
          ${contribution.usage.cachedInputTokens},
          ${contribution.usage.outputTokens},
          ${contribution.usage.reasoningOutputTokens},
          ${contribution.usage.totalTokens},
          ${contribution.weightedUnits}, 1,
          ${contribution.at}, ${contribution.at})
        ON CONFLICT (day, thread_id, provider_id, model) DO UPDATE SET
          input_tokens = input_tokens + excluded.input_tokens,
          cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          reasoning_output_tokens =
            reasoning_output_tokens + excluded.reasoning_output_tokens,
          total_tokens = total_tokens + excluded.total_tokens,
          weighted_units = weighted_units + excluded.weighted_units,
          turns = turns + 1,
          first_event_at = MIN(first_event_at, excluded.first_event_at),
          last_event_at = MAX(last_event_at, excluded.last_event_at)`,
  );
}

export type SpendGroupBy = "day" | "thread" | "provider" | "model";

export interface ListSpendRollupArgs {
  from?: string;
  to?: string;
  threadId?: string;
  providerId?: string;
}

export function listSpendRollupRows(
  db: DbQueryConnection,
  args: ListSpendRollupArgs,
): SpendRollupRow[] {
  const conditions = [sql`1 = 1`];
  if (args.from !== undefined) {
    conditions.push(sql` AND day >= ${args.from}`);
  }
  if (args.to !== undefined) {
    conditions.push(sql` AND day <= ${args.to}`);
  }
  if (args.threadId !== undefined) {
    conditions.push(sql` AND thread_id = ${args.threadId}`);
  }
  if (args.providerId !== undefined) {
    conditions.push(sql` AND provider_id = ${args.providerId}`);
  }
  return db.all<SpendRollupRow>(
    sql`SELECT day, thread_id AS threadId, provider_id AS providerId, model,
               input_tokens AS inputTokens,
               cached_input_tokens AS cachedInputTokens,
               output_tokens AS outputTokens,
               reasoning_output_tokens AS reasoningOutputTokens,
               total_tokens AS totalTokens,
               weighted_units AS weightedUnits,
               turns,
               first_event_at AS firstEventAt,
               last_event_at AS lastEventAt
        FROM ${sql.raw(DAILY_TABLE)}
        WHERE ${sql.join(conditions, sql``)}
        ORDER BY day DESC, total_tokens DESC`,
  );
}

export function getSpendCoverage(db: DbQueryConnection): SpendCoverage {
  const row = db.get<{ threads: number; historyComplete: number }>(
    sql`SELECT COUNT(DISTINCT thread_id) AS threads,
               COUNT(DISTINCT CASE WHEN history_complete = 1 THEN thread_id END)
                 AS historyComplete
        FROM ${sql.raw(CURSOR_TABLE)}`,
  );
  const threads = row?.threads ?? 0;
  const historyComplete = row?.historyComplete ?? 0;
  return {
    threads,
    historyComplete,
    historyPartial: threads - historyComplete,
  };
}

export function countSpendCursors(db: DbQueryConnection): number {
  const row = db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM ${sql.raw(CURSOR_TABLE)}`,
  );
  return row?.n ?? 0;
}

export { ZERO_USAGE as ZERO_SPEND_USAGE };

/**
 * The model in force at a point in a thread's history.
 *
 * bb emits `client/turn/requested` once per turn, before the turn starts, for
 * every provider, and it carries the resolved execution settings. Reading the
 * latest one at or below the usage event's sequence attributes each turn to the
 * model actually in force, so a mid-thread model switch lands on the right side
 * of the change instead of flattening to one value for the thread.
 *
 * Called once per turn, not once per usage event: codex emits thousands of usage
 * events against a few hundred turns, and the cursor carries the answer between
 * them.
 */
export function resolveSpendModel(
  db: DbQueryConnection,
  args: { threadId: string; sequence: number },
): string | null {
  const row = db.get<{ model: string | null }>(
    sql`SELECT json_extract(data, '$.execution.model') AS model
        FROM events
        WHERE thread_id = ${args.threadId}
          AND type = 'client/turn/requested'
          AND sequence <= ${args.sequence}
        ORDER BY sequence DESC
        LIMIT 1`,
  );
  const model = row?.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

export interface StoredTokenUsageEventRow {
  createdAt: number;
  data: string;
  providerThreadId: string | null;
  sequence: number;
  threadId: string;
  turnId: string | null;
}

export function listStoredTokenUsageEvents(
  db: DbQueryConnection,
  args: { threadId: string },
): StoredTokenUsageEventRow[] {
  return db.all<StoredTokenUsageEventRow>(
    sql`SELECT thread_id AS threadId, provider_thread_id AS providerThreadId,
               turn_id AS turnId, sequence, created_at AS createdAt, data
        FROM events
        WHERE thread_id = ${args.threadId}
          AND type = 'thread/tokenUsage/updated'
        ORDER BY sequence`,
  );
}

export interface SpendBackfillThreadRow {
  threadId: string;
  providerId: string;
  earliestUsageSequence: number;
  earliestSequence: number;
}

/**
 * Threads with usage events still in the store, and how much of their history
 * the pruner left behind.
 *
 * `earliestUsageSequence > earliestSequence` means usage events were deleted out
 * from under this thread, so whatever the backfill records for it is a floor and
 * not a total. That is reported rather than papered over: a partial figure that
 * says it is partial is worth having, and the alternative — banking the one
 * surviving cumulative `total` — invents a per-day bucket from a single
 * timestamp and double counts at the seam the moment the thread emits again.
 */
export function listSpendBackfillThreads(
  db: DbQueryConnection,
): SpendBackfillThreadRow[] {
  return db.all<SpendBackfillThreadRow>(
    sql`SELECT usage.thread_id AS threadId,
               threads.provider_id AS providerId,
               MIN(usage.sequence) AS earliestUsageSequence,
               (SELECT MIN(any_event.sequence) FROM events any_event
                 WHERE any_event.thread_id = usage.thread_id) AS earliestSequence
        FROM events usage
        JOIN threads ON threads.id = usage.thread_id
        WHERE usage.type = 'thread/tokenUsage/updated'
        GROUP BY usage.thread_id, threads.provider_id
        ORDER BY usage.thread_id`,
  );
}
