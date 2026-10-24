import { sql } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "./connection.js";

export interface NativeTerminalThreadRecord {
  threadId: string;
  providerId: string;
  nativeSessionId: string | null;
  terminalSessionId: string | null;
  lastEvidenceAt: number | null;
  lastToolCallAt: number | null;
  lastToolCallSessionId: string | null;
  initialPrompt: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

const SELECT_COLUMNS = `thread_id AS threadId, provider_id AS providerId, native_session_id AS nativeSessionId,
  terminal_session_id AS terminalSessionId, last_evidence_at AS lastEvidenceAt,
  last_tool_call_at AS lastToolCallAt, last_tool_call_session_id AS lastToolCallSessionId,
  initial_prompt AS initialPrompt, model,
  created_at AS createdAt, updated_at AS updatedAt`;

export function ensureNativeTerminalThreadsTable(db: DbConnection): void {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS fork_native_terminal_threads (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      native_session_id TEXT,
      terminal_session_id TEXT,
      initial_prompt TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fork_native_terminal_threads_session_idx
      ON fork_native_terminal_threads (provider_id, native_session_id)
      WHERE native_session_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS fork_native_terminal_tool_credentials (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      terminal_session_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const columns = db.$client
    .prepare(`PRAGMA table_info(fork_native_terminal_threads)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "initial_images")) {
    db.$client.exec(
      `ALTER TABLE fork_native_terminal_threads ADD COLUMN initial_images TEXT`,
    );
  }
  if (!columns.some((column) => column.name === "last_evidence_at")) {
    db.$client.exec(
      `ALTER TABLE fork_native_terminal_threads ADD COLUMN last_evidence_at INTEGER`,
    );
  }
  if (!columns.some((column) => column.name === "last_tool_call_at")) {
    db.$client.exec(
      `ALTER TABLE fork_native_terminal_threads ADD COLUMN last_tool_call_at INTEGER`,
    );
  }
  if (!columns.some((column) => column.name === "last_tool_call_session_id")) {
    db.$client.exec(
      `ALTER TABLE fork_native_terminal_threads ADD COLUMN last_tool_call_session_id TEXT`,
    );
  }
}

export function createNativeTerminalThread(
  db: DbConnection,
  args: {
    threadId: string;
    providerId: string;
    nativeSessionId: string | null;
    initialPrompt: string | null;
    initialImages: readonly string[];
    model: string | null;
  },
): NativeTerminalThreadRecord {
  const now = Date.now();
  db.$client
    .prepare(
      `INSERT INTO fork_native_terminal_threads
         (thread_id, provider_id, native_session_id, terminal_session_id, initial_prompt, initial_images, model, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.threadId,
      args.providerId,
      args.nativeSessionId,
      args.initialPrompt,
      args.initialImages.length === 0
        ? null
        : JSON.stringify(args.initialImages),
      args.model,
      now,
      now,
    );
  return {
    threadId: args.threadId,
    providerId: args.providerId,
    nativeSessionId: args.nativeSessionId,
    terminalSessionId: null,
    lastEvidenceAt: null,
    lastToolCallAt: null,
    lastToolCallSessionId: null,
    initialPrompt: args.initialPrompt,
    model: args.model,
    createdAt: now,
    updatedAt: now,
  };
}

export function getNativeTerminalThread(
  db: DbConnection,
  threadId: string,
): NativeTerminalThreadRecord | null {
  const row = db.$client
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM fork_native_terminal_threads WHERE thread_id = ?`,
    )
    .get(threadId) as NativeTerminalThreadRecord | undefined;
  return row ?? null;
}

export function findNativeTerminalThreadBySession(
  db: DbConnection,
  args: { providerId: string; nativeSessionId: string },
): NativeTerminalThreadRecord | null {
  const row = db.$client
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM fork_native_terminal_threads
       WHERE provider_id = ? AND native_session_id = ?`,
    )
    .get(args.providerId, args.nativeSessionId) as
    | NativeTerminalThreadRecord
    | undefined;
  return row ?? null;
}

export function deleteNativeTerminalThread(
  db: DbConnection,
  threadId: string,
): void {
  db.$client
    .prepare(`DELETE FROM fork_native_terminal_threads WHERE thread_id = ?`)
    .run(threadId);
}

export function isNativeTerminalThread(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return (
    db.get(
      sql`SELECT 1 AS present FROM fork_native_terminal_threads WHERE thread_id = ${threadId}`,
    ) !== undefined
  );
}

export function listNativeTerminalThreadIds(
  db: DbConnection,
  threadIds: readonly string[],
): Set<string> {
  if (threadIds.length === 0) return new Set();
  const rows = db.$client
    .prepare(
      `SELECT thread_id AS threadId FROM fork_native_terminal_threads
       WHERE thread_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(threadIds)) as { threadId: string }[];
  return new Set(rows.map((row) => row.threadId));
}

export function listNativeTerminalThreadsByIds(
  db: DbConnection,
  threadIds: readonly string[],
): Pick<
  NativeTerminalThreadRecord,
  | "threadId"
  | "providerId"
  | "lastEvidenceAt"
  | "lastToolCallAt"
  | "lastToolCallSessionId"
  | "nativeSessionId"
>[] {
  if (threadIds.length === 0) return [];
  const rows = db.$client
    .prepare(
      `SELECT thread_id AS threadId, provider_id AS providerId,
         native_session_id AS nativeSessionId,
         last_evidence_at AS lastEvidenceAt,
         last_tool_call_at AS lastToolCallAt,
         last_tool_call_session_id AS lastToolCallSessionId
       FROM fork_native_terminal_threads
       WHERE thread_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(threadIds)) as Pick<
    NativeTerminalThreadRecord,
    | "threadId"
    | "providerId"
    | "lastEvidenceAt"
    | "lastToolCallAt"
    | "lastToolCallSessionId"
    | "nativeSessionId"
  >[];
  return rows;
}

export function listNativeTerminalThreadsWithDisconnectedTerminal(
  db: DbConnection,
  hostId: string,
): string[] {
  const rows = db.$client
    .prepare(
      `SELECT n.thread_id AS threadId
       FROM fork_native_terminal_threads n
       JOIN terminal_sessions t ON t.id = n.terminal_session_id
       JOIN threads th ON th.id = n.thread_id
       WHERE t.host_id = ?
         AND th.archived_at IS NULL
         AND th.deleted_at IS NULL
         AND (
           t.status = 'disconnected'
           OR (t.status = 'exited' AND t.close_reason = 'thread-archived')
         )`,
    )
    .all(hostId) as { threadId: string }[];
  return rows.map((row) => row.threadId);
}

export function setNativeTerminalThreadTerminal(
  db: DbConnection,
  args: { threadId: string; terminalSessionId: string },
): void {
  db.$client
    .prepare(
      `UPDATE fork_native_terminal_threads SET terminal_session_id = ?, last_evidence_at = NULL, last_tool_call_at = NULL, last_tool_call_session_id = NULL, updated_at = ? WHERE thread_id = ?`,
    )
    .run(args.terminalSessionId, Date.now(), args.threadId);
}

export function clearNativeTerminalThreadEvidence(
  db: DbConnection,
  threadId: string,
): void {
  db.$client
    .prepare(
      `UPDATE fork_native_terminal_threads SET last_evidence_at = NULL, last_tool_call_at = NULL, last_tool_call_session_id = NULL WHERE thread_id = ?`,
    )
    .run(threadId);
}

export type StampNativeTerminalActivityResult =
  | { updated: false }
  | { updated: true; previousLastEvidenceAt: number | null };

export function stampNativeTerminalThreadActivity(
  db: DbConnection,
  args: { at: number; terminalSessionId: string; threadId: string },
): StampNativeTerminalActivityResult {
  return db.$client.transaction((): StampNativeTerminalActivityResult => {
    const record = db.$client
      .prepare(
        `SELECT last_evidence_at AS lastEvidenceAt
         FROM fork_native_terminal_threads
         WHERE thread_id = ? AND terminal_session_id = ?`,
      )
      .get(args.threadId, args.terminalSessionId) as
      | { lastEvidenceAt: number | null }
      | undefined;
    if (record === undefined) return { updated: false };
    const result = db.$client
      .prepare(
        `UPDATE fork_native_terminal_threads
         SET last_evidence_at = ?
         WHERE thread_id = ? AND terminal_session_id = ?`,
      )
      .run(args.at, args.threadId, args.terminalSessionId);
    if (result.changes !== 1) return { updated: false };
    return { updated: true, previousLastEvidenceAt: record.lastEvidenceAt };
  })();
}

export function clearNativeTerminalThreadActivityEvidence(
  db: DbConnection,
  args: { at: number; terminalSessionId: string; threadId: string },
): { cleared: boolean } {
  const result = db.$client
    .prepare(
      `UPDATE fork_native_terminal_threads
       SET last_evidence_at = NULL
       WHERE thread_id = ? AND terminal_session_id = ?
         AND last_evidence_at IS NOT NULL AND last_evidence_at <= ?`,
    )
    .run(args.threadId, args.terminalSessionId, args.at);
  return { cleared: result.changes === 1 };
}

export type StampNativeTerminalToolCallResult =
  | { updated: false }
  | { updated: true; previousLastToolCallAt: number | null };

export function stampNativeTerminalThreadToolCall(
  db: DbConnection,
  args: { at: number; terminalSessionId: string; threadId: string },
): StampNativeTerminalToolCallResult {
  return db.$client.transaction((): StampNativeTerminalToolCallResult => {
    const record = db.$client
      .prepare(
        `SELECT last_tool_call_at AS lastToolCallAt
         FROM fork_native_terminal_threads
         WHERE thread_id = ? AND terminal_session_id = ?
           AND native_session_id IS NOT NULL`,
      )
      .get(args.threadId, args.terminalSessionId) as
      | { lastToolCallAt: number | null }
      | undefined;
    if (record === undefined) return { updated: false };
    const result = db.$client
      .prepare(
        `UPDATE fork_native_terminal_threads
         SET last_tool_call_at = ?, last_tool_call_session_id = native_session_id
         WHERE thread_id = ? AND terminal_session_id = ?
           AND native_session_id IS NOT NULL`,
      )
      .run(args.at, args.threadId, args.terminalSessionId);
    if (result.changes !== 1) return { updated: false };
    return { updated: true, previousLastToolCallAt: record.lastToolCallAt };
  })();
}

export interface NativeTerminalThreadLaunchInput {
  initialPrompt: string | null;
  initialImages: string[];
}

function parseStoredInitialImages(stored: string): string[] {
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

export function consumeNativeTerminalThreadLaunchInput(
  db: DbConnection,
  threadId: string,
): NativeTerminalThreadLaunchInput {
  return db.$client.transaction(() => {
    const row = db.$client
      .prepare(
        `SELECT initial_prompt AS initialPrompt, initial_images AS initialImages
         FROM fork_native_terminal_threads WHERE thread_id = ?`,
      )
      .get(threadId) as
      | { initialPrompt: string | null; initialImages: string | null }
      | undefined;
    if (
      row === undefined ||
      (row.initialPrompt === null && row.initialImages === null)
    ) {
      return { initialPrompt: null, initialImages: [] };
    }
    db.$client
      .prepare(
        `UPDATE fork_native_terminal_threads
         SET initial_prompt = NULL, initial_images = NULL, updated_at = ? WHERE thread_id = ?`,
      )
      .run(Date.now(), threadId);
    return {
      initialPrompt: row.initialPrompt,
      initialImages:
        row.initialImages === null
          ? []
          : parseStoredInitialImages(row.initialImages),
    };
  })();
}

export type RecordNativeSessionIdResult =
  | { kind: "recorded" }
  | { kind: "unchanged" }
  | { kind: "claimed-by-other-thread"; threadId: string }
  | { kind: "already-bound"; nativeSessionId: string };

export function recordNativeTerminalThreadSessionId(
  db: DbConnection,
  args: { threadId: string; nativeSessionId: string },
): RecordNativeSessionIdResult {
  return db.$client.transaction((): RecordNativeSessionIdResult => {
    const current = getNativeTerminalThread(db, args.threadId);
    if (current === null) {
      throw new Error(
        `Thread ${args.threadId} is not a native terminal thread`,
      );
    }
    if (current.nativeSessionId === args.nativeSessionId) {
      return { kind: "unchanged" };
    }
    if (current.nativeSessionId !== null) {
      return {
        kind: "already-bound",
        nativeSessionId: current.nativeSessionId,
      };
    }
    const owner = db.$client
      .prepare(
        `SELECT thread_id AS threadId FROM fork_native_terminal_threads
         WHERE provider_id = ? AND native_session_id = ?`,
      )
      .get(current.providerId, args.nativeSessionId) as
      | { threadId: string }
      | undefined;
    if (owner !== undefined) {
      return { kind: "claimed-by-other-thread", threadId: owner.threadId };
    }
    db.$client
      .prepare(
        `UPDATE fork_native_terminal_threads SET native_session_id = ?, updated_at = ? WHERE thread_id = ?`,
      )
      .run(args.nativeSessionId, Date.now(), args.threadId);
    return { kind: "recorded" };
  })();
}

export type RebindNativeSessionIdResult =
  | { kind: "rebound" }
  | { kind: "stale"; nativeSessionId: string | null }
  | { kind: "claimed-by-other-thread"; threadId: string };

export function rebindNativeTerminalThreadSessionId(
  db: DbConnection,
  args: {
    nativeSessionId: string;
    replacesNativeSessionId: string;
    threadId: string;
  },
): RebindNativeSessionIdResult {
  return db.$client.transaction((): RebindNativeSessionIdResult => {
    const current = getNativeTerminalThread(db, args.threadId);
    if (current === null) {
      throw new Error(
        `Thread ${args.threadId} is not a native terminal thread`,
      );
    }
    if (current.nativeSessionId !== args.replacesNativeSessionId) {
      return { kind: "stale", nativeSessionId: current.nativeSessionId };
    }
    const owner = db.$client
      .prepare(
        `SELECT thread_id AS threadId FROM fork_native_terminal_threads
         WHERE provider_id = ? AND native_session_id = ? AND thread_id != ?`,
      )
      .get(current.providerId, args.nativeSessionId, args.threadId) as
      | { threadId: string }
      | undefined;
    if (owner !== undefined) {
      return { kind: "claimed-by-other-thread", threadId: owner.threadId };
    }
    const result = db.$client
      .prepare(
        `UPDATE fork_native_terminal_threads SET native_session_id = ?, updated_at = ?
         WHERE thread_id = ? AND native_session_id = ?`,
      )
      .run(
        args.nativeSessionId,
        Date.now(),
        args.threadId,
        args.replacesNativeSessionId,
      );
    return result.changes === 1
      ? { kind: "rebound" }
      : { kind: "stale", nativeSessionId: null };
  })();
}

export interface NativeTerminalToolCredentialRecord {
  threadId: string;
  terminalSessionId: string;
  credentialHash: string;
}

export function setNativeTerminalToolCredential(
  db: DbConnection,
  args: NativeTerminalToolCredentialRecord,
): void {
  db.$client
    .prepare(
      `INSERT INTO fork_native_terminal_tool_credentials
         (thread_id, terminal_session_id, credential_hash, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         terminal_session_id = excluded.terminal_session_id,
         credential_hash = excluded.credential_hash,
         created_at = excluded.created_at`,
    )
    .run(
      args.threadId,
      args.terminalSessionId,
      args.credentialHash,
      Date.now(),
    );
}

export function getNativeTerminalToolCredential(
  db: DbConnection,
  threadId: string,
): NativeTerminalToolCredentialRecord | null {
  const row = db.$client
    .prepare(
      `SELECT thread_id AS threadId, terminal_session_id AS terminalSessionId,
         credential_hash AS credentialHash
       FROM fork_native_terminal_tool_credentials WHERE thread_id = ?`,
    )
    .get(threadId) as NativeTerminalToolCredentialRecord | undefined;
  return row ?? null;
}

export function deleteNativeTerminalToolCredential(
  db: DbConnection,
  threadId: string,
): void {
  db.$client
    .prepare(
      `DELETE FROM fork_native_terminal_tool_credentials WHERE thread_id = ?`,
    )
    .run(threadId);
}
