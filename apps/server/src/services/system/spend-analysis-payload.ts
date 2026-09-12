import { createHash } from "node:crypto";
import type { SpendRollupRow } from "@bb/db";

export interface SpendAnalysisPayload {
  payload: string;
  rows: number;
  sha256: string;
  windowFrom: string;
  windowTo: string;
}

export interface BuildSpendAnalysisPayloadArgs {
  coverage: { threads: number; historyComplete: number; historyPartial: number };
  from: string;
  rows: readonly SpendRollupRow[];
  to: string;
}

/**
 * The complete set of fields an analysis request may carry.
 *
 * The guarantee is structural rather than a filter: every value below is read
 * from a column of `fork_thread_spend_daily`, and that table has no column that
 * can hold a prompt, a message, a title, a path, a repository name or a
 * credential. There is no richer object being narrowed here, so there is no
 * narrowing to get wrong, and a later change that widens what leaves the
 * machine has to add a column in a diff someone can see.
 *
 * Thread ids are opaque handles. `thr_4teuv9v346` identifies a row in the local
 * database and carries no content.
 */
export const SPEND_ANALYSIS_PAYLOAD_FIELDS = [
  "day",
  "threadId",
  "providerId",
  "model",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "weightedUnits",
  "turns",
] as const;

const INSTRUCTION = [
  "You are reviewing token usage for a fleet of coding agents.",
  "Each line is one day of one thread on one provider and model.",
  "Fresh input, cached input, output and reasoning output are disjoint counts.",
  "Weighted units apply published price ratios (fresh input 1, cached input",
  "0.1, output 5); they are a cost proxy and not a currency figure.",
  "",
  "Assess where the tokens are going, which threads or models dominate, what",
  "the cache share suggests about context churn, and what would reduce spend",
  "without losing capability. Be specific about which rows support each claim.",
].join("\n");

function formatRow(row: SpendRollupRow): string {
  return [
    row.day,
    row.threadId,
    row.providerId,
    row.model === "" ? "unknown-model" : row.model,
    `in=${row.inputTokens}`,
    `cached=${row.cachedInputTokens}`,
    `out=${row.outputTokens}`,
    `reasoning=${row.reasoningOutputTokens}`,
    `total=${row.totalTokens}`,
    `weighted=${Math.round(row.weightedUnits)}`,
    `turns=${row.turns}`,
  ].join("\t");
}

/**
 * Build the exact bytes an analysis request would send, and their digest.
 *
 * Returned rather than sent so `--dry-run` can print them: what leaves the
 * machine should be something the operator reads, not something the command
 * asserts.
 */
export function buildSpendAnalysisPayload(
  args: BuildSpendAnalysisPayloadArgs,
): SpendAnalysisPayload {
  const lines = [
    INSTRUCTION,
    "",
    `window: ${args.from} to ${args.to} (local calendar days)`,
    `threads with recorded spend: ${args.coverage.threads}`,
    `threads whose earlier usage events were pruned before the rollup existed: ${args.coverage.historyPartial}`,
    "",
    SPEND_ANALYSIS_PAYLOAD_FIELDS.join("\t"),
    ...args.rows.map(formatRow),
  ];
  const payload = lines.join("\n");
  return {
    payload,
    rows: args.rows.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    windowFrom: args.from,
    windowTo: args.to,
  };
}
