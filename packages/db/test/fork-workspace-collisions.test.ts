import { describe, expect, it } from "vitest";
import { createMigratedConnection } from "./helpers/migrated-connection.js";
import {
  listRecentWorkspaceFiles,
  recordWorkspaceFileChanges,
} from "../src/index.js";

describe("fork workspace collisions", () => {
  it("notices both sides exactly once for one file", () => {
    const db = createMigratedConnection();
    try {
      const first = recordWorkspaceFileChanges(db, {
        hostId: "host",
        workspacePath: "/repo",
        filePaths: ["src/a.ts"],
        candidateThreadIds: ["thread-a"],
        now: 1_000,
      });
      const second = recordWorkspaceFileChanges(db, {
        hostId: "host",
        workspacePath: "/repo",
        filePaths: ["src/a.ts"],
        candidateThreadIds: ["thread-b"],
        now: 1_001,
      });
      const repeat = recordWorkspaceFileChanges(db, {
        hostId: "host",
        workspacePath: "/repo",
        filePaths: ["src/a.ts"],
        candidateThreadIds: ["thread-b"],
        now: 1_002,
      });
      expect(first).toEqual([]);
      expect(second).toEqual([
        {
          filePath: "src/a.ts",
          threadId: "thread-a",
          otherThreadId: "thread-b",
        },
        {
          filePath: "src/a.ts",
          threadId: "thread-b",
          otherThreadId: "thread-a",
        },
      ]);
      expect(
        listRecentWorkspaceFiles(db, {
          hostId: "host",
          workspacePath: "/repo",
          now: 1_002,
        }),
      ).toEqual([
        {
          filePath: "src/a.ts",
          threadIds: ["thread-a", "thread-b"],
          observedAt: 1_002,
        },
      ]);
      expect(repeat).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("does not notice one thread changing many files", () => {
    const db = createMigratedConnection();
    try {
      expect(
        recordWorkspaceFileChanges(db, {
          hostId: "host",
          workspacePath: "/repo",
          filePaths: ["a.ts", "b.ts", "c.ts"],
          candidateThreadIds: ["thread-a"],
          now: 1_000,
        }),
      ).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("notices an ambiguous candidate set once per pair", () => {
    const db = createMigratedConnection();
    try {
      const args = {
        hostId: "host",
        workspacePath: "/repo",
        filePaths: ["a.ts"],
        candidateThreadIds: ["thread-a", "thread-b"],
      };
      expect(recordWorkspaceFileChanges(db, { ...args, now: 1_000 })).toEqual(
        [],
      );
      expect(recordWorkspaceFileChanges(db, { ...args, now: 1_001 })).toEqual([
        { filePath: "a.ts", threadId: "thread-a", otherThreadId: "thread-b" },
        { filePath: "a.ts", threadId: "thread-b", otherThreadId: "thread-a" },
      ]);
      expect(recordWorkspaceFileChanges(db, { ...args, now: 1_002 })).toEqual(
        [],
      );
    } finally {
      db.$client.close();
    }
  });

  it("bounds recent files and expires old observations", () => {
    const db = createMigratedConnection();
    try {
      const filePaths = Array.from({ length: 70 }, (_, index) => `file-${index}.ts`);
      expect(
        recordWorkspaceFileChanges(db, {
          hostId: "host",
          workspacePath: "/repo",
          filePaths,
          candidateThreadIds: ["thread-a"],
          now: 1_000_000,
        }),
      ).toEqual([]);
      expect(
        listRecentWorkspaceFiles(db, {
          hostId: "host",
          workspacePath: "/repo",
          now: 1_000_001,
          limit: 100,
        }),
      ).toHaveLength(64);
      expect(
        listRecentWorkspaceFiles(db, {
          hostId: "host",
          workspacePath: "/repo",
          now: 1_000_000 + 15 * 60_000 + 1,
        }),
      ).toEqual([]);
    } finally {
      db.$client.close();
    }
  });
});
