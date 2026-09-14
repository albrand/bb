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
