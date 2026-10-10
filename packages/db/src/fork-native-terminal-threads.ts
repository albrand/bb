import type { DbConnection } from "./connection.js";

export interface NativeTerminalThreadRecord {
  threadId: string;
  providerId: string;
  nativeSessionId: string | null;
  terminalSessionId: string | null;
  initialPrompt: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

const SELECT_COLUMNS = `thread_id AS threadId, provider_id AS providerId, native_session_id AS nativeSessionId,
  terminal_session_id AS terminalSessionId, initial_prompt AS initialPrompt, model,
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
  `);
}

export function createNativeTerminalThread(
  db: DbConnection,
  args: {
    threadId: string;
    providerId: string;
    nativeSessionId: string | null;
    initialPrompt: string | null;
    model: string | null;
  },
): NativeTerminalThreadRecord {
  const now = Date.now();
  db.$client
    .prepare(
      `INSERT INTO fork_native_terminal_threads
         (thread_id, provider_id, native_session_id, terminal_session_id, initial_prompt, model, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      args.threadId,
      args.providerId,
      args.nativeSessionId,
      args.initialPrompt,
      args.model,
      now,
      now,
    );
  return {
    threadId: args.threadId,
    providerId: args.providerId,
    nativeSessionId: args.nativeSessionId,
    terminalSessionId: null,
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

export function isNativeTerminalThread(
  db: DbConnection,
  threadId: string,
): boolean {
  return (
    db.$client
      .prepare(
        `SELECT 1 AS present FROM fork_native_terminal_threads WHERE thread_id = ?`,
      )
      .get(threadId) !== undefined
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

export function setNativeTerminalThreadTerminal(
  db: DbConnection,
  args: { threadId: string; terminalSessionId: string },
): void {
  db.$client
    .prepare(
      `UPDATE fork_native_terminal_threads SET terminal_session_id = ?, updated_at = ? WHERE thread_id = ?`,
    )
    .run(args.terminalSessionId, Date.now(), args.threadId);
}

export function consumeNativeTerminalThreadInitialPrompt(
  db: DbConnection,
  threadId: string,
): string | null {
  return db.$client.transaction(() => {
    const row = db.$client
      .prepare(
        `SELECT initial_prompt AS initialPrompt FROM fork_native_terminal_threads WHERE thread_id = ?`,
      )
      .get(threadId) as { initialPrompt: string | null } | undefined;
    if (row === undefined || row.initialPrompt === null) return null;
    db.$client
      .prepare(
        `UPDATE fork_native_terminal_threads SET initial_prompt = NULL, updated_at = ? WHERE thread_id = ?`,
      )
      .run(Date.now(), threadId);
    return row.initialPrompt;
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
