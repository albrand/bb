import { and, eq, sql } from "drizzle-orm";
import { events, listSpendRollupRows, type SpendRollupRow } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
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

      // 100, then the same reading re-emitted, then a real 150.
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

      // A repeat in a LATER batch. The guard only holds if the last total was
      // persisted rather than kept in the batch's own memory.
      expect((await post([usage({ total: 250, last: 150 })])).status).toBe(200);
      expect(totalTokens()).toBe(250);

      // The provider process restarts and its running total goes backwards.
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

      // An adopted worker replays unacked lines after a daemon restart, so the
      // server is re-sent events it already stored. Replay-key dedup drops them
      // at the append; the rollup must not count what was never inserted.
      //
      // NOTE: this test does NOT bind the fold's own sequence guard. The dedup
      // stops re-delivery upstream, so the rollup never sees the repeat at all.
      // What binds that guard is "backfills to exactly what the live path
      // recorded", which replays stored events past a cursor that has already
      // passed them. Editing one of these believing it covers the other will
      // leave the guard unprotected.
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
    // The fleet plugin reads usage by polling the event log. If the rollup
    // consumed the event the way `storeExecutionReports` consumes its own, the
    // plugin's numbers would silently go to zero.
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

      // The rollup needed the stored row's timestamp, so `AcceptedDaemonEvent`
      // gained a `createdAt`. That type is server-internal and must stay that
      // way: a stock upstream daemon parses this body against a strict schema,
      // so an extra field would fail it and HOST_DAEMON_PROTOCOL_VERSION is
      // deliberately still 180.
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
    // This is also the test that binds the fold's sequence guard: the second
    // backfill replays events the cursor has already passed. The replay-key
    // test above does not, because dedup stops those events upstream.
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

      // Idempotent: replaying the same history changes nothing.
      const second = backfillSpend(harness.db);
      expect(second.contributionsApplied).toBe(0);
      expect(
        listSpendRollupRows(harness.db, { threadId: thread.id }),
      ).toEqual<SpendRollupRow[]>(backfilled);
    });
  });

  it("keeps a complete thread complete when it spends again", async () => {
    // Every live append saves a cursor, and most have no opinion about whether
    // the thread's early history survived. Writing "not complete" for "no
    // opinion" reset the flag on the next usage event, so coverage converged on
    // "every thread is partial" and said so in the CLI and to Hermes.
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
      // The thread has not reached the pruner's smallest window, so no usage
      // event can have been taken from it and the backfill agrees.
      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      backfillSpend(harness.db);
      expect(historyComplete()).toBe(1);

      expect((await post([usage({ total: 250, last: 150 })])).status).toBe(200);
      expect(historyComplete()).toBe(1);
    });
  });

  it("refuses to call a rewound thread complete", async () => {
    // The pruner is not the only thing that deletes usage events. Editing an
    // earlier message deletes the range after it, and that can happen while the
    // thread is still far short of the pruner's window - so the prune-safe
    // proof would call it complete with tokens missing from its total. A wrong
    // number wearing a certainty badge is the one outcome this work exists to
    // prevent.
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

      // Without the marker this thread is short enough for the prune-safe
      // proof, so the backfill calls it complete.
      harness.db.run(sql`DELETE FROM fork_thread_spend_cursor`);
      backfillSpend(harness.db);
      const completeness = () =>
        harness.db.get<{ historyComplete: number }>(
          sql`SELECT history_complete AS historyComplete
              FROM fork_thread_spend_cursor WHERE thread_id = ${thread.id}`,
        )?.historyComplete;
      expect(completeness()).toBe(1);

      // The rewind marker an edited message leaves behind. It is appended above
      // the range it deletes, so it survives that deletion.
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

      // Push the thread past the pruner's smallest keep-recent window. Below it
      // the pruner provably never ran; above it there is no way to tell from
      // here whether a usage event was taken, so the thread is partial and its
      // total is a floor.
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
