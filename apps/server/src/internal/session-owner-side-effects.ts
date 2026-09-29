import { eq } from "drizzle-orm";
import {
  clearDetachedThreads,
  closeSession,
  getActiveStoredTurnId,
  hostDaemonSessions,
  listActiveHostThreads,
  listHostThreadIds,
  listPendingDetachedThreads,
  type HostDaemonSessionRow,
} from "@bb/db";
import type {
  HostDaemonActiveThread,
  HostDaemonAdoptedThread,
  HostDaemonSessionCloseReason,
} from "@bb/host-daemon-contract";
import { HOST_RECONNECT_GRACE_MS, LEASE_TIMEOUT_MS } from "../constants.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import {
  interruptActiveThreadsForHost,
  reconcileDaemonReportedThreads,
} from "../services/threads/thread-lifecycle.js";
import { buildThreadStatusChangeMetadataByThreadId } from "../services/threads/thread-runtime-display.js";
import { settleDanglingBackgroundTasks } from "../services/threads/background-task-reconciliation.js";
import { interruptEnvironmentProvisioningForHost } from "../services/environments/environment-engine.js";
import {
  closeItemsOrphanedByAdoption,
  scheduleAdoptedThreadTurnCheck,
} from "./fork-adoption.js";

const DAEMON_RESTARTED_PENDING_INTERACTION_REASON =
  "Host daemon restarted while awaiting user interaction; retry the thread to continue";
const DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON =
  "Host daemon disconnected while awaiting user interaction; retry the thread to continue";
const DAEMON_DISCONNECTED_ENVIRONMENT_PROVISIONING_REASON =
  "The connection to the host was lost while preparing the workspace. Retry provisioning to continue.";

type HostSessionOpenedDeps = LoggedPendingInteractionWorkSessionDeps;
type DaemonSocketClosedDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<AppDeps, "sharedPorts">;
type LostHostWorkDeps = LoggedPendingInteractionWorkSessionDeps;

interface HandleHostSessionOpenedArgs {
  activeThreads: HostDaemonActiveThread[];
  adoptedThreads: readonly HostDaemonAdoptedThread[];
  hostId: string;
  openedSession: HostDaemonSessionRow;
  previousSession: HostDaemonSessionRow | null;
  undeliveredEventThreadIds: string[];
}

interface HandleDaemonSocketClosedArgs {
  sessionId: string;
}

interface HandleDaemonSessionLostArgs {
  reason: Extract<
    HostDaemonSessionCloseReason,
    "daemon-disconnect" | "expired"
  >;
  sessionId: string;
}

interface HandleHostRemovedArgs {
  hostId: string;
  sessionId: string;
}

export async function handleHostSessionOpened(
  deps: HostSessionOpenedDeps,
  args: HandleHostSessionOpenedArgs,
): Promise<void> {
  deps.logger.info(
    {
      sessionId: args.openedSession.id,
      hostId: args.hostId,
      replacedSessionId: args.previousSession?.id ?? null,
    },
    "Session opened",
  );
  const adopted = classifyAdoptedThreads(deps, args);

  const sameDaemonInstance =
    args.previousSession?.instanceId === args.openedSession.instanceId;
  if (
    args.previousSession &&
    args.previousSession.id !== args.openedSession.id
  ) {
    deps.hub.cancelPendingDaemonDisconnect(args.previousSession.id);

    if (args.previousSession.status === "active") {
      if (sameDaemonInstance) {
        deps.hub.closeDaemonSessionSocket(args.previousSession.id, "replaced");
      } else {
        deps.hub.closeDaemonSession(args.previousSession.id, "replaced");
      }
      deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: args.previousSession.id,
      });
    }

    if (!sameDaemonInstance) {
      interruptPendingInteractionsForHostThreads(deps, {
        hostId: args.hostId,
        reason: DAEMON_RESTARTED_PENDING_INTERACTION_REASON,
      });
      interruptActiveThreadsForHost(deps, {
        exceptThreadIds: adopted.excepted,
        includeStopping: false,
        hostId: args.hostId,
        reason: "host-daemon-restarted",
      });
      settleDanglingBackgroundTasks(deps, {
        exceptThreadIds: adopted.excepted,
        hostId: args.hostId,
      });
    }
  }
  clearDetachedThreads(deps.db, { hostId: args.hostId });
  closeItemsOrphanedByAdoption(deps, {
    adoptedThreadIds: adopted.excepted,
    runningTurnIds: adopted.runningTurnIds,
  });

  await reconcileDaemonReportedThreads(deps, {
    activeThreadIds: [
      ...new Set([
        ...args.activeThreads.map((thread) => thread.threadId),
        ...adopted.running,
      ]),
    ],
    exceptThreadIds: adopted.excepted,
    hostId: args.hostId,
    sameDaemonInstance,
    undeliveredEventThreadIds: args.undeliveredEventThreadIds,
  });

  scheduleAdoptedThreadTurnCheck(deps, {
    hostId: args.hostId,
    threadIds: adopted.awaitingTurn,
  });
}

export function handleDaemonSocketClosed(
  deps: DaemonSocketClosedDeps,
  args: HandleDaemonSocketClosedArgs,
): void {
  deps.logger.info({ sessionId: args.sessionId }, "Daemon WebSocket closed");
  handleDaemonSessionLost(deps, {
    reason: "daemon-disconnect",
    sessionId: args.sessionId,
  });
}

export function handleDaemonSocketOpened(
  deps: Pick<AppDeps, "db" | "hub" | "providerRegistry">,
  args: { hostId: string },
): void {
  notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}

export function handleDaemonSessionSilent(
  deps: DaemonSocketClosedDeps,
  args: HandleDaemonSocketClosedArgs,
): void {
  deps.logger.warn(
    { leaseTimeoutMs: LEASE_TIMEOUT_MS, sessionId: args.sessionId },
    "Daemon sent nothing within its lease; closing its socket",
  );
  deps.hub.closeDaemonSession(args.sessionId, "expired");
  handleDaemonSessionLost(deps, {
    reason: "expired",
    sessionId: args.sessionId,
  });
}

function handleDaemonSessionLost(
  deps: DaemonSocketClosedDeps,
  args: HandleDaemonSessionLostArgs,
): void {
  deps.hub.unregisterDaemon(args.sessionId);
  deps.sharedPorts.clearHostConnectCapability(args.sessionId);

  const session = deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .get();
  if (!session || session.status !== "active") {
    return;
  }
  deps.terminalSessions.handleDaemonSessionClosed({
    sessionId: args.sessionId,
  });

  closeSession(deps.db, deps.hub, args.sessionId, args.reason);

  notifyHostThreadRuntimeStatusChanged(deps, session.hostId);
  if (args.reason === "expired") {
    return;
  }
  deps.hub.scheduleDaemonDisconnect(
    args.sessionId,
    HOST_RECONNECT_GRACE_MS,
    () => {
      if (deps.hub.hasDaemonForHost(session.hostId)) {
        return;
      }
      deps.hub.clearHostRestarting(session.hostId);
      deps.hub.notifyHost(session.hostId, ["host-disconnected"]);
      notifyHostThreadRuntimeStatusChanged(deps, session.hostId);
    },
  );
}

function detachedThreadIdsAt(deps: LoggedPendingInteractionWorkSessionDeps, hostId: string): Set<string> {
  return new Set(
    listPendingDetachedThreads(deps.db, {
      hostId,
      now: Date.now(),
    }).map((thread) => thread.threadId),
  );
}

export function handleHostRemoved(
  deps: Omit<DaemonSocketClosedDeps, "sharedPorts">,
  args: HandleHostRemovedArgs,
): void {
  const session = deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .get();
  if (
    !session ||
    session.status !== "active" ||
    session.hostId !== args.hostId
  ) {
    return;
  }

  closeSession(deps.db, deps.hub, args.sessionId, "expired");
  deps.hub.closeDaemonSession(args.sessionId, "expired");
  deps.terminalSessions.handleDaemonSessionClosed({
    sessionId: args.sessionId,
  });
  settleRemovedHostWork(deps, { hostId: args.hostId });
}

export function settleRemovedHostWork(
  deps: Omit<DaemonSocketClosedDeps, "sharedPorts">,
  args: { hostId: string },
): void {
  interruptPendingInteractionsForHostThreads(deps, {
    hostId: args.hostId,
    reason: "The machine was removed",
  });
  interruptEnvironmentProvisioningForHost(deps, {
    hostId: args.hostId,
    reason: DAEMON_DISCONNECTED_ENVIRONMENT_PROVISIONING_REASON,
  });
  interruptActiveThreadsForHost(deps, {
    includeStopping: true,
    hostId: args.hostId,
    reason: "host-removed",
  });
  settleDanglingBackgroundTasks(deps, { hostId: args.hostId });
  notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}

interface DisconnectImportedDaemonSessionsArgs {
  sessions: ReadonlyArray<{ hostId: string; id: string }>;
}

export function disconnectImportedDaemonSessions(
  deps: LostHostWorkDeps,
  args: DisconnectImportedDaemonSessionsArgs,
): void {
  if (args.sessions.length === 0) {
    return;
  }
  const hostIds = new Set<string>();
  for (const session of args.sessions) {
    deps.terminalSessions.handleDaemonSessionClosed({ sessionId: session.id });
    closeSession(deps.db, deps.hub, session.id, "daemon-disconnect");
    hostIds.add(session.hostId);
  }
  for (const hostId of hostIds) {
    const detachedThreadIds = detachedThreadIdsAt(deps, hostId);
    deps.hub.clearHostRestarting(hostId);
    interruptPendingInteractionsForHostThreads(deps, {
      hostId,
      reason: DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON,
    });
    settleDanglingBackgroundTasks(deps, {
      exceptThreadIds: detachedThreadIds,
      hostId,
    });
    notifyHostThreadRuntimeStatusChanged(deps, hostId);
    interruptActiveThreadsForHost(deps, {
      exceptThreadIds: detachedThreadIds,
      includeStopping: false,
      hostId,
      reason: "host-daemon-restarted",
      cause: "host-connection-lost",
    });
    interruptEnvironmentProvisioningForHost(deps, {
      hostId,
      reason: DAEMON_DISCONNECTED_ENVIRONMENT_PROVISIONING_REASON,
    });
  }
  deps.logger.info(
    { hosts: hostIds.size, sessions: args.sessions.length },
    "Closed the daemon sessions an imported server snapshot left active",
  );
}

function classifyAdoptedThreads(
  deps: Pick<AppDeps, "db">,
  args: Pick<HandleHostSessionOpenedArgs, "adoptedThreads">,
): {
  awaitingTurn: Set<string>;
  excepted: Set<string>;
  running: Set<string>;
  runningTurnIds: Map<string, string>;
} {
  const awaitingTurn = new Set<string>();
  const excepted = new Set<string>();
  const running = new Set<string>();
  const runningTurnIds = new Map<string, string>();
  for (const thread of args.adoptedThreads) {
    const storedTurnId = getActiveStoredTurnId(deps.db, thread.threadId);
    if (thread.activeTurnId !== null && storedTurnId === thread.activeTurnId) {
      running.add(thread.threadId);
      runningTurnIds.set(thread.threadId, thread.activeTurnId);
    }
    if (
      thread.activeTurnId !== null &&
      (storedTurnId === thread.activeTurnId || storedTurnId === null)
    ) {
      excepted.add(thread.threadId);
    }
    if (thread.activeTurnId === null && storedTurnId === null) {
      excepted.add(thread.threadId);
      awaitingTurn.add(thread.threadId);
    }
  }
  return { awaitingTurn, excepted, running, runningTurnIds };
}

function notifyHostThreadRuntimeStatusChanged(
  deps: Pick<AppDeps, "db" | "hub" | "providerRegistry">,
  hostId: string,
): void {
  const metadataByThreadId = buildThreadStatusChangeMetadataByThreadId(deps, {
    environmentHostId: hostId,
    threads: listActiveHostThreads(deps.db, { hostId }),
  });
  for (const threadId of listHostThreadIds(deps.db, { hostId })) {
    deps.hub.notifyThread(
      threadId,
      ["status-changed"],
      metadataByThreadId.get(threadId),
    );
  }
}

function interruptPendingInteractionsForHostThreads(
  deps: Pick<AppDeps, "db" | "pendingInteractions">,
  args: { hostId: string; reason: string },
): void {
  deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
    threadIds: listHostThreadIds(deps.db, { hostId: args.hostId }),
    reason: args.reason,
  });
}
