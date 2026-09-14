import { existsSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createConnection, listSpendRollupRows } from "@bb/db";
import { describe, expect, it } from "vitest";
import { backfillSpend } from "../../src/services/system/spend-rollup.js";

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

    const rollupByKey = new Map<string, number>();
    for (const row of listSpendRollupRows(db, {})) {
      const key = `${row.threadId}:${row.providerId}`;
      rollupByKey.set(key, (rollupByKey.get(key) ?? 0) + row.totalTokens);
    }

    const compared: string[] = [];
    const missing: string[] = [];
    let agreed = 0;
    let disagreed = 0;
    let comparedTokens = 0;
    for (const fleetRow of fleetTotals) {
      const mine = rollupByKey.get(
        `${fleetRow.threadId}:${fleetRow.providerId}`,
      );
      if (mine === undefined) {
        missing.push(
          `MISSING thread=${fleetRow.threadId} provider=${fleetRow.providerId} ` +
            `fleet=${fleetRow.totalTokens}`,
        );
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
        `fleet rows restricted to surviving events: pairs=${fleetTotals.length}`,
        `compared pairs=${agreed + disagreed} agreed=${agreed} ` +
          `disagreed=${disagreed} missingFromRollup=${missing.length} ` +
          `tokensCompared=${comparedTokens}`,
        ...compared.slice(0, 50),
        ...missing.slice(0, 50),
        "",
      ].join("\n"),
    );

    expect(agreed + disagreed).toBeGreaterThan(0);
  });
});
