import type { DbConnection } from "../connection.js";

const THREAD_TURN_SPEND_TABLE = "fork_thread_turn_spend";
const threadTurnSpendTableReady = new WeakSet<object>();

function ensureThreadTurnSpendTable(db: DbConnection): void {
  if (threadTurnSpendTableReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${THREAD_TURN_SPEND_TABLE} (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      total_tokens INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_id, provider_thread_id)
    )
  `);
  const columns = db.$client
    .prepare<[], { name: string }>(`PRAGMA table_info(${THREAD_TURN_SPEND_TABLE})`)
    .all();
  if (!columns.some((column) => column.name === "model")) {
    db.$client.exec(
      `ALTER TABLE ${THREAD_TURN_SPEND_TABLE} ADD COLUMN model TEXT`,
    );
  }
  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS ${THREAD_TURN_SPEND_TABLE}_thread_idx
      ON ${THREAD_TURN_SPEND_TABLE} (thread_id, turn_id)
  `);
  threadTurnSpendTableReady.add(db.$client);
}

export interface ThreadTurnSpendContribution {
  at: number;
  providerThreadId: string;
  threadId: string;
  turnId: string;
  model?: string | null;
  usage: {
    cachedInputTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
    totalTokens: number;
  };
}

export interface ThreadTurnSpendRow {
  turnId: string;
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number;
}

export function recordThreadTurnSpendContribution(
  db: DbConnection,
  contribution: ThreadTurnSpendContribution,
): void {
  ensureThreadTurnSpendTable(db);
  db.$client
    .prepare<
      [string, string, string, string | null, number | null, number | null, number | null, number | null, number, number]
    >(
      `INSERT INTO ${THREAD_TURN_SPEND_TABLE} (
        thread_id, turn_id, provider_thread_id, model, input_tokens,
        cached_input_tokens, output_tokens, reasoning_output_tokens,
        total_tokens, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id, turn_id, provider_thread_id) DO UPDATE SET
        model = CASE
          WHEN model IS NULL THEN excluded.model
          WHEN excluded.model IS NULL OR model = excluded.model THEN model
          ELSE NULL
        END,
        input_tokens = CASE WHEN input_tokens IS NULL OR excluded.input_tokens IS NULL
          THEN NULL ELSE input_tokens + excluded.input_tokens END,
        cached_input_tokens = CASE WHEN cached_input_tokens IS NULL OR excluded.cached_input_tokens IS NULL
          THEN NULL ELSE cached_input_tokens + excluded.cached_input_tokens END,
        output_tokens = CASE WHEN output_tokens IS NULL OR excluded.output_tokens IS NULL
          THEN NULL ELSE output_tokens + excluded.output_tokens END,
        reasoning_output_tokens = CASE WHEN reasoning_output_tokens IS NULL OR excluded.reasoning_output_tokens IS NULL
          THEN NULL ELSE reasoning_output_tokens + excluded.reasoning_output_tokens END,
        total_tokens = total_tokens + excluded.total_tokens,
        updated_at = MAX(updated_at, excluded.updated_at)`,
    )
    .run(
      contribution.threadId,
      contribution.turnId,
      contribution.providerThreadId,
      contribution.model ?? null,
      contribution.usage.inputTokens,
      contribution.usage.cachedInputTokens,
      contribution.usage.outputTokens,
      contribution.usage.reasoningOutputTokens,
      contribution.usage.totalTokens,
      contribution.at,
    );
}

export function listThreadTurnSpend(
  db: DbConnection,
  args: { threadId: string },
): ThreadTurnSpendRow[] {
  ensureThreadTurnSpendTable(db);
  return db
    .$client.prepare<[string], ThreadTurnSpendRow>(
      `SELECT turn_id AS turnId,
        CASE WHEN COUNT(DISTINCT model) = 1 AND COUNT(model) = COUNT(*)
          THEN MIN(model) ELSE NULL END AS model,
        CASE WHEN COUNT(*) = COUNT(input_tokens)
          THEN SUM(input_tokens) ELSE NULL END AS inputTokens,
        CASE WHEN COUNT(*) = COUNT(cached_input_tokens)
          THEN SUM(cached_input_tokens) ELSE NULL END AS cachedInputTokens,
        CASE WHEN COUNT(*) = COUNT(output_tokens)
          THEN SUM(output_tokens) ELSE NULL END AS outputTokens,
        CASE WHEN COUNT(*) = COUNT(reasoning_output_tokens)
          THEN SUM(reasoning_output_tokens) ELSE NULL END AS reasoningOutputTokens,
        SUM(total_tokens) AS totalTokens
      FROM ${THREAD_TURN_SPEND_TABLE}
      WHERE thread_id = ?
      GROUP BY turn_id
      ORDER BY MAX(updated_at) DESC`,
    )
    .all(args.threadId);
}
