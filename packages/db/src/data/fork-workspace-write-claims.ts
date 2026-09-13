import type { DbConnection } from "../connection.js";

const TABLE = "fork_workspace_write_claims";
const STALE_AFTER_MS = 90_000;

const readyClients = new WeakSet<object>();

function ensureTable(db: DbConnection): void {
  if (readyClients.has(db.$client)) return;
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      host_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, workspace_path)
    );
    CREATE INDEX IF NOT EXISTS ${TABLE}_thread
      ON ${TABLE} (thread_id);
  `);
  readyClients.add(db.$client);
}

export interface WorkspaceWriteClaim {
  hostId: string;
  workspacePath: string;
  threadId: string;
  ownerToken: string;
  acquiredAt: number;
  heartbeatAt: number;
}

export function tryClaimWorkspaceWrite(
  db: DbConnection,
  args: {
    hostId: string;
    workspacePath: string;
    threadId: string;
    ownerToken: string;
    now?: number;
  },
): { acquired: true } | { acquired: false; holderThreadId: string } {
  ensureTable(db);
  const now = args.now ?? Date.now();
  const insert = db.$client.prepare<
    [string, string, string, string, number, number]
  >(
    `INSERT INTO ${TABLE}
      (host_id, workspace_path, thread_id, owner_token, acquired_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (host_id, workspace_path) DO NOTHING`,
  );
  const result = insert.run(
    args.hostId,
    args.workspacePath,
    args.threadId,
    args.ownerToken,
    now,
    now,
  );
  if (result.changes > 0) return { acquired: true };

  const existing = db.$client
    .prepare<
      [string, string],
      { threadId: string; ownerToken: string; heartbeatAt: number }
    >(
      `SELECT thread_id AS threadId, owner_token AS ownerToken,
              heartbeat_at AS heartbeatAt
       FROM ${TABLE} WHERE host_id = ? AND workspace_path = ?`,
    )
    .get(args.hostId, args.workspacePath);
  if (existing === undefined) {
    return tryClaimWorkspaceWrite(db, args);
  }
  if (
    existing.threadId === args.threadId &&
    existing.ownerToken === args.ownerToken
  ) {
    db.$client
      .prepare<[number, string, string, string]>(
        `UPDATE ${TABLE} SET heartbeat_at = ?
         WHERE host_id = ? AND workspace_path = ? AND thread_id = ?`,
      )
      .run(now, args.hostId, args.workspacePath, args.threadId);
    return { acquired: true };
  }
  if (now - existing.heartbeatAt > STALE_AFTER_MS) {
    db.$client
      .prepare<[string, string, number]>(
        `DELETE FROM ${TABLE}
         WHERE host_id = ? AND workspace_path = ? AND heartbeat_at < ?`,
      )
      .run(args.hostId, args.workspacePath, now - STALE_AFTER_MS);
    return tryClaimWorkspaceWrite(db, args);
  }
  return { acquired: false, holderThreadId: existing.threadId };
}

export function releaseWorkspaceWriteClaims(
  db: DbConnection,
  args: { threadId: string; ownerToken?: string },
): void {
  ensureTable(db);
  if (args.ownerToken === undefined) {
    db.$client
      .prepare<[string]>(`DELETE FROM ${TABLE} WHERE thread_id = ?`)
      .run(args.threadId);
    return;
  }
  db.$client
    .prepare<
      [string, string]
    >(`DELETE FROM ${TABLE} WHERE thread_id = ? AND owner_token = ?`)
    .run(args.threadId, args.ownerToken);
}

export function releaseAllWorkspaceWriteClaims(db: DbConnection): void {
  ensureTable(db);
  db.$client.prepare(`DELETE FROM ${TABLE}`).run();
}

export function heartbeatWorkspaceWriteClaims(
  db: DbConnection,
  args: { ownerToken: string; now?: number },
): void {
  ensureTable(db);
  db.$client
    .prepare<
      [number, string]
    >(`UPDATE ${TABLE} SET heartbeat_at = ? WHERE owner_token = ?`)
    .run(args.now ?? Date.now(), args.ownerToken);
}

export function getWorkspaceWriteClaim(
  db: DbConnection,
  args: { hostId: string; workspacePath: string; now?: number },
): WorkspaceWriteClaim | null {
  ensureTable(db);
  const row = db.$client
    .prepare<
      [string, string],
      {
        hostId: string;
        workspacePath: string;
        threadId: string;
        ownerToken: string;
        acquiredAt: number;
        heartbeatAt: number;
      }
    >(
      `SELECT host_id AS hostId, workspace_path AS workspacePath,
              thread_id AS threadId, owner_token AS ownerToken,
              acquired_at AS acquiredAt, heartbeat_at AS heartbeatAt
       FROM ${TABLE} WHERE host_id = ? AND workspace_path = ?`,
    )
    .get(args.hostId, args.workspacePath);
  if (row === undefined) return null;
  if ((args.now ?? Date.now()) - row.heartbeatAt > STALE_AFTER_MS) {
    db.$client
      .prepare<
        [string, string]
      >(`DELETE FROM ${TABLE} WHERE host_id = ? AND workspace_path = ?`)
      .run(args.hostId, args.workspacePath);
    return null;
  }
  return row;
}

export function countUnmanagedWorkspaceThreads(
  db: DbConnection,
  args: { hostId: string; workspacePath: string },
): number {
  const row = db.$client
    .prepare<[string, string], { count: number }>(
      `SELECT COUNT(*) AS count
       FROM threads
       INNER JOIN environments ON environments.id = threads.environment_id
       WHERE environments.host_id = ?
         AND environments.path = ?
         AND environments.managed = 0
         AND environments.workspace_provision_type = 'unmanaged'
         AND threads.archived_at IS NULL
         AND threads.deleted_at IS NULL`,
    )
    .get(args.hostId, args.workspacePath);
  return row?.count ?? 0;
}
