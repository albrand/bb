import { afterEach, describe, expect, it } from "vitest";
import {
  advanceThreadPruning,
  appendStoredThreadEventsInTransaction,
  createConnection,
  createProject,
  createThread,
  deleteExpiredRetainedEventOutputs,
  getCompletedEventOutputTruncationLimits,
  insertEvents,
  migrate,
  noopNotifier,
  runIncrementalVacuum,
  upsertHost,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import { threadScope } from "@bb/domain";
import { getNewlyCheckpointedPages } from "../../src/data/maintenance.js";

describe("database write byte instrumentation", () => {
  let db: DbConnection | undefined;

  afterEach(() => {
    db?.$client.close();
    db = undefined;
  });

  it("counts only frames checkpointed by this invocation", () => {
    const before = { busy: 0, log: 12, checkpointed: 8 };
    expect(
      getNewlyCheckpointedPages("PASSIVE", before, {
        busy: 0,
        log: 12,
        checkpointed: 8,
      }),
    ).toBe(0);
    expect(
      getNewlyCheckpointedPages("PASSIVE", before, {
        busy: 0,
        log: 12,
        checkpointed: 11,
      }),
    ).toBe(3);
    expect(
      getNewlyCheckpointedPages("PASSIVE", before, {
        busy: 0,
        log: 2,
        checkpointed: 2,
      }),
    ).toBe(2);
    expect(
      getNewlyCheckpointedPages("TRUNCATE", before, {
        busy: 0,
        log: 0,
        checkpointed: 0,
      }),
    ).toBe(4);
  });

  it("records event append, prune-delete, and WAL checkpoint bytes", () => {
    const writeMetrics: Array<{
      fields: { bytes: number; source: string };
      message: string;
    }> = [];
    db = createConnection(":memory:", {
      databaseWriteBytesLogger: {
        debug(fields, message) {
          writeMetrics.push({ fields, message });
        },
      },
    });
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "test-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "test-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
    });
    const output = "o".repeat(
      getCompletedEventOutputTruncationLimits("commandExecution")
        .thresholdChars + 128,
    );
    const appendData = JSON.stringify({
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "run",
        cwd: "/tmp/test",
        status: "completed",
        approvalStatus: null,
        exitCode: 0,
        aggregatedOutput: output,
      },
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/completed",
        scope: threadScope(),
        itemId: "command-1",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: appendData,
      },
    ]);

    const appendedBytes = db.$client
      .prepare<[string], { bytes: number }>(
        `SELECT length(CAST(events.data AS BLOB)) +
          COALESCE((SELECT length(CAST(value AS BLOB))
            FROM retained_event_outputs
            WHERE retained_event_outputs.event_id = events.id), 0) AS bytes
         FROM events WHERE thread_id = ? AND sequence = 1`,
      )
      .get(thread.id)!.bytes;
    expect(writeMetrics).toContainEqual({
      fields: { bytes: appendedBytes, source: "event-append" },
      message: "Database write payload bytes by source",
    });

    writeMetrics.length = 0;
    db.transaction(
      (tx) =>
        appendStoredThreadEventsInTransaction(tx, [
          {
            threadId: thread.id,
            scope: threadScope(),
            type: "system/thread/interrupted",
            data: { reason: "host-daemon-restarted" },
          },
        ]),
      { behavior: "immediate" },
    );
    const transactionAppendBytes = db.$client
      .prepare<[string], { bytes: number }>(
        `SELECT length(CAST(data AS BLOB)) AS bytes
         FROM events WHERE thread_id = ? AND sequence = 2`,
      )
      .get(thread.id)!.bytes;
    expect(writeMetrics).toContainEqual({
      fields: { bytes: transactionAppendBytes, source: "event-append" },
      message: "Database write payload bytes by source",
    });

    const rateLimitData = ["first", "second", "third", "latest"].map((label) =>
      JSON.stringify({ limits: [label] }),
    );
    insertEvents(
      db,
      noopNotifier,
      rateLimitData.map((data, index) => ({
        threadId: thread.id,
        sequence: index + 3,
        type: "provider/rateLimits/updated" as const,
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data,
      })),
    );
    writeMetrics.length = 0;

    const pruneResult = advanceThreadPruning(db, "rate-limits");
    const expectedDeletedBytes = rateLimitData
      .slice(0, 3)
      .reduce((total, data) => total + Buffer.byteLength(data, "utf8"), 0);
    expect(pruneResult).toMatchObject({
      removed: 3,
      removedBytes: expectedDeletedBytes,
    });
    expect(writeMetrics).toContainEqual({
      fields: { bytes: expectedDeletedBytes, source: "event-prune-delete" },
      message: "Database write payload bytes by source",
    });

    writeMetrics.length = 0;
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 7,
        type: "item/completed",
        scope: threadScope(),
        itemId: "command-expired",
        itemKind: "commandExecution",
        parentToolCallId: null,
        createdAt: 0,
        data: appendData,
      },
    ]);
    const expiredOutputBytes = db.$client
      .prepare<[number], { bytes: number }>(
        "SELECT length(CAST(value AS BLOB)) AS bytes FROM retained_event_outputs WHERE expires_at <= ?",
      )
      .get(Date.now())!.bytes;
    writeMetrics.length = 0;
    const retainedPruneResult = deleteExpiredRetainedEventOutputs(db, {
      expiredAtOrBefore: Date.now(),
      limit: 10,
    });
    expect(retainedPruneResult).toMatchObject({
      deleted: 1,
      removedBytes: expiredOutputBytes,
    });
    expect(writeMetrics).toContainEqual({
      fields: { bytes: expiredOutputBytes, source: "event-prune-delete" },
      message: "Database write payload bytes by source",
    });

    writeMetrics.length = 0;
    runIncrementalVacuum(db, { maxPages: 0 });
    const checkpointMetrics = writeMetrics.filter(
      ({ fields }) => fields.source === "wal-checkpoint",
    );
    expect(checkpointMetrics).toHaveLength(2);
    expect(checkpointMetrics.map(({ fields }) => fields.bytes)).toEqual([
      0,
      0,
    ]);
  });
});
