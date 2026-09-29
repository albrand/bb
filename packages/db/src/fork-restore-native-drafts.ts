import type { DbConnection } from "./connection.js";
import { createOrderKeyAfter, createOrderKeyBetween } from "./data/order-keys.js";
import { createQueuedThreadMessageId } from "./ids.js";

const DRAFTS_WAITING_ON = JSON.stringify({
  kind: "plugin",
  pluginId: "drafts",
  reason: "Draft",
});
const DRAFTS_WAIT_HOLDER = "plugin:drafts";
const FALLBACK_PERMISSION_MODE = "accept-edits";
const FALLBACK_SERVICE_TIER = "default";

interface NativeDraftRow {
  id: string;
  projectId: string;
  providerId: string;
  draft: string;
  model: string | null;
  reasoningLevel: string | null;
  permissionMode: string | null;
  serviceTier: string | null;
}

export function restoreNativeThreadDraftsToDraftsQueue(db: DbConnection): void {
  const sqlite = db.$client;
  const threadColumns = sqlite
    .prepare("SELECT name FROM pragma_table_info('threads')")
    .all() as Array<{ name: string }>;
  if (!threadColumns.some((column) => column.name === "draft")) {
    return;
  }

  const rows = sqlite
    .prepare(
      `SELECT
        t.id AS id,
        t.project_id AS projectId,
        t.provider_id AS providerId,
        t.draft AS draft,
        COALESCE(json_extract(r.execution, '$.model'), q.model, t.model_override, pd.model, pq.model) AS model,
        COALESCE(json_extract(r.execution, '$.reasoningLevel'), q.reasoning_level, t.reasoning_level_override, pd.reasoning_level, pq.reasoning_level) AS reasoningLevel,
        COALESCE(json_extract(r.execution, '$.permissionMode'), q.permission_mode, pd.permission_mode, pq.permission_mode) AS permissionMode,
        COALESCE(json_extract(r.execution, '$.serviceTier'), q.service_tier, pd.service_tier, pq.service_tier) AS serviceTier
      FROM threads AS t
      LEFT JOIN queued_thread_messages AS q ON q.id = (
        SELECT latest.id FROM queued_thread_messages AS latest
        WHERE latest.thread_id = t.id
        ORDER BY latest.sort_key DESC, latest.id DESC
        LIMIT 1
      )
      LEFT JOIN project_execution_defaults AS pd
        ON pd.project_id = t.project_id AND pd.provider_id = t.provider_id
      LEFT JOIN queued_thread_messages AS pq ON pq.id = (
        SELECT latest.id FROM queued_thread_messages AS latest
        JOIN threads AS sibling ON sibling.id = latest.thread_id
        WHERE sibling.provider_id = t.provider_id
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
      LEFT JOIN (
        SELECT e.thread_id, json_extract(e.data, '$.execution') AS execution
        FROM events AS e
        WHERE e.type = 'client/turn/requested'
          AND e.sequence = (
            SELECT max(latest.sequence) FROM events AS latest
            WHERE latest.thread_id = e.thread_id
              AND latest.type = 'client/turn/requested'
          )
      ) AS r ON r.thread_id = t.id
      WHERE t.draft IS NOT NULL`,
    )
    .all() as NativeDraftRow[];
  if (rows.length === 0) {
    return;
  }

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS fork_unrestored_thread_drafts (
      thread_id TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL,
      preserved_at INTEGER NOT NULL
    )`,
  );
  const lastSortKey = sqlite.prepare(
    "SELECT sort_key AS sortKey FROM queued_thread_messages WHERE thread_id = ? ORDER BY sort_key DESC, id DESC LIMIT 1",
  );
  const insertQueued = sqlite.prepare(
    `INSERT INTO queued_thread_messages (
      id, thread_id, content, model, reasoning_level, permission_mode,
      service_tier, waiting_on, wait_holder, payload_kind, group_with_next,
      failure_count, sort_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inline', 0, 0, ?, ?, ?)`,
  );
  const preserve = sqlite.prepare(
    "INSERT OR REPLACE INTO fork_unrestored_thread_drafts (thread_id, content, preserved_at) VALUES (?, ?, ?)",
  );
  const clearDraft = sqlite.prepare(
    "UPDATE threads SET draft = NULL WHERE id = ?",
  );
  const siblingTurnExecution = sqlite.prepare(
    `SELECT execution FROM (
      SELECT
        s.project_id AS projectId,
        s.updated_at AS updatedAt,
        (
          SELECT json_extract(e.data, '$.execution') FROM events AS e
          WHERE e.thread_id = s.id AND e.type = 'client/turn/requested'
          ORDER BY e.sequence DESC LIMIT 1
        ) AS execution
      FROM threads AS s
      WHERE s.provider_id = ? AND s.id != ?
    )
    WHERE execution IS NOT NULL
    ORDER BY (projectId = ?) DESC, updatedAt DESC
    LIMIT 1`,
  );
  const withSiblingExecution = (row: NativeDraftRow): NativeDraftRow => {
    if (row.model !== null && row.reasoningLevel !== null) {
      return row;
    }
    const sibling = siblingTurnExecution.get(
      row.providerId,
      row.id,
      row.projectId,
    ) as { execution: string } | undefined;
    const execution = sibling ? parseExecution(sibling.execution) : null;
    if (execution === null) {
      return row;
    }
    return {
      ...row,
      model: row.model ?? execution.model,
      reasoningLevel: row.reasoningLevel ?? execution.reasoningLevel,
      permissionMode: row.permissionMode ?? execution.permissionMode,
      serviceTier: row.serviceTier ?? execution.serviceTier,
    };
  };

  sqlite.transaction(() => {
    const now = Date.now();
    for (const found of rows) {
      const row = withSiblingExecution(found);
      if (!isNonEmptyJsonArray(row.draft)) {
        if (row.draft.trim() !== "" && row.draft.trim() !== "[]") {
          preserve.run(row.id, row.draft, now);
        }
        clearDraft.run(row.id);
        continue;
      }
      if (row.model === null || row.reasoningLevel === null) {
        preserve.run(row.id, row.draft, now);
        clearDraft.run(row.id);
        continue;
      }
      const previous = lastSortKey.get(row.id) as
        | { sortKey: string }
        | undefined;
      const sortKey = previous
        ? createOrderKeyAfter({ previousKey: previous.sortKey })
        : createOrderKeyBetween({ previousKey: null, nextKey: null });
      insertQueued.run(
        createQueuedThreadMessageId(),
        row.id,
        row.draft,
        row.model,
        row.reasoningLevel,
        row.permissionMode ?? FALLBACK_PERMISSION_MODE,
        row.serviceTier ?? FALLBACK_SERVICE_TIER,
        DRAFTS_WAITING_ON,
        DRAFTS_WAIT_HOLDER,
        sortKey,
        now,
        now,
      );
      clearDraft.run(row.id);
    }
  })();
}

interface SiblingExecution {
  model: string | null;
  reasoningLevel: string | null;
  permissionMode: string | null;
  serviceTier: string | null;
}

function parseExecution(value: string): SiblingExecution | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const field = (key: string): string | null => {
      const fieldValue = (parsed as Record<string, unknown>)[key];
      return typeof fieldValue === "string" && fieldValue !== ""
        ? fieldValue
        : null;
    };
    return {
      model: field("model"),
      reasoningLevel: field("reasoningLevel"),
      permissionMode: field("permissionMode"),
      serviceTier: field("serviceTier"),
    };
  } catch {
    return null;
  }
}

function isNonEmptyJsonArray(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}
