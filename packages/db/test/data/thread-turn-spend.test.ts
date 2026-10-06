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
        model: "gpt-5-codex",
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
            model: "gpt-5-codex",
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

  it("adds model metadata to an existing spend table without losing rows", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, { name: "test-host" });
      const { project } = createProject(db, noopNotifier, {
        name: "test-project",
        source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
      });
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      db.$client.exec(`
        CREATE TABLE fork_thread_turn_spend (
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          provider_thread_id TEXT NOT NULL,
          input_tokens INTEGER,
          cached_input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_output_tokens INTEGER,
          total_tokens INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (thread_id, turn_id, provider_thread_id)
        )
      `);
      db.$client
        .prepare(
          `INSERT INTO fork_thread_turn_spend (
            thread_id, turn_id, provider_thread_id, input_tokens,
            cached_input_tokens, output_tokens, reasoning_output_tokens,
            total_tokens, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(thread.id, "turn-legacy", "provider-thread-1", 100, 0, 20, 0, 120, 10);

      recordThreadTurnSpendContribution(db, {
        at: 11,
        model: "gpt-5-codex",
        providerThreadId: "provider-thread-1",
        threadId: thread.id,
        turnId: "turn-new",
        usage: {
          cachedInputTokens: 5,
          inputTokens: 100,
          outputTokens: 20,
          reasoningOutputTokens: 0,
          totalTokens: 125,
        },
      });

      expect(
        listThreadTurnSpend(db, { threadId: thread.id }).map((row) => ({
          model: row.model,
          turnId: row.turnId,
        })),
      ).toEqual([
        { turnId: "turn-new", model: "gpt-5-codex" },
        { turnId: "turn-legacy", model: null },
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("keeps mixed-model turns unknown after later contributions", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, { name: "test-host" });
      const { project } = createProject(db, noopNotifier, {
        name: "test-project",
        source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
      });
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const record = (model: string, at: number) =>
        recordThreadTurnSpendContribution(db, {
          at,
          model,
          providerThreadId: "provider-thread-1",
          threadId: thread.id,
          turnId: "turn-mixed",
          usage: {
            cachedInputTokens: 0,
            inputTokens: 100,
            outputTokens: 20,
            reasoningOutputTokens: 0,
            totalTokens: 120,
          },
        });

      record("model-a", 10);
      record("model-b", 11);
      record("model-b", 12);

      expect(listThreadTurnSpend(db, { threadId: thread.id })[0]?.model).toBe(
        null,
      );
    } finally {
      db.$client.close();
    }
  });
});
