import type { DbConnection } from "./connection.js";

// Which thread spawned a thread, when an agent created it from inside another
// thread (the CLI sends BB_THREAD_ID) without parenting it. A thread with a
// spawner is a child for model routing even though it sits at the top level.
// A fork-owned side table, so upstream migration numbering stays untouched.
export function ensureThreadSpawnersTable(db: DbConnection): void {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS fork_thread_spawners (
      thread_id TEXT PRIMARY KEY NOT NULL,
      spawned_by_thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

export function recordThreadSpawner(
  db: DbConnection,
  args: { threadId: string; spawnedByThreadId: string },
): void {
  db.$client
    .prepare(
      `INSERT OR IGNORE INTO fork_thread_spawners (thread_id, spawned_by_thread_id, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(args.threadId, args.spawnedByThreadId, Date.now());
}

export function getThreadSpawner(
  db: DbConnection,
  threadId: string,
): string | null {
  const row = db.$client
    .prepare(
      `SELECT spawned_by_thread_id AS spawnedByThreadId FROM fork_thread_spawners WHERE thread_id = ?`,
    )
    .get(threadId) as { spawnedByThreadId: string } | undefined;
  return row?.spawnedByThreadId ?? null;
}
