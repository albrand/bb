import { describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "../src/index.js";

const INDEX_NAME = "fork_events_item_completion_lookup_idx";
const LIVE_DEFINITION = `CREATE INDEX ${INDEX_NAME} ON events (thread_id, item_id, type, parent_tool_call_id)`;

interface IndexMasterRow {
  rootpage: number;
  sql: string;
  tbl_name: string;
}

interface IndexColumnRow {
  name: string;
}

interface IndexListRow {
  name: string;
  partial: number;
  unique: number;
}

function indexMasterRow(db: DbConnection): IndexMasterRow | undefined {
  return db.$client
    .prepare<
      [string],
      IndexMasterRow
    >("SELECT rootpage, sql, tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(INDEX_NAME);
}

function schemaVersion(db: DbConnection): number {
  return db.$client.pragma("schema_version", { simple: true }) as number;
}

describe("fork item-completion lookup index", () => {
  it("exists on a freshly migrated database with the adopted-open-items lookup columns", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);

      expect(indexMasterRow(db)?.tbl_name).toBe("events");
      const columns = db.$client
        .prepare<[string], IndexColumnRow>(
          "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
        )
        .all(INDEX_NAME)
        .map((column) => column.name);
      expect(columns).toEqual([
        "thread_id",
        "item_id",
        "type",
        "parent_tool_call_id",
      ]);
      const listed = db.$client
        .prepare<[], IndexListRow>(
          "SELECT name, partial, \"unique\" FROM pragma_index_list('events')",
        )
        .all()
        .find((row) => row.name === INDEX_NAME);
      expect(listed).toEqual({ name: INDEX_NAME, partial: 0, unique: 0 });
    } finally {
      db.$client.close();
    }
  });

  it("leaves the schema untouched when migrate runs again on a database that already has the index", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const before = indexMasterRow(db);
      const versionBefore = schemaVersion(db);
      expect(before).toBeDefined();

      migrate(db);

      expect(indexMasterRow(db)).toEqual(before);
      expect(schemaVersion(db)).toBe(versionBefore);
    } finally {
      db.$client.close();
    }
  });

  it("keeps the live hand-created index without rebuilding it", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
      db.$client.exec(LIVE_DEFINITION);
      const before = indexMasterRow(db);
      const versionBefore = schemaVersion(db);

      migrate(db);

      expect(indexMasterRow(db)).toEqual(before);
      expect(before?.sql).toBe(LIVE_DEFINITION);
      expect(schemaVersion(db)).toBe(versionBefore);
    } finally {
      db.$client.close();
    }
  });
});
