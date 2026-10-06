import { describe, expect, it } from "vitest";
import { THREAD_CONTEXT_CLEAR_OPERATION } from "@bb/domain";
import {
  getLatestStoredConversationOutlineSequence,
  getLatestThreadSequence,
  upsertThreadConversationOutlineRecord,
} from "@bb/db";
import {
  buildThreadConversationOutline,
  buildThreadConversationOutlineProjectionKey,
  buildThreadTimelineWithProfile,
  loadThreadConversationOutline,
} from "../../../src/services/threads/timeline.js";
import {
  appendRows,
  withTestThread,
  type RowSpec,
  type TestThread,
} from "../../helpers/timeline-cache-fixture.js";

const requestId = "creq_abcdefghij";
const targetTurnId = "history-0";

function turn(turnId: string): [RowSpec, RowSpec, RowSpec] {
  return [
    { type: "turn/started", turnId },
    {
      type: "item/completed",
      turnId,
      itemId: `answer-${turnId}`,
      itemKind: "agentMessage",
      data: {
        item: {
          id: `answer-${turnId}`,
          type: "agentMessage",
          text: `Answer ${turnId}`,
        },
      },
    },
    { type: "turn/completed", turnId, data: { status: "completed" } },
  ];
}

function request(expectedTurnId: string | null = targetTurnId): RowSpec {
  return {
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId,
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "Late rejected steer" }],
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

function rejected(): RowSpec {
  return {
    type: "client/turn/rejected",
    data: {
      requestId,
      reason: "host_unavailable",
      message: "Host disconnected",
    },
  };
}

function load(
  testThread: TestThread,
  eventBudget = 64,
  segmentLimit = 1,
  completedTurnDisplay: "flat" | "collapse" = "flat",
) {
  return buildThreadTimelineWithProfile(testThread.db, testThread.thread, {
    completedTurnDisplay,
    eventBudget,
    includeNestedRows: true,
    includeDiagnosticOperations: false,
    maxInlineOutputChars: null,
    maxSeq: getLatestThreadSequence(testThread.db, {
      threadId: testThread.thread.id,
    }),
    page: { kind: "latest", segmentLimit },
  });
}

function steer(result: ReturnType<typeof load>) {
  const rows = [
    ...result.response.rows,
    ...(result.response.timelinePage.olderRowUpdates ?? []),
  ];
  return rows.filter(
    (row) =>
      row.kind === "conversation" &&
      row.role === "user" &&
      row.text === "Late rejected steer",
  );
}

function outlineOptions(testThread: TestThread) {
  return {
    completedTurnDisplay: "collapse" as const,
    maxSeq: getLatestThreadSequence(testThread.db, {
      threadId: testThread.thread.id,
    }),
    outlineSequence: getLatestStoredConversationOutlineSequence(testThread.db, {
      threadId: testThread.thread.id,
    }),
  };
}

describe("rejected steer turn context", () => {
  it.each(["agent", "system", "user"] as const)(
    "keeps a rejected %s steer visible without replacing a historical summary",
    (initiator) => {
      withTestThread((testThread) => {
        const [start, answer, completed] = turn(targetTurnId);
        appendRows(testThread, [
          start,
          {
            type: "item/completed",
            turnId: targetTurnId,
            itemId: "old-command",
            itemKind: "commandExecution",
            data: {
              item: {
                type: "commandExecution",
                id: "old-command",
                command: "echo done",
                cwd: "/tmp",
                status: "completed",
                aggregatedOutput: "done",
                approvalStatus: null,
                exitCode: 0,
                durationMs: 1000,
              },
            },
          },
          answer,
          completed,
          ...Array.from({ length: 100 }, (_, index) =>
            turn(`later-${index}`),
          ).flat(),
        ]);
        const requested = request();
        loadThreadConversationOutline(
          testThread.db,
          testThread.thread,
          outlineOptions(testThread),
        );
        const [liveStart, ...liveRest] = turn("live");
        appendRows(testThread, [
          liveStart,
          { ...requested, data: { ...requested.data, initiator } },
          rejected(),
          ...liveRest,
        ]);
        const latest = load(testThread, 64, 1, "collapse");
        const full = load(testThread, 10_000, 200, "collapse");
        const fullSteer = steer(full)[0];
        expect(fullSteer).toMatchObject({
          turnId: targetTurnId,
          turnRequest: { status: "rejected" },
        });
        expect(latest.response.rows).toContainEqual(fullSteer);
        const lastHistoricalAnswer = full.response.rows.findIndex(
          (row) =>
            row.kind === "conversation" && row.text === "Answer later-99",
        );
        expect(full.response.rows.indexOf(fullSteer!)).toBeGreaterThan(
          lastHistoricalAnswer,
        );
        const outline = buildThreadConversationOutline(
          testThread.db,
          testThread.thread,
          outlineOptions(testThread),
        );
        const options = outlineOptions(testThread);
        const rejectedItem = outline.items.find(
          (item) => item.id === fullSteer?.id,
        );
        if (rejectedItem === undefined)
          throw new Error("Rejected outline item missing");
        const staleItems = outline.items.filter(
          (item) => item.id !== rejectedItem.id,
        );
        staleItems.splice(2, 0, rejectedItem);
        upsertThreadConversationOutlineRecord(testThread.db, {
          threadId: testThread.thread.id,
          projectionKey: buildThreadConversationOutlineProjectionKey(
            testThread.thread,
            options.outlineSequence,
            options,
          ).replace(/^\[\d+,/, "[3,"),
          itemsJson: JSON.stringify(staleItems),
        });
        expect(
          loadThreadConversationOutline(
            testThread.db,
            testThread.thread,
            options,
          ),
        ).toEqual(outline);
        expect(
          outline.items.findIndex((item) => item.id === fullSteer?.id),
        ).toBeGreaterThan(
          outline.items.findIndex((item) => item.preview === "Answer later-99"),
        );
        const historicalSummary = full.response.rows.find(
          (row) => row.kind === "turn" && row.turnId === targetTurnId,
        );
        expect(historicalSummary).toBeDefined();
        expect(latest.response.timelinePage.olderRowUpdates ?? []).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: historicalSummary?.id }),
          ]),
        );
        expect(latest.profile.eventRowCount).toBeLessThan(30);
      });
    },
  );

  it.each(["steer", "auto"] as const)(
    "retains the historical target in a bounded latest window (%s)",
    (kind) => {
      withTestThread((testThread) => {
        appendRows(
          testThread,
          Array.from({ length: 100 }, (_, index) =>
            turn(`history-${index}`),
          ).flat(),
        );
        const requested = request();
        const [liveStart, ...liveRest] = turn("live");
        appendRows(testThread, [
          liveStart,
          {
            ...requested,
            data: {
              ...requested.data,
              target: { kind, expectedTurnId: targetTurnId },
            },
          },
          rejected(),
          ...liveRest,
        ]);
        const latest = load(testThread);
        const full = load(testThread, 10_000, 100);
        expect(steer(latest)).toHaveLength(1);
        expect(steer(latest)[0]).toMatchObject({
          turnId: targetTurnId,
          turnRequest: { status: "rejected" },
        });
        expect(steer(full)[0]).toMatchObject({ turnId: targetTurnId });
        expect(latest.profile.eventRowCount).toBeLessThan(30);
      });
    },
  );

  it("loads a request referenced by a rejection after the request left the window", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [
        ...turn(targetTurnId),
        request(),
        ...Array.from({ length: 100 }, (_, index) =>
          turn(`later-${index}`),
        ).flat(),
        {
          ...request(null),
          data: {
            ...request(null).data,
            requestId: "creq_kmnpqrstuv",
            input: [{ type: "text", text: "Fresh message" }],
          },
        },
        ...turn("live"),
        rejected(),
      ]);
      const latest = load(testThread);
      expect(steer(latest)).toHaveLength(1);
      expect(steer(latest)[0]).toMatchObject({
        turnId: targetTurnId,
        turnRequest: { status: "rejected" },
      });
      expect(latest.profile.eventRowCount).toBeLessThan(30);
    });
  });

  it.each(["missing", "cleared", "new-turn"] as const)(
    "keeps the safe thread-level fallback for a %s target",
    (scenario) => {
      withTestThread((testThread) => {
        if (scenario !== "missing") appendRows(testThread, turn(targetTurnId));
        if (scenario === "cleared")
          appendRows(testThread, [
            {
              type: "system/operation",
              data: {
                operation: THREAD_CONTEXT_CLEAR_OPERATION,
                operationId: "clear",
                status: "completed",
                message: "Fresh context",
              },
            },
          ]);
        appendRows(testThread, [
          request(scenario === "new-turn" ? null : targetTurnId),
          rejected(),
          ...turn("live"),
        ]);
        expect(steer(load(testThread))[0]).toMatchObject({
          turnId: null,
          turnRequest: { status: "rejected" },
        });
      });
    },
  );

  it("does not resurrect a request from before a context clear", () => {
    withTestThread((testThread) => {
      appendRows(testThread, [
        ...turn(targetTurnId),
        request(),
        {
          type: "system/operation",
          data: {
            operation: THREAD_CONTEXT_CLEAR_OPERATION,
            operationId: "clear",
            status: "completed",
            message: "Fresh context",
          },
        },
        {
          ...request(null),
          data: {
            ...request(null).data,
            requestId: "creq_kmnpqrstuv",
            input: [{ type: "text", text: "Fresh message" }],
          },
        },
        ...turn("live"),
        rejected(),
      ]);
      const result = load(testThread);
      expect(result.response.contextBoundarySeq).toBe(5);
      expect(steer(result)).toHaveLength(0);
    });
  });
});
