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
} from "@bb/host-daemon-contract";
import {
  DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
  DAEMON_DISCONNECT_GRACE_MS,
} from "../constants.js";
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
import { closeItemsOrphanedByAdoption } from "./fork-adoption.js";

const DAEMON_RESTARTED_PENDING_INTERACTION_REASON =
  "Host daemon restarted while awaiting user interaction; retry the thread to continue";
const DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON =
  "Host daemon disconnected while awaiting user interaction; retry the thread to continue";

type HostSessionOpenedDeps = LoggedPendingInteractionWorkSessionDeps;
type DaemonSocketClosedDeps = Pick<
  AppDeps,
  | "db"
  | "hub"
  | "logger"
  | "pendingInteractions"
  | "providerRegistry"
  | "sharedPorts"
  | "terminalSessions"
>;
type DaemonDisconnectGraceDeps = Pick<
  AppDeps,
  | "db"
  | "hub"
  | "logger"
  | "pendingInteractions"
  | "providerRegistry"
  | "terminalSessions"
>;

interface HandleHostSessionOpenedArgs {
  activeThreads: HostDaemonActiveThread[];
  adoptedThreads: readonly HostDaemonAdoptedThread[];
  hostId: string;
  openedSession: HostDaemonSessionRow;
  previousSession: HostDaemonSessionRow | null;
}

interface HandleDaemonSocketClosedArgs {
  sessionId: string;
}

interface HandleHostRemovedArgs {
  hostId: string;
  sessionId: string;
}

interface CompleteDaemonDisconnectGraceArgs {
  hostId: string;
}

interface CompleteDaemonActiveWorkDisconnectGraceArgs {
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
  });
}

export function handleDaemonSocketClosed(
  deps: DaemonSocketClosedDeps,
  args: HandleDaemonSocketClosedArgs,
): void {
  deps.logger.info({ sessionId: args.sessionId }, "Daemon WebSocket closed");
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

  closeSession(deps.db, deps.hub, args.sessionId, "daemon-disconnect");

  notifyHostThreadRuntimeStatusChanged(deps, session.hostId);
  deps.hub.scheduleDaemonDisconnect(
    args.sessionId,
    DAEMON_DISCONNECT_GRACE_MS,
    () =>
      completeDaemonDisconnectGrace(deps, {
        hostId: session.hostId,
      }),
  );
  deps.hub.scheduleDaemonActiveWorkDisconnect(
    args.sessionId,
    DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
    () =>
      completeDaemonActiveWorkDisconnectGrace(deps, {
        hostId: session.hostId,
        sessionId: args.sessionId,
      }),
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
  interruptPendingInteractionsForHostThreads(deps, {
    hostId: args.hostId,
    reason: DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON,
  });
  interruptActiveThreadsForHost(deps, {
    hostId: args.hostId,
    reason: "host-daemon-restarted",
  });
  settleDanglingBackgroundTasks(deps, { hostId: args.hostId });
  notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}

function completeDaemonDisconnectGrace(
  deps: DaemonDisconnectGraceDeps,
  args: CompleteDaemonDisconnectGraceArgs,
): void {
  if (deps.hub.hasDaemonForHost(args.hostId)) {
    return;
  }

  interruptPendingInteractionsForHostThreads(deps, {
    hostId: args.hostId,
    reason: DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON,
  });
  settleDanglingBackgroundTasks(deps, {
    exceptThreadIds: new Set(
      listPendingDetachedThreads(deps.db, {
        hostId: args.hostId,
        now: Date.now(),
      }).map((thread) => thread.threadId),
    ),
    hostId: args.hostId,
  });
  notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}

function completeDaemonActiveWorkDisconnectGrace(
  deps: Pick<
    AppDeps,
    "db" | "hub" | "logger" | "pendingInteractions" | "providerRegistry"
  >,
  args: CompleteDaemonActiveWorkDisconnectGraceArgs,
): void {
  if (deps.hub.hasDaemonForHost(args.hostId)) {
    return;
  }

  const now = Date.now();
  const detached = listPendingDetachedThreads(deps.db, {
    hostId: args.hostId,
    now,
  });
  const detachedThreadIds = new Set(detached.map((thread) => thread.threadId));
  interruptActiveThreadsForHost(deps, {
    exceptThreadIds: detachedThreadIds,
    hostId: args.hostId,
    reason: "host-daemon-restarted",
    cause: "host-connection-lost",
  });
  settleDanglingBackgroundTasks(deps, {
    exceptThreadIds: detachedThreadIds,
    hostId: args.hostId,
  });
  if (detached.length > 0) {
    const nextExpiry = Math.min(...detached.map((thread) => thread.expiresAt));
    deps.hub.scheduleDaemonActiveWorkDisconnect(
      args.sessionId,
      Math.max(nextExpiry - now, 0) + 1,
      () => completeDaemonActiveWorkDisconnectGrace(deps, args),
    );
  }
}

function classifyAdoptedThreads(
  deps: Pick<AppDeps, "db">,
  args: Pick<HandleHostSessionOpenedArgs, "adoptedThreads">,
): {
  excepted: Set<string>;
  running: Set<string>;
  runningTurnIds: Map<string, string>;
} {
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
  }
  return { excepted, running, runningTurnIds };
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
