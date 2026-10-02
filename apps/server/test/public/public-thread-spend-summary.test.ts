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
        threadId: parent.id,
        usage: {
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 2,
          totalTokens: 16,
        },
        weightedUnits: 20,
      });
      applySpendContribution(harness.db, {
        at: 1_780_000_000_100,
        day: "2026-06-01",
        model: "claude-test",
        providerId: "claude-code",
        threadId: parent.id,
        usage: {
          cachedInputTokens: 0,
          inputTokens: 20,
          outputTokens: 8,
          reasoningOutputTokens: 0,
          totalTokens: 28,
        },
        weightedUnits: 40,
      });
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
        providerThreadId: "child-provider",
        threadId: children[0]!.id,
        turnId: "child-turn",
        usage: {
          cachedInputTokens: 20,
          inputTokens: 100,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          totalTokens: 155,
        },
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
      recordThreadTurnSpendContribution(harness.db, {
        at: 1_780_000_000_200,
        providerThreadId: "provider-c",
        threadId: parent.id,
        turnId: "turn-b",
        usage: {
          cachedInputTokens: 0,
          inputTokens: 40,
          outputTokens: 9,
          reasoningOutputTokens: 2,
          totalTokens: 51,
        },
      });
      recordThreadTurnSpendContribution(harness.db, {
        at: 1_780_000_000_300,
        providerThreadId: "provider-c",
        threadId: parent.id,
        turnId: "turn-b",
        usage: {
          cachedInputTokens: 0,
          inputTokens: 5,
          outputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: 8,
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
        inputTokens: 105,
        outputTokens: 34,
        reasoningOutputTokens: null,
        totalTokens: 153,
      });
      expect(spend.turns).toEqual([
        {
          turnId: "turn-b",
          inputTokens: 45,
          cachedInputTokens: 0,
          outputTokens: 11,
          reasoningOutputTokens: 3,
          totalTokens: 59,
        },
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
        totalTokens: null,
      });
      expect((summary.children ?? []).map((child) => child.id)).toEqual(
        children.map((child) => child.id),
      );
    });
  });
});
