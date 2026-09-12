import { existsSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createConnection, listSpendRollupRows } from "@bb/db";
import { describe, expect, it } from "vitest";
import { backfillSpend } from "../../src/services/system/spend-rollup.js";

/**
 * Does the native rollup agree with the fleet plugin's ledger?
 *
 * The two cannot be compared on totals: the plugin polls `events.list` and has
 * been running for weeks, so it holds usage the pruner has since deleted, and
 * its ledger covers threads bb no longer has. Comparing those totals measures
 * how long each has been running, not whether either is right.
 *
 * What IS comparable is the arithmetic. Restrict the plugin's rows to the exact
 * event sequences that still survive in bb's event store, and both sides have
 * been given the same input. Any difference is then a disagreement about how to
 * count - the repeat guard, the reset rule, which field to sum - and that is
 * the thing worth knowing before the panels are repointed.
 *
 * Skipped unless pointed at snapshots, because it reads real databases:
 *
 *   sqlite3 ~/.bb/bb.db ".backup '/tmp/bb-snapshot.db'"
 *   sqlite3 ~/.bb/plugins/fleet/data.db ".backup '/tmp/fleet-snapshot.db'"
 *   BB_SPEND_LEDGER_BB=/tmp/bb-snapshot.db \
 *     BB_SPEND_LEDGER_FLEET=/tmp/fleet-snapshot.db \
 *     npx vitest run test/internal/spend-ledger-agreement.test.ts --root apps/server
 *
 * Use copies. The backfill writes, and the live database must not be touched.
 */
const BB_DB = process.env.BB_SPEND_LEDGER_BB;
const FLEET_DB = process.env.BB_SPEND_LEDGER_FLEET;
const OUT = process.env.BB_SPEND_LEDGER_OUT ?? "/tmp/spend-ledger.txt";

const ENABLED =
  BB_DB !== undefined &&
  FLEET_DB !== undefined &&
  existsSync(BB_DB) &&
  existsSync(FLEET_DB);

interface ThreadTotal {
  threadId: string;
  providerId: string;
  totalTokens: number;
}

describe.skipIf(!ENABLED)("spend rollup versus fleet ledger", () => {
  it("counts identical input identically", () => {
    const db = createConnection(BB_DB as string);
    const result = backfillSpend(db);

    // The plugin's rows, restricted to the usage events bb still has. Its `seq`
    // is bb's own event sequence, which is what makes the restriction exact.
    db.run(sql`ATTACH DATABASE ${FLEET_DB as string} AS fleet`);
    const fleetTotals = db.all<ThreadTotal>(
      sql`SELECT turns.thread_id AS threadId,
                 turns.provider_id AS providerId,
                 SUM(turns.total_tokens) AS totalTokens
          FROM fleet.token_turns turns
          WHERE turns.estimated = 0
            AND EXISTS (
              SELECT 1 FROM events surviving
              WHERE surviving.thread_id = turns.thread_id
                AND surviving.sequence = turns.seq
                AND surviving.type = 'thread/tokenUsage/updated'
            )
          GROUP BY turns.thread_id, turns.provider_id`,
    );

    const rollupByThread = new Map<string, number>();
    for (const row of listSpendRollupRows(db, {})) {
      rollupByThread.set(
        row.threadId,
        (rollupByThread.get(row.threadId) ?? 0) + row.totalTokens,
      );
    }

    const compared: string[] = [];
    let agreed = 0;
    let disagreed = 0;
    let comparedTokens = 0;
    for (const fleetRow of fleetTotals) {
      const mine = rollupByThread.get(fleetRow.threadId);
      if (mine === undefined) {
        continue;
      }
      comparedTokens += fleetRow.totalTokens;
      if (mine === fleetRow.totalTokens) {
        agreed += 1;
        continue;
      }
      disagreed += 1;
      compared.push(
        `DIFF thread=${fleetRow.threadId} provider=${fleetRow.providerId} ` +
          `fleet=${fleetRow.totalTokens} rollup=${mine} ` +
          `delta=${mine - fleetRow.totalTokens}`,
      );
    }

    writeFileSync(
      OUT,
      [
        `backfill: threads=${result.threadsScanned} ` +
          `usageEvents=${result.usageEventsScanned} ` +
          `contributions=${result.contributionsApplied} ` +
          `complete=${result.threadsHistoryComplete} ` +
          `partial=${result.threadsHistoryPartial}`,
        `fleet rows restricted to surviving events: threads=${fleetTotals.length}`,
        `compared threads=${agreed + disagreed} agreed=${agreed} ` +
          `disagreed=${disagreed} tokensCompared=${comparedTokens}`,
        ...compared.slice(0, 50),
        "",
      ].join("\n"),
    );

    expect(agreed + disagreed).toBeGreaterThan(0);
  });
});
