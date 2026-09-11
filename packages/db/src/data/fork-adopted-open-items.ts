import { sql } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";

/**
 * Fork (albrand/bb): items an adopted provider bridge worker can never
 * complete under their stored ids.
 *
 * An adopting daemon starts with a fresh delta assembler, so whatever the
 * provider does next for an item that was open when the old daemon went
 * away arrives under a new item id. The server closes the old ids when the
 * adoption is reported, or they render as running forever.
 */
export interface UncompletedTurnItemRow {
  data: string;
  providerThreadId: string | null;
}

export function listUncompletedTurnItemRows(
  db: DbQueryConnection,
  args: { threadId: string; turnId: string },
): UncompletedTurnItemRow[] {
  return db.all<UncompletedTurnItemRow>(
    sql`SELECT started.data AS data, started.provider_thread_id AS providerThreadId
        FROM events started
        WHERE started.thread_id = ${args.threadId}
          AND started.turn_id = ${args.turnId}
          AND started.type = 'item/started'
          AND started.item_id IS NOT NULL
          AND started.item_kind IS NOT 'backgroundTask'
          AND NOT EXISTS (
            SELECT 1 FROM events completed
            WHERE completed.thread_id = started.thread_id
              AND completed.item_id = started.item_id
              AND completed.type = 'item/completed'
              AND completed.parent_tool_call_id IS started.parent_tool_call_id
          )
        ORDER BY started.sequence`,
  );
}
