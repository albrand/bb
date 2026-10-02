import { and, eq, sql } from "drizzle-orm";
import { threadTurnSpend } from "../schema.js";
import type { DbQueryConnection } from "../connection.js";

export interface ThreadTurnSpendContribution {
  at: number;
  providerThreadId: string;
  threadId: string;
  turnId: string;
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
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number;
}

export function recordThreadTurnSpendContribution(
  db: DbQueryConnection,
  contribution: ThreadTurnSpendContribution,
): void {
  db.run(sql`INSERT INTO thread_turn_spend (
      thread_id, turn_id, provider_thread_id, input_tokens,
      cached_input_tokens, output_tokens, reasoning_output_tokens,
      total_tokens, updated_at
    ) VALUES (
      ${contribution.threadId}, ${contribution.turnId},
      ${contribution.providerThreadId}, ${contribution.usage.inputTokens},
      ${contribution.usage.cachedInputTokens}, ${contribution.usage.outputTokens},
      ${contribution.usage.reasoningOutputTokens},
      ${contribution.usage.totalTokens}, ${contribution.at}
    ) ON CONFLICT (thread_id, turn_id, provider_thread_id) DO UPDATE SET
      input_tokens = CASE WHEN input_tokens IS NULL OR excluded.input_tokens IS NULL
        THEN NULL ELSE input_tokens + excluded.input_tokens END,
      cached_input_tokens = CASE WHEN cached_input_tokens IS NULL OR excluded.cached_input_tokens IS NULL
        THEN NULL ELSE cached_input_tokens + excluded.cached_input_tokens END,
      output_tokens = CASE WHEN output_tokens IS NULL OR excluded.output_tokens IS NULL
        THEN NULL ELSE output_tokens + excluded.output_tokens END,
      reasoning_output_tokens = CASE WHEN reasoning_output_tokens IS NULL OR excluded.reasoning_output_tokens IS NULL
        THEN NULL ELSE reasoning_output_tokens + excluded.reasoning_output_tokens END,
      total_tokens = total_tokens + excluded.total_tokens,
      updated_at = MAX(updated_at, excluded.updated_at)`);
}

export function listThreadTurnSpend(
  db: DbQueryConnection,
  args: { threadId: string },
): ThreadTurnSpendRow[] {
  return db
    .select({
      turnId: threadTurnSpend.turnId,
      inputTokens: sql<number | null>`CASE WHEN COUNT(*) = COUNT(${threadTurnSpend.inputTokens})
        THEN SUM(${threadTurnSpend.inputTokens}) ELSE NULL END`,
      cachedInputTokens: sql<number | null>`CASE WHEN COUNT(*) = COUNT(${threadTurnSpend.cachedInputTokens})
        THEN SUM(${threadTurnSpend.cachedInputTokens}) ELSE NULL END`,
      outputTokens: sql<number | null>`CASE WHEN COUNT(*) = COUNT(${threadTurnSpend.outputTokens})
        THEN SUM(${threadTurnSpend.outputTokens}) ELSE NULL END`,
      reasoningOutputTokens: sql<number | null>`CASE WHEN COUNT(*) = COUNT(${threadTurnSpend.reasoningOutputTokens})
        THEN SUM(${threadTurnSpend.reasoningOutputTokens}) ELSE NULL END`,
      totalTokens: sql<number>`SUM(${threadTurnSpend.totalTokens})`,
    })
    .from(threadTurnSpend)
    .where(and(eq(threadTurnSpend.threadId, args.threadId)))
    .groupBy(threadTurnSpend.turnId)
    .orderBy(sql`MAX(${threadTurnSpend.updatedAt}) DESC`)
    .all();
}
