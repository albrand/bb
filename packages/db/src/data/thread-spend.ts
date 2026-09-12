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
const ASSESSMENTS_TABLE = "fork_spend_assessments";

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
  /** Null unless `fork_spend_prices` holds a rate for this provider+model. */
  costUsd: number | null;
}

export interface SpendCoverage {
  threads: number;
  /** Threads counted from their first turn, so their totals are exact. */
  historyComplete: number;
  /**
   * Threads whose usage events bb had already deleted before the rollup
   * existed. Their totals are lower bounds, not shortfalls: deletion leaves no
   * trace, so there is no missing amount to report, only a floor.
   */
  historyPartial: number;
  /** True when any thread in the window contributes a floor rather than a total. */
  totalsAreLowerBound: boolean;
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

/**
 * The pruner's smallest keep-recent window.
 *
 * It prunes with `sequenceCutoff = latestSequence - keepRecent` and does
 * nothing when that is not positive, so a thread whose latest sequence is at or
 * below the smallest window (archived threads, 120) provably cannot have had a
 * usage event deleted. Anything above it might have.
 */
export const SPEND_PRUNE_SAFE_SEQUENCE = 120;

/**
 * Whether a thread has been rewound by an edited message.
 *
 * The pruner is not the only thing that deletes usage events.
 * `deleteThreadEventSuffixInTransaction` removes every event in
 * [cutoffSequence, oldMaxSequence] when an earlier message is edited, usage
 * events with them, and a thread can be rewound while still far short of the
 * pruner's window - so the prune-safe proof would call it complete while its
 * recorded total was missing whatever the rewind took.
 *
 * The rewind leaves evidence that survives its own deletion: a
 * `system/operation` event with `operation: "edit_message"`, appended BEFORE
 * the range below it is removed and at a sequence above that range, because
 * sequences are allocated as max-per-thread. Seeing one is enough to refuse the
 * certainty; it is not enough to say how much was lost, which is exactly what
 * "partial" means.
 *
 * A thread whose cursor already exists is unaffected: those tokens were spent
 * and the rollup counted them as they arrived, so a later rewind does not make
 * the recorded total wrong.
 */
export function hasThreadRewind(
  db: DbQueryConnection,
  args: { threadId: string },
): boolean {
  const row = db.get<{ found: number }>(
    sql`SELECT 1 AS found FROM events
        WHERE thread_id = ${args.threadId}
          AND type = 'system/operation'
          AND json_extract(data, '$.operation') = 'edit_message'
        LIMIT 1`,
  );
  return row?.found === 1;
}

/**
 * The thread's latest sequence, which is what decides whether the pruner can
 * have taken a usage event from it.
 *
 * There is no way to see a deleted row, so completeness is inferred from the
 * pruner's own rule rather than asserted, and only one inference is sound: a
 * usage event at sequence `s` can only be deleted by a prune whose cutoff
 * reached it, which needs the thread's latest sequence to have been at least
 * `s + keepRecent`. Sequences only grow, so `latestSequence <= 120` proves no
 * usage event has ever been deleted from this thread.
 *
 * An earlier version also accepted "the rollup just stored the earliest
 * surviving usage event", which is not the same claim once the pruner has run
 * and is unsound exactly where it is the only thing firing. Ruling out the
 * deletion of an event at sequence 1 requires `latestSequence < 121` anyway, so
 * it collapsed into the rule above and only ever added false certainty.
 * Measured on a live database: all 14 threads the pruner had never run on had
 * their first usage event at sequence <= 120, so the sound rule already covers
 * every thread the unsound one would have.
 */
export function getSpendThreadLatestSequence(
  db: DbQueryConnection,
  args: { threadId: string },
): number | null {
  const row = db.get<{ latestSequence: number | null }>(
    sql`SELECT MAX(sequence) AS latestSequence FROM events
        WHERE thread_id = ${args.threadId}`,
  );
  return row?.latestSequence ?? null;
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
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${ASSESSMENTS_TABLE} (
      topic TEXT PRIMARY KEY NOT NULL,
      requested_at INTEGER NOT NULL,
      window_from TEXT NOT NULL,
      window_to TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      response TEXT NOT NULL,
      host TEXT NOT NULL,
      thread_id TEXT NOT NULL
    )
  `);
  spendTablesReady.add(db.$client);
}

export interface SpendAssessmentRow {
  topic: string;
  requestedAt: number;
  windowFrom: string;
  windowTo: string;
  payloadSha256: string;
  response: string;
  host: string;
  threadId: string;
}

/**
 * The answer to one analysis request, keyed by topic so a follow-up round
 * replaces the round it follows rather than accumulating.
 *
 * `payload_sha256` is the digest of exactly what was sent, so an assessment can
 * be checked against the numbers it was given rather than the numbers now.
 */
export function recordSpendAssessment(
  db: DbQueryConnection,
  row: SpendAssessmentRow,
): void {
  db.run(
    sql`INSERT INTO ${sql.raw(ASSESSMENTS_TABLE)} (topic, requested_at,
          window_from, window_to, payload_sha256, response, host, thread_id)
        VALUES (${row.topic}, ${row.requestedAt}, ${row.windowFrom},
          ${row.windowTo}, ${row.payloadSha256}, ${row.response}, ${row.host},
          ${row.threadId})
        ON CONFLICT (topic) DO UPDATE SET
          requested_at = excluded.requested_at,
          window_from = excluded.window_from,
          window_to = excluded.window_to,
          payload_sha256 = excluded.payload_sha256,
          response = excluded.response,
          host = excluded.host,
          thread_id = excluded.thread_id`,
  );
}

export function listSpendAssessments(
  db: DbQueryConnection,
  args: { topic?: string },
): SpendAssessmentRow[] {
  const filter =
    args.topic === undefined ? sql`` : sql` AND topic = ${args.topic}`;
  return db.all<SpendAssessmentRow>(
    sql`SELECT topic, requested_at AS requestedAt, window_from AS windowFrom,
               window_to AS windowTo, payload_sha256 AS payloadSha256,
               response, host, thread_id AS threadId
        FROM ${sql.raw(ASSESSMENTS_TABLE)}
        WHERE 1 = 1${filter}
        ORDER BY requested_at DESC`,
  );
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

/**
 * `historyComplete` is three-valued on purpose: true, false, or not known now.
 *
 * Every live append saves a cursor, and most of them have no opinion about
 * whether the thread's early history survived - that is settled once, when the
 * cursor row is created. Writing `0` for "no opinion" reset every thread the
 * backfill had marked complete on its very next usage event, so coverage
 * converged on "every thread is partial" and both `bb spend` and the Hermes
 * payload reported it. An unknown is COALESCEd away instead.
 */
export function saveSpendCursor(
  db: DbQueryConnection,
  args: {
    threadId: string;
    providerThreadId: string;
    state: SpendCursorState;
    historyComplete?: boolean | undefined;
  },
): void {
  const historyComplete =
    args.historyComplete === undefined ? null : args.historyComplete ? 1 : 0;
  db.run(
    sql`INSERT INTO ${sql.raw(CURSOR_TABLE)} (thread_id, provider_thread_id,
          last_sequence, last_total_tokens, first_sequence, history_complete,
          last_turn_id, last_model)
        VALUES (${args.threadId}, ${args.providerThreadId},
          ${args.state.lastSequence}, ${args.state.lastTotalTokens},
          ${args.state.firstSequence}, COALESCE(${historyComplete}, 0),
          ${args.state.lastTurnId}, ${args.state.lastModel})
        ON CONFLICT (thread_id, provider_thread_id) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          last_total_tokens = excluded.last_total_tokens,
          first_sequence = MIN(${sql.raw(CURSOR_TABLE)}.first_sequence,
            excluded.first_sequence),
          history_complete = COALESCE(${historyComplete},
            ${sql.raw(CURSOR_TABLE)}.history_complete),
          last_turn_id = excluded.last_turn_id,
          last_model = excluded.last_model`,
  );
}

/**
 * Whether a thread's usage history survived intact, by the same rule the
 * backfill uses: its earliest surviving usage event is also its earliest
 * surviving event, so nothing was pruned out from under it.
 *
 * Asked once per thread, when its cursor row is created, not per event.
 */
export function isSpendHistoryComplete(
  db: DbQueryConnection,
  args: { threadId: string },
): boolean {
  const row = db.get<{
    earliestUsage: number | null;
    earliest: number | null;
  }>(
    sql`SELECT
          (SELECT MIN(sequence) FROM events
            WHERE thread_id = ${args.threadId}
              AND type = 'thread/tokenUsage/updated') AS earliestUsage,
          (SELECT MIN(sequence) FROM events
            WHERE thread_id = ${args.threadId}) AS earliest`,
  );
  if (row?.earliestUsage == null || row.earliest == null) {
    return false;
  }
  return row.earliestUsage <= row.earliest;
}

export function applySpendContribution(
  db: DbQueryConnection,
  contribution: SpendContribution,
  turns = 1,
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
          ${contribution.weightedUnits}, ${turns},
          ${contribution.at}, ${contribution.at})
        ON CONFLICT (day, thread_id, provider_id, model) DO UPDATE SET
          input_tokens = input_tokens + excluded.input_tokens,
          cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          reasoning_output_tokens =
            reasoning_output_tokens + excluded.reasoning_output_tokens,
          total_tokens = total_tokens + excluded.total_tokens,
          weighted_units = weighted_units + excluded.weighted_units,
          turns = turns + excluded.turns,
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

/**
 * Rows for a window, with dollars applied only where a price exists.
 *
 * `fork_spend_prices` ships empty, so `costUsd` is null everywhere until
 * somebody puts a rate in it. That is the point: both providers here are on
 * flat subscriptions, and a figure derived from a guessed rate reads as fact.
 * A null is visibly absent; a wrong number is not.
 */
export function listSpendRollupRows(
  db: DbQueryConnection,
  args: ListSpendRollupArgs,
): SpendRollupRow[] {
  const conditions = [sql`1 = 1`];
  if (args.from !== undefined) {
    conditions.push(sql` AND rollup.day >= ${args.from}`);
  }
  if (args.to !== undefined) {
    conditions.push(sql` AND rollup.day <= ${args.to}`);
  }
  if (args.threadId !== undefined) {
    conditions.push(sql` AND rollup.thread_id = ${args.threadId}`);
  }
  if (args.providerId !== undefined) {
    conditions.push(sql` AND rollup.provider_id = ${args.providerId}`);
  }
  return db.all<SpendRollupRow>(
    sql`SELECT rollup.day AS day,
               rollup.thread_id AS threadId,
               rollup.provider_id AS providerId,
               rollup.model AS model,
               rollup.input_tokens AS inputTokens,
               rollup.cached_input_tokens AS cachedInputTokens,
               rollup.output_tokens AS outputTokens,
               rollup.reasoning_output_tokens AS reasoningOutputTokens,
               rollup.total_tokens AS totalTokens,
               rollup.weighted_units AS weightedUnits,
               rollup.turns AS turns,
               rollup.first_event_at AS firstEventAt,
               rollup.last_event_at AS lastEventAt,
               CASE WHEN price.provider_id IS NULL THEN NULL ELSE
                 (rollup.input_tokens * price.input_usd_per_mtok
                  + rollup.cached_input_tokens * price.cached_input_usd_per_mtok
                  + rollup.output_tokens * price.output_usd_per_mtok) / 1000000.0
               END AS costUsd
        FROM ${sql.raw(DAILY_TABLE)} rollup
        LEFT JOIN ${sql.raw(PRICES_TABLE)} price
          ON price.provider_id = rollup.provider_id
          AND price.model = rollup.model
        WHERE ${sql.join(conditions, sql``)}
        ORDER BY rollup.day DESC, rollup.total_tokens DESC`,
  );
}

/**
 * Coverage for the same window the rows describe.
 *
 * Reported unscoped it described all history beside fourteen days of rows, and
 * the analysis payload carried that mismatch into its window header.
 *
 * A thread counts as complete only when EVERY provider conversation on it is.
 * Cursors are per conversation, so a thread resumed onto a second provider
 * session can hold one complete and one partial, and counting distinct complete
 * thread ids would have made the partial one disappear behind the complete one.
 */
export function getSpendCoverage(
  db: DbQueryConnection,
  args: { from?: string; to?: string } = {},
): SpendCoverage {
  const windowConditions = [sql`1 = 1`];
  if (args.from !== undefined) {
    windowConditions.push(sql` AND rollup.day >= ${args.from}`);
  }
  if (args.to !== undefined) {
    windowConditions.push(sql` AND rollup.day <= ${args.to}`);
  }
  const row = db.get<{ threads: number; historyComplete: number }>(
    sql`SELECT COUNT(DISTINCT cursor.thread_id) AS threads,
               COUNT(DISTINCT CASE WHEN NOT EXISTS (
                 SELECT 1 FROM ${sql.raw(CURSOR_TABLE)} partial
                 WHERE partial.thread_id = cursor.thread_id
                   AND partial.history_complete = 0
               ) THEN cursor.thread_id END) AS historyComplete
        FROM ${sql.raw(CURSOR_TABLE)} cursor
        WHERE EXISTS (
          SELECT 1 FROM ${sql.raw(DAILY_TABLE)} rollup
          WHERE rollup.thread_id = cursor.thread_id
            AND ${sql.join(windowConditions, sql``)}
        )`,
  );
  const threads = row?.threads ?? 0;
  const historyComplete = row?.historyComplete ?? 0;
  return {
    threads,
    historyComplete,
    historyPartial: threads - historyComplete,
    totalsAreLowerBound: threads - historyComplete > 0,
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
  latestSequence: number;
}

/**
 * Threads with usage events still in the store, and how far each has run.
 *
 * `latestSequence` is what decides whether a backfilled thread can be called
 * complete: below the pruner's smallest window it cannot have lost a usage
 * event, and above it there is no way to tell from here, so the thread is
 * reported as partial and its total read as a floor.
 */
export function listSpendBackfillThreads(
  db: DbQueryConnection,
): SpendBackfillThreadRow[] {
  return db.all<SpendBackfillThreadRow>(
    sql`SELECT usage.thread_id AS threadId,
               threads.provider_id AS providerId,
               (SELECT MAX(any_event.sequence) FROM events any_event
                 WHERE any_event.thread_id = usage.thread_id) AS latestSequence
        FROM events usage
        JOIN threads ON threads.id = usage.thread_id
        WHERE usage.type = 'thread/tokenUsage/updated'
        GROUP BY usage.thread_id, threads.provider_id
        ORDER BY usage.thread_id`,
  );
}
