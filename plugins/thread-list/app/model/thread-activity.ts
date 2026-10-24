import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
  PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";

type ThreadStatusShape = Pick<
  PluginSidebarThread,
  "status" | "isUnread" | "parentThreadId"
>;
type ThreadRuntimeShape = Pick<
  PluginSidebarThread,
  "runtimeStatus" | "experimental_nativeActivity"
>;
type ThreadActivityStateShape = Pick<PluginSidebarThread, "activity">;

export interface ThreadListIndicatorState {
  hasPendingInteraction: boolean;
  hasUnsubmittedDraft: boolean;
  hasUnreadError: boolean;
  hasUnreadSuccess: boolean;
  isAutomationWoken: boolean;
  isActivityUnreported: boolean;
  queuedFailedCount: number;
  isBackgroundAgentActive: boolean;
  isBackgroundCommandActive: boolean;
  isGoalActive: boolean;
  isPlanModeActive: boolean;
  isRuntimeActive: boolean;
  isWorkflowActive: boolean;
  queuedWork: PluginSidebarThread["queuedWork"];
}

export type ThreadListIndicatorKind = PluginSidebarThreadIndicator;

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

export function getThreadListIndicatorLabel(
  kind: ThreadListIndicatorKind,
  queuedFailedCount = 0,
): string | null {
  if (kind === "none") return null;
  if (kind === "queued-failed" && queuedFailedCount > 0) {
    return queuedFailedCount === 1
      ? "1 queued message not delivered"
      : `${queuedFailedCount} queued messages not delivered`;
  }
  return THREAD_LIST_INDICATOR_LABELS[kind];
}

const RUNNING_RUNTIME_STATUSES: Record<
  PluginSidebarThread["runtimeStatus"],
  boolean
> = {
  active: true,
  provisioning: true,
  starting: true,
  stopping: true,
  error: false,
  idle: false,
  pending: false,
  "waiting-for-host": false,
};

const DONE_THREAD_STATUSES: Record<PluginSidebarThread["status"], boolean> = {
  error: true,
  idle: true,
  active: false,
  starting: false,
  stopping: false,
  pending: false,
};

function isNativeActivityConfirmedOrAbsent(
  thread: ThreadRuntimeShape,
): boolean {
  const activity = thread.experimental_nativeActivity;
  return activity === undefined || activity.confirmation === "confirmed";
}

export function isRuntimeBusyThread(thread: ThreadRuntimeShape): boolean {
  return (
    isNativeActivityConfirmedOrAbsent(thread) &&
    (RUNNING_RUNTIME_STATUSES[thread.runtimeStatus] ?? false)
  );
}

export function nativeActivityNoticeText(
  thread: ThreadRuntimeShape,
  now = Date.now(),
): string {
  const activity = thread.experimental_nativeActivity;
  const lastToolCallAt = activity?.lastToolCallAt;
  if (
    activity?.evidenceKind !== "tool-call" ||
    lastToolCallAt === undefined ||
    now < lastToolCallAt
  ) {
    return "Activity not reported";
  }
  const minutes = Math.floor((now - lastToolCallAt) / 60_000);
  return minutes < 1
    ? "Agent tool call seen just now"
    : `Agent tool call seen ${minutes}m ago`;
}

export function nativeActivityGuidanceText(
  thread: Pick<
    PluginSidebarThread,
    "experimental_nativeActivity" | "host" | "id"
  >,
): string | null {
  const activity = thread.experimental_nativeActivity;
  if (activity === undefined || activity.confirmation === "confirmed") {
    return null;
  }
  return `If this session started before bb was updated, update bb on ${
    thread.host?.name ?? "this thread's machine"
  }, save your work, type /exit in the terminal, then reopen with bb thread native ${thread.id}. A pending question will need to be asked again.`;
}

function isActivityUnreportedThread(thread: ThreadRuntimeShape): boolean {
  return (
    thread.experimental_nativeActivity !== undefined &&
    !isNativeActivityConfirmedOrAbsent(thread) &&
    (RUNNING_RUNTIME_STATUSES[thread.runtimeStatus] ?? false)
  );
}

function hasActiveWorkflowActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.workflows > 0;
}

function hasActiveBackgroundAgentActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.backgroundAgents > 0;
}

function hasActiveBackgroundCommandActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.backgroundCommands > 0;
}

function hasActivePlanModeActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.planMode > 0;
}

function hasActiveGoalActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.goals > 0;
}

function isBusyThread(
  thread: ThreadRuntimeShape & ThreadActivityStateShape,
): boolean {
  return (
    isRuntimeBusyThread(thread) ||
    hasActiveWorkflowActivity(thread) ||
    hasActiveBackgroundAgentActivity(thread) ||
    hasActiveBackgroundCommandActivity(thread) ||
    hasActivePlanModeActivity(thread) ||
    hasActiveGoalActivity(thread)
  );
}

export function hasThreadListWorkingActivity(
  state: ThreadListIndicatorState,
  hasRunningPluginStatus = false,
): boolean {
  return (
    state.isRuntimeActive ||
    state.isWorkflowActive ||
    state.isBackgroundAgentActive ||
    state.isBackgroundCommandActive ||
    state.isPlanModeActive ||
    state.isGoalActive ||
    hasRunningPluginStatus
  );
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

interface ThreadStatusResolution {
  accessibleLabel: string | null;
  indicatorKind: ThreadListIndicatorKind;
  rowStatusIsVisible: boolean;
}

export function resolveThreadStatus(
  state: ThreadListIndicatorState,
  rowStatus: PluginSidebarThreadRowStatus | null,
): ThreadStatusResolution {
  const indicatorKind = resolveThreadListIndicator(state);
  const rowStatusIsVisible =
    rowStatus !== null &&
    indicatorKind !== "working" &&
    indicatorKind !== "runtime" &&
    indicatorKind !== "unread-error" &&
    indicatorKind !== "waiting-for-input" &&
    indicatorKind !== "needs-input";
  return {
    accessibleLabel: rowStatusIsVisible
      ? rowStatus.label
      : getThreadListIndicatorLabel(indicatorKind, state.queuedFailedCount),
    indicatorKind,
    rowStatusIsVisible,
  };
}

export function threadListIndicatorStateForThread(
  thread: ThreadStatusShape &
    ThreadRuntimeShape &
    ThreadActivityStateShape &
    Pick<
      PluginSidebarThread,
      "experimental_queuedFailedCount" | "hasPendingInteraction" | "queuedWork"
    >,
  hasUnsubmittedDraft: boolean,
): ThreadListIndicatorState {
  const unreadDone = isUnreadDoneThread(thread);
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    hasUnsubmittedDraft,
    hasUnreadError: unreadDone && thread.status === "error",
    hasUnreadSuccess: unreadDone && thread.status !== "error",
    isAutomationWoken: false,
    isBackgroundAgentActive: hasActiveBackgroundAgentActivity(thread),
    isBackgroundCommandActive: hasActiveBackgroundCommandActivity(thread),
    isGoalActive: hasActiveGoalActivity(thread),
    queuedWork: thread.queuedWork,
    queuedFailedCount: thread.experimental_queuedFailedCount,
    isActivityUnreported: isActivityUnreportedThread(thread),
    isPlanModeActive: hasActivePlanModeActivity(thread),
    isRuntimeActive: isRuntimeBusyThread(thread),
    isWorkflowActive: hasActiveWorkflowActivity(thread),
  };
}

export interface CollapsedChildActivity {
  threadIds: readonly string[];
  pending: boolean;
  working: boolean;
  runtimeWorking: boolean;
  workflow: boolean;
  backgroundAgent: boolean;
  backgroundCommand: boolean;
  planMode: boolean;
  goal: boolean;
  unread: boolean;
  unreadError: boolean;
}

export const NO_COLLAPSED_CHILD_ACTIVITY: CollapsedChildActivity = {
  threadIds: [],
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
};

type ThreadActivityShape = ThreadStatusShape &
  ThreadRuntimeShape &
  Pick<PluginSidebarThread, "id" | "activity" | "hasPendingInteraction">;

export function getCollapsedChildActivity(
  threads: readonly ThreadActivityShape[],
): CollapsedChildActivity {
  const threadIds: string[] = [];
  let pending = false;
  let working = false;
  let runtimeWorking = false;
  let workflow = false;
  let backgroundAgent = false;
  let backgroundCommand = false;
  let planMode = false;
  let goal = false;
  let unread = false;
  let unreadError = false;
  for (const thread of threads) {
    threadIds.push(thread.id);
    const childUnreadDone = isUnreadDoneThread(thread);
    if (childUnreadDone && thread.status === "error") {
      unreadError = true;
    } else if (childUnreadDone) {
      unread = true;
    }

    if (thread.hasPendingInteraction) {
      pending = true;
    }
    if (isBusyThread(thread)) working = true;
    if (isRuntimeBusyThread(thread)) runtimeWorking = true;
    if (hasActiveWorkflowActivity(thread)) workflow = true;
    if (hasActiveBackgroundAgentActivity(thread)) backgroundAgent = true;
    if (hasActiveBackgroundCommandActivity(thread)) backgroundCommand = true;
    if (hasActivePlanModeActivity(thread)) planMode = true;
    if (hasActiveGoalActivity(thread)) goal = true;
  }
  return {
    threadIds,
    pending,
    working,
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
  return (DONE_THREAD_STATUSES[thread.status] ?? false) && thread.isUnread;
}
