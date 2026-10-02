import { describe, expect, it } from "vitest";
import { createConnection, migrate } from "../../src/index.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  listThreadTurnSpend,
  recordThreadTurnSpendContribution,
} from "../../src/data/thread-turn-spend.js";

function hasTable(db: ReturnType<typeof createConnection>, name: string): boolean {
  return (
    db.$client
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

describe("thread turn spend runtime table", () => {
  it("returns unavailable before writes and creates its table on the first write", () => {
    const readDb = createConnection(":memory:");
    try {
      migrate(readDb);
      expect(hasTable(readDb, "fork_thread_turn_spend")).toBe(false);
      expect(listThreadTurnSpend(readDb, { threadId: "thread-read" })).toEqual(
        [],
      );
    } finally {
      readDb.$client.close();
    }

    const writeDb = createConnection(":memory:");
    try {
      migrate(writeDb);
      const host = upsertHost(writeDb, noopNotifier, { name: "test-host" });
      const { project } = createProject(writeDb, noopNotifier, {
        name: "test-project",
        source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
      });
      const thread = createThread(writeDb, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      expect(hasTable(writeDb, "fork_thread_turn_spend")).toBe(false);
      recordThreadTurnSpendContribution(writeDb, {
        at: 10,
        providerThreadId: "provider-thread-1",
        threadId: thread.id,
        turnId: "turn-1",
        usage: {
          cachedInputTokens: null,
          inputTokens: 100,
          outputTokens: 20,
          reasoningOutputTokens: null,
          totalTokens: 120,
        },
      });
      expect(hasTable(writeDb, "fork_thread_turn_spend")).toBe(true);
      expect(listThreadTurnSpend(writeDb, { threadId: thread.id })).toEqual(
        [
          {
            turnId: "turn-1",
            inputTokens: 100,
            cachedInputTokens: null,
            outputTokens: 20,
            reasoningOutputTokens: null,
            totalTokens: 120,
          },
        ],
      );
    } finally {
      writeDb.$client.close();
    }
  });
});
