import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { createMigratedConnection } from "../src/testing.js";

const liveSchemaPath = fileURLToPath(
  new URL("./fixtures/fork-live-upgrade-schema.sql", import.meta.url),
);
const oursForkMigrationWhens = [
  1792163858066, 1792183118231, 1792193667184, 1792200133276, 1792262861731,
];
const addedMigrations = [
  {
    createdAt: 1792453324528,
    hash: "9fec044e3b7902083cde83067c20b03b3e71076a25bb3e6a0e56090f2a92ac3c",
  },
  {
    createdAt: 1792693676447,
    hash: "a26f91de1b18228b2739eded945ee5c7bf40886efc1a78818dee7f14a351f32d",
  },
  {
    createdAt: 1792744408107,
    hash: "469d9cc77489ba41e77a885cdd569e776ed015a4d5cdc42959a633ea986af571",
  },
  {
    createdAt: 1792782930987,
    hash: "64a2e5dd1f2ef5c3f824e38d90f3f924550aecc841da7eb04856772a4d5b4c22",
  },
];
const ignoredIndexName = "fork_events_item_completion_lookup_idx";

function schema(db: ReturnType<typeof createConnection>): string[] {
  return db.$client
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY type, name",
    )
    .all()
    .map((row) => {
      const value = row as { type: string; name: string; sql: string };
      return `${value.type} ${value.name} ${value.sql.replace(/\s+/g, " ").trim()}`;
    })
    .filter((entry) => !entry.includes(` ${ignoredIndexName} `));
}

function importLiveSchema(db: ReturnType<typeof createConnection>): void {
  const sql = readFileSync(liveSchemaPath, "utf8").replace(
    /^CREATE TABLE ['"]?thread_search_segments_fts_(?:data|idx|content|docsize|config)['\"]?[^;]*;\s*$/gm,
    "",
  );
  db.$client.exec(sql);
}

describe("upstream database migration reconciliation", () => {
  it("upgrades an ours live schema and matches a fresh migrated database", () => {
    const live = createConnection(":memory:");
    const fresh = createMigratedConnection();
    try {
      importLiveSchema(live);
      const priorForkTables = live.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fork_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      const priorMigrationRows = live.$client
        .prepare(
          "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at",
        )
        .all() as { hash: string; createdAt: number }[];
      const priorMigrationWhens = new Set(
        priorMigrationRows.map((row) => row.createdAt),
      );

      expect(
        oursForkMigrationWhens.filter((when) => priorMigrationWhens.has(when)),
      ).toEqual(oursForkMigrationWhens);
      expect(() => migrate(live)).not.toThrow();

      const addedMigrationRows = (
        live.$client
          .prepare(
            "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at",
          )
          .all() as { hash: string; createdAt: number }[]
      ).filter((row) => !priorMigrationWhens.has(row.createdAt));
      const forkTablesAfter = new Set(
        (
          live.$client
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fork_%' ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((row) => row.name),
      );

      expect(addedMigrationRows).toEqual(addedMigrations);
      expect(
        live.$client
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'terminal_sessions_status_thread_idx'",
          )
          .get(),
      ).toEqual({ name: "terminal_sessions_status_thread_idx" });
      expect(
        priorForkTables.filter((name) => !forkTablesAfter.has(name)),
      ).toEqual([]);
      expect(schema(live)).toEqual(schema(fresh));
    } finally {
      live.$client.close();
      fresh.$client.close();
    }
  });
});
