import type { DbConnection } from "../connection.js";

/**
 * Fork (albrand/bb): replay keys of daemon events already stored.
 *
 * A provider bridge worker outlives its host daemon and replays every line
 * the old daemon had not acknowledged to the daemon that adopts it. The
 * daemon posts each resulting event with a stable replay key
 * (`<workerId>:<wseq>:<index>`), and the server skips an event whose key it
 * already holds. The keys only matter for the short window between a
 * forwarded line and its acknowledgement, so rows older than a week go.
 *
 * Deliberately not a drizzle migration: a fork-numbered migration collides
 * with upstream's next one, while this table is invisible to bb's migration
 * history and dropping it loses nothing but deduplication of replays.
 */
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
