import { assertNever } from "@bb/core-ui";
import type {
  NativeActivityEvidenceKind,
  Thread,
  ThreadListEntry,
  ThreadListIndicator,
  ThreadQueuedWork,
  ThreadWithRuntime,
} from "@bb/domain";
// Imported from the defining leaf module, not the timeline barrel: the sidebar
// thread list reaches this helper before first paint, and the barrel would pull
// the whole timeline (and @pierre/diffs, Shiki, KaTeX behind it) onto the boot
// path for one predicate.
import { isRunningThreadRuntimeDisplayStatus } from "../timeline/thread-runtime-status.js";
import { isThreadRead } from "./thread-read-state.js";

type ThreadStatusShape = Pick<
  Thread,
  "status" | "lastReadAt" | "latestAttentionAt" | "parentThreadId"
>;

type ThreadRuntimeShape = Pick<ThreadWithRuntime, "runtime">;
type ThreadActivityStateShape = Pick<ThreadListEntry, "activity">;

function isRuntimeBusyThread(
  thread: ThreadRuntimeShape,
  now = Date.now(),
  nativeActivityUnconfirmed = isNativeActivityUnconfirmed(thread.runtime, now),
): boolean {
  return (
    !nativeActivityUnconfirmed &&
    isRunningThreadRuntimeDisplayStatus(thread.runtime.displayStatus)
  );
}

export function isNativeActivityUnconfirmed(
  runtime: ThreadRuntimeShape["runtime"],
  now = Date.now(),
): boolean {
  const activity = runtime.nativeActivity;
  if (activity === undefined) return false;
  return (
    activity.confirmation !== "confirmed" ||
    activity.lastEvidenceAt === null ||
    now < activity.lastEvidenceAt ||
    now - activity.lastEvidenceAt > activity.freshForMs
  );
}

export function nativeActivityEvidenceKind(
  runtime: ThreadRuntimeShape["runtime"],
  now = Date.now(),
  unconfirmed = isNativeActivityUnconfirmed(runtime, now),
): NativeActivityEvidenceKind {
  const activity = runtime.nativeActivity;
  if (activity === undefined) return "unknown";
  if (!unconfirmed) return "holder-report";
  const lastToolCallAt = activity.lastToolCallAt;
  return lastToolCallAt !== undefined &&
    now >= lastToolCallAt &&
    now - lastToolCallAt <= activity.freshForMs
    ? "tool-call"
    : "unknown";
}

function hasActiveWorkflowActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.activeWorkflowCount > 0;
}

function hasActiveBackgroundAgentActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.activeBackgroundAgentCount > 0;
}

function hasActiveBackgroundCommandActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.activeBackgroundCommandCount > 0;
}

function hasActivePlanModeActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.activePlanModeCount > 0;
}

function hasActiveGoalActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.activeGoalCount > 0;
}

function isBusyThread(
  thread: ThreadRuntimeShape & ThreadActivityStateShape,
  now = Date.now(),
): boolean {
  return (
    isRuntimeBusyThread(thread, now) ||
    hasActiveWorkflowActivity(thread) ||
    hasActiveBackgroundAgentActivity(thread) ||
    hasActiveBackgroundCommandActivity(thread) ||
    hasActivePlanModeActivity(thread) ||
    hasActiveGoalActivity(thread)
  );
}

export interface ThreadListIndicatorState {
  hasPendingInteraction: boolean;
  isActivityUnreported: boolean;
  queuedFailedCount: number;
  hasUnsubmittedDraft: boolean;
  hasUnreadError: boolean;
  hasUnreadSuccess: boolean;
  isAutomationWoken: boolean;
  isBackgroundAgentActive: boolean;
  isBackgroundCommandActive: boolean;
  isGoalActive: boolean;
  isPlanModeActive: boolean;
  isRuntimeActive: boolean;
  isWorkflowActive: boolean;
  /**
   * Whether the thread has work waiting on its queue. Read straight off the list
   * entry rather than inferred from the thread's status: a `pending` thread is
   * only the most obvious case, and an idle thread with a scheduled send or a
   * plugin-queued follow-up is waiting just as much.
   */
  queuedWork: ThreadQueuedWork;
}

export type ThreadListIndicatorKind = ThreadListIndicator;

const THREAD_LIST_INDICATOR_LABELS: Record<
  Exclude<ThreadListIndicatorKind, "none">,
  string
> = {
  "unread-error": "Unread thread failed",
  "waiting-for-input": "Thread needs user input",
  "needs-input": "Needs input",
  working: "Working",
  woke: "Woke",
  "done-unread": "Done",
  "working-draft": "Thread working with unsubmitted draft",
  workflow: "Workflow running",
  "background-agent": "Background agent running",
  "background-command": "Background command running",
  "plan-mode": "Plan mode active",
  goal: "Goal active",
  runtime: "Thread working",
  "queued-failed": "Queued messages not delivered",
  "queued-waiting": "Thread has a message waiting to send",
  "activity-unreported": "Activity not reported",
  draft: "Thread has unsubmitted draft",
  "unread-success": "Unread thread succeeded",
};

export function formatQueuedFailedLabel(queuedFailedCount: number): string {
  return queuedFailedCount === 1
    ? "1 queued message not delivered"
    : `${queuedFailedCount} queued messages not delivered`;
}

export function getThreadListIndicatorLabel(
  kind: ThreadListIndicatorKind,
  queuedFailedCount = 0,
): string | null {
  if (kind === "none") return null;
  if (kind === "queued-failed" && queuedFailedCount > 0) {
    return formatQueuedFailedLabel(queuedFailedCount);
  }
  return THREAD_LIST_INDICATOR_LABELS[kind];
}

function hasThreadListWorkingActivity(
  state: ThreadListIndicatorState,
): boolean {
  return (
    state.isRuntimeActive ||
    state.isWorkflowActive ||
    state.isBackgroundAgentActive ||
    state.isBackgroundCommandActive ||
    state.isPlanModeActive ||
    state.isGoalActive
  );
}

export function threadListIndicatorStateForThread(
  thread: ThreadListEntry,
  hasUnsubmittedDraft: boolean,
  now = Date.now(),
  nativeActivityUnconfirmed?: boolean,
): ThreadListIndicatorState {
  const unreadDone = isUnreadDoneThread(thread);
  const activityUnconfirmed =
    nativeActivityUnconfirmed ??
    isNativeActivityUnconfirmed(thread.runtime, now);
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    isActivityUnreported:
      thread.runtime.nativeActivity !== undefined &&
      activityUnconfirmed &&
      isRunningThreadRuntimeDisplayStatus(thread.runtime.displayStatus),
    hasUnsubmittedDraft,
    hasUnreadError: unreadDone && thread.status === "error",
    hasUnreadSuccess: unreadDone && thread.status !== "error",
    isAutomationWoken: false,
    isBackgroundAgentActive: hasActiveBackgroundAgentActivity(thread),
    isBackgroundCommandActive: hasActiveBackgroundCommandActivity(thread),
    isGoalActive: hasActiveGoalActivity(thread),
    queuedWork: thread.queuedWork,
    queuedFailedCount: thread.queuedFailedCount,
    isPlanModeActive: hasActivePlanModeActivity(thread),
    isRuntimeActive: isRuntimeBusyThread(
      thread,
      now,
      nativeActivityUnconfirmed,
    ),
    isWorkflowActive: hasActiveWorkflowActivity(thread),
  };
}

export function resolveThreadListIndicator(
  state: ThreadListIndicatorState,
): ThreadListIndicatorKind {
  if (state.hasPendingInteraction) return "needs-input";
  const hasActiveWork = hasThreadListWorkingActivity(state);
  if (hasActiveWork) return "working";
  if (state.isAutomationWoken) return "woke";
  if (state.hasUnreadError || state.hasUnreadSuccess) return "done-unread";
  if (state.queuedWork === "failed") return "queued-failed";
  if (state.queuedWork === "waiting") return "queued-waiting";
  if (state.isActivityUnreported) return "activity-unreported";
  if (state.hasUnsubmittedDraft) return "draft";
  return "none";
}

export interface CollapsedChildActivity {
  pending: boolean;
  working: boolean;
  hasUnsubmittedDraft: boolean;
  runtimeWorking: boolean;
  workflow: boolean;
  backgroundAgent: boolean;
  backgroundCommand: boolean;
  planMode: boolean;
  goal: boolean;
  unread: boolean;
  unreadError: boolean;
}

type ThreadActivityShape = ThreadStatusShape &
  ThreadRuntimeShape &
  Pick<ThreadListEntry, "id" | "activity" | "hasPendingInteraction">;

const EMPTY_DRAFT_THREAD_IDS: ReadonlySet<string> = new Set();

export function getCollapsedChildActivity(
  threads: readonly ThreadActivityShape[],
  draftThreadIds: ReadonlySet<string> = EMPTY_DRAFT_THREAD_IDS,
  now = Date.now(),
): CollapsedChildActivity {
  let pending = false;
  let working = false;
  let hasUnsubmittedDraft = false;
  let runtimeWorking = false;
  let workflow = false;
  let backgroundAgent = false;
  let backgroundCommand = false;
  let planMode = false;
  let goal = false;
  let unread = false;
  let unreadError = false;
  for (const thread of threads) {
    if (draftThreadIds.has(thread.id)) {
      hasUnsubmittedDraft = true;
    }
    const childUnreadDone = isUnreadDoneThread(thread);
    if (childUnreadDone && thread.status === "error") {
      unreadError = true;
    } else if (childUnreadDone) {
      unread = true;
    }

    if (thread.hasPendingInteraction) {
      pending = true;
    }
    if (isBusyThread(thread, now)) working = true;
    if (isRuntimeBusyThread(thread, now)) runtimeWorking = true;
    if (hasActiveWorkflowActivity(thread)) workflow = true;
    if (hasActiveBackgroundAgentActivity(thread)) backgroundAgent = true;
    if (hasActiveBackgroundCommandActivity(thread)) backgroundCommand = true;
    if (hasActivePlanModeActivity(thread)) planMode = true;
    if (hasActiveGoalActivity(thread)) goal = true;
  }
  return {
    pending,
    working,
    hasUnsubmittedDraft,
    runtimeWorking,
    workflow,
    backgroundAgent,
    backgroundCommand,
    planMode,
    goal,
    unread,
    unreadError,
  };
}

export function isUnreadDoneThread(thread: ThreadStatusShape): boolean {
  if (thread.parentThreadId != null) {
    return false;
  }

  switch (thread.status) {
    case "error":
    case "idle":
      return !isThreadRead(thread);
    case "active":
    case "starting":
    case "stopping":
    // A pending thread has never run, so it has no outcome to be unread
    // about; it is waiting, not done.
    case "pending":
      return false;
    default:
      return assertNever(thread.status);
  }
}
