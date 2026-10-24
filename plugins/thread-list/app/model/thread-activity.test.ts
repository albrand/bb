import { describe, expect, it } from "vitest";
import {
  getCollapsedChildActivity,
  hasThreadListWorkingActivity,
  isUnreadDoneThread,
  nativeActivityGuidanceText,
  nativeActivityNoticeText,
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
  type ThreadListIndicatorState,
} from "./thread-activity.js";
import { makeSidebarThread, type SidebarThreadOverrides } from "./fixtures.js";

type ChildActivityInput = Parameters<
  typeof getCollapsedChildActivity
>[0][number];

function makeChild(overrides: SidebarThreadOverrides = {}): ChildActivityInput {
  return makeSidebarThread({
    id: "thr-child",
    status: "idle",
    lastReadAt: 10,
    latestAttentionAt: 10,
    parentThreadId: null,
    hasPendingInteraction: false,
    runtimeStatus: "idle",
    ...overrides,
  });
}

function makeEntry(overrides: SidebarThreadOverrides = {}) {
  return makeSidebarThread({
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  });
}

const busyChild = makeChild({
  status: "active",
  runtimeStatus: "active",
});
const pendingChild = makeChild({ hasPendingInteraction: true });
const unreadChild = makeChild({ latestAttentionAt: 20, lastReadAt: 10 });
const unreadErrorChild = makeChild({
  status: "error",
  latestAttentionAt: 20,
  lastReadAt: 10,
});

const idleIndicatorState: ThreadListIndicatorState = {
  hasPendingInteraction: false,
  isActivityUnreported: false,
  queuedFailedCount: 0,
  hasUnsubmittedDraft: false,
  hasUnreadError: false,
  hasUnreadSuccess: false,
  isAutomationWoken: false,
  isBackgroundAgentActive: false,
  isBackgroundCommandActive: false,
  isGoalActive: false,
  queuedWork: "none",
  isPlanModeActive: false,
  isRuntimeActive: false,
  isWorkflowActive: false,
};

describe("thread-activity", () => {
  it("suppresses unconfirmed native runtime while preserving independent activity and attention", () => {
    const unconfirmed = makeEntry({
      status: "active",
      runtimeStatus: "active",
      experimental_nativeActivity: {
        lastEvidenceAt: null,
        freshForMs: 90_000,
        confirmation: "unconfirmed",
        evidenceKind: "unknown",
      },
    });
    const state = threadListIndicatorStateForThread(unconfirmed, false);
    expect(state.isRuntimeActive).toBe(false);
    expect(resolveThreadListIndicator(state)).toBe("activity-unreported");

    const background = makeEntry({
      ...unconfirmed,
      activity: { ...unconfirmed.activity, backgroundAgents: 1 },
    });
    expect(
      resolveThreadListIndicator(
        threadListIndicatorStateForThread(background, false),
      ),
    ).toBe("working");
    const waiting = makeEntry({ ...unconfirmed, hasPendingInteraction: true });
    expect(
      resolveThreadListIndicator(
        threadListIndicatorStateForThread(waiting, false),
      ),
    ).toBe("needs-input");
  });

  describe("a live native thread whose activity is not reported", () => {
    const base = {
      status: "active" as const,
      runtimeStatus: "active" as const,
      experimental_nativeActivity: {
        lastEvidenceAt: null,
        freshForMs: 90_000,
        confirmation: "unconfirmed" as const,
        evidenceKind: "unknown" as const,
      },
    };

    it("never reads as working from tool-call evidence or an unrecognised confirmation", () => {
      for (const confirmation of ["unconfirmed", "tool-call", "unknown"]) {
        const entry = makeEntry({
          ...base,
          experimental_nativeActivity: {
            lastEvidenceAt: null,
            lastToolCallAt: Date.now(),
            freshForMs: 90_000,
            confirmation: confirmation as "unconfirmed",
            evidenceKind: "tool-call",
          },
        });
        const state = threadListIndicatorStateForThread(entry, false);
        expect(state.isRuntimeActive).toBe(false);
        expect(resolveThreadListIndicator(state)).toBe("activity-unreported");
      }
      const confirmed = makeEntry({
        ...base,
        experimental_nativeActivity: {
          lastEvidenceAt: Date.now(),
          freshForMs: 90_000,
          confirmation: "confirmed",
          evidenceKind: "holder-report",
        },
      });
      expect(
        resolveThreadListIndicator(
          threadListIndicatorStateForThread(confirmed, false),
        ),
      ).toBe("working");
    });

    it("says an agent tool call was seen, with its age", () => {
      const now = 10 * 60_000;
      const entry = makeEntry({
        ...base,
        experimental_nativeActivity: {
          lastEvidenceAt: null,
          lastToolCallAt: now - 3 * 60_000,
          freshForMs: 90_000,
          confirmation: "unconfirmed",
          evidenceKind: "tool-call",
        },
      });
      expect(nativeActivityNoticeText(entry, now)).toBe(
        "Agent tool call seen 3m ago",
      );
      expect(nativeActivityNoticeText(makeEntry(base), now)).toBe(
        "Activity not reported",
      );
    });

    it("never masks failed or waiting queued messages", () => {
      const failed = makeEntry({
        ...base,
        queuedWork: "failed",
        experimental_queuedFailedCount: 4,
      });
      const state = threadListIndicatorStateForThread(failed, false);
      expect(resolveThreadListIndicator(state)).toBe("queued-failed");
      expect(state.queuedFailedCount).toBe(4);
      expect(
        resolveThreadListIndicator(
          threadListIndicatorStateForThread(
            makeEntry({ ...base, queuedWork: "waiting" }),
            false,
          ),
        ),
      ).toBe("queued-waiting");
    });
  });

  describe("hasThreadListWorkingActivity", () => {
    it.each([
      "isRuntimeActive",
      "isWorkflowActive",
      "isBackgroundAgentActive",
      "isBackgroundCommandActive",
      "isPlanModeActive",
      "isGoalActive",
    ] as const)(
      "keeps %s working despite higher-priority attention states",
      (flag) => {
        expect(
          hasThreadListWorkingActivity({
            ...idleIndicatorState,
            hasPendingInteraction: true,
            hasUnreadError: true,
            [flag]: true,
          }),
        ).toBe(true);
      },
    );

    it("includes plugin work without treating attention-only states as work", () => {
      const attentionOnly = {
        ...idleIndicatorState,
        hasPendingInteraction: true,
        hasUnreadError: true,
      };

      expect(hasThreadListWorkingActivity(attentionOnly)).toBe(false);
      expect(hasThreadListWorkingActivity(attentionOnly, true)).toBe(true);
    });
  });

  describe("resolveThreadListIndicator", () => {
    it.each([
      ["hasPendingInteraction", "needs-input"],
      ["hasUnreadError", "working"],
      ["hasUnsubmittedDraft", "working"],
      ["isPlanModeActive", "working"],
      ["isGoalActive", "working"],
    ] as const)("shows %s as %s over the runtime spinner", (flag, kind) => {
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          isRuntimeActive: true,
          [flag]: true,
        }),
      ).toBe(kind);
    });

    it.each([
      "hasUnreadSuccess",
      "isWorkflowActive",
      "isBackgroundAgentActive",
      "isBackgroundCommandActive",
    ] as const)("prefers runtime work over concurrent %s", (flag) => {
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          isRuntimeActive: true,
          [flag]: true,
        }),
      ).toBe("working");
    });

    it.each([
      "isWorkflowActive",
      "isBackgroundAgentActive",
      "isBackgroundCommandActive",
      "isPlanModeActive",
      "isGoalActive",
    ] as const)("uses Working with %s", (flag) => {
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasUnsubmittedDraft: true,
          [flag]: true,
        }),
      ).toBe("working");
    });

    it("shows the queued clock over a draft, and never over active work", () => {
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasUnsubmittedDraft: true,
          queuedWork: "waiting",
        }),
      ).toBe("queued-waiting");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          queuedWork: "waiting",
          isRuntimeActive: true,
        }),
      ).toBe("working");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasPendingInteraction: true,
          queuedWork: "waiting",
        }),
      ).toBe("needs-input");
    });

    it("promotes a failed queued row over a waiting one, but not over work", () => {
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          queuedWork: "failed",
        }),
      ).toBe("queued-failed");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          queuedWork: "failed",
          isBackgroundCommandActive: true,
        }),
      ).toBe("working");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasUnreadError: true,
          queuedWork: "failed",
        }),
      ).toBe("done-unread");
    });

    it.each([
      ["waiting", "done-unread"],
      ["failed", "done-unread"],
    ] as const)(
      "resolves unread success and %s queued work as %s",
      (queuedWork, expectedIndicator) => {
        expect(
          resolveThreadListIndicator({
            ...idleIndicatorState,
            hasUnreadSuccess: true,
            queuedWork,
          }),
        ).toBe(expectedIndicator);
      },
    );

    it("keeps Plan and Goal independent and applies Plan precedence", () => {
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          isGoalActive: true,
          isPlanModeActive: true,
        }),
      ).toBe("working");
    });

    it("applies idle activity precedence before background work", () => {
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          isBackgroundAgentActive: true,
          isBackgroundCommandActive: true,
          isGoalActive: true,
          isPlanModeActive: true,
        }),
      ).toBe("working");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          isBackgroundAgentActive: true,
          isBackgroundCommandActive: true,
          isGoalActive: true,
        }),
      ).toBe("working");
    });

    it("applies critical, idle draft, and unread precedence", () => {
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasPendingInteraction: true,
          hasUnreadError: true,
          isWorkflowActive: true,
        }),
      ).toBe("needs-input");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasPendingInteraction: true,
          isWorkflowActive: true,
        }),
      ).toBe("needs-input");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasUnsubmittedDraft: true,
          hasUnreadSuccess: true,
        }),
      ).toBe("done-unread");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasUnreadSuccess: true,
        }),
      ).toBe("done-unread");
    });
  });

  it("exposes shared running/unread helpers", () => {
    expect(
      isUnreadDoneThread({
        status: "idle",
        isUnread: true,
        parentThreadId: null,
      }),
    ).toBe(true);
    expect(
      isUnreadDoneThread({
        status: "idle",
        isUnread: true,
        parentThreadId: "manager-1",
      }),
    ).toBe(false);
    expect(
      isUnreadDoneThread({
        status: "error",
        isUnread: true,
        parentThreadId: null,
      }),
    ).toBe(true);
    expect(
      isUnreadDoneThread({
        status: "active",
        isUnread: true,
        parentThreadId: null,
      }),
    ).toBe(false);
  });

  describe("threadListIndicatorStateForThread", () => {
    it("marks an unread error thread as an unread error, not a success", () => {
      const thread = makeEntry({
        status: "error",
        latestAttentionAt: 20,
        lastReadAt: 10,
      });

      expect(threadListIndicatorStateForThread(thread, false)).toMatchObject({
        hasUnreadError: true,
        hasUnreadSuccess: false,
        hasUnsubmittedDraft: false,
      });
    });

    it("marks an unread idle thread as an unread success and passes the draft flag through", () => {
      const thread = makeEntry({
        status: "idle",
        latestAttentionAt: 20,
        lastReadAt: 10,
      });

      expect(threadListIndicatorStateForThread(thread, true)).toMatchObject({
        hasUnreadError: false,
        hasUnreadSuccess: true,
        hasUnsubmittedDraft: true,
      });
    });

    it("fills activity flags from the list entry", () => {
      const thread = makeEntry({
        hasPendingInteraction: true,
        queuedWork: "waiting",
        activity: {
          workflows: 1,
          backgroundAgents: 0,
          backgroundCommands: 1,
          planMode: 0,
          goals: 1,
        },
        runtimeStatus: "active",
      });

      expect(threadListIndicatorStateForThread(thread, false)).toEqual({
        hasPendingInteraction: true,
        isActivityUnreported: false,
        queuedFailedCount: 0,
        hasUnsubmittedDraft: false,
        hasUnreadError: false,
        hasUnreadSuccess: false,
        isAutomationWoken: false,
        isBackgroundAgentActive: false,
        isBackgroundCommandActive: true,
        isGoalActive: true,
        queuedWork: "waiting",
        isPlanModeActive: false,
        isRuntimeActive: true,
        isWorkflowActive: true,
      });
    });
  });

  describe("getCollapsedChildActivity", () => {
    it("lists every aggregated thread for per-row draft lookups", () => {
      expect(
        getCollapsedChildActivity([busyChild, pendingChild]),
      ).toMatchObject({
        threadIds: [busyChild.id, pendingChild.id],
        pending: true,
        working: true,
        runtimeWorking: true,
      });
    });

    it("flags nothing for an empty or fully-idle child list", () => {
      expect(getCollapsedChildActivity([])).toMatchObject({
        pending: false,
        working: false,
        runtimeWorking: false,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      });
      expect(
        getCollapsedChildActivity([makeChild(), makeChild()]),
      ).toMatchObject({
        pending: false,
        working: false,
        runtimeWorking: false,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      });
    });

    it("flags a single child's activity", () => {
      expect(getCollapsedChildActivity([busyChild])).toMatchObject({
        pending: false,
        working: true,
        runtimeWorking: true,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      });
      expect(getCollapsedChildActivity([pendingChild])).toMatchObject({
        pending: true,
        working: false,
        runtimeWorking: false,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      });
      expect(getCollapsedChildActivity([unreadChild])).toMatchObject({
        pending: false,
        working: false,
        runtimeWorking: false,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: true,
        unreadError: false,
      });
      expect(getCollapsedChildActivity([unreadErrorChild])).toMatchObject({
        pending: false,
        working: false,
        runtimeWorking: false,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: true,
      });
    });

    it("flags pending and working independently when both are present", () => {
      expect(
        getCollapsedChildActivity([unreadChild, busyChild, pendingChild]),
      ).toMatchObject({
        pending: true,
        working: true,
        runtimeWorking: true,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: true,
        unreadError: false,
      });
      expect(
        getCollapsedChildActivity([
          unreadErrorChild,
          unreadChild,
          busyChild,
          pendingChild,
        ]),
      ).toMatchObject({
        pending: true,
        working: true,
        runtimeWorking: true,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: true,
        unreadError: true,
      });
    });

    it("keeps unread errors visible even when a child is busy", () => {
      const busyUnreadErrorChild = makeChild({
        status: "error",
        latestAttentionAt: 20,
        lastReadAt: 10,
        activity: {
          workflows: 1,
          backgroundAgents: 1,
          backgroundCommands: 1,
          planMode: 0,
          goals: 0,
        },
        runtimeStatus: "active",
      });

      expect(getCollapsedChildActivity([busyUnreadErrorChild])).toMatchObject({
        pending: false,
        working: true,
        runtimeWorking: true,
        workflow: true,
        backgroundAgent: true,
        backgroundCommand: true,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: true,
      });
    });

    it("preserves raw work signals for a blocked child", () => {
      const busyAndPending = makeChild({
        status: "active",
        hasPendingInteraction: true,
        runtimeStatus: "active",
      });
      expect(getCollapsedChildActivity([busyAndPending])).toMatchObject({
        pending: true,
        working: true,
        runtimeWorking: true,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      });
    });

    it.each([
      ["backgroundCommands", "backgroundCommand"],
      ["backgroundAgents", "backgroundAgent"],
      ["workflows", "workflow"],
      ["planMode", "planMode"],
      ["goals", "goal"],
    ] as const)(
      "distinguishes idle %s activity from runtime work",
      (activityKey, flag) => {
        const child = makeChild({
          activity: {
            workflows: 0,
            backgroundAgents: 0,
            backgroundCommands: 0,
            planMode: 0,
            goals: 0,
            [activityKey]: 1,
          },
        });

        expect(getCollapsedChildActivity([child])).toMatchObject({
          pending: false,
          working: true,
          runtimeWorking: false,
          workflow: false,
          backgroundAgent: false,
          backgroundCommand: false,
          planMode: false,
          goal: false,
          unread: false,
          unreadError: false,
          [flag]: true,
        });
      },
    );

    it("never flags 'unread' for parented children", () => {
      const unreadButParented = makeChild({
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: "manager-1",
      });
      expect(getCollapsedChildActivity([unreadButParented])).toMatchObject({
        unread: false,
        unreadError: false,
      });
    });
  });
});

describe("nativeActivityGuidanceText", () => {
  const unconfirmed = {
    lastEvidenceAt: null,
    freshForMs: 90_000,
    confirmation: "unconfirmed" as const,
    evidenceKind: "unknown" as const,
  };

  it("is null for confirmed activity and when no activity diagnostic exists", () => {
    expect(
      nativeActivityGuidanceText(
        makeSidebarThread({
          experimental_nativeActivity: {
            ...unconfirmed,
            confirmation: "confirmed",
            evidenceKind: "holder-report",
            lastEvidenceAt: 1,
          },
        }),
      ),
    ).toBeNull();
    expect(nativeActivityGuidanceText(makeSidebarThread())).toBeNull();
  });

  it("names the host and the thread when the activity is unconfirmed", () => {
    expect(
      nativeActivityGuidanceText(
        makeSidebarThread({
          id: "thr_x",
          host: { id: "host_1", name: "Build box" },
          experimental_nativeActivity: unconfirmed,
        }),
      ),
    ).toBe(
      "If this session started before bb was updated, update bb on Build box, save your work, type /exit in the terminal, then reopen with bb thread native thr_x. A pending question will need to be asked again.",
    );
  });

  it("falls back to this thread's machine when the host is unknown", () => {
    expect(
      nativeActivityGuidanceText(
        makeSidebarThread({
          host: null,
          experimental_nativeActivity: unconfirmed,
        }),
      ),
    ).toContain("update bb on this thread's machine, save your work");
  });
});
