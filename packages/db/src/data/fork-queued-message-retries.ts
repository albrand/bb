import type { DbConnection } from "../connection.js";

/**
 * Fork (albrand/bb): the retry budget a queued row has spent on failed dispatch
 * attempts, and when the next attempt is due.
 *
 * Deliberately neither a drizzle migration nor new columns on
 * `queued_thread_messages`. A migration would fork the snapshot chain, and the
 * row's existing `retry_*` columns already mean something else — they describe
 * a `retry` PAYLOAD (re-submitting a failed turn), which `toQueuedMessagePayload`
 * throws on if they are set without a `retry` payload kind. A table created here
 * is invisible to the migration history, an official build ignores it, and
 * dropping it loses nothing but an in-progress backoff.
 *
 * The state lives in the database rather than in a timer so a server restart
 * re-derives it: the row and its budget are one durable fact, and the sweep that
 * re-attempts them reads both from disk on every tick.
 */
const QUEUED_MESSAGE_RETRIES_TABLE = "fork_queued_message_dispatch_retries";

const retriesTableReady = new WeakSet<object>();

function ensureQueuedMessageRetriesTable(db: DbConnection): void {
  if (retriesTableReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${QUEUED_MESSAGE_RETRIES_TABLE} (
      queued_message_id TEXT PRIMARY KEY NOT NULL
        REFERENCES queued_thread_messages(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS ${QUEUED_MESSAGE_RETRIES_TABLE}_due_idx
      ON ${QUEUED_MESSAGE_RETRIES_TABLE} (next_attempt_at, queued_message_id)
  `);
  retriesTableReady.add(db.$client);
}

export interface QueuedMessageDispatchRetry {
  attempt: number;
  lastError: string;
  nextAttemptAt: number;
  queuedMessageId: string;
  threadId: string;
}

export interface QueuedMessageDispatchRetryRef {
  id: string;
  threadId: string;
}

export interface RecordQueuedMessageDispatchRetryArgs {
  attempt: number;
  lastError: string;
  nextAttemptAt: number;
  queuedMessageId: string;
  threadId: string;
}

/**
 * Books one failed attempt against a row's budget, returning false when the row
 * is not there to book it against.
 *
 * The insert is a SELECT gated on the same liveness the queue's own wait writes
 * use — the row exists, belongs to this thread, and no drain holds a claim on
 * it. Without that gate a row that dispatched (and was deleted) or that another
 * drain is dispatching right now would accumulate attempts it never made, and
 * the budget would run out on a message that was going fine.
 */
export function recordQueuedMessageDispatchRetry(
  db: DbConnection,
  args: RecordQueuedMessageDispatchRetryArgs,
): boolean {
  ensureQueuedMessageRetriesTable(db);
  const result = db.$client
    .prepare<[string, string, number, number, string, number, string, string]>(
      `
        INSERT INTO ${QUEUED_MESSAGE_RETRIES_TABLE} (queued_message_id,
          thread_id, attempt, next_attempt_at, last_error, updated_at)
        SELECT ?, ?, ?, ?, ?, ?
        FROM queued_thread_messages
        WHERE id = ? AND thread_id = ?
          AND claimed_at IS NULL AND claim_token IS NULL
        ON CONFLICT (queued_message_id) DO UPDATE SET
          attempt = excluded.attempt,
          next_attempt_at = excluded.next_attempt_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      args.queuedMessageId,
      args.threadId,
      args.attempt,
      args.nextAttemptAt,
      args.lastError,
      Date.now(),
      args.queuedMessageId,
      args.threadId,
    );
  return result.changes > 0;
}

export function getQueuedMessageDispatchRetry(
  db: DbConnection,
  queuedMessageId: string,
): QueuedMessageDispatchRetry | null {
  ensureQueuedMessageRetriesTable(db);
  const row = db.$client
    .prepare<[string], QueuedMessageDispatchRetry>(
      `
        SELECT queued_message_id AS queuedMessageId, thread_id AS threadId,
          attempt, next_attempt_at AS nextAttemptAt, last_error AS lastError
        FROM ${QUEUED_MESSAGE_RETRIES_TABLE}
        WHERE queued_message_id = ?
      `,
    )
    .get(queuedMessageId);
  return row ?? null;
}

/**
 * Forgets a row's budget. Called whenever the row gets a fresh, successful
 * statement of why it is waiting — a re-queue, a cleared wait, a host that went
 * away — because those supersede what the last attempt failed with, exactly as
 * they already supersede `failure_reason`.
 */
export function clearQueuedMessageDispatchRetry(
  db: DbConnection,
  queuedMessageId: string,
): void {
  ensureQueuedMessageRetriesTable(db);
  db.$client
    .prepare<[string]>(
      `DELETE FROM ${QUEUED_MESSAGE_RETRIES_TABLE} WHERE queued_message_id = ?`,
    )
    .run(queuedMessageId);
}

/**
 * The ids on this thread whose next attempt has not come round yet, as the
 * drain's group eligibility consults them.
 *
 * Scoped to one thread and read once per drain rather than once per row: the
 * table is empty in the overwhelming case, and a backoff that only the due
 * sweep honoured would be no backoff at all — the idle drain re-claims a
 * `thread-busy` row every sweep tick without ever looking at a clock.
 */
export function listDeferredQueuedMessageDispatchRetryIds(
  db: DbConnection,
  args: { now: number; threadId: string },
): Set<string> {
  ensureQueuedMessageRetriesTable(db);
  const rows = db.$client
    .prepare<[string, number], { queuedMessageId: string }>(
      `
        SELECT queued_message_id AS queuedMessageId
        FROM ${QUEUED_MESSAGE_RETRIES_TABLE}
        WHERE thread_id = ? AND next_attempt_at > ?
      `,
    )
    .all(args.threadId, args.now);
  return new Set(rows.map((row) => row.queuedMessageId));
}

/**
 * Rows whose next attempt is due, oldest first.
 *
 * The queue join is what makes a deleted or claimed row invisible here, and the
 * thread predicates are the same ones the due-scheduled sweep applies: a
 * message into a thread the user archived or threw away, or onto an environment
 * that is never coming back, must not wake the sweep every cycle.
 */
export function listDueQueuedMessageDispatchRetries(
  db: DbConnection,
  now: number,
): QueuedMessageDispatchRetryRef[] {
  ensureQueuedMessageRetriesTable(db);
  return db.$client
    .prepare<[number], QueuedMessageDispatchRetryRef>(
      `
        SELECT retries.queued_message_id AS id, retries.thread_id AS threadId
        FROM ${QUEUED_MESSAGE_RETRIES_TABLE} AS retries
        JOIN queued_thread_messages AS retry_rows
          ON retry_rows.id = retries.queued_message_id
        JOIN threads ON threads.id = retry_rows.thread_id
        LEFT JOIN environments ON environments.id = threads.environment_id
        WHERE retries.next_attempt_at <= ?
          AND retry_rows.claimed_at IS NULL AND retry_rows.claim_token IS NULL
          AND retry_rows.failure_reason IS NULL
          AND threads.archived_at IS NULL AND threads.deleted_at IS NULL
          AND (threads.environment_id IS NULL
            OR environments.status NOT IN ('destroying', 'destroyed'))
        ORDER BY retries.next_attempt_at ASC, retries.queued_message_id ASC
      `,
    )
    .all(now);
}
