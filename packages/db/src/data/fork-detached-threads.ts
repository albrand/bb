import type { DbConnection } from "../connection.js";

/**
 * Fork (albrand/bb): threads a daemon detached from on purpose.
 *
 * A graceful daemon exit leaves its provider workers running so the next
 * daemon can adopt them. Before exiting it names the threads it left
 * mid-turn, and the server holds off interrupting them for a while instead
 * of the usual 30 s, so a slow restart still finds them active. A row
 * expires on its own; a new daemon session for the host consumes them.
 *
 * Deliberately not a drizzle migration, for the same reason as the other
 * fork side tables: it must stay invisible to bb's migration history.
 */
const DETACHED_THREADS_TABLE = "fork_detached_threads";

const detachedThreadsTableReady = new WeakSet<object>();

function ensureDetachedThreadsTable(db: DbConnection): void {
  if (detachedThreadsTableReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${DETACHED_THREADS_TABLE} (
      thread_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${DETACHED_THREADS_TABLE}_host
      ON ${DETACHED_THREADS_TABLE} (host_id);
  `);
  detachedThreadsTableReady.add(db.$client);
}

export function recordDetachedThreads(
  db: DbConnection,
  args: { hostId: string; threadIds: readonly string[]; expiresAt: number },
): void {
  ensureDetachedThreadsTable(db);
  const upsert = db.$client.prepare<[string, string, number]>(
    `INSERT INTO ${DETACHED_THREADS_TABLE} (thread_id, host_id, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET
       host_id = excluded.host_id,
       expires_at = excluded.expires_at`,
  );
  for (const threadId of args.threadIds) {
    upsert.run(threadId, args.hostId, args.expiresAt);
  }
}

export function listPendingDetachedThreads(
  db: DbConnection,
  args: { hostId: string; now: number },
): { threadId: string; expiresAt: number }[] {
  ensureDetachedThreadsTable(db);
  return db.$client
    .prepare<[string, number], { threadId: string; expiresAt: number }>(
      `SELECT thread_id AS threadId, expires_at AS expiresAt
       FROM ${DETACHED_THREADS_TABLE}
       WHERE host_id = ? AND expires_at > ?`,
    )
    .all(args.hostId, args.now);
}

export function clearDetachedThreads(
  db: DbConnection,
  args: { hostId: string },
): void {
  ensureDetachedThreadsTable(db);
  db.$client
    .prepare<[string]>(
      `DELETE FROM ${DETACHED_THREADS_TABLE} WHERE host_id = ?`,
    )
    .run(args.hostId);
}
