import type { DbConnection } from "../connection.js";

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
