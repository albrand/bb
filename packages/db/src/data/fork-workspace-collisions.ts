import type { DbConnection } from "../connection.js";

const OBSERVATIONS_TABLE = "fork_workspace_file_observations";
const COLLISIONS_TABLE = "fork_workspace_collisions";
const WINDOW_MS = 60_000;
const RETENTION_MS = 15 * 60_000;
const MAX_ROWS = 4096;

const ready = new WeakSet<object>();

function ensureTables(db: Pick<DbConnection, "$client">): void {
  if (ready.has(db.$client)) return;
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${OBSERVATIONS_TABLE} (
      host_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      thread_ids TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, workspace_path, file_path, window_start)
    );
    CREATE TABLE IF NOT EXISTS ${COLLISIONS_TABLE} (
      host_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      thread_a TEXT NOT NULL,
      thread_b TEXT NOT NULL,
      noticed_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, workspace_path, file_path, window_start, thread_a, thread_b)
    );
    CREATE INDEX IF NOT EXISTS ${OBSERVATIONS_TABLE}_retention
      ON ${OBSERVATIONS_TABLE} (observed_at);
    CREATE INDEX IF NOT EXISTS ${COLLISIONS_TABLE}_retention
      ON ${COLLISIONS_TABLE} (noticed_at);
  `);
  ready.add(db.$client);
}

interface ObservationRow {
  threadIds: string;
}

export interface WorkspaceCollisionNotice {
  filePath: string;
  threadId: string;
  otherThreadId: string;
}

export interface RecentWorkspaceFile {
  filePath: string;
  threadIds: string[];
  observedAt: number;
}

export function listRecentWorkspaceFiles(
  db: Pick<DbConnection, "$client">,
  args: { hostId: string; workspacePath: string; now?: number; limit?: number },
): RecentWorkspaceFile[] {
  ensureTables(db);
  const now = args.now ?? Date.now();
  const limit = Math.min(Math.max(args.limit ?? 16, 1), 64);
  const rows = db.$client
    .prepare<[string, string, number, number], { filePath: string; threadIds: string; observedAt: number }>(
      `SELECT file_path AS filePath, thread_ids AS threadIds, observed_at AS observedAt
       FROM ${OBSERVATIONS_TABLE}
       WHERE host_id = ? AND workspace_path = ? AND observed_at >= ?
       ORDER BY observed_at DESC LIMIT ?`,
    )
    .all(args.hostId, args.workspacePath, now - RETENTION_MS, limit);
  return rows.map((row) => ({
    filePath: row.filePath,
    threadIds: JSON.parse(row.threadIds),
    observedAt: row.observedAt,
  }));
}

export function recordWorkspaceFileChanges(
  db: DbConnection,
  args: {
    hostId: string;
    workspacePath: string;
    filePaths: readonly string[];
    candidateThreadIds: readonly string[];
    now?: number;
  },
): WorkspaceCollisionNotice[] {
  ensureTables(db);
  const now = args.now ?? Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const candidates = [...new Set(args.candidateThreadIds)].sort();
  if (args.filePaths.length === 0 || candidates.length === 0) {
    pruneWorkspaceCollisionTables(db, now);
    return [];
  }
  const notices: WorkspaceCollisionNotice[] = [];
  const read = db.$client.prepare<[string, string, string, number], ObservationRow>(
    `SELECT thread_ids AS threadIds FROM ${OBSERVATIONS_TABLE}
     WHERE host_id = ? AND workspace_path = ? AND file_path = ? AND window_start = ?`,
  );
  const write = db.$client.prepare<[string, string, string, number, string, number]>(
    `INSERT INTO ${OBSERVATIONS_TABLE}
      (host_id, workspace_path, file_path, window_start, thread_ids, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (host_id, workspace_path, file_path, window_start) DO UPDATE SET
       thread_ids = excluded.thread_ids, observed_at = excluded.observed_at`,
  );
  const collision = db.$client.prepare<[string, string, string, number, string, string], { noticedAt: number }>(
    `SELECT noticed_at AS noticedAt FROM ${COLLISIONS_TABLE}
     WHERE host_id = ? AND workspace_path = ? AND file_path = ? AND window_start = ?
       AND thread_a = ? AND thread_b = ?`,
  );
  const insertCollision = db.$client.prepare<[string, string, string, number, string, string, number]>(
    `INSERT OR IGNORE INTO ${COLLISIONS_TABLE}
      (host_id, workspace_path, file_path, window_start, thread_a, thread_b, noticed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const filePath of [...new Set(args.filePaths)].slice(0, 64)) {
    const previous = read.get(args.hostId, args.workspacePath, filePath, windowStart);
    const previousIds = previous ? (JSON.parse(previous.threadIds) as string[]) : [];
    const previousSet = new Set(previousIds);
    const newIds = candidates.filter((id) => !previousSet.has(id));
    for (const threadId of newIds) {
      for (const otherThreadId of previousIds) {
        const [threadA, threadB] = [threadId, otherThreadId].sort();
        if (collision.get(args.hostId, args.workspacePath, filePath, windowStart, threadA, threadB)) continue;
        insertCollision.run(args.hostId, args.workspacePath, filePath, windowStart, threadA, threadB, now);
        notices.push({ filePath, threadId: threadA, otherThreadId: threadB });
        notices.push({ filePath, threadId: threadB, otherThreadId: threadA });
      }
    }
    if (newIds.length === 0 && previousIds.length > 1 && candidates.length > 1) {
      for (const threadA of previousIds) {
        for (const threadB of previousIds) {
          if (threadA >= threadB) continue;
          if (collision.get(args.hostId, args.workspacePath, filePath, windowStart, threadA, threadB)) continue;
          insertCollision.run(args.hostId, args.workspacePath, filePath, windowStart, threadA, threadB, now);
          notices.push({ filePath, threadId: threadA, otherThreadId: threadB });
          notices.push({ filePath, threadId: threadB, otherThreadId: threadA });
        }
      }
    }
    write.run(args.hostId, args.workspacePath, filePath, windowStart, JSON.stringify([...new Set([...previousIds, ...candidates])]), now);
  }
  pruneWorkspaceCollisionTables(db, now);
  return notices;
}

function pruneWorkspaceCollisionTables(db: DbConnection, now: number): void {
  db.$client.prepare<[number]>(`DELETE FROM ${OBSERVATIONS_TABLE} WHERE observed_at < ?`).run(now - RETENTION_MS);
  db.$client.prepare<[number]>(`DELETE FROM ${COLLISIONS_TABLE} WHERE noticed_at < ?`).run(now - RETENTION_MS);
  db.$client.prepare(`DELETE FROM ${OBSERVATIONS_TABLE} WHERE rowid NOT IN (SELECT rowid FROM ${OBSERVATIONS_TABLE} ORDER BY observed_at DESC LIMIT ${MAX_ROWS})`).run();
  db.$client.prepare(`DELETE FROM ${COLLISIONS_TABLE} WHERE rowid NOT IN (SELECT rowid FROM ${COLLISIONS_TABLE} ORDER BY noticed_at DESC LIMIT ${MAX_ROWS})`).run();
}
