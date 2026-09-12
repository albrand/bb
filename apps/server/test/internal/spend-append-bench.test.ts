import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { initDb } from "../../src/db.js";
import { migrate } from "@bb/db";

/**
 * What the spend rollup costs the append path, measured rather than asserted.
 *
 * Skipped by default because it is a measurement, not a test - nothing here has
 * a pass or fail. Run it with `BB_SPEND_BENCH=1` and read `BB_SPEND_BENCH_OUT`
 * (default /tmp/spend-bench.txt):
 *
 *   BB_SPEND_BENCH=1 npx vitest run test/internal/spend-append-bench.test.ts \
 *     --root apps/server
 *
 * To get the no-hook baseline, comment out the `recordSpendForInsertedEvents`
 * call in `apps/server/src/internal/events.ts` and run it again.
 *
 * Two configurations, because they answer different questions. The harness's
 * in-memory database has no WAL commit and no fsync, so it isolates the
 * rollup's own work but overstates it as a fraction of a real append.
 * `BB_SPEND_BENCH_FILE=1` puts the harness database on disk in WAL mode, which
 * is what a running bb does, and is the number to quote as a production cost.
 */
const ENABLED = process.env.BB_SPEND_BENCH === "1";
const ON_DISK = process.env.BB_SPEND_BENCH_FILE === "1";
const OUT = process.env.BB_SPEND_BENCH_OUT ?? "/tmp/spend-bench.txt";
const BATCHES = Number.parseInt(process.env.BB_SPEND_BENCH_BATCHES ?? "200", 10);
const EVENTS_PER_BATCH = Number.parseInt(
  process.env.BB_SPEND_BENCH_EVENTS ?? "10",
  10,
);

describe.skipIf(!ENABLED)("spend append latency", () => {
  it("times batches of usage events", { timeout: 600_000 }, async () => {
    const directory = ON_DISK
      ? mkdtempSync(path.join(tmpdir(), "spend-bench-"))
      : null;
    try {
      const fileDb =
        directory === null ? null : initDb(path.join(directory, "bench.db"));
      if (fileDb !== null) {
        migrate(fileDb);
      }
      await withTestHarness(
        fileDb === null ? {} : { db: fileDb },
        async (harness) => {
          const { host, session } = seedHostSession(harness.deps, {
            id: "host-bench",
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
          const turnId = "turn-bench";
          const post = (envelopes: HostDaemonEventEnvelope[]) =>
            harness.app.request("/internal/session/events", {
              method: "POST",
              headers: internalAuthHeaders(harness, { hostId: host.id }),
              body: JSON.stringify({
                sessionId: session.id,
                eventGroups: groupHostDaemonEvents(envelopes),
              }),
            });
          await post([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "pt-bench",
                scope: turnScope(turnId),
              },
            },
          ]);

          let running = 0;
          const durations: number[] = [];
          for (let batch = 0; batch < BATCHES; batch += 1) {
            const envelopes: HostDaemonEventEnvelope[] = [];
            for (let n = 0; n < EVENTS_PER_BATCH; n += 1) {
              running += 1_000;
              envelopes.push({
                threadId: thread.id,
                event: {
                  type: "thread/tokenUsage/updated",
                  threadId: thread.id,
                  providerThreadId: "pt-bench",
                  scope: turnScope(turnId),
                  tokenUsage: {
                    total: {
                      inputTokens: running,
                      cachedInputTokens: 0,
                      outputTokens: 0,
                      reasoningOutputTokens: 0,
                      totalTokens: running,
                    },
                    last: {
                      inputTokens: 1_000,
                      cachedInputTokens: 0,
                      outputTokens: 0,
                      reasoningOutputTokens: 0,
                      totalTokens: 1_000,
                    },
                    modelContextWindow: 258_400,
                  },
                },
              });
            }
            const started = performance.now();
            await post(envelopes);
            durations.push(performance.now() - started);
          }
          durations.sort((a, b) => a - b);
          const total = durations.reduce((sum, value) => sum + value, 0);
          const at = (fraction: number) =>
            (durations[Math.floor(durations.length * fraction)] ?? 0).toFixed(2);
          appendFileSync(
            OUT,
            `BENCH db=${ON_DISK ? "file-wal" : "memory"} batches=${BATCHES} ` +
              `eventsPerBatch=${EVENTS_PER_BATCH} ` +
              `meanMs=${(total / BATCHES).toFixed(3)} p50Ms=${at(0.5)} ` +
              `p95Ms=${at(0.95)} ` +
              `maxMs=${(durations[durations.length - 1] ?? 0).toFixed(2)}\n`,
          );
        },
      );
    } finally {
      if (directory !== null) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
