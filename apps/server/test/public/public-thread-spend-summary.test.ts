import {
  applySpendContribution,
  ensureSpendTables,
  recordThreadTurnSpendContribution,
} from "@bb/db";
import {
  threadChildSummaryResponseSchema,
  threadSpendSummaryResponseSchema,
} from "@bb/server-contract";
import { turnScope } from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadFixture,
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
          cachedInputTokens: 4,
          inputTokens: 95,
          outputTokens: 31,
          reasoningOutputTokens: 10,
          totalTokens: 140,
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
          inputTokens: 10,
          outputTokens: 3,
          reasoningOutputTokens: 0,
          totalTokens: 13,
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
          cachedInputTokens: 0,
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
        cachedInputTokens: 4,
        inputTokens: 105,
        outputTokens: 34,
        reasoningOutputTokens: 10,
        totalTokens: 153,
      });
      expect(spend.historyComplete).toBe(false);
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
          cachedInputTokens: 4,
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

  it("uses durable Claude cache totals when only recent turns have turn rows", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { providerId: "claude-code" },
      });
      ensureSpendTables(harness.db);
      applySpendContribution(harness.db, {
        at: 1_790_000_000_000,
        day: "2026-10-01",
        model: "claude-opus-test",
        providerId: "claude-code",
        threadId: thread.id,
        usage: {
          cachedInputTokens: 9_000_000,
          inputTokens: 1_000,
          outputTokens: 40_000,
          reasoningOutputTokens: 0,
          totalTokens: 9_041_000,
        },
        weightedUnits: 903_000,
      });
      recordThreadTurnSpendContribution(harness.db, {
        at: 1_790_000_000_000,
        providerThreadId: "claude-provider",
        threadId: thread.id,
        turnId: "recent-turn",
        usage: {
          cachedInputTokens: 2_000_000,
          inputTokens: 50,
          outputTokens: 2_000,
          reasoningOutputTokens: null,
          totalTokens: 2_002_050,
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );
      const spend = threadSpendSummaryResponseSchema.parse(
        await readJson(response),
      );

      expect(spend).toEqual({
        historyComplete: false,
        providerId: "claude-code",
        total: {
          cachedInputTokens: 9_000_000,
          inputTokens: 1_000,
          outputTokens: 40_000,
          reasoningOutputTokens: 0,
          totalTokens: 9_041_000,
        },
        turns: [
          {
            turnId: "recent-turn",
            inputTokens: 50,
            cachedInputTokens: 2_000_000,
            outputTokens: 2_000,
            reasoningOutputTokens: null,
            totalTokens: 2_002_050,
          },
        ],
      });
    });
  });

  it("backfills retained usage for finished turns before returning the summary", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { providerId: "codex" },
      });
      const providerThreadId = "provider-backfill";
      const turnId = "turn-backfill";
      const scope = turnScope(turnId);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 1,
        type: "turn/started",
        scope,
        data: { providerThreadId },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        scope,
        data: {
          providerThreadId,
          tokenUsage: {
            total: {
              totalTokens: 45,
              inputTokens: 20,
              cachedInputTokens: 10,
              cacheReadInputTokens: 10,
              cacheWriteInputTokens: 0,
              outputTokens: 15,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 45,
              inputTokens: 20,
              cachedInputTokens: 10,
              cacheReadInputTokens: 10,
              cacheWriteInputTokens: 0,
              outputTokens: 15,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 200_000,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 3,
        type: "item/completed",
        scope,
        data: {
          providerThreadId,
          item: {
            type: "agentMessage",
            id: "assistant-backfill",
            text: "Finished response",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 4,
        type: "turn/completed",
        scope,
        data: { providerThreadId, status: "completed" },
      });
      ensureSpendTables(harness.db);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );
      const spend = threadSpendSummaryResponseSchema.parse(
        await readJson(response),
      );

      expect(spend.turns).toContainEqual({
        turnId,
        inputTokens: 20,
        cachedInputTokens: 10,
        outputTokens: 15,
        reasoningOutputTokens: null,
        totalTokens: 45,
      });
      expect(spend.total).toEqual({
        cachedInputTokens: 10,
        inputTokens: 20,
        outputTokens: 15,
        reasoningOutputTokens: 0,
        totalTokens: 45,
      });

      const repeatedResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );
      const repeatedSpend = threadSpendSummaryResponseSchema.parse(
        await readJson(repeatedResponse),
      );
      expect(repeatedSpend.total).toEqual(spend.total);
      expect(
        repeatedSpend.turns.filter((turn) => turn.turnId === turnId),
      ).toEqual([
        {
          turnId,
          inputTokens: 20,
          cachedInputTokens: 10,
          outputTokens: 15,
          reasoningOutputTokens: null,
          totalTokens: 45,
        },
      ]);
    });
  });

  it("serves a spend summary without opening a write transaction when no turn needs repair", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { providerId: "codex" },
      });
      ensureSpendTables(harness.db);
      recordThreadTurnSpendContribution(harness.db, {
        at: 1_780_000_000_200,
        providerThreadId: "provider-no-repair",
        threadId: thread.id,
        turnId: "turn-already-recorded",
        usage: {
          cachedInputTokens: 0,
          inputTokens: 20,
          outputTokens: 15,
          reasoningOutputTokens: 0,
          totalTokens: 35,
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-no-repair",
        sequence: 1,
        type: "turn/completed",
        scope: turnScope("turn-already-recorded"),
        data: { providerThreadId: "provider-no-repair", status: "completed" },
      });
      harness.db.$client.exec("PRAGMA query_only = ON");

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );

      expect(response.status).toBe(200);
    });
  });

  it("reads completed turns once per request, with or without a repair", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { providerId: "codex" },
      });
      ensureSpendTables(harness.db);
      recordThreadTurnSpendContribution(harness.db, {
        at: 1_780_000_000_200,
        providerThreadId: "provider-read-count",
        threadId: thread.id,
        turnId: "turn-recorded",
        usage: {
          cachedInputTokens: 0,
          inputTokens: 20,
          outputTokens: 15,
          reasoningOutputTokens: 0,
          totalTokens: 35,
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-read-count",
        sequence: 1,
        type: "turn/completed",
        scope: turnScope("turn-recorded"),
        data: { providerThreadId: "provider-read-count", status: "completed" },
      });
      const prepareSpy = vi.spyOn(harness.db.$client, "prepare");
      const countCompletedTurnReads = () =>
        prepareSpy.mock.calls.filter(
          ([source]) =>
            typeof source === "string" &&
            source.startsWith('select "thread_id", "turn_id" from "events"') &&
            source.includes('"events"."turn_id" is not null'),
        ).length;

      const noRepairResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );
      expect(noRepairResponse.status).toBe(200);
      expect(countCompletedTurnReads()).toBe(1);

      const repairUsage = {
        totalTokens: 45,
        inputTokens: 20,
        cachedInputTokens: 10,
        cacheReadInputTokens: 10,
        cacheWriteInputTokens: 0,
        outputTokens: 15,
        reasoningOutputTokens: 0,
      };
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-read-count",
        sequence: 2,
        type: "thread/tokenUsage/updated",
        scope: turnScope("turn-repaired"),
        data: {
          providerThreadId: "provider-read-count",
          tokenUsage: {
            total: repairUsage,
            last: repairUsage,
            modelContextWindow: 200_000,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-read-count",
        sequence: 3,
        type: "turn/completed",
        scope: turnScope("turn-repaired"),
        data: { providerThreadId: "provider-read-count", status: "completed" },
      });
      prepareSpy.mockClear();

      const repairResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );
      expect(repairResponse.status).toBe(200);
      expect(countCompletedTurnReads()).toBe(1);
      expect(
        threadSpendSummaryResponseSchema.parse(await readJson(repairResponse))
          .turns,
      ).toContainEqual({
        turnId: "turn-repaired",
        inputTokens: 20,
        cachedInputTokens: 10,
        outputTokens: 15,
        reasoningOutputTokens: null,
        totalTokens: 45,
      });

      prepareSpy.mockClear();
      harness.db.$client.exec("PRAGMA query_only = ON");
      const repairedResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );
      expect(repairedResponse.status).toBe(200);
      expect(countCompletedTurnReads()).toBe(1);
      prepareSpy.mockRestore();
    });
  });

  it("rebuilds a missing daily rollup when turn rows already exist", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { providerId: "codex" },
      });
      const providerThreadId = "provider-daily-repair";
      const turnId = "turn-daily-repair";
      const scope = turnScope(turnId);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 1,
        type: "thread/tokenUsage/updated",
        scope,
        data: {
          providerThreadId,
          tokenUsage: {
            total: {
              totalTokens: 45,
              inputTokens: 20,
              cachedInputTokens: 10,
              cacheReadInputTokens: 10,
              cacheWriteInputTokens: 0,
              outputTokens: 15,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 45,
              inputTokens: 20,
              cachedInputTokens: 10,
              cacheReadInputTokens: 10,
              cacheWriteInputTokens: 0,
              outputTokens: 15,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 200_000,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 2,
        type: "turn/completed",
        scope,
        data: { providerThreadId, status: "completed" },
      });
      ensureSpendTables(harness.db);
      recordThreadTurnSpendContribution(harness.db, {
        at: 1_780_000_000_200,
        providerThreadId,
        threadId: thread.id,
        turnId,
        usage: {
          cachedInputTokens: 10,
          inputTokens: 20,
          outputTokens: 15,
          reasoningOutputTokens: null,
          totalTokens: 45,
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );
      const spend = threadSpendSummaryResponseSchema.parse(
        await readJson(response),
      );

      expect(spend.turns).toContainEqual({
        turnId,
        inputTokens: 20,
        cachedInputTokens: 10,
        outputTokens: 15,
        reasoningOutputTokens: null,
        totalTokens: 45,
      });
      expect(spend.total).toEqual({
        cachedInputTokens: 10,
        inputTokens: 20,
        outputTokens: 15,
        reasoningOutputTokens: 0,
        totalTokens: 45,
      });
    });
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "returns an unavailable breakdown for a $status turn without retained usage",
    async (status) => {
      await withTestHarness(async (harness) => {
        const { environment, thread } = seedThreadFixture(harness, {
          thread: { providerId: "acp-hermes-agent" },
        });
        const turnId = `turn-without-usage-${status}`;
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "hermes-provider",
          sequence: 1,
          type: "turn/completed",
          scope: turnScope(turnId),
          data: { providerThreadId: "hermes-provider", status },
        });

        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/spend-summary`,
        );
        const spend = threadSpendSummaryResponseSchema.parse(
          await readJson(response),
        );

        expect(spend.turns).toContainEqual({
          turnId,
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          totalTokens: null,
        });
      });
    },
  );
});
