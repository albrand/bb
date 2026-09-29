import { sql, type SQL } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";

export interface SearchStoredPromptHistoryArgs {
  limit: number;
  projectId: string | null;
  terms: readonly string[];
}

export interface StoredPromptHistorySearchRow {
  id: string;
  input: string;
  lastUsedAt: number;
  projectId: string;
  projectName: string;
  threadId: string;
  threadTitle: string | null;
  useCount: number;
}

function likeContainsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
}

function termCondition(term: string): SQL {
  return sql`AND EXISTS (
    SELECT 1 FROM json_each(p.input) AS item
    WHERE json_extract(item.value, '$.type') = 'text'
      AND json_extract(item.value, '$.text') LIKE ${likeContainsPattern(term)} ESCAPE '\\'
  )`;
}

export function searchStoredPromptHistoryRows(
  db: DbQueryConnection,
  args: SearchStoredPromptHistoryArgs,
): StoredPromptHistorySearchRow[] {
  const projectCondition =
    args.projectId === null ? sql`` : sql`AND p.project_id = ${args.projectId}`;
  const termConditions = sql.join(args.terms.map(termCondition), sql` `);
  return db.all<StoredPromptHistorySearchRow>(sql`
    SELECT
      p.id AS id,
      p.input AS input,
      max(p.created_at) AS lastUsedAt,
      count(*) AS useCount,
      p.project_id AS projectId,
      pr.name AS projectName,
      p.thread_id AS threadId,
      coalesce(t.title, t.title_fallback) AS threadTitle
    FROM prompt_history_entries AS p
    INNER JOIN threads AS t ON t.id = p.thread_id
    INNER JOIN projects AS pr ON pr.id = p.project_id
    WHERE t.deleted_at IS NULL
      AND pr.deleted_at IS NULL
      ${projectCondition}
      ${termConditions}
    GROUP BY p.input
    ORDER BY lastUsedAt DESC, p.id DESC
    LIMIT ${args.limit}
  `);
}
