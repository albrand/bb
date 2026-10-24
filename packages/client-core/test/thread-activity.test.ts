import { describe, expect, it } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import {
  getCollapsedChildActivity,
  isNativeActivityUnconfirmed,
  isUnreadDoneThread,
  nativeActivityEvidenceKind,
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
  type ThreadListIndicatorState,
} from "../src/thread/thread-activity.js";

type ChildActivityInput = Parameters<
  typeof getCollapsedChildActivity
>[0][number];

function makeChild(
  overrides: Partial<ChildActivityInput> = {},
): ChildActivityInput {
  return {
    id: "thr-child",
    status: "idle",
    lastReadAt: 10,
    latestAttentionAt: 10,
    parentThreadId: null,
    hasPendingInteraction: false,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    runtime: { displayStatus: "idle" },
    ...overrides,
  };
}

const busyChild = makeChild({
  status: "active",
  runtime: { displayStatus: "active" },
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
  it("treats native confirmation as stale after 90 seconds and on future timestamps", () => {
    const runtime = {
      displayStatus: "active" as const,
      nativeActivity: {
        lastEvidenceAt: 1_000_000,
        freshForMs: 90_000,
        confirmation: "confirmed" as const,
        evidenceKind: "holder-report" as const,
      },
    };
    expect(isNativeActivityUnconfirmed(runtime, 1_090_000)).toBe(false);
    expect(isNativeActivityUnconfirmed(runtime, 1_090_001)).toBe(true);
    expect(isNativeActivityUnconfirmed(runtime, 999_999)).toBe(true);
    expect(
      isNativeActivityUnconfirmed(
        {
          ...runtime,
          nativeActivity: { ...runtime.nativeActivity, lastEvidenceAt: null },
        },
        1_000_000,
      ),
    ).toBe(true);
  });

  describe("resolveThreadListIndicator", () => {
    it.each([
      ["needs input", { hasPendingInteraction: true }, "needs-input"],
      ["working", { isRuntimeActive: true }, "working"],
      ["woke", { isAutomationWoken: true }, "woke"],
      ["done unread", { hasUnreadSuccess: true }, "done-unread"],
      ["at rest", {}, "none"],
    ] as const)("resolves %s", (_name, state, expected) => {
      expect(
        resolveThreadListIndicator({ ...idleIndicatorState, ...state }),
      ).toBe(expected);
    });

    it("uses needs input, working, woke, done, then at-rest precedence", () => {
      const all = {
        ...idleIndicatorState,
        hasPendingInteraction: true,
        isRuntimeActive: true,
        isAutomationWoken: true,
        hasUnreadSuccess: true,
      };
      expect(resolveThreadListIndicator(all)).toBe("needs-input");
      expect(
        resolveThreadListIndicator({ ...all, hasPendingInteraction: false }),
      ).toBe("working");
      expect(
        resolveThreadListIndicator({
          ...all,
          hasPendingInteraction: false,
          isRuntimeActive: false,
        }),
      ).toBe("woke");
      expect(
        resolveThreadListIndicator({
          ...all,
          hasPendingInteraction: false,
          isRuntimeActive: false,
          isAutomationWoken: false,
        }),
      ).toBe("done-unread");
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          hasPendingInteraction: false,
          isRuntimeActive: false,
          isAutomationWoken: false,
          hasUnreadSuccess: false,
        }),
      ).toBe("none");
    });

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
      // Queued work does not mean the thread is idle — a running thread can
      // hold a queued follow-up — and what it is DOING outranks what is
      // waiting behind it.
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
      // Precedence inside the queue fact: a row that failed to go out is the
      // one the reader has to act on, and a thread can hold both at once.
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          queuedWork: "failed",
        }),
      ).toBe("queued-failed");
      // Still below every working arm: the failure is about a message that has
      // not gone, not about the turn currently running.
      expect(
        resolveThreadListIndicator({
          ...idleIndicatorState,
          queuedWork: "failed",
          isBackgroundCommandActive: true,
        }),
      ).toBe("working");
      // And below the thread's own unread failure, which is the same glyph
      // reporting the bigger fact.
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
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: null,
      }),
    ).toBe(true);
    expect(
      isUnreadDoneThread({
        status: "idle",
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: "manager-1",
      }),
    ).toBe(false);
    expect(
      isUnreadDoneThread({
        status: "error",
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: null,
      }),
    ).toBe(true);
    expect(
      isUnreadDoneThread({
        status: "active",
        latestAttentionAt: 20,
        lastReadAt: null,
        parentThreadId: null,
      }),
    ).toBe(false);
  });

  describe("threadListIndicatorStateForThread", () => {
    it("marks an unread error thread as an unread error, not a success", () => {
      const thread = makeThreadListEntry({
        status: "error",
        latestAttentionAt: 20,
        lastReadAt: 10,
      });

      expect(threadListIndicatorStateForThread(thread, false)).toMatchObject({
        hasUnreadError: true,
        hasUnreadSuccess: false,
        isAutomationWoken: false,
        hasUnsubmittedDraft: false,
      });
    });

    it("marks an unread idle thread as an unread success and passes the draft flag through", () => {
      const thread = makeThreadListEntry({
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
      const thread = makeThreadListEntry({
        hasPendingInteraction: true,
        queuedWork: "waiting",
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 0,
          activeGoalCount: 1,
        },
        runtime: { displayStatus: "active" },
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

  describe("a live native thread whose activity is not reported", () => {
    const unconfirmedRuntime = {
      displayStatus: "active" as const,
      nativeActivity: {
        lastEvidenceAt: null,
        freshForMs: 90_000,
        confirmation: "unconfirmed" as const,
        evidenceKind: "unknown" as const,
      },
    };
    const indicatorFor = (
      overrides: Parameters<typeof makeThreadListEntry>[0],
    ) =>
      resolveThreadListIndicator(
        threadListIndicatorStateForThread(
          makeThreadListEntry({ status: "active", ...overrides }),
          false,
        ),
      );

    it("reports fresh agent tool-call evidence as its own kind and never as working", () => {
      const now = 5_000_000;
      const toolCall = {
        displayStatus: "active" as const,
        nativeActivity: {
          lastEvidenceAt: null,
          lastToolCallAt: now - 1_000,
          freshForMs: 90_000,
          confirmation: "unconfirmed" as const,
          evidenceKind: "tool-call" as const,
        },
      };
      expect(isNativeActivityUnconfirmed(toolCall, now)).toBe(true);
      expect(nativeActivityEvidenceKind(toolCall, now)).toBe("tool-call");
      expect(
        resolveThreadListIndicator(
          threadListIndicatorStateForThread(
            makeThreadListEntry({ status: "active", runtime: toolCall }),
            false,
            now,
          ),
        ),
      ).toBe("activity-unreported");
      expect(nativeActivityEvidenceKind(toolCall, now + 90_001)).toBe(
        "unknown",
      );
      expect(
        nativeActivityEvidenceKind(
          {
            ...toolCall,
            nativeActivity: {
              ...toolCall.nativeActivity,
              lastToolCallAt: now + 1,
            },
          },
          now,
        ),
      ).toBe("unknown");
    });

    it("lets only an explicit confirmed holder report enable working", () => {
      const now = 5_000_000;
      const runtimeWith = (confirmation: string, lastEvidenceAt: number) => ({
        displayStatus: "active" as const,
        nativeActivity: {
          lastEvidenceAt,
          freshForMs: 90_000,
          confirmation: confirmation as "confirmed",
          evidenceKind: "holder-report" as const,
        },
      });
      expect(
        isNativeActivityUnconfirmed(runtimeWith("confirmed", now), now),
      ).toBe(false);
      for (const confirmation of ["unconfirmed", "tool-call", "unknown", ""]) {
        expect(
          isNativeActivityUnconfirmed(runtimeWith(confirmation, now), now),
        ).toBe(true);
      }
    });

    it("shows a neutral activity-not-reported state, never working", () => {
      expect(indicatorFor({ runtime: unconfirmedRuntime })).toBe(
        "activity-unreported",
      );
      expect(
        indicatorFor({
          runtime: {
            ...unconfirmedRuntime,
            nativeActivity: {
              lastEvidenceAt: Date.now(),
              freshForMs: 90_000,
              confirmation: "confirmed",
              evidenceKind: "holder-report",
            },
          },
        }),
      ).toBe("working");
    });

    it("never masks a failed queued message or a message waiting to send", () => {
      expect(
        indicatorFor({ runtime: unconfirmedRuntime, queuedWork: "failed" }),
      ).toBe("queued-failed");
      expect(
        indicatorFor({ runtime: unconfirmedRuntime, queuedWork: "waiting" }),
      ).toBe("queued-waiting");
    });

    it("yields to a thread that needs input", () => {
      expect(
        indicatorFor({
          runtime: unconfirmedRuntime,
          hasPendingInteraction: true,
        }),
      ).toBe("needs-input");
    });

    it("is not claimed by a thread without native activity or one that is idle", () => {
      expect(indicatorFor({ runtime: { displayStatus: "active" } })).toBe(
        "working",
      );
      expect(
        indicatorFor({
          status: "idle",
          runtime: { ...unconfirmedRuntime, displayStatus: "idle" },
        }),
      ).toBe("none");
    });
  });

  describe("getCollapsedChildActivity", () => {
    it("excludes unconfirmed native runtime while retaining independent child work", () => {
      const nativeChild = makeChild({
        status: "active",
        runtime: {
          displayStatus: "active",
          nativeActivity: {
            lastEvidenceAt: null,
            freshForMs: 90_000,
            confirmation: "unconfirmed",
            evidenceKind: "unknown",
          },
        },
      });
      expect(getCollapsedChildActivity([nativeChild])).toMatchObject({
        working: false,
        runtimeWorking: false,
      });
      expect(
        getCollapsedChildActivity([
          {
            ...nativeChild,
            activity: {
              ...nativeChild.activity,
              activeBackgroundAgentCount: 1,
            },
          },
        ]),
      ).toMatchObject({ working: true, runtimeWorking: false });
    });

    it("preserves descendant draft state independently from work", () => {
      expect(
        getCollapsedChildActivity(
          [busyChild, pendingChild],
          new Set([pendingChild.id]),
        ),
      ).toMatchObject({
        pending: true,
        working: true,
        hasUnsubmittedDraft: true,
        runtimeWorking: true,
      });
    });

    it("flags nothing for an empty or fully-idle child list", () => {
      expect(getCollapsedChildActivity([])).toEqual({
        pending: false,
        working: false,
        hasUnsubmittedDraft: false,
        runtimeWorking: false,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      });
      expect(getCollapsedChildActivity([makeChild(), makeChild()])).toEqual({
        pending: false,
        working: false,
        hasUnsubmittedDraft: false,
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
      expect(getCollapsedChildActivity([busyChild])).toEqual({
        pending: false,
        working: true,
        hasUnsubmittedDraft: false,
        runtimeWorking: true,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      });
      expect(getCollapsedChildActivity([pendingChild])).toEqual({
        pending: true,
        working: false,
        hasUnsubmittedDraft: false,
        runtimeWorking: false,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: false,
        unreadError: false,
      });
      expect(getCollapsedChildActivity([unreadChild])).toEqual({
        pending: false,
        working: false,
        hasUnsubmittedDraft: false,
        runtimeWorking: false,
        workflow: false,
        backgroundAgent: false,
        backgroundCommand: false,
        planMode: false,
        goal: false,
        unread: true,
        unreadError: false,
      });
      expect(getCollapsedChildActivity([unreadErrorChild])).toEqual({
        pending: false,
        working: false,
        hasUnsubmittedDraft: false,
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
      ).toEqual({
        pending: true,
        working: true,
        hasUnsubmittedDraft: false,
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
      ).toEqual({
        pending: true,
        working: true,
        hasUnsubmittedDraft: false,
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
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 1,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
        runtime: { displayStatus: "active" },
      });

      expect(getCollapsedChildActivity([busyUnreadErrorChild])).toEqual({
        pending: false,
        working: true,
        hasUnsubmittedDraft: false,
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
        runtime: { displayStatus: "active" },
      });
      expect(getCollapsedChildActivity([busyAndPending])).toEqual({
        pending: true,
        working: true,
        hasUnsubmittedDraft: false,
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
      [
        "idle background commands",
        "activeBackgroundCommandCount",
        "backgroundCommand",
      ],
      [
        "idle background agent activity",
        "activeBackgroundAgentCount",
        "backgroundAgent",
      ],
      ["idle workflow activity", "activeWorkflowCount", "workflow"],
      ["plan-mode banner activity", "activePlanModeCount", "planMode"],
      ["active-goal banner activity", "activeGoalCount", "goal"],
    ] as const)(
      "distinguishes %s from runtime work",
      (_label, countKey, flag) => {
        const child = makeChild({
          activity: {
            activeWorkflowCount: 0,
            activeBackgroundAgentCount: 0,
            activeBackgroundCommandCount: 0,
            activePlanModeCount: 0,
            activeGoalCount: 0,
            [countKey]: 1,
          },
        });

        expect(getCollapsedChildActivity([child])).toEqual({
          pending: false,
          working: true,
          hasUnsubmittedDraft: false,
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
