import {
  getEnvironment,
  getNativeTerminalThread,
  getThreadRowState,
  getSessionById,
  listActiveBackgroundTaskCountsByThreadIds,
  listLatestClosedSessionsForHosts,
  listNativeTerminalThreadsByIds,
  listLatestThreadStateEventRowsByThreadIds,
  listOpenTurnInputAcceptedRowsByThreadIds,
  listStoredClientTurnRequestRowsByKeys,
  type DbConnection,
  type HostDaemonSessionRow,
  type NativeTerminalThreadRecord,
  type StoredEventRow,
  type ThreadClientTurnRequestKey,
  type ThreadWithPendingInteractionState,
} from "@bb/db";
import {
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  NATIVE_TERMINAL_ACTIVITY_FRESH_FOR_MS,
} from "@bb/domain";
import type {
  Thread,
  ThreadActivityState,
  ThreadChangeMetadata,
  ThreadListEntry,
  ThreadQueuedWork,
  ThreadRuntimeState,
  ThreadStatus,
  ThreadWithRuntime,
} from "@bb/domain";
import {
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "@bb/client-core";
import {
  extractThreadTimelineActivePlanTurn,
  extractThreadTimelineGoal,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import type { ThreadResponse } from "@bb/server-contract";
import type { NotificationHub } from "../../ws/hub.js";
import { isHostDisconnectHidden } from "../hosts/host-disconnect-display.js";
import { resolveProviderPlanCommand } from "../providers/provider-plan-command.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import {
  countUnmanagedWorkspaceThreads,
  listQueuedThreadMessageCountsByThreadIds,
} from "@bb/db";
import {
  resolveEnvironmentWorkspaceDisplayKind,
  toEnvironmentResponse,
} from "../environments/environment-response.js";
import { canThreadSpawnChild } from "./thread-parent.js";
import { canRestoreThreadEnvironment } from "./thread-environment-restore.js";
import {
  canThreadEditMessages,
  type ThreadMessageEditPolicyDeps,
} from "./thread-message-edit-policy.js";
import { toThreadEventWithMeta } from "./timeline.js";
import { intendedThreadHostId } from "./dispatch-attempt.js";

type ThreadRuntimeDisplayHub = Pick<
  NotificationHub,
  "getDaemonSessionIdForHost"
>;

interface ThreadRuntimeDisplayDeps {
  db: DbConnection;
  hub: ThreadRuntimeDisplayHub;
}

interface NativeActivityDisplayDeps extends ThreadRuntimeDisplayDeps {
  providerRegistry: ProviderRegistryService;
}

interface PluginThreadResponseDisplayDeps extends ThreadRuntimeDisplayDeps {
  providerRegistry?: ProviderRegistryService;
}

type ThreadResponseDisplayDeps = NativeActivityDisplayDeps &
  ThreadMessageEditPolicyDeps;

type ThreadPromptBannerDeps = NativeActivityDisplayDeps;
type NativeActivityThreadRecord = Pick<
  NativeTerminalThreadRecord,
  | "providerId"
  | "lastEvidenceAt"
  | "lastToolCallAt"
  | "lastToolCallSessionId"
  | "nativeSessionId"
>;

interface ResolveThreadRuntimeStateArgs {
  environmentHostId: string | null;
  now?: number;
  status: ThreadStatus;
}

interface ResolveThreadRuntimeStateFromLatestSessionArgs {
  environmentHostId: string | null;
  hostConnected: boolean;
  latestClosedSession: HostDaemonSessionRow | null;
  now?: number;
  status: ThreadStatus;
}

interface ToThreadResponseFromThreadArgs {
  now?: number;
  thread: Thread;
}

interface ToThreadResponseWithHostArgs extends ToThreadResponseFromThreadArgs {
  environmentHostId: string | null;
}

interface ToThreadListEntryResponsesArgs {
  now?: number;
  threads: readonly ThreadWithPendingInteractionState[];
}

interface ToThreadListEntryResponseFromLatestSessionArgs {
  deps: NativeActivityDisplayDeps;
  activity: ThreadActivityState;
  hostConnected: boolean;
  latestClosedSession: HostDaemonSessionRow | null;
  nativeTerminalThread: NativeActivityThreadRecord | null;
  now?: number;
  queuedWork: ThreadQueuedWork;
  queuedFailedCount: number;
  rowState: ReturnType<typeof getThreadRowState>;
  thread: ThreadWithPendingInteractionState;
}

interface BuildThreadStatusChangeMetadataByThreadIdArgs {
  environmentHostId: string;
  threads: readonly Thread[];
}

interface ToThreadStatusChangeMetadataArgs {
  activity: ThreadActivityState;
  runtime: ThreadRuntimeState;
  thread: Thread;
}

interface PromptBannerActivityState extends Pick<
  ThreadActivityState,
  "activeGoalCount" | "activePlanModeCount"
> {
  activePlanTurnId: string | null;
}

const EMPTY_THREAD_ACTIVITY: ThreadActivityState = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeGoalCount: 0,
  activePlanModeCount: 0,
  activeWorkflowCount: 0,
};

function threadStatusRuntimeState(status: ThreadStatus): ThreadRuntimeState {
  switch (status) {
    case "pending":
    case "starting":
    case "idle":
    case "active":
    case "stopping":
    case "error":
      return { displayStatus: status };
  }
}

function hasOpenDaemonSessionForHost(
  deps: ThreadRuntimeDisplayDeps,
  hostId: string,
): boolean {
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
  if (!sessionId) {
    return false;
  }
  const session = getSessionById(deps.db, { sessionId });
  return session?.hostId === hostId && session.status === "active";
}

function toPublicThread(thread: Thread): Thread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    providerId: thread.providerId,
    title: thread.title,
    titleFallback: thread.titleFallback,
    sectionId: thread.sectionId,
    status: thread.status,
    parentThreadId: thread.parentThreadId,
    sourceThreadId: thread.sourceThreadId,
    lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId,
    originKind: thread.originKind,
    originPluginId: thread.originPluginId,
    visibility: thread.visibility,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    deletedAt: thread.deletedAt,
    lastReadAt: thread.lastReadAt,
    latestAttentionAt: thread.latestAttentionAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export function resolveThreadRuntimeState(
  deps: ThreadRuntimeDisplayDeps,
  args: ResolveThreadRuntimeStateArgs,
): ThreadRuntimeState {
  if (args.status !== "active" || args.environmentHostId === null) {
    return resolveThreadRuntimeStateFromLatestSession({
      environmentHostId: args.environmentHostId,
      hostConnected: false,
      latestClosedSession: null,
      now: args.now,
      status: args.status,
    });
  }

  const hostConnected = hasOpenDaemonSessionForHost(
    deps,
    args.environmentHostId,
  );
  return resolveThreadRuntimeStateFromLatestSession({
    environmentHostId: args.environmentHostId,
    hostConnected,
    latestClosedSession: getLatestClosedSessionForHost(deps, {
      hostConnected,
      hostId: args.environmentHostId,
    }),
    now: args.now,
    status: args.status,
  });
}

function resolveThreadRuntimeStateFromLatestSession(
  args: ResolveThreadRuntimeStateFromLatestSessionArgs,
): ThreadRuntimeState {
  if (args.status !== "active" || args.environmentHostId === null) {
    return threadStatusRuntimeState(args.status);
  }

  if (
    args.hostConnected ||
    isHostDisconnectHidden(args.latestClosedSession, args.now ?? Date.now())
  ) {
    return threadStatusRuntimeState("active");
  }
  return { displayStatus: "waiting-for-host" };
}

function getLatestClosedSessionForHost(
  deps: ThreadRuntimeDisplayDeps,
  args: { hostConnected: boolean; hostId: string },
): HostDaemonSessionRow | null {
  if (args.hostConnected) {
    return null;
  }
  return (
    listLatestClosedSessionsForHosts(deps.db, { hostIds: [args.hostId] })[0] ??
    null
  );
}

function resolveThreadEnvironmentHostId(
  deps: ThreadRuntimeDisplayDeps,
  thread: Thread,
): string | null {
  if (thread.environmentId === null) {
    return null;
  }
  return getEnvironment(deps.db, thread.environmentId)?.hostId ?? null;
}

function supportsNativeActivity(
  deps: NativeActivityDisplayDeps,
  thread: Thread,
): boolean {
  return (
    thread.status === "active" &&
    deps.providerRegistry.get(thread.providerId)?.nativeTerminal?.activity !==
      undefined
  );
}

function getNativeActivityThread(
  deps: NativeActivityDisplayDeps,
  thread: Thread,
): NativeTerminalThreadRecord | null {
  return supportsNativeActivity(deps, thread)
    ? getNativeTerminalThread(deps.db, thread.id)
    : null;
}

function getNativeTerminalThreadsById(
  deps: NativeActivityDisplayDeps,
  threads: readonly Thread[],
): Map<string, NativeActivityThreadRecord> {
  return new Map<string, NativeActivityThreadRecord>(
    listNativeTerminalThreadsByIds(
      deps.db,
      threads.map((thread) => thread.id),
    ).map((thread) => [thread.threadId, thread]),
  );
}

function addNativeActivityDiagnostic(
  thread: Thread,
  runtime: ThreadRuntimeState,
  nativeThread: NativeActivityThreadRecord | null,
  now = Date.now(),
): ThreadRuntimeState {
  if (
    thread.status !== "active" ||
    nativeThread?.providerId !== thread.providerId
  ) {
    return runtime;
  }
  const lastEvidenceAt = nativeThread.lastEvidenceAt;
  const isFresh =
    lastEvidenceAt !== null &&
    now >= lastEvidenceAt &&
    now - lastEvidenceAt <= NATIVE_TERMINAL_ACTIVITY_FRESH_FOR_MS;
  const lastToolCallAt = nativeThread.lastToolCallAt;
  const toolCallIsBoundToSession =
    nativeThread.nativeSessionId !== null &&
    nativeThread.lastToolCallSessionId === nativeThread.nativeSessionId;
  const toolCallIsFresh =
    toolCallIsBoundToSession &&
    lastToolCallAt !== null &&
    now >= lastToolCallAt &&
    now - lastToolCallAt <= NATIVE_TERMINAL_ACTIVITY_FRESH_FOR_MS;
  return {
    ...runtime,
    nativeActivity: {
      lastEvidenceAt,
      ...(toolCallIsBoundToSession && lastToolCallAt !== null
        ? { lastToolCallAt }
        : {}),
      freshForMs: NATIVE_TERMINAL_ACTIVITY_FRESH_FOR_MS,
      confirmation: isFresh ? "confirmed" : "unconfirmed",
      evidenceKind: isFresh
        ? "holder-report"
        : toolCallIsFresh
          ? "tool-call"
          : "unknown",
    },
  };
}

export function buildThreadStatusChangeMetadata(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): ThreadChangeMetadata {
  return toThreadStatusChangeMetadata({
    activity:
      buildThreadActivityStateByThreadId(deps, [thread]).get(thread.id) ??
      EMPTY_THREAD_ACTIVITY,
    runtime: addNativeActivityDiagnostic(
      thread,
      resolveThreadRuntimeState(deps, {
        environmentHostId: resolveThreadEnvironmentHostId(deps, thread),
        status: thread.status,
      }),
      getNativeActivityThread(deps, thread),
    ),
    thread,
  });
}

export function buildThreadStatusChangeMetadataByThreadId(
  deps: ThreadPromptBannerDeps,
  args: BuildThreadStatusChangeMetadataByThreadIdArgs,
): Map<string, ThreadChangeMetadata> {
  if (args.threads.length === 0) {
    return new Map();
  }
  const activityByThreadId = buildThreadActivityStateByThreadId(
    deps,
    args.threads,
  );
  const hostConnected = hasOpenDaemonSessionForHost(
    deps,
    args.environmentHostId,
  );
  const latestClosedSession = getLatestClosedSessionForHost(deps, {
    hostConnected,
    hostId: args.environmentHostId,
  });
  const nativeTerminalThreadsById = getNativeTerminalThreadsById(
    deps,
    args.threads,
  );
  return new Map(
    args.threads.map((thread) => [
      thread.id,
      toThreadStatusChangeMetadata({
        activity: activityByThreadId.get(thread.id) ?? EMPTY_THREAD_ACTIVITY,
        runtime: addNativeActivityDiagnostic(
          thread,
          resolveThreadRuntimeStateFromLatestSession({
            environmentHostId: args.environmentHostId,
            hostConnected,
            latestClosedSession,
            status: thread.status,
          }),
          supportsNativeActivity(deps, thread)
            ? (nativeTerminalThreadsById.get(thread.id) ?? null)
            : null,
        ),
        thread,
      }),
    ]),
  );
}

function toThreadStatusChangeMetadata(
  args: ToThreadStatusChangeMetadataArgs,
): ThreadChangeMetadata {
  return {
    projectId: args.thread.projectId,
    statusChange: {
      status: args.thread.status,
      runtime: args.runtime,
      activity: args.activity,
      latestAttentionAt: args.thread.latestAttentionAt,
      updatedAt: args.thread.updatedAt,
    },
  };
}

function toThreadResponseWithHost(
  deps: PluginThreadResponseDisplayDeps,
  args: ToThreadResponseWithHostArgs,
): ThreadWithRuntime {
  const thread = toPublicThread(args.thread);
  const runtime = resolveThreadRuntimeState(deps, {
    environmentHostId: args.environmentHostId,
    now: args.now,
    status: thread.status,
  });
  return {
    ...thread,
    runtime: deps.providerRegistry
      ? addNativeActivityDiagnostic(
          args.thread,
          runtime,
          getNativeActivityThread(
            {
              db: deps.db,
              hub: deps.hub,
              providerRegistry: deps.providerRegistry,
            },
            args.thread,
          ),
          args.now,
        )
      : runtime,
  };
}

export function toThreadResponseFromThread(
  deps: ThreadResponseDisplayDeps,
  args: ToThreadResponseFromThreadArgs,
): ThreadResponse {
  return buildThreadResponseFromThread(deps, args);
}

export function toPluginThreadDtoFromThread(
  deps: PluginThreadResponseDisplayDeps,
  args: ToThreadResponseFromThreadArgs,
): ThreadResponse {
  return buildThreadResponseFromThread(deps, args);
}

function buildThreadResponseFromThread(
  deps: PluginThreadResponseDisplayDeps,
  args: ToThreadResponseFromThreadArgs,
): ThreadResponse {
  const threadWithRuntime = toThreadResponseWithHost(deps, {
    ...args,
    environmentHostId: resolveThreadEnvironmentHostId(deps, args.thread),
  });
  return {
    ...threadWithRuntime,
    nativeTerminal: getNativeTerminalThread(deps.db, args.thread.id) !== null,
    activeBackgroundAgentCount:
      listActiveBackgroundTaskCountsByThreadIds(deps.db, {
        threadIds: [args.thread.id],
      })[0]?.activeBackgroundAgentCount ?? 0,
    canRestoreEnvironment: canRestoreThreadEnvironment(deps, {
      thread: args.thread,
    }),
    canEditMessages:
      deps.providerRegistry !== undefined &&
      canThreadEditMessages(
        { providerRegistry: deps.providerRegistry },
        args.thread,
      ),
    canSpawnChild: canThreadSpawnChild(deps, { thread: args.thread }),
    queuedMessageCount:
      listQueuedThreadMessageCountsByThreadIds(deps.db, {
        threadIds: [args.thread.id],
      })[0]?.queuedMessageCount ?? 0,
    workspaceSharing: ((): { threadCount: number } | null => {
      try {
        return resolveWorkspaceSharing(deps, args.thread);
      } catch {
        return null;
      }
    })(),
  };
}

function resolveWorkspaceSharing(
  deps: ThreadRuntimeDisplayDeps,
  thread: Thread,
): { threadCount: number } | null {
  const environmentRow =
    thread.environmentId === null
      ? null
      : getEnvironment(deps.db, thread.environmentId);
  const environment =
    environmentRow === null
      ? null
      : toEnvironmentResponse(deps.db, environmentRow);
  if (
    environment === null ||
    environment.managed ||
    environment.workspaceProvisionType !== "unmanaged" ||
    environment.path === null
  ) {
    return null;
  }
  const threadCount = countUnmanagedWorkspaceThreads(deps.db, {
    hostId: environment.hostId,
    workspacePath: environment.path,
  });
  return threadCount > 1 ? { threadCount } : null;
}

function getThreadPromptBannerActivityState(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
  events: readonly ThreadEventWithMeta[],
): PromptBannerActivityState {
  const activePlanTurn = extractThreadTimelineActivePlanTurn({
    events,
    planCommand: resolveProviderPlanCommand(
      deps.providerRegistry,
      thread.providerId,
    ),
    providerId: thread.providerId,
    threadStatus: thread.status,
  });
  const goal = extractThreadTimelineGoal(events);

  return {
    activeGoalCount: goal?.status === "active" ? 1 : 0,
    activePlanModeCount: activePlanTurn === null ? 0 : 1,
    activePlanTurnId: activePlanTurn?.turnId ?? null,
  };
}

function canThreadShowActivePlanMode(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): boolean {
  return (
    thread.status === "active" &&
    resolveProviderPlanCommand(deps.providerRegistry, thread.providerId) !==
      null
  );
}

function listPromptBannerActivityCandidateRows(
  deps: ThreadPromptBannerDeps,
  threads: readonly Thread[],
): StoredEventRow[] {
  const latestGoalRows = listLatestThreadStateEventRowsByThreadIds(deps.db, {
    threadIds: threads.map((thread) => thread.id),
    kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
  });
  const openAcceptedRows = listOpenTurnInputAcceptedRowsByThreadIds(deps.db, {
    threadIds: threads
      .filter((thread) => canThreadShowActivePlanMode(deps, thread))
      .map((thread) => thread.id),
  });
  const openAcceptedEvents = openAcceptedRows.map(toThreadEventWithMeta);
  const requestKeys: ThreadClientTurnRequestKey[] = openAcceptedEvents.flatMap(
    ({ event }) =>
      event.type === "turn/input/accepted"
        ? [{ requestId: event.clientRequestId, threadId: event.threadId }]
        : [],
  );
  const requestRows = listStoredClientTurnRequestRowsByKeys(deps.db, {
    keys: requestKeys,
  });

  return [...latestGoalRows, ...openAcceptedRows, ...requestRows].sort(
    (left, right) =>
      left.threadId.localeCompare(right.threadId) ||
      left.sequence - right.sequence,
  );
}

function buildThreadPromptBannerActivityByThreadId(
  deps: ThreadPromptBannerDeps,
  threads: readonly Thread[],
): Map<string, PromptBannerActivityState> {
  const rows = listPromptBannerActivityCandidateRows(deps, threads);
  const eventsByThreadId = new Map<string, ThreadEventWithMeta[]>();
  for (const row of rows) {
    const threadEvents = eventsByThreadId.get(row.threadId);
    const event = toThreadEventWithMeta(row);
    if (threadEvents) {
      threadEvents.push(event);
    } else {
      eventsByThreadId.set(row.threadId, [event]);
    }
  }

  const result = new Map<string, PromptBannerActivityState>();
  for (const thread of threads) {
    const activity = getThreadPromptBannerActivityState(
      deps,
      thread,
      eventsByThreadId.get(thread.id) ?? [],
    );
    if (activity.activeGoalCount > 0 || activity.activePlanModeCount > 0) {
      result.set(thread.id, activity);
    }
  }
  return result;
}

export function getThreadPromptBannerActivity(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): PromptBannerActivityState {
  return (
    buildThreadPromptBannerActivityByThreadId(deps, [thread]).get(
      thread.id,
    ) ?? {
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activePlanTurnId: null,
    }
  );
}

function buildThreadActivityStateByThreadId(
  deps: ThreadPromptBannerDeps,
  threads: readonly Thread[],
): Map<string, ThreadActivityState> {
  const backgroundTaskActivityByThreadId = new Map(
    listActiveBackgroundTaskCountsByThreadIds(deps.db, {
      threadIds: threads.map((thread) => thread.id),
    }).map((activity) => [activity.threadId, activity]),
  );
  const promptBannerActivityByThreadId =
    buildThreadPromptBannerActivityByThreadId(deps, threads);
  const result = new Map<string, ThreadActivityState>();
  for (const thread of threads) {
    const backgroundActivity = backgroundTaskActivityByThreadId.get(thread.id);
    const promptBannerActivity = promptBannerActivityByThreadId.get(thread.id);
    if (!backgroundActivity && !promptBannerActivity) {
      continue;
    }
    result.set(thread.id, {
      activeBackgroundAgentCount:
        backgroundActivity?.activeBackgroundAgentCount ??
        EMPTY_THREAD_ACTIVITY.activeBackgroundAgentCount,
      activeBackgroundCommandCount:
        backgroundActivity?.activeBackgroundCommandCount ??
        EMPTY_THREAD_ACTIVITY.activeBackgroundCommandCount,
      activeGoalCount:
        promptBannerActivity?.activeGoalCount ??
        EMPTY_THREAD_ACTIVITY.activeGoalCount,
      activePlanModeCount:
        promptBannerActivity?.activePlanModeCount ??
        EMPTY_THREAD_ACTIVITY.activePlanModeCount,
      activeWorkflowCount:
        backgroundActivity?.activeWorkflowCount ??
        EMPTY_THREAD_ACTIVITY.activeWorkflowCount,
    });
  }
  return result;
}

interface ThreadQueuedWorkSummary {
  queuedFailedCount: number;
  queuedWork: ThreadQueuedWork;
}

function buildThreadQueuedWorkByThreadId(
  deps: ThreadRuntimeDisplayDeps,
  threads: readonly Thread[],
): Map<string, ThreadQueuedWorkSummary> {
  const result = new Map<string, ThreadQueuedWorkSummary>();
  for (const counts of listQueuedThreadMessageCountsByThreadIds(deps.db, {
    threadIds: threads.map((thread) => thread.id),
  })) {
    if (counts.queuedMessageCount === 0) continue;
    result.set(counts.threadId, {
      queuedFailedCount: counts.failedQueuedMessageCount,
      queuedWork: counts.failedQueuedMessageCount > 0 ? "failed" : "waiting",
    });
  }
  return result;
}

export function toThreadListEntryResponses(
  deps: ThreadPromptBannerDeps,
  args: ToThreadListEntryResponsesArgs,
): ThreadListEntry[] {
  const activityByThreadId = buildThreadActivityStateByThreadId(
    deps,
    args.threads,
  );
  const activeHostIds = [
    ...new Set(
      args.threads.flatMap((thread) =>
        thread.status === "active" && thread.environmentHostId !== null
          ? [thread.environmentHostId]
          : [],
      ),
    ),
  ];
  const connectedActiveHostIds = new Set(
    activeHostIds.filter((hostId) => hasOpenDaemonSessionForHost(deps, hostId)),
  );
  const latestClosedSessionByHostId = new Map(
    listLatestClosedSessionsForHosts(deps.db, {
      hostIds: activeHostIds.filter(
        (hostId) => !connectedActiveHostIds.has(hostId),
      ),
    }).map((session) => [session.hostId, session]),
  );
  const queuedWorkByThreadId = buildThreadQueuedWorkByThreadId(
    deps,
    args.threads,
  );
  const nativeTerminalThreadsById = getNativeTerminalThreadsById(
    deps,
    args.threads,
  );
  return args.threads.map((thread) => {
    const entry = toThreadListEntryResponseFromLatestSession({
      deps,
      activity: activityByThreadId.get(thread.id) ?? EMPTY_THREAD_ACTIVITY,
      queuedWork: queuedWorkByThreadId.get(thread.id)?.queuedWork ?? "none",
      queuedFailedCount:
        queuedWorkByThreadId.get(thread.id)?.queuedFailedCount ?? 0,
      hostConnected:
        thread.environmentHostId !== null &&
        connectedActiveHostIds.has(thread.environmentHostId),
      latestClosedSession:
        thread.environmentHostId === null
          ? null
          : (latestClosedSessionByHostId.get(thread.environmentHostId) ?? null),
      nativeTerminalThread: nativeTerminalThreadsById.get(thread.id) ?? null,
      now: args.now,
      rowState: getThreadRowState(deps.db, thread.id),
      thread,
    });
    const withEnvironmentHost =
      thread.environmentHostId === null &&
      (thread.status === "pending" || thread.status === "starting")
        ? {
            ...entry,
            environmentHostId: intendedThreadHostId(deps, thread.id),
          }
        : entry;
    return {
      ...withEnvironmentHost,
      listIndicator: resolveThreadListIndicator(
        threadListIndicatorStateForThread(withEnvironmentHost, false, args.now),
      ),
    };
  });
}

function toThreadListEntryResponseFromLatestSession(
  args: ToThreadListEntryResponseFromLatestSessionArgs,
): ThreadListEntry {
  const thread = toPublicThread(args.thread);
  return {
    ...thread,
    nativeTerminal: args.nativeTerminalThread !== null,
    activity: args.activity,
    queuedWork: args.queuedWork,
    queuedFailedCount: args.queuedFailedCount,
    pinSortKey: args.thread.pinSortKey,
    environmentBranchName: args.thread.environmentBranchName,
    environmentHostId: args.thread.environmentHostId,
    environmentName: args.thread.environmentName,
    environmentPath: args.thread.environmentPath,
    environmentProviderId: args.thread.environmentProviderId,
    environmentIsWorktree: args.thread.environmentIsWorktree,
    environmentWorkspaceDisplayKind: resolveEnvironmentWorkspaceDisplayKind({
      environmentProviderId: args.thread.environmentProviderId,
      isWorktree: args.thread.environmentIsWorktree,
    }),
    hasPendingInteraction: args.thread.hasPendingInteraction,
    listIndicator: "none",
    rowState: args.rowState,
    runtime: addNativeActivityDiagnostic(
      args.thread,
      resolveThreadRuntimeStateFromLatestSession({
        environmentHostId: args.thread.environmentHostId,
        hostConnected: args.hostConnected,
        latestClosedSession: args.latestClosedSession,
        now: args.now,
        status: thread.status,
      }),
      supportsNativeActivity(args.deps, args.thread)
        ? args.nativeTerminalThread
        : null,
      args.now,
    ),
  };
}
