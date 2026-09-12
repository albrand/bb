import { eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { maintenanceScanCursors } from "../schema.js";

/**
 * Fork (albrand/bb): retention for file-change diffs.
 *
 * Upstream's completed-event output sweep truncates three string paths
 * (aggregatedOutput, result, resultText). A fileChange item stores its patches
 * in `$.item.changes`, a structured array of {path, kind, diff}, which that
 * sweep cannot touch: slicing the array's JSON text head and tail produces
 * invalid JSON. This truncates structurally instead. Every entry survives, so
 * the file list a thread renders stays complete, and only each entry's `diff`
 * string is shortened, with the truncation marker left inline because
 * ThreadEventFileChange has nowhere to record a truncation descriptor and
 * adding one would change a contract shared with the daemon and the plugin SDK.
 *
 * Both item/started and item/completed carry the same array, so both are
 * scanned: leaving one side whole re-inflates what the other side dropped.
 *
 * The already-truncated test is structural, not a substring search. A diff can
 * legitimately contain the marker text — a diff of this very file does, and on
 * the live database twelve command events quote it in their command line or
 * their output without having been truncated at all. A substring test would
 * exempt those from truncation forever. A truncated diff instead has an exact
 * shape: its length is head + marker + tail and the marker sits at exactly
 * `head`, which ordinary content cannot reach by accident.
 *
 * The cursor is seeded at the time of its first scan, so introducing this
 * target never rewrites the rows already on disk. Compacting those is a
 * separate, scheduled, backed-up pass.
 *
 * Deliberately not a drizzle migration: the index is created on demand, the
 * way the fork's other side tables are.
 */
const FILE_CHANGE_DIFF_TRUNCATION_CURSOR_POLICY =
  "fork_file_change_diff_truncation";
const FILE_CHANGE_DIFF_TRUNCATION_CURSOR_VERSION = 1;
export const FILE_CHANGE_SCAN_INDEX =
  "fork_events_file_change_truncation_idx";

export const FILE_CHANGE_DIFF_TRUNCATION_THRESHOLD_CHARS = 16 * 1024;
export const FILE_CHANGE_DIFF_RETAINED_HEAD_CHARS = 8 * 1024;
export const FILE_CHANGE_DIFF_RETAINED_TAIL_CHARS = 8 * 1024;
export const DEFAULT_FILE_CHANGE_DIFF_TRUNCATION_BATCH_SIZE = 250;

export const FILE_CHANGE_DIFF_TRUNCATION_MARKER =
  "\n\n[... diff truncated by retention policy; showing beginning and end ...]\n\n";

export interface TruncateFileChangeDiffsArgs {
  createdBefore: number;
  limit: number;
  truncatedAt: number;
}

export interface TruncateFileChangeDiffsResult {
  scannedRows: number;
  truncatedDiffs: number;
  truncatedRows: number;
}

interface FileChangeScanRow {
  created_at: number;
  data: string;
  id: string;
}

interface FileChangeEntry {
  diff?: unknown;
}

interface FileChangeItemPayload {
  item?: { changes?: unknown };
}

const scanIndexReady = new WeakSet<object>();

function ensureFileChangeScanIndex(db: DbConnection): void {
  if (scanIndexReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS ${FILE_CHANGE_SCAN_INDEX}
      ON events (created_at, id)
      WHERE item_kind = 'fileChange'
        AND type IN ('item/started', 'item/completed');
  `);
  scanIndexReady.add(db.$client);
}

function cursorId(): string {
  return `${FILE_CHANGE_DIFF_TRUNCATION_CURSOR_POLICY}:v${FILE_CHANGE_DIFF_TRUNCATION_CURSOR_VERSION}`;
}

function readCursor(
  db: DbConnection,
): { lastCreatedAt: number; lastEventId: string } | null {
  return (
    db
      .select({
        lastCreatedAt: maintenanceScanCursors.lastCreatedAt,
        lastEventId: maintenanceScanCursors.lastEventId,
      })
      .from(maintenanceScanCursors)
      .where(eq(maintenanceScanCursors.id, cursorId()))
      .get() ?? null
  );
}

function writeCursor(
  db: DbConnection,
  args: { lastCreatedAt: number; lastEventId: string; updatedAt: number },
): void {
  db.insert(maintenanceScanCursors)
    .values({
      id: cursorId(),
      policy: FILE_CHANGE_DIFF_TRUNCATION_CURSOR_POLICY,
      version: FILE_CHANGE_DIFF_TRUNCATION_CURSOR_VERSION,
      itemKind: "fileChange",
      outputPath: "changes",
      lastCreatedAt: args.lastCreatedAt,
      lastEventId: args.lastEventId,
      updatedAt: args.updatedAt,
    })
    .onConflictDoUpdate({
      target: maintenanceScanCursors.id,
      set: {
        lastCreatedAt: args.lastCreatedAt,
        lastEventId: args.lastEventId,
        updatedAt: args.updatedAt,
      },
    })
    .run();
}

export const FILE_CHANGE_DIFF_TRUNCATED_LENGTH =
  FILE_CHANGE_DIFF_RETAINED_HEAD_CHARS +
  FILE_CHANGE_DIFF_TRUNCATION_MARKER.length +
  FILE_CHANGE_DIFF_RETAINED_TAIL_CHARS;

export function isTruncatedFileChangeDiff(diff: string): boolean {
  return (
    diff.length === FILE_CHANGE_DIFF_TRUNCATED_LENGTH &&
    diff.startsWith(
      FILE_CHANGE_DIFF_TRUNCATION_MARKER,
      FILE_CHANGE_DIFF_RETAINED_HEAD_CHARS,
    )
  );
}

export function truncateFileChangeDiff(diff: string): string | null {
  if (
    diff.length <= FILE_CHANGE_DIFF_TRUNCATION_THRESHOLD_CHARS ||
    diff.length <= FILE_CHANGE_DIFF_TRUNCATED_LENGTH ||
    isTruncatedFileChangeDiff(diff)
  ) {
    return null;
  }
  return (
    diff.slice(0, FILE_CHANGE_DIFF_RETAINED_HEAD_CHARS) +
    FILE_CHANGE_DIFF_TRUNCATION_MARKER +
    diff.slice(-FILE_CHANGE_DIFF_RETAINED_TAIL_CHARS)
  );
}

export function truncateFileChangeDiffsInPayload(
  data: string,
): { data: string; truncatedDiffs: number } | null {
  let payload: FileChangeItemPayload;
  try {
    payload = JSON.parse(data) as FileChangeItemPayload;
  } catch {
    return null;
  }
  const changes = payload.item?.changes;
  if (!Array.isArray(changes)) {
    return null;
  }
  let truncatedDiffs = 0;
  for (const change of changes as FileChangeEntry[]) {
    if (typeof change.diff !== "string") {
      continue;
    }
    const truncated = truncateFileChangeDiff(change.diff);
    if (truncated === null) {
      continue;
    }
    change.diff = truncated;
    truncatedDiffs += 1;
  }
  if (truncatedDiffs === 0) {
    return null;
  }
  return { data: JSON.stringify(payload), truncatedDiffs };
}

export function truncateFileChangeDiffs(
  db: DbConnection,
  args: TruncateFileChangeDiffsArgs,
): TruncateFileChangeDiffsResult {
  const empty: TruncateFileChangeDiffsResult = {
    scannedRows: 0,
    truncatedDiffs: 0,
    truncatedRows: 0,
  };
  if (args.limit <= 0) {
    return empty;
  }
  ensureFileChangeScanIndex(db);

  const cursor = readCursor(db);
  if (cursor === null) {
    writeCursor(db, {
      lastCreatedAt: args.truncatedAt,
      lastEventId: "",
      updatedAt: args.truncatedAt,
    });
    return empty;
  }

  const rows = db.$client
    .prepare<[number, number, string, number], FileChangeScanRow>(
      `
        SELECT id, created_at, data
        FROM events
        WHERE item_kind = 'fileChange'
          AND type IN ('item/started', 'item/completed')
          AND created_at < ?
          AND (created_at, id) > (?, ?)
        ORDER BY created_at, id
        LIMIT ?
      `,
    )
    .all(args.createdBefore, cursor.lastCreatedAt, cursor.lastEventId, args.limit);
  if (rows.length === 0) {
    return empty;
  }

  const update = db.$client.prepare<[string, string]>(
    `UPDATE events SET data = ? WHERE id = ?`,
  );
  let truncatedDiffs = 0;
  let truncatedRows = 0;
  for (const row of rows) {
    const result = truncateFileChangeDiffsInPayload(row.data);
    if (result === null) {
      continue;
    }
    update.run(result.data, row.id);
    truncatedDiffs += result.truncatedDiffs;
    truncatedRows += 1;
  }

  const lastRow = rows[rows.length - 1];
  if (lastRow !== undefined) {
    writeCursor(db, {
      lastCreatedAt: lastRow.created_at,
      lastEventId: lastRow.id,
      updatedAt: args.truncatedAt,
    });
  }

  return { scannedRows: rows.length, truncatedDiffs, truncatedRows };
}
