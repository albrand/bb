import { and, eq, sql } from "drizzle-orm";
import { events, listSpendRollupRows, type SpendRollupRow } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  summarizeTokenWeather,
  threadScope,
  turnScope,
} from "@bb/domain";
import {
  groupHostDaemonEvents,
  hostDaemonEventBatchResponseSchema,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { backfillSpend } from "../../src/services/system/spend-rollup.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

interface Reading {
  cached?: number;
  last: number;
  output?: number;
  total: number;
}

const TURN_ID = "turn-spend-1";
const PROVIDER_THREAD_ID = "provider-thread-spend";

function breakdown(total: number, parts: { cached?: number; output?: number }) {
  const cached = parts.cached ?? 0;
  const output = parts.output ?? 0;
  return {
    inputTokens: Math.max(0, total - cached - output),
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: total,
  };
}

describe("daemon event spend rollup", () => {
  it("records usage once, drops re-emissions, and survives a provider reset", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });

      const turnStarted: HostDaemonEventEnvelope = {
        threadId: thread.id,
        event: {
          type: "turn/started",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
        },
      };
      const usage = (
        reading: Reading,
        replayKey?: string,
      ): HostDaemonEventEnvelope => ({
        threadId: thread.id,
        ...(replayKey === undefined ? {} : { replayKey }),
        event: {
          type: "thread/tokenUsage/updated",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
          tokenUsage: {
            total: breakdown(reading.total, {}),
            last: breakdown(reading.last, {
              cached: reading.cached,
              output: reading.output,
            }),
            modelContextWindow: 258_400,
          },
        },
      });
      const post = (envelopes: HostDaemonEventEnvelope[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(envelopes),
          }),
        });
      const rollup = () =>
        listSpendRollupRows(harness.db, { threadId: thread.id });
      const totalTokens = () =>
        rollup().reduce((sum, row) => sum + row.totalTokens, 0);

      expect((await post([turnStarted])).status).toBe(200);

      expect(
        (
          await post([
            usage({ total: 100, last: 100 }),
            usage({ total: 100, last: 100 }),
            usage({ total: 250, last: 150 }),
          ])
        ).status,
      ).toBe(200);
      expect(totalTokens()).toBe(250);

      expect((await post([usage({ total: 250, last: 150 })])).status).toBe(200);
      expect(totalTokens()).toBe(250);

      expect(
        (
          await post([
            usage({ total: 40, last: 40 }),
            usage({ total: 90, last: 50 }),
          ])
        ).status,
      ).toBe(200);
      expect(totalTokens()).toBe(340);

      expect(rollup().map((row) => row.providerId)).toEqual(["codex"]);
    });
  });

  it("serves native spend totals after usage events have been pruned", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-pruned-spend",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 121,
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        providerThreadId: PROVIDER_THREAD_ID,
        data: {
          contextWindowUsage: {
            usedTokens: 1,
            modelContextWindow: 2,
            estimated: false,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 122,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 122 }),
          input: [{ type: "text", text: "seed" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5-codex",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
                tokenUsage: {
                  total: breakdown(2_105_922, {}),
                  last: breakdown(2_105_922, {
                    cached: 2_100_000,
                    output: 5_900,
                  }),
                  modelContextWindow: 258_400,
                },
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);
      harness.db.run(
        sql`DELETE FROM events WHERE thread_id = ${thread.id}
            AND type = 'thread/tokenUsage/updated'`,
      );
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 124,
        type: "turn/completed",
        scope: turnScope("pruned-turn"),
        providerThreadId: PROVIDER_THREAD_ID,
        data: { status: "completed" },
      });
      harness.db.run(
        sql`UPDATE fork_thread_turn_spend SET model = NULL
            WHERE thread_id = ${thread.id}`,
      );

      const summaryResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/spend-summary`,
      );
      expect(summaryResponse.status).toBe(200);
      const summary = (await summaryResponse.json()) as {
        historyComplete: boolean;
        providerId: string;
        total: {
          inputTokens: number | null;
          cachedInputTokens: number | null;
          outputTokens: number | null;
          reasoningOutputTokens: number | null;
          totalTokens: number | null;
        };
        turns: Array<{
          turnId: string;
          model: string | null;
          inputTokens: number | null;
          cachedInputTokens: number | null;
          outputTokens: number | null;
          reasoningOutputTokens: number | null;
          totalTokens: number | null;
        }>;
      };
      expect(summary.historyComplete).toBe(false);
      expect(summary.total).toEqual({
        inputTokens: 22,
        cachedInputTokens: 2_100_000,
        outputTokens: 5_900,
        reasoningOutputTokens: 0,
        totalTokens: 2_105_922,
      });
      const weather = summarizeTokenWeather({
        totals: summary.total,
        turns: summary.turns.map((turn) => ({
          ...turn,
          providerId: summary.providerId,
        })),
      });
      expect(weather.totals).toEqual(summary.total);
      expect(weather.cacheReuseShare).toBeGreaterThan(0.99);
      expect(weather.weather).toBe("clear");
      expect(summary.turns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ turnId: TURN_ID, model: null }),
          expect.objectContaining({
            turnId: "pruned-turn",
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningOutputTokens: null,
            totalTokens: null,
          }),
        ]),
      );
    });
  });

  it("counts a replayed worker line once", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-replay",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const post = (envelopes: HostDaemonEventEnvelope[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(envelopes),
          }),
        });
      const usage = (
        reading: Reading,
        replayKey: string,
      ): HostDaemonEventEnvelope => ({
        threadId: thread.id,
        replayKey,
        event: {
          type: "thread/tokenUsage/updated",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
          tokenUsage: {
            total: breakdown(reading.total, {}),
            last: breakdown(reading.last, {}),
            modelContextWindow: 258_400,
          },
        },
      });

      expect(
        (
          await post([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
          ])
        ).status,
      ).toBe(200);

      expect(
        (
          await post([
            usage({ total: 100, last: 100 }, "w1:5:0"),
            usage({ total: 250, last: 150 }, "w1:5:1"),
          ])
        ).status,
      ).toBe(200);
      expect(
        (
          await post([
            usage({ total: 100, last: 100 }, "w1:5:0"),
            usage({ total: 250, last: 150 }, "w1:5:1"),
            usage({ total: 400, last: 150 }, "w1:6:0"),
          ])
        ).status,
      ).toBe(200);

      const rows = listSpendRollupRows(harness.db, { threadId: thread.id });
      expect(rows.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(400);
      expect(rows.reduce((sum, row) => sum + row.turns, 0)).toBe(3);
    });
  });

  it("leaves the usage event in the thread's event log", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-observe",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
                tokenUsage: {
                  total: breakdown(100, {}),
                  last: breakdown(100, {}),
                  modelContextWindow: 258_400,
                },
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);

      const stored = harness.db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "thread/tokenUsage/updated"),
          ),
        )
        .all();
      expect(stored).toHaveLength(1);

      const body = hostDaemonEventBatchResponseSchema.parse(
        await response.json(),
      );
      for (const accepted of body.acceptedEvents) {
        expect(Object.keys(accepted).sort()).toEqual([
          "eventIndex",
          "sequence",
          "threadId",
        ]);
      }
    });
  });

  it("backfills to exactly what the live path recorded", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-backfill",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const usage = (reading: Reading): HostDaemonEventEnvelope => ({
        threadId: thread.id,
        event: {
          type: "thread/tokenUsage/updated",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
          tokenUsage: {
            total: breakdown(reading.total, {}),
            last: breakdown(reading.last, {
              cached: reading.cached,
              output: reading.output,
            }),
            modelContextWindow: 258_400,
          },
        },
      });
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            usage({ total: 100, last: 100, cached: 40, output: 10 }),
            usage({ total: 100, last: 100, cached: 40, output: 10 }),
            usage({ total: 250, last: 150, cached: 60, output: 20 }),
            usage({ total: 40, last: 40, output: 5 }),
            usage({ total: 90, last: 50, cached: 10, output: 5 }),
          ]),
        }),
      });
      expect(response.status).toBe(200);

      const live = listSpendRollupRows(harness.db, { threadId: thread.id });
      expect(live.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(340);

      const clear = () => {
        harness.db.run(sql`DELETE FROM fork_thread_spend_daily`);
        harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      };

      clear();
      expect(listSpendRollupRows(harness.db, { threadId: thread.id })).toEqual(
        [],
      );

      const first = backfillSpend(harness.db);
      expect(first.usageEventsScanned).toBe(5);
      const backfilled = listSpendRollupRows(harness.db, {
        threadId: thread.id,
      });
      expect(backfilled).toEqual(live);

      const second = backfillSpend(harness.db);
      expect(second.contributionsApplied).toBe(0);
      expect(listSpendRollupRows(harness.db, { threadId: thread.id })).toEqual<
        SpendRollupRow[]
      >(backfilled);
    });
  });

  it("keeps a complete thread complete when it spends again", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-keeps",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const usage = (reading: Reading): HostDaemonEventEnvelope => ({
        threadId: thread.id,
        event: {
          type: "thread/tokenUsage/updated",
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
          tokenUsage: {
            total: breakdown(reading.total, {}),
            last: breakdown(reading.last, {}),
            modelContextWindow: 258_400,
          },
        },
      });
      const post = (envelopes: HostDaemonEventEnvelope[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(envelopes),
          }),
        });
      const historyComplete = () =>
        harness.db.get<{ historyComplete: number }>(
          sql`SELECT history_complete AS historyComplete
              FROM fork_thread_spend_cursor WHERE thread_id = ${thread.id}`,
        )?.historyComplete;

      expect(
        (
          await post([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            usage({ total: 100, last: 100 }),
          ])
        ).status,
      ).toBe(200);
      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      backfillSpend(harness.db);
      expect(historyComplete()).toBe(1);

      expect((await post([usage({ total: 250, last: 150 })])).status).toBe(200);
      expect(historyComplete()).toBe(1);
    });
  });

  it("refuses to call a resumed thread complete when its history is gone", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-resume",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const spend = (
        turnId: string,
        total: number,
      ): HostDaemonEventEnvelope[] => [
        {
          threadId: thread.id,
          event: {
            type: "turn/started",
            threadId: thread.id,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(turnId),
          },
        },
        {
          threadId: thread.id,
          event: {
            type: "thread/tokenUsage/updated",
            threadId: thread.id,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(turnId),
            tokenUsage: {
              total: breakdown(total, {}),
              last: breakdown(total, {}),
              modelContextWindow: 258_400,
            },
          },
        },
      ];
      const post = (envelopes: HostDaemonEventEnvelope[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(envelopes),
          }),
        });

      expect((await post(spend("turn-old", 900))).status).toBe(200);

      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      harness.db.run(sql`DELETE FROM fork_thread_spend_daily`);
      harness.db.run(
        sql`DELETE FROM events WHERE thread_id = ${thread.id}
              AND type = 'thread/tokenUsage/updated'`,
      );
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2000,
        type: "provider/warning",
        scope: threadScope(),
        data: {
          providerThreadId: PROVIDER_THREAD_ID,
          category: "general",
          summary: "length",
        },
      });

      expect((await post(spend("turn-new", 500))).status).toBe(200);

      const cursor = harness.db.get<{ historyComplete: number }>(
        sql`SELECT history_complete AS historyComplete
            FROM fork_thread_spend_cursor WHERE thread_id = ${thread.id}`,
      );
      const rolledUp = listSpendRollupRows(harness.db, {
        threadId: thread.id,
      }).reduce((sum, row) => sum + row.totalTokens, 0);

      expect(rolledUp).toBe(500);
      expect(cursor?.historyComplete).toBe(0);
    });
  });

  it("refuses to call a rewound thread complete", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-rewind",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
                tokenUsage: {
                  total: breakdown(100, {}),
                  last: breakdown(100, {}),
                  modelContextWindow: 258_400,
                },
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);

      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      backfillSpend(harness.db);
      const completeness = () =>
        harness.db.get<{ historyComplete: number }>(
          sql`SELECT history_complete AS historyComplete
              FROM fork_thread_spend_cursor WHERE thread_id = ${thread.id}`,
        )?.historyComplete;
      expect(completeness()).toBe(1);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 50,
        type: "system/operation",
        scope: threadScope(),
        data: {
          operation: "edit_message",
          status: "completed",
          message: "Message edited",
          operationId: "op-rewind",
          metadata: { cutoffSequence: 2, oldMaxSequence: 2 },
        },
      });
      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      backfillSpend(harness.db);
      expect(completeness()).toBe(0);
    });
  });

  it("marks a thread whose usage history was pruned as incomplete", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-spend-coverage",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: PROVIDER_THREAD_ID,
                scope: turnScope(TURN_ID),
                tokenUsage: {
                  total: breakdown(100, {}),
                  last: breakdown(100, {}),
                  modelContextWindow: 258_400,
                },
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 500,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 500 }),
          input: [{ type: "text", text: "more" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      backfillSpend(harness.db);
      const complete = harness.db.get<{ historyComplete: number }>(
        sql`SELECT history_complete AS historyComplete
            FROM fork_thread_spend_cursor WHERE thread_id = ${thread.id}`,
      );
      expect(complete?.historyComplete).toBe(0);
    });
  });
});
