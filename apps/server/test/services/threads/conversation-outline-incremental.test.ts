import { describe, expect, it } from "vitest";
import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  type CompletedTurnDisplay,
} from "@bb/domain";
import {
  advanceThreadPruning,
  deleteThreadEventSuffixInTransaction,
  createThread,
  noopNotifier,
  getLatestStoredConversationOutlineSequence,
  getLatestThreadSequence,
  listStoredConversationOutlineEventRows,
} from "@bb/db";
import {
  buildThreadConversationOutline,
  loadThreadConversationOutline,
  toThreadEventWithMeta,
} from "../../../src/services/threads/timeline.js";
import { projectConversationOutlineIncrementally } from "../../../src/services/threads/conversation-outline-cache.js";
import {
  appendRows,
  withTestThread,
  type RowSpec,
  type TestThread,
} from "../../helpers/timeline-cache-fixture.js";

function started(turnId: string, parentToolCallId?: string): RowSpec {
  return {
    type: "turn/started",
    turnId,
    parentToolCallId,
    data: { parentToolCallId },
  };
}

function completed(turnId: string): RowSpec {
  return { type: "turn/completed", turnId, data: { status: "completed" } };
}

function message(
  turnId: string,
  text: string,
  parentToolCallId?: string,
): RowSpec {
  return {
    type: "item/completed",
    turnId,
    itemId: `message-${turnId}`,
    itemKind: "agentMessage",
    parentToolCallId,
    data: {
      item: {
        id: `message-${turnId}`,
        type: "agentMessage",
        text,
        parentToolCallId,
      },
    },
  };
}

function delta(turnId: string, text: string): RowSpec {
  return {
    type: "item/agentMessage/delta",
    turnId,
    itemId: `message-${turnId}`,
    data: { itemId: `message-${turnId}`, delta: text },
  };
}

function request(
  requestId: string,
  expectedTurnId: string | null = null,
): RowSpec {
  return {
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId,
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "User request" }],
      target:
        expectedTurnId === null
          ? { kind: "new-turn" }
          : { kind: "steer", expectedTurnId },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "workspace-write",
        source: "client/turn/requested",
        serviceTier: "auto",
      },
    },
  };
}

function accepted(requestId: string, turnId: string): RowSpec {
  return {
    type: "turn/input/accepted",
    turnId,
    data: { clientRequestId: requestId },
  };
}

function requestIdAt(index: number): string {
  return `creq_${index.toString(8).replaceAll("0", "a").replaceAll("1", "b").padStart(10, "a")}`;
}

function backgroundTask(
  type:
    | "item/started"
    | "item/backgroundTask/progress"
    | "item/backgroundTask/completed",
  taskId: string,
  turnId?: string,
): RowSpec {
  const settled = type === "item/backgroundTask/completed";
  return {
    type,
    turnId,
    providerThreadId: "provider-memo",
    itemId: taskId,
    itemKind: "backgroundTask",
    data: {
      item: {
        id: taskId,
        type: "backgroundTask",
        taskType: "local_bash",
        description: `Background ${taskId}`,
        status: settled ? "completed" : "pending",
        taskStatus: settled ? "completed" : "running",
        skipTranscript: false,
      },
    },
  };
}

function seedStreamedHistory(
  testThread: TestThread,
  options: { backgroundTasks: boolean; openTaskTurn: number | null },
): void {
  appendRows(
    testThread,
    Array.from({ length: 100 }, (_, i) => {
      const turnId = `turn-${i}`;
      const taskStarts =
        (options.backgroundTasks && i % 7 === 3) || i === options.openTaskTurn;
      return [
        request(requestIdAt(i)),
        started(turnId),
        accepted(requestIdAt(i), turnId),
        ...(taskStarts
          ? [backgroundTask("item/started", `task-${i}`, turnId)]
          : []),
        ...(options.backgroundTasks && i % 7 === 3
          ? [backgroundTask("item/backgroundTask/progress", `task-${i}`, turnId)]
          : []),
        delta(turnId, "Answer"),
        delta(turnId, ` ${i}`),
        message(turnId, `Answer ${i}`),
        completed(turnId),
        ...(options.backgroundTasks && i % 7 === 5
          ? [backgroundTask("item/backgroundTask/completed", `task-${i - 2}`)]
          : []),
      ];
    }).flat(),
  );
  appendRows(testThread, [started("live"), delta("live", "Live")]);
}

function pruneUntilResolvedItemsComplete(testThread: TestThread): number {
  const threadId = testThread.thread.id;
  let removed = 0;
  for (let pass = 0; pass < 2_000; pass += 1) {
    const result = advanceThreadPruning(testThread.db, { threadId });
    removed += result.removed;
    if (result.policy === "resolved-items" && result.action !== "advanced")
      return removed;
  }
  throw new Error("Resolved-item pruning did not finish a thread pass");
}

function listEventSequences(
  testThread: TestThread,
  types: readonly string[],
): number[] {
  return testThread.db.$client
    .prepare<[string], { sequence: number }>(
      `SELECT sequence FROM events WHERE thread_id = ? AND type IN (${types.map((type) => `'${type}'`).join(", ")}) ORDER BY sequence`,
    )
    .all(testThread.thread.id)
    .map((row) => row.sequence);
}

function seed(
  testThread: TestThread,
  count = 3,
  nestedWork?: RowSpec,
): void {
  appendRows(
    testThread,
    Array.from({ length: count }, (_, i) => {
      const turnId = `turn-${i}`;
      const requestId = requestIdAt(i);
      return [
        request(requestId),
        started(turnId),
        accepted(requestId, turnId),
        message(turnId, `Answer ${i}`),
        ...(i === 0 && nestedWork !== undefined ? [nestedWork] : []),
        completed(turnId),
      ];
    }).flat(),
  );
  appendRows(testThread, [started("live"), delta("live", "Live")]);
}

function nestedTurn(index: number, includeParent = true): RowSpec[] {
  const root = `nested-root-${index}`;
  const child = `nested-child-${index}`;
  const parent = `nested-call-${index}`;
  return [
    started(root),
    ...(includeParent ? [parentCall(root, parent)] : []),
    started(child, parent),
    message(child, `Child answer ${index}`, parent),
    { ...completed(child), parentToolCallId: parent },
    message(root, `Root answer ${index}`),
    completed(root),
  ];
}

function parentCall(turnId: string, itemId: string): RowSpec {
  return {
    type: "item/started",
    turnId,
    itemId,
    itemKind: "toolCall",
    data: {
      item: {
        id: itemId,
        type: "toolCall",
        tool: "Agent",
        arguments: {},
        status: "pending",
      },
    },
  };
}

function load(
  testThread: TestThread,
  completedTurnDisplay: CompletedTurnDisplay = "collapse",
) {
  const threadId = testThread.thread.id;
  return loadThreadConversationOutline(testThread.db, testThread.thread, {
    completedTurnDisplay,
    maxSeq: getLatestThreadSequence(testThread.db, { threadId }),
    outlineSequence: getLatestStoredConversationOutlineSequence(testThread.db, {
      threadId,
    }),
  });
}

function expectMatchesFull(
  testThread: TestThread,
  completedTurnDisplay: CompletedTurnDisplay = "collapse",
) {
  const result = load(testThread, completedTurnDisplay);
  expect(result).toEqual(
    buildThreadConversationOutline(testThread.coldDb, testThread.thread, {
      completedTurnDisplay,
      maxSeq: result.maxSeq,
    }),
  );
  return result;
}

function countSelectedEventRows(
  testThread: TestThread,
  run: () => void,
): number {
  const raw = testThread.db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  let count = 0;
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      if (source.includes('from "events"') && source.includes('"created_at"')) {
        const originalAll = statement.all.bind(statement);
        statement.all = function (...params: unknown[]) {
          const rows = originalAll(...params);
          count += rows.length;
          return rows;
        };
      }
      return statement;
    },
  });
  try {
    run();
  } finally {
    raw.prepare = originalPrepare;
  }
  return count;
}

function expectCheckpointFallbackForTailEvent(tailEvent: RowSpec): void {
  withTestThread((testThread) => {
    seed(testThread, 100, parentCall("turn-0", "historical-call"));
    const sequenceStarts: number[] = [];
    const project = () =>
      projectConversationOutlineIncrementally({
        db: testThread.db,
        threadId: testThread.thread.id,
        key: "checkpoint-parent-reference",
        maxSeq: getLatestThreadSequence(testThread.db, {
          threadId: testThread.thread.id,
        }),
        contextBoundarySeq: 0,
        orderingBoundarySequence: null,
        resolveProjectionState: () => ({
          includeNestedEvents: true,
          summaryCompactionEnabled: false,
        }),
        select: (sequenceStart) => {
          sequenceStarts.push(sequenceStart);
          const rows = listStoredConversationOutlineEventRows(testThread.db, {
            sequenceStart,
            threadId: testThread.thread.id,
          });
          return {
            events: rows.map(toThreadEventWithMeta),
            project: () => [],
          };
        },
      });

    project();
    sequenceStarts.length = 0;
    appendRows(testThread, [tailEvent]);

    project();

    expect(sequenceStarts).toEqual([502, 0]);
    expectMatchesFull(testThread);
  });
}

describe("incremental conversation outlines", () => {
  it.each(["collapse", "flat"] as const)(
    "retains completed nested history while updating the live tail (%s)",
    (display) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          ...Array.from({ length: 100 }, (_, index) =>
            nestedTurn(index),
          ).flat(),
          started("live"),
          delta("live", "Live"),
        ]);
        expectMatchesFull(testThread, display);
        for (const rows of [
          [delta("live", " continued")],
          [message("live", "Finished"), completed("live")],
          nestedTurn(101),
          [started("next"), delta("next", "Next")],
        ]) {
          appendRows(testThread, rows);
          const selected = countSelectedEventRows(testThread, () =>
            expectMatchesFull(testThread, display),
          );
          expect(selected).toBeLessThan(25);
        }
      });
    },
  );

  it.each([
    "new child",
    "late parent",
    "reopened turn",
    "completion rewrite",
    "incomplete child",
  ] as const)(
    "preserves outlines after nested history changes: %s",
    (change) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          ...Array.from({ length: 30 }, (_, index) =>
            nestedTurn(index, change !== "late parent"),
          ).flat(),
          started("live"),
          delta("live", "Live"),
        ]);
        const removeCompletion = () =>
          testThread.coldDb.$client
            .prepare(
              "DELETE FROM events WHERE thread_id = ? AND turn_id = ? AND type = 'turn/completed'",
            )
            .run(testThread.thread.id, "nested-child-0");
        if (change === "incomplete child") removeCompletion();
        expectMatchesFull(testThread);
        switch (change) {
          case "new child":
            appendRows(testThread, [
              started("late-child", "nested-call-0"),
              message("late-child", "Late child", "nested-call-0"),
            ]);
            break;
          case "late parent":
            appendRows(testThread, [parentCall("live", "nested-call-0")]);
            break;
          case "reopened turn":
            appendRows(testThread, [
              started("nested-child-0", "nested-call-0"),
              message("nested-child-0", "Reopened", "nested-call-0"),
            ]);
            break;
          case "completion rewrite":
            removeCompletion();
            break;
          case "incomplete child":
            appendRows(testThread, [delta("live", "More")]);
            break;
        }
        const selected = countSelectedEventRows(testThread, () =>
          expectMatchesFull(testThread),
        );
        if (change === "completion rewrite")
          expect(selected).toBeGreaterThan(100);
        else expect(selected).toBeLessThan(25);
      });
    },
  );

  it.each(["collapse", "flat"] as const)(
    "only reads root messages while a nested child is still streaming (%s)",
    (display) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          ...nestedTurn(0).filter(
            (row) =>
              !(
                row.type === "turn/completed" && row.turnId === "nested-child-0"
              ),
          ),
          ...Array.from({ length: 99 }, (_, index) =>
            nestedTurn(index + 1),
          ).flat(),
          started("live"),
          delta("live", "Live"),
        ]);
        expectMatchesFull(testThread, display);
        for (let index = 0; index < 3; index += 1) {
          appendRows(testThread, [
            {
              ...delta("nested-child-0", "Nested update"),
              parentToolCallId: "nested-call-0",
              data: {
                itemId: "message-nested-child-0",
                delta: "Nested update",
                parentToolCallId: "nested-call-0",
              },
            },
            delta("live", " Root update"),
          ]);
          const selected = countSelectedEventRows(testThread, () =>
            expectMatchesFull(testThread, display),
          );
          expect(selected).toBeLessThan(25);
        }
      });
    },
  );

  it.each(["immediate", "late"] as const)(
    "keeps accepted root answers with inherited parent metadata (%s acceptance)",
    (acceptance) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          request("creq_abcdefghij"),
          started("inherited-root", "inherited-parent"),
          ...(acceptance !== "late"
            ? [accepted("creq_abcdefghij", "inherited-root")]
            : []),
          message("inherited-root", "Actual root answer", "inherited-parent"),
          completed("inherited-root"),
          started("live"),
          delta("live", "Live"),
        ]);
        expectMatchesFull(testThread);
        if (acceptance === "late") {
          appendRows(testThread, [
            accepted("creq_abcdefghij", "inherited-root"),
          ]);
        }
        const result = expectMatchesFull(testThread);
        expect(result.items.map((item) => item.preview)).toContain(
          "Actual root answer",
        );
      });
    },
  );

  it("rebuilds root fallback previews when child deltas cross the compaction threshold", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [
        started("root"),
        parentCall("root", "parent"),
        started("child", "parent"),
        delta("root", "First"),
        delta("root", " second"),
        message("root", ""),
        completed("root"),
        started("live"),
        delta("live", "Live"),
      ]);
      const before = expectMatchesFull(testThread);
      expect(before.items.map((item) => item.preview)).toContain(
        "First second",
      );
      appendRows(
        testThread,
        Array.from({ length: 1_000 }, () => ({
          ...delta("child", "Nested"),
          parentToolCallId: "parent",
          data: {
            itemId: "message-child",
            delta: "Nested",
            parentToolCallId: "parent",
          },
        })),
      );
      const after = expectMatchesFull(testThread);
      expect(after.items.map((item) => item.preview)).toContain("First");
    });
  });

  it.each([950, 1050])(
    "preserves previews across delta compaction with %i historical deltas",
    (deltaCount) => {
      withTestThread((testThread) => {
        appendRows(testThread, [
          started("old"),
          ...Array.from({ length: deltaCount }, () => delta("old", "word ")),
          message("old", "Complete"),
          completed("old"),
          started("live"),
          delta("live", "First"),
          delta("live", " second"),
        ]);
        expectMatchesFull(testThread);
        appendRows(testThread, [message("live", ""), completed("live")]);
        expectMatchesFull(testThread);
        appendRows(testThread, [
          started("next"),
          ...Array.from({ length: 100 }, () => delta("next", "more ")),
        ]);
        expectMatchesFull(testThread);
      });
    },
  );

  it("rebuilds when a previously unaccepted request joins a later turn", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [request("creq_abcdefghij")]);
      seed(testThread);
      expectMatchesFull(testThread);
      appendRows(testThread, [
        accepted("creq_abcdefghij", "live"),
        delta("live", " accepted"),
      ]);
      expectMatchesFull(testThread);
    });
  });

  it("only reads the live tail after a long completed history, including across turn boundaries", () => {
    withTestThread((testThread) => {
      seed(testThread, 100);
      expectMatchesFull(testThread);
      for (const rows of [
        [delta("live", " continuation")],
        [message("live", "Final answer"), completed("live")],
        [
          request("creq_abcdefghij"),
          started("next"),
          accepted("creq_abcdefghij", "next"),
          delta("next", "Next"),
        ],
        [delta("next", " update")],
      ]) {
        appendRows(testThread, rows);
        const count = countSelectedEventRows(testThread, () => {
          load(testThread);
        });
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(20);
        expectMatchesFull(testThread);
      }
    });
  });

  it("reuses a completed prefix after nested history and a live-tail update", () => {
    withTestThread((testThread) => {
      seed(testThread, 100);
      testThread.db.$client
        .prepare(
          "UPDATE events SET parent_tool_call_id = ?, data = json_set(data, '$.item.parentToolCallId', ?) WHERE thread_id = ? AND sequence = 4",
        )
        .run(
          "historical-parent",
          "historical-parent",
          testThread.thread.id,
        );
      expectMatchesFull(testThread);

      appendRows(testThread, [delta("live", " continuation")]);
      const selectedRows = countSelectedEventRows(testThread, () => {
        load(testThread);
      });

      expect(selectedRows).toBe(3);
      expectMatchesFull(testThread);
    });
  });

  it("rebuilds when a new nested item points into the completed prefix", () => {
    withTestThread((testThread) => {
      seed(testThread, 100, parentCall("turn-0", "historical-call"));
      expectMatchesFull(testThread);

      appendRows(testThread, [
        {
          type: "item/completed",
          turnId: "live",
          itemId: "message-child",
          itemKind: "agentMessage",
          parentToolCallId: "historical-call",
          data: {
            item: {
              id: "message-child",
              type: "agentMessage",
              text: "Nested continuation",
              parentToolCallId: "historical-call",
            },
          },
        },
      ]);
      const selectedRows = countSelectedEventRows(testThread, () => {
        load(testThread);
      });

      expect(selectedRows).toBeGreaterThan(500);
      expectMatchesFull(testThread);
    });
  });

  it("invalidates a checkpoint when a tail event references a checkpointed item", () => {
    expectCheckpointFallbackForTailEvent({
      type: "item/completed",
      turnId: "live",
      itemId: "message-child",
      itemKind: "agentMessage",
      parentToolCallId: "historical-call",
      data: {
        item: {
          id: "message-child",
          type: "agentMessage",
          text: "Nested continuation",
          parentToolCallId: "historical-call",
        },
      },
    });
  });

  it("invalidates a checkpoint when a tail tool call reuses a completed item id", () => {
    expectCheckpointFallbackForTailEvent({
      type: "item/started",
      turnId: "live",
      itemId: "historical-call",
      itemKind: "toolCall",
      data: {
        item: {
          id: "historical-call",
          type: "toolCall",
          tool: "Agent",
          arguments: {},
          status: "pending",
        },
      },
    });
  });

  it("rebuilds when a late nested update targets an item in the completed prefix", () => {
    withTestThread((testThread) => {
      seed(testThread, 100, {
        type: "item/backgroundTask/progress",
        providerThreadId: "provider-memo",
        itemId: "workflow-task",
        itemKind: "backgroundTask",
        data: {
          item: {
            id: "workflow-task",
            type: "backgroundTask",
            taskType: "local_workflow",
            description: "Complete workflow",
            status: "pending",
            taskStatus: "pending",
            skipTranscript: false,
          },
        },
      });
      expectMatchesFull(testThread);

      appendRows(testThread, [
        {
          type: "item/backgroundTask/completed",
          providerThreadId: "provider-memo",
          itemId: "workflow-task",
          itemKind: "backgroundTask",
          data: {
            item: {
              id: "workflow-task",
              type: "backgroundTask",
              taskType: "local_workflow",
              description: "Complete workflow",
              status: "completed",
              taskStatus: "completed",
              skipTranscript: false,
              summary: "Workflow finished",
            },
          },
        },
      ]);
      const selectedRows = countSelectedEventRows(testThread, () => {
        load(testThread);
      });

      expect(selectedRows).toBeGreaterThan(500);
      expectMatchesFull(testThread);
    });
  });

  it("reuses the prefix before a still-open background task after settled ones", () => {
    withTestThread((testThread) => {
      seedStreamedHistory(testThread, {
        backgroundTasks: true,
        openTaskTurn: 99,
      });
      expectMatchesFull(testThread);
      for (const rows of [
        [delta("live", " continuation")],
        [message("live", "Final answer"), completed("live")],
        [started("next"), delta("next", "Next")],
      ]) {
        appendRows(testThread, rows);
        const selectedRows = countSelectedEventRows(testThread, () => {
          load(testThread);
        });
        expect(selectedRows).toBeGreaterThan(0);
        expect(selectedRows).toBeLessThan(25);
        expectMatchesFull(testThread);
      }
    });
  });

  it("rebuilds when a late update targets a settled background task in the prefix", () => {
    withTestThread((testThread) => {
      seedStreamedHistory(testThread, {
        backgroundTasks: true,
        openTaskTurn: null,
      });
      expectMatchesFull(testThread);

      appendRows(testThread, [
        backgroundTask("item/backgroundTask/progress", "task-3"),
      ]);
      const selectedRows = countSelectedEventRows(testThread, () => {
        load(testThread);
      });

      expect(selectedRows).toBeGreaterThan(500);
      expectMatchesFull(testThread);
    });
  });

  it.each([false, true])(
    "keeps the prefix when live pruning removes resolved rows below it (background tasks: %s)",
    (backgroundTasks) => {
      withTestThread((testThread) => {
        seedStreamedHistory(testThread, {
          backgroundTasks,
          openTaskTurn: null,
        });
        expectMatchesFull(testThread);
        const [liveStart] = listEventSequences(testThread, ["turn/started"]).slice(-1);
        const prunable = [
          "item/agentMessage/delta",
          "item/backgroundTask/progress",
        ];
        const before = listEventSequences(testThread, prunable);

        expect(pruneUntilResolvedItemsComplete(testThread)).toBeGreaterThan(0);

        const after = new Set(listEventSequences(testThread, prunable));
        const removed = before.filter((sequence) => !after.has(sequence));
        expect(removed).toHaveLength(backgroundTasks ? 114 : 100);
        expect(removed.every((sequence) => sequence < liveStart!)).toBe(true);

        appendRows(testThread, [delta("live", " continuation")]);
        const selectedRows = countSelectedEventRows(testThread, () => {
          load(testThread);
        });
        expect(selectedRows).toBeLessThan(25);
        expectMatchesFull(testThread);
      });
    },
  );

  it("rebuilds when pruning removes deltas of a message without final text", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [
        request("creq_nexttextab"),
        started("textless"),
        accepted("creq_nexttextab", "textless"),
        delta("textless", "First"),
        delta("textless", " second"),
        delta("textless", " third"),
        message("textless", ""),
        completed("textless"),
      ]);
      seedStreamedHistory(testThread, {
        backgroundTasks: false,
        openTaskTurn: null,
      });
      const before = expectMatchesFull(testThread);
      expect(before.items.map((item) => item.preview)).toContain(
        "First second third",
      );

      pruneUntilResolvedItemsComplete(testThread);
      const selectedRows = countSelectedEventRows(testThread, () => {
        load(testThread);
      });

      expect(selectedRows).toBeGreaterThan(500);
      expectMatchesFull(testThread);
    });
  });

  it("rebuilds when pruning drops historical deltas below the compaction threshold", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [
        started("old"),
        backgroundTask("item/started", "task-old", "old"),
        ...Array.from({ length: 1_001 }, () => delta("old", "word ")),
        message("old", "Complete"),
        backgroundTask("item/backgroundTask/completed", "task-old", "old"),
        completed("old"),
        started("live"),
        delta("live", "First"),
        delta("live", " second"),
      ]);
      expectMatchesFull(testThread);
      expect(
        countSelectedEventRows(testThread, () => {
          load(testThread);
        }),
      ).toBeLessThan(25);

      pruneUntilResolvedItemsComplete(testThread);
      expect(
        listEventSequences(testThread, ["item/agentMessage/delta"]),
      ).toHaveLength(3);
      appendRows(testThread, [message("live", ""), completed("live")]);

      const result = expectMatchesFull(testThread);
      expect(result.items.map((item) => item.preview)).toContain(
        "First second",
      );
    });
  });

  it.each([
    "rewind",
    "clear",
    "external rewrite",
    "metadata",
    "display",
    "late event",
    "late steer",
    "thread error",
    "nested",
  ] as const)(
    "matches a full rebuild after %s invalidates the frozen prefix",
    (change) =>
      withTestThread((testThread) => {
        seed(testThread);
        appendRows(testThread, [
          message("live", "Finished prelude"),
          completed("live"),
          ...nestedTurn(900),
          started("next-live"),
          delta("next-live", "Live"),
        ]);
        expectMatchesFull(testThread);
        switch (change) {
          case "rewind": {
            const maxSeq = getLatestThreadSequence(testThread.db, {
              threadId: testThread.thread.id,
            });
            testThread.db.transaction((tx) =>
              deleteThreadEventSuffixInTransaction(tx, {
                threadId: testThread.thread.id,
                cutoffSequence: 4,
                oldMaxSequence: maxSeq,
              }),
            );
            appendRows(testThread, [
              message("turn-0", "Replacement"),
              completed("turn-0"),
              started("replacement"),
              delta("replacement", "New"),
            ]);
            while (
              getLatestThreadSequence(testThread.db, {
                threadId: testThread.thread.id,
              }) < maxSeq
            ) {
              appendRows(testThread, [
                {
                  type: "system/manager/user_message",
                  data: { text: "Refilled history" },
                },
              ]);
            }
            break;
          }
          case "clear":
            appendRows(testThread, [
              {
                type: "system/operation",
                data: {
                  operation: THREAD_CONTEXT_CLEAR_OPERATION,
                  operationId: "clear",
                  status: "completed",
                  message: "Context cleared",
                },
              },
              started("fresh"),
              delta("fresh", "Fresh"),
            ]);
            break;
          case "external rewrite":
            testThread.coldDb.$client
              .prepare(
                "UPDATE events SET data = json_set(data, '$.item.text', 'Rewritten') WHERE thread_id = ? AND sequence = 4",
              )
              .run(testThread.thread.id);
            break;
          case "display":
            break;
          case "metadata":
            testThread.thread = {
              ...testThread.thread,
              title: "Renamed",
              status: "error",
            };
            break;
          case "late event":
            appendRows(testThread, [message("turn-0", "Late replacement")]);
            break;
          case "late steer":
            appendRows(testThread, [
              request("creq_abcdefghij", "turn-0"),
              accepted("creq_abcdefghij", "turn-0"),
            ]);
            break;
          case "thread error":
            appendRows(testThread, [
              { type: "system/error", data: { message: "Failed" } },
            ]);
            break;
          case "nested":
            appendRows(testThread, [
              {
                ...started("child"),
                parentToolCallId: "parent",
                data: { parentToolCallId: "parent" },
              },
              {
                ...message("child", "Child answer"),
                parentToolCallId: "parent",
                data: {
                  item: {
                    id: "message-child",
                    type: "agentMessage",
                    text: "Child answer",
                    parentToolCallId: "parent",
                  },
                },
              },
            ]);
            break;
        }
        expectMatchesFull(
          testThread,
          change === "display" ? "flat" : "collapse",
        );
      }),
  );

  it("evicts old checkpoints without changing their rebuilt outlines", () => {
    withTestThread((testThread) => {
      seed(testThread, 100);
      expectMatchesFull(testThread);
      const firstThread = testThread.thread;
      for (let index = 0; index < 16; index += 1) {
        testThread.thread = createThread(testThread.db, noopNotifier, {
          projectId: testThread.projectId,
          providerId: "codex",
          status: "active",
        });
        seed(testThread);
        load(testThread);
      }
      testThread.thread = firstThread;
      const count = countSelectedEventRows(testThread, () => {
        load(testThread);
      });
      expect(count).toBeGreaterThan(500);
      expectMatchesFull(testThread);
      appendRows(testThread, [delta("live", " after eviction")]);
      expect(
        countSelectedEventRows(testThread, () => {
          load(testThread);
        }),
      ).toBeLessThan(20);
      expectMatchesFull(testThread);
    });
  });

  it("preserves overlapping turns and pending steers as they complete", () => {
    withTestThread((testThread) => {
      seed(testThread);
      expectMatchesFull(testThread);
      for (const rows of [
        [
          request("creq_abcdefghij", "live"),
          started("overlapping"),
          delta("overlapping", "Other"),
        ],
        [message("live", "Finished"), completed("live")],
        [
          accepted("creq_abcdefghij", "overlapping"),
          message("overlapping", "Other finished"),
          completed("overlapping"),
        ],
        [started("last"), delta("last", "Last")],
        [started("another"), delta("another", "Another")],
        [message("another", "Another done"), completed("another")],
        [message("last", "Last done"), completed("last")],
        [started("final"), delta("final", "Final")],
      ]) {
        appendRows(testThread, rows);
        expectMatchesFull(testThread);
      }
    });
  });
});
