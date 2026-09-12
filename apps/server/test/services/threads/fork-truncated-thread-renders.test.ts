import { describe, expect, it } from "vitest";
import { turnScope } from "@bb/domain";
import type { Thread } from "@bb/domain";
import {
  createConnection,
  createProject,
  createThread,
  FILE_CHANGE_DIFF_TRUNCATION_MARKER,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import { buildThreadTimeline } from "../../../src/services/threads/timeline.js";

const providerThreadId = "provider-root";

function setup(): { db: DbConnection; thread: Thread } {
  const db = createConnection(":memory:");
  migrate(db);
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
    providerId: "claude-code",
  });
  return { db, thread };
}

describe("a thread whose rows retention already truncated still renders", () => {
  it("renders a truncated command, a truncated file change, and an item that never completed", () => {
    const { db, thread } = setup();
    const truncatedOutput = `${"h".repeat(4096)}\n\n[... output truncated by retention policy; showing beginning and end ...]\n\n${"t".repeat(4096)}`;
    const truncatedDiff = `${"a".repeat(8192)}${FILE_CHANGE_DIFF_TRUNCATION_MARKER}${"z".repeat(8192)}`;

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-1"),
        providerThreadId,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ providerThreadId }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        scope: turnScope("turn-1"),
        providerThreadId,
        itemId: "cmd-truncated",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "commandExecution",
            id: "cmd-truncated",
            command: "pnpm test",
            cwd: "/tmp/test",
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
            aggregatedOutput: truncatedOutput,
            truncation: {
              aggregatedOutput: {
                originalLength: 400_000,
                retainedHeadLength: 4096,
                retainedTailLength: 4096,
                truncatedAt: 1,
              },
            },
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/completed",
        scope: turnScope("turn-1"),
        providerThreadId,
        itemId: "fc-truncated",
        itemKind: "fileChange",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "fileChange",
            id: "fc-truncated",
            status: "completed",
            approvalStatus: null,
            changes: [
              { path: "/tmp/test/a.ts", kind: "update", diff: truncatedDiff },
              { path: "/tmp/test/b.ts", kind: "add", diff: "small" },
              { path: "/tmp/test/c.ts", kind: "delete" },
            ],
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "item/started",
        scope: turnScope("turn-1"),
        providerThreadId,
        itemId: "cmd-orphan",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "commandExecution",
            id: "cmd-orphan",
            command: "sleep 900",
            cwd: "/tmp/test",
            status: "pending",
            approvalStatus: null,
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "item/completed",
        scope: turnScope("turn-1"),
        providerThreadId,
        itemId: "msg-1",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: { type: "agentMessage", id: "msg-1", text: "done" },
        }),
      },
    ]);

    const timeline = buildThreadTimeline(db, thread, {
      eventBudget: 1_000_000,
      includeProviderUnhandledOperations: false,
      includeNestedRows: true,
      maxInlineOutputChars: 32_000,
      maxSeq: 0,
      page: { kind: "latest", segmentLimit: 20 },
    });

    const workRows = timeline.rows.filter((row) => row.kind === "work");
    expect(workRows.length).toBeGreaterThanOrEqual(3);

    const command = workRows.find((row) => row.id.includes("cmd-truncated"));
    expect(command).toBeDefined();
    expect(command).toMatchObject({ status: "completed" });
    expect(JSON.stringify(command)).toContain(
      "output truncated by retention policy",
    );

    const fileChangeRows = workRows.filter((row) =>
      row.id.includes("fc-truncated"),
    );
    expect(fileChangeRows).toHaveLength(3);
    const fileChangeText = JSON.stringify(fileChangeRows);
    expect(fileChangeText).toContain("a.ts");
    expect(fileChangeText).toContain("b.ts");
    expect(fileChangeText).toContain("c.ts");

    const orphan = workRows.find((row) => row.id.includes("cmd-orphan"));
    expect(orphan).toBeDefined();
    expect(orphan).not.toMatchObject({ status: "completed" });

    expect(
      timeline.rows.some((row) => JSON.stringify(row).includes("done")),
    ).toBe(true);
  });
});
