import {
  threadExecutionReportSchema,
  type ThreadExecutionReport,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";

/**
 * Fork (albrand/bb), get-bb/bb#1787: the latest session settings a provider
 * reported for a thread.
 *
 * Deliberately neither a drizzle migration nor a stored thread event. A stored
 * event with a type an official build does not know makes its strict event
 * parse throw, which breaks the thread's event log and timeline after a
 * rollback. A table created here is invisible to the migration history, the
 * official app ignores it, and dropping it loses nothing but the report.
 */
const EXECUTION_REPORTS_TABLE = "fork_thread_execution_reports";

interface ExecutionReportRow {
  model: string;
  reasoningLevel: string | null;
  permissionMode: string | null;
  serviceTier: string | null;
}

const executionReportsTableReady = new WeakSet<object>();

function ensureExecutionReportsTable(db: DbConnection): void {
  if (executionReportsTableReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${EXECUTION_REPORTS_TABLE} (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      reasoning_level TEXT,
      permission_mode TEXT,
      service_tier TEXT,
      reported_at INTEGER NOT NULL
    )
  `);
  executionReportsTableReady.add(db.$client);
}

export function upsertThreadExecutionReport(
  db: DbConnection,
  args: {
    threadId: string;
    execution: ThreadExecutionReport;
    reportedAt: number;
  },
): void {
  ensureExecutionReportsTable(db);
  db.$client
    .prepare<
      [string, string, string | null, string | null, string | null, number]
    >(
      `
        INSERT INTO ${EXECUTION_REPORTS_TABLE} (thread_id, model,
          reasoning_level, permission_mode, service_tier, reported_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (thread_id) DO UPDATE SET
          model = excluded.model,
          reasoning_level = excluded.reasoning_level,
          permission_mode = excluded.permission_mode,
          service_tier = excluded.service_tier,
          reported_at = excluded.reported_at
      `,
    )
    .run(
      args.threadId,
      args.execution.model,
      args.execution.reasoningLevel,
      args.execution.permissionMode,
      args.execution.serviceTier,
      args.reportedAt,
    );
}

export function getThreadExecutionReport(
  db: DbConnection,
  threadId: string,
): ThreadExecutionReport | null {
  ensureExecutionReportsTable(db);
  const row = db.$client
    .prepare<[string], ExecutionReportRow>(
      `
        SELECT model, reasoning_level AS reasoningLevel,
          permission_mode AS permissionMode, service_tier AS serviceTier
        FROM ${EXECUTION_REPORTS_TABLE}
        WHERE thread_id = ?
      `,
    )
    .get(threadId);
  if (row === undefined) {
    return null;
  }
  const parsed = threadExecutionReportSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}
