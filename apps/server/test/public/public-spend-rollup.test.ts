import {
  applySpendContribution,
  ensureSpendTables,
  spendWeightedUnits,
  type SpendUsageBreakdown,
} from "@bb/db";
import {
  spendAnalysisPayloadResponseSchema,
  spendRollupResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

const USAGE: SpendUsageBreakdown = {
  inputTokens: 1_000,
  cachedInputTokens: 9_000,
  outputTokens: 500,
  reasoningOutputTokens: 100,
  totalTokens: 10_500,
};

// Fork (albrand/bb): the spend rollup the server maintains because the events
// behind it are pruned out from under anything that polls for them.
describe("spend rollup route", () => {
  it("groups onto one dimension and reports how partial the history is", async () => {
    await withTestHarness(async (harness) => {
      ensureSpendTables(harness.db);
      for (const day of ["2026-09-10", "2026-09-11"]) {
        for (const model of ["gpt-5", "gpt-5-codex"]) {
          applySpendContribution(harness.db, {
            day,
            model,
            providerId: "codex",
            threadId: "thr_one",
            usage: USAGE,
            weightedUnits: spendWeightedUnits(USAGE),
            at: Date.parse(`${day}T12:00:00Z`),
          });
        }
      }

      const ungrouped = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request("/api/v1/spend/rollup?from=2026-09-01"),
        ),
      );
      expect(ungrouped.rows).toHaveLength(4);

      const byProvider = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/spend/rollup?from=2026-09-01&groupBy=provider",
          ),
        ),
      );
      expect(byProvider.rows).toHaveLength(1);
      expect(byProvider.rows[0]?.providerId).toBe("codex");
      expect(byProvider.rows[0]?.totalTokens).toBe(USAGE.totalTokens * 4);
      // A grouped row keeps a span, not a single time, so a consumer in another
      // timezone can tell whether it straddles its own day boundary.
      expect(byProvider.rows[0]?.firstEventAt).toBeLessThan(
        byProvider.rows[0]?.lastEventAt ?? 0,
      );

      const byModel = spendRollupResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/spend/rollup?from=2026-09-01&groupBy=model",
          ),
        ),
      );
      expect(byModel.rows.map((row) => row.model).sort()).toEqual([
        "gpt-5",
        "gpt-5-codex",
      ]);
    });
  });

  it("rejects a day that is not a calendar day", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/spend/rollup?from=last-tuesday",
      );
      expect(response.status).toBe(400);
    });
  });

  it("returns the analysis payload without sending anything", async () => {
    await withTestHarness(async (harness) => {
      ensureSpendTables(harness.db);
      applySpendContribution(harness.db, {
        day: "2026-09-11",
        model: "gpt-5",
        providerId: "codex",
        threadId: "thr_one",
        usage: USAGE,
        weightedUnits: spendWeightedUnits(USAGE),
        at: Date.parse("2026-09-11T12:00:00Z"),
      });
      const built = spendAnalysisPayloadResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/spend/analysis-payload?from=2026-09-01&to=2026-09-30",
          ),
        ),
      );
      expect(built.rows).toBe(1);
      expect(built.sha256).toHaveLength(64);
      expect(built.payload).toContain("thr_one");
      expect(built.payload).toContain("total=10500");
    });
  });
});
