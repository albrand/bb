import type { DbConnection } from "./connection.js";

export function ensureItemCompletionLookupIndex(db: DbConnection): void {
  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS fork_events_item_completion_lookup_idx
      ON events (thread_id, item_id, type, parent_tool_call_id);
  `);
}
