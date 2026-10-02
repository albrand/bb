import {
  applySpendContribution,
  ensureSpendTables,
  recordThreadTurnSpendContribution,
} from "@bb/db";
import {
  threadChildSummaryResponseSchema,
  threadSpendSummaryResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public thread spend summaries", () => {
  it("returns durable token kinds and child counts for mixed child states", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const parent = seedThread(harness.deps, { projectId: project.id });
      const children = [
        seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: parent.id,
          status: "active",
        }),
        seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: parent.id,
          status: "pending",
        }),
        seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: parent.id,
          status: "idle",
        }),
        seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: parent.id,
          status: "error",
        }),
      ];

      ensureSpendTables(harness.db);
      applySpendContribution(harness.db, {
        at: 1_780_000_000_000,
        day: "2026-06-01",
        model: "gpt-test",
        providerId: "codex",
        threadId: children[0]!.id,
        usage: {
          cachedInputTokens: 20,
          inputTokens: 100,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          totalTokens: 155,
        },
        weightedUnits: 250,
      });
      recordThreadTurnSpendContribution(harness.db, {
        at: 1_780_000_000_000,
        providerThreadId: "provider-a",
        threadId: parent.id,
        turnId: "turn-a",
        usage: {
          cachedInputTokens: 4,
          inputTokens: 50,
          outputTokens: 20,
          reasoningOutputTokens: 7,
          totalTokens: 81,
        },
      });
      recordThreadTurnSpendContribution(harness.db, {
        at: 1_780_000_000_100,
        providerThreadId: "provider-b",
        threadId: parent.id,
        turnId: "turn-a",
        usage: {
          cachedInputTokens: null,
          inputTokens: 10,
          outputTokens: 3,
          reasoningOutputTokens: null,
          totalTokens: 13,
        },
      });

      const spendResponse = await harness.app.request(
        `/api/v1/threads/${parent.id}/spend-summary`,
      );
      expect(spendResponse.status).toBe(200);
      const spend = threadSpendSummaryResponseSchema.parse(
        await readJson(spendResponse),
      );
      expect(spend.total).toEqual({
        cachedInputTokens: null,
        inputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        totalTokens: null,
      });
      expect(spend.turns).toEqual([
        {
          turnId: "turn-a",
          inputTokens: 60,
          cachedInputTokens: null,
          outputTokens: 23,
          reasoningOutputTokens: null,
          totalTokens: 94,
        },
      ]);

      const childResponse = await harness.app.request(
        `/api/v1/threads/${parent.id}/child-summary`,
      );
      expect(childResponse.status).toBe(200);
      const summary = threadChildSummaryResponseSchema.parse(
        await readJson(childResponse),
      );
      expect(summary).toMatchObject({
        nonDeletedChildCount: 4,
        working: 1,
        waiting: 1,
        idle: 1,
        failed: 1,
        totalTokens: 155,
      });
      expect((summary.children ?? []).map((child) => child.id)).toEqual(
        children.map((child) => child.id),
      );
    });
  });
});
