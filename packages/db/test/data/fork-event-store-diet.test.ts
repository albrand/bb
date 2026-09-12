import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbConnection } from "../../src/connection.js";
import { createEventId } from "../../src/ids.js";
import { noopNotifier } from "../../src/notifier.js";
import { prepareCompletedEventOutputData } from "../../src/data/retained-event-outputs.js";
import {
  COMPLETED_EVENT_OUTPUT_RETENTION_MS,
  getCompletedEventOutputTruncationLimits,
} from "../../src/retained-event-output.js";
import {
  FILE_CHANGE_DIFF_RETAINED_HEAD_CHARS,
  FILE_CHANGE_DIFF_RETAINED_TAIL_CHARS,
  FILE_CHANGE_DIFF_TRUNCATION_MARKER,
  FILE_CHANGE_DIFF_TRUNCATION_THRESHOLD_CHARS,
  truncateFileChangeDiffs,
} from "../../src/data/fork-file-change-truncation.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { events } from "../../src/schema.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "idle",
  });
  return { db, thread };
}

interface InsertItemEventArgs {
  createdAt: number;
  db: DbConnection;
  item: object;
  itemId: string;
  itemKind: string;
  sequence: number;
  threadId: string;
  type: "item/started" | "item/completed";
}

function insertItemEvent(args: InsertItemEventArgs): string {
  const id = createEventId();
  args.db
    .insert(events)
    .values({
      id,
      threadId: args.threadId,
      scopeKind: "turn",
      turnId: "turn_1",
      providerThreadId: "provider-thread-1",
      sequence: args.sequence,
      type: args.type,
      itemId: args.itemId,
      itemKind: args.itemKind as "commandExecution",
      data: JSON.stringify({
        item: args.item,
        providerThreadId: "provider-thread-1",
        threadId: args.threadId,
        type: args.type,
      }),
      createdAt: args.createdAt,
    })
    .run();
  return id;
}

function readItem(db: DbConnection, id: string): Record<string, never> {
  const row = db.select().from(events).where(eq(events.id, id)).get();
  return JSON.parse(row?.data ?? "{}").item;
}

describe("per-target completed-output truncation limits", () => {
  function completedData(item: Record<string, unknown>): string {
    return JSON.stringify({
      item,
      providerThreadId: "provider-thread-1",
      threadId: "thr_1",
      type: "item/completed",
    });
  }

  it("keeps a command log above 8 KiB and a tool result above 4 KiB aside that the 32 KiB threshold left whole", () => {
    const createdAt = 1_000;
    const commandOutput = "a".repeat(10 * 1024);
    const untouchedCommandOutput = "b".repeat(6 * 1024);
    const toolResult = "c".repeat(5 * 1024);
    const commandLimits =
      getCompletedEventOutputTruncationLimits("commandExecution");

    const command = prepareCompletedEventOutputData({
      createdAt,
      itemKind: "commandExecution",
      type: "item/completed",
      data: completedData({
        type: "commandExecution",
        id: "item-cmd",
        command: "echo",
        cwd: "/tmp",
        status: "completed",
        approvalStatus: "approved",
        aggregatedOutput: commandOutput,
      }),
    });
    const truncatedCommand = JSON.parse(command.data).item as {
      aggregatedOutput: string;
      truncation: { aggregatedOutput: Record<string, number> };
    };
    expect(truncatedCommand.aggregatedOutput).not.toBe(commandOutput);
    expect(
      truncatedCommand.aggregatedOutput.startsWith(
        commandOutput.slice(0, commandLimits.retainedHeadChars),
      ),
    ).toBe(true);
    expect(truncatedCommand.truncation.aggregatedOutput).toMatchObject({
      originalLength: commandOutput.length,
      retainedHeadLength: 4 * 1024,
      retainedTailLength: 4 * 1024,
    });
    expect(command.retainedOutput).toEqual({
      expiresAt: createdAt + COMPLETED_EVENT_OUTPUT_RETENTION_MS,
      outputPath: "aggregatedOutput",
      value: commandOutput,
    });

    const smallCommandData = completedData({
      type: "commandExecution",
      id: "item-cmd-small",
      command: "echo",
      cwd: "/tmp",
      status: "completed",
      approvalStatus: "approved",
      aggregatedOutput: untouchedCommandOutput,
    });
    expect(
      prepareCompletedEventOutputData({
        createdAt,
        itemKind: "commandExecution",
        type: "item/completed",
        data: smallCommandData,
      }),
    ).toEqual({ data: smallCommandData, retainedOutput: null });

    const tool = prepareCompletedEventOutputData({
      createdAt,
      itemKind: "toolCall",
      type: "item/completed",
      data: completedData({
        type: "toolCall",
        id: "item-tool",
        tool: "grep",
        status: "completed",
        result: toolResult,
      }),
    });
    const truncatedTool = JSON.parse(tool.data).item as {
      result: string;
      truncation: { result: Record<string, number> };
    };
    expect(truncatedTool.result).not.toBe(toolResult);
    expect(truncatedTool.truncation.result).toMatchObject({
      originalLength: toolResult.length,
      retainedHeadLength: 2 * 1024,
      retainedTailLength: 2 * 1024,
    });
    expect(tool.retainedOutput?.value).toBe(toolResult);
  });
});

describe("fork file-change diff truncation", () => {
  const bigDiff = "d".repeat(FILE_CHANGE_DIFF_TRUNCATION_THRESHOLD_CHARS + 5_000);
  const smallDiff = "e".repeat(100);

  function seedFileChanges(db: DbConnection, threadId: string, createdAt: number) {
    const changes = [
      { path: "/a.ts", kind: "add", diff: bigDiff },
      { path: "/b.ts", kind: "update", diff: smallDiff },
      { path: "/c.ts", kind: "delete" },
    ];
    const completedId = insertItemEvent({
      db,
      threadId,
      type: "item/completed",
      itemKind: "fileChange",
      itemId: "item-fc",
      sequence: 1,
      createdAt,
      item: {
        type: "fileChange",
        id: "item-fc",
        status: "completed",
        approvalStatus: "approved",
        changes,
      },
    });
    const startedId = insertItemEvent({
      db,
      threadId,
      type: "item/started",
      itemKind: "fileChange",
      itemId: "item-fc",
      sequence: 2,
      createdAt,
      item: {
        type: "fileChange",
        id: "item-fc",
        status: "pending",
        approvalStatus: "approved",
        changes,
      },
    });
    return { completedId, startedId };
  }

  it("seeds its cursor on the first scan so rows already on disk are never rewritten", () => {
    const { db, thread } = setup();
    const now = Date.now();
    const { completedId } = seedFileChanges(db, thread.id, now - 10_000);

    const first = truncateFileChangeDiffs(db, {
      createdBefore: now - 5_000,
      limit: 50,
      truncatedAt: now,
    });
    expect(first.truncatedRows).toBe(0);

    const second = truncateFileChangeDiffs(db, {
      createdBefore: now - 5_000,
      limit: 50,
      truncatedAt: now,
    });
    expect(second.truncatedRows).toBe(0);

    const item = readItem(db, completedId) as unknown as {
      changes: { diff?: string }[];
    };
    expect(item.changes[0]?.diff).toBe(bigDiff);
  });

  it("truncates every oversized diff on both item/started and item/completed, keeps every entry, and leaves the row parseable", () => {
    const { db, thread } = setup();
    const now = Date.now();
    const seedAt = now - 100_000;
    truncateFileChangeDiffs(db, {
      createdBefore: seedAt,
      limit: 50,
      truncatedAt: seedAt,
    });
    const { completedId, startedId } = seedFileChanges(db, thread.id, now - 10_000);

    const result = truncateFileChangeDiffs(db, {
      createdBefore: now - 5_000,
      limit: 50,
      truncatedAt: now,
    });
    expect(result.truncatedRows).toBe(2);
    expect(result.truncatedDiffs).toBe(2);

    for (const id of [completedId, startedId]) {
      const row = db.select().from(events).where(eq(events.id, id)).get();
      expect(() => JSON.parse(row?.data ?? "")).not.toThrow();
      const item = readItem(db, id) as unknown as {
        changes: { path: string; kind: string; diff?: string }[];
      };
      expect(item.changes).toHaveLength(3);
      expect(item.changes.map((change) => change.path)).toEqual([
        "/a.ts",
        "/b.ts",
        "/c.ts",
      ]);
      expect(item.changes[2]?.diff).toBeUndefined();
      expect(item.changes[1]?.diff).toBe(smallDiff);
      const truncated = item.changes[0]?.diff ?? "";
      expect(truncated).toContain(FILE_CHANGE_DIFF_TRUNCATION_MARKER);
      expect(
        truncated.startsWith(bigDiff.slice(0, FILE_CHANGE_DIFF_RETAINED_HEAD_CHARS)),
      ).toBe(true);
      expect(
        truncated.endsWith(bigDiff.slice(-FILE_CHANGE_DIFF_RETAINED_TAIL_CHARS)),
      ).toBe(true);
      expect(truncated.length).toBeLessThan(bigDiff.length);
    }
  });

  it("does not re-truncate a diff it already truncated", () => {
    const { db, thread } = setup();
    const now = Date.now();
    truncateFileChangeDiffs(db, {
      createdBefore: now - 100_000,
      limit: 50,
      truncatedAt: now - 100_000,
    });
    const { completedId } = seedFileChanges(db, thread.id, now - 10_000);
    truncateFileChangeDiffs(db, {
      createdBefore: now - 5_000,
      limit: 50,
      truncatedAt: now,
    });
    const once = readItem(db, completedId) as unknown as {
      changes: { diff?: string }[];
    };
    const afterFirst = once.changes[0]?.diff;

    db.update(events)
      .set({ createdAt: now - 9_000 })
      .where(eq(events.id, completedId))
      .run();
    truncateFileChangeDiffs(db, {
      createdBefore: now - 5_000,
      limit: 50,
      truncatedAt: now,
    });
    const twice = readItem(db, completedId) as unknown as {
      changes: { diff?: string }[];
    };
    expect(twice.changes[0]?.diff).toBe(afterFirst);
  });
});
