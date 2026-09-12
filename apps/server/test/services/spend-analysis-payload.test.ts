import type { SpendRollupRow } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  buildSpendAnalysisPayload,
  SPEND_ANALYSIS_PAYLOAD_FIELDS,
} from "../../src/services/system/spend-analysis-payload.js";

const ROW: SpendRollupRow = {
  day: "2026-09-11",
  threadId: "thr_4teuv9v346",
  providerId: "codex",
  model: "gpt-5",
  inputTokens: 21_475,
  cachedInputTokens: 4_224,
  outputTokens: 800,
  reasoningOutputTokens: 120,
  totalTokens: 26_499,
  weightedUnits: 25_897.4,
  turns: 3,
  firstEventAt: 1_789_000_000_000,
  lastEventAt: 1_789_000_900_000,
};

const COVERAGE = { threads: 12, historyComplete: 5, historyPartial: 7 };

function build(rows: SpendRollupRow[]) {
  return buildSpendAnalysisPayload({
    coverage: COVERAGE,
    from: "2026-09-01",
    rows,
    to: "2026-09-11",
  });
}

describe("spend analysis payload", () => {
  it("carries only ids, providers, models, counts and dates", () => {
    // The guarantee is that the payload is built from rollup columns, none of
    // which can hold prose. This pins it: a row's data line has exactly one
    // field per declared column and nothing else.
    const built = build([ROW]);
    const lines = built.payload.split("\n");
    const header = lines.find((line) =>
      line.startsWith(SPEND_ANALYSIS_PAYLOAD_FIELDS[0]),
    );
    expect(header?.split("\t")).toEqual([...SPEND_ANALYSIS_PAYLOAD_FIELDS]);

    const dataLine = lines[lines.length - 1];
    expect(dataLine?.split("\t")).toHaveLength(
      SPEND_ANALYSIS_PAYLOAD_FIELDS.length,
    );
    expect(dataLine).toBe(
      "2026-09-11\tthr_4teuv9v346\tcodex\tgpt-5\tin=21475\tcached=4224\tout=800\treasoning=120\ttotal=26499\tweighted=25897\tturns=3",
    );
  });

  it("never carries a field the rollup does not store", () => {
    // A regression guard for the day someone adds a title or a path to the
    // rollup and the payload starts carrying it silently.
    const built = build([ROW]);
    const forbidden = [
      "prompt",
      "message",
      "title",
      "path",
      "branch",
      "environment",
      "token=",
      "secret",
      "@",
    ];
    for (const needle of forbidden) {
      expect(built.payload.includes(needle)).toBe(false);
    }
  });

  it("says how much of the history is a floor rather than a total", () => {
    const built = build([ROW]);
    expect(built.payload).toContain("pruned before the rollup existed: 7");
  });

  it("digests exactly what it returns, and changes when a count changes", () => {
    const built = build([ROW]);
    const changed = build([{ ...ROW, totalTokens: ROW.totalTokens + 1 }]);
    expect(built.sha256).toHaveLength(64);
    expect(changed.sha256).not.toBe(built.sha256);
    expect(built.rows).toBe(1);
  });
});
