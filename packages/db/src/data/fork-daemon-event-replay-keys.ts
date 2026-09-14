import type { DbConnection } from "../connection.js";

const REPLAY_KEYS_TABLE = "fork_worker_event_keys";
const REPLAY_KEY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const replayKeysTableReady = new WeakSet<object>();
const lastPruneAtByClient = new WeakMap<object, number>();

function ensureReplayKeysTable(db: DbConnection): void {
  if (replayKeysTableReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${REPLAY_KEYS_TABLE} (
      replay_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${REPLAY_KEYS_TABLE}_created_at
      ON ${REPLAY_KEYS_TABLE} (created_at);
  `);
  replayKeysTableReady.add(db.$client);
}

export function listStoredDaemonReplayKeys(
  db: DbConnection,
  replayKeys: readonly string[],
): Set<string> {
  if (replayKeys.length === 0) {
    return new Set();
  }
  ensureReplayKeysTable(db);
  const lookup = db.$client.prepare<[string], { replayKey: string }>(
    `SELECT replay_key AS replayKey FROM ${REPLAY_KEYS_TABLE} WHERE replay_key = ?`,
  );
  const stored = new Set<string>();
  for (const replayKey of new Set(replayKeys)) {
    if (lookup.get(replayKey) !== undefined) stored.add(replayKey);
  }
  return stored;
}

export function recordDaemonReplayKeys(
  db: DbConnection,
  args: { replayKeys: readonly string[]; now: number },
): void {
  if (args.replayKeys.length === 0) {
    return;
  }
  ensureReplayKeysTable(db);
  const insert = db.$client.prepare<[string, number]>(
    `INSERT OR IGNORE INTO ${REPLAY_KEYS_TABLE} (replay_key, created_at) VALUES (?, ?)`,
  );
  for (const replayKey of args.replayKeys) {
    insert.run(replayKey, args.now);
  }
  const lastPruneAt = lastPruneAtByClient.get(db.$client) ?? 0;
  if (args.now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAtByClient.set(db.$client, args.now);
    db.$client
      .prepare<[number]>(
        `DELETE FROM ${REPLAY_KEYS_TABLE} WHERE created_at < ?`,
      )
      .run(args.now - REPLAY_KEY_RETENTION_MS);
  }
}
