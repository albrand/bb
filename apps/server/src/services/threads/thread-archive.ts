import {
  cancelProviderEnvironmentCreation,
  sweepProviderEnvironment,
} from "../environments/environment-engine.js";
import {
  removeCreatingMachine,
  sweepProviderMachine,
} from "../machines/provider-orchestration.js";
import {
  listLiveThreadsInEnvironment,
  listLifecycleThreadDependents,
  archiveThread,
  getEnvironment,
  getNativeTerminalThread,
  listNonDeletedChildThreads,
  listNonDeletedHiddenSourceThreads,
  recordThreadEnvironmentReleases,
} from "@bb/db";
import type { EnvironmentRow } from "@bb/db";
import type { Thread } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../system/event-pruning.js";
import { emitPluginThreadArchived } from "../plugins/plugin-thread-events.js";
import {
  dispatchSettledArchivedThreadProviderArchiveCommand,
  requestThreadStopForCurrentState,
} from "./thread-lifecycle.js";
import {
  archiveUndoGraceKeepsTerminals,
  archiveUndoGraceKeepsTurnRunning,
} from "./archive-undo-grace.js";
import { archiveThreadAndReleaseChildren } from "./thread-ownership.js";
import { resolveThreadHostCommandEnvironment } from "./thread-command-environment.js";
import { releaseActorFor } from "./release-actor.js";

interface ArchiveThreadEnvironment {
  hostId: string;
  id: string;
}

interface ArchiveThreadWithLifecycleEffectsArgs {
  actorThreadId: string | null;
  environment: ArchiveThreadEnvironment | null;
  thread: Pick<Thread, "environmentId" | "id" | "status">;
}

interface ArchiveEnvironmentThreadsArgs {
  actorThreadId?: string | null;
  environment: EnvironmentRow;
}

interface ArchiveThreadAndChildrenArgs {
  actorThreadId?: string | null;
  parentThread: Thread;
}

function archiveThreadWithLifecycleEffects(
  deps: AppDeps,
  args: ArchiveThreadWithLifecycleEffectsArgs,
): Thread | null {
  const archivedThread = archiveThreadAndReleaseChildren(deps, {
    release: releaseActorFor(args.actorThreadId, args.thread.id),
    threadId: args.thread.id,
  });
  if (!archivedThread) {
    return null;
  }

  const now = Date.now();
  if (
    getNativeTerminalThread(deps.db, archivedThread.id) !== null ||
    !archiveUndoGraceKeepsTerminals(archivedThread, now)
  ) {
    deps.terminalSessions.closeArchivedThreadTerminals({
      threadId: archivedThread.id,
    });
  }
  if (!archiveUndoGraceKeepsTurnRunning(archivedThread, now)) {
    requestThreadStopForCurrentState(deps, archivedThread, args.environment);
  }
  dispatchSettledArchivedThreadProviderArchiveCommand(deps, {
    threadId: archivedThread.id,
  });
  resetActiveThreadEventPruningState(archivedThread.id);
  pruneThreadEventHistoryBestEffort(deps, {
    mode: "archived",
    threadId: archivedThread.id,
  });
  void cancelProviderEnvironmentCreation(deps, archivedThread.id).catch(
    (error) =>
      deps.logger.warn({ error }, "Environment launch cancellation failed"),
  );
  void removeCreatingMachine(deps, archivedThread.id).catch((error) =>
    deps.logger.warn({ error }, "Machine launch cancellation failed"),
  );
  if (archivedThread.environmentId !== null)
    void sweepProviderEnvironment(deps, archivedThread.environmentId).catch(
      (error) => deps.logger.warn({ error }, "Environment retirement failed"),
    );
  if (args.environment !== null) {
    void sweepProviderMachine(deps, args.environment.hostId).catch((error) =>
      deps.logger.warn({ error }, "Machine retirement failed"),
    );
  }
  emitPluginThreadArchived(archivedThread);

  return archivedThread;
}

export function archiveEnvironmentThreads(
  deps: AppDeps,
  args: ArchiveEnvironmentThreadsArgs,
): string[] {
  const roots = listLiveThreadsInEnvironment(deps.db, {
    environmentId: args.environment.id,
  });
  return archiveThreadTrees(
    deps,
    roots,
    (thread) =>
      thread.environmentId === null
        ? null
        : getEnvironment(deps.db, thread.environmentId),
    args.actorThreadId ?? null,
  );
}

export function archiveThreadAndChildren(
  deps: AppDeps,
  args: ArchiveThreadAndChildrenArgs,
): string[] {
  const environment = resolveThreadHostCommandEnvironment({
    db: deps.db,
    thread: args.parentThread,
  });
  return archiveThreadTrees(
    deps,
    [args.parentThread],
    (thread) =>
      thread.id === args.parentThread.id
        ? environment
        : thread.environmentId === null
          ? null
          : getEnvironment(deps.db, thread.environmentId),
    args.actorThreadId ?? null,
  );
}

function archiveThreadTrees(
  deps: AppDeps,
  roots: Thread[],
  resolveEnvironment: (
    thread: ArchiveThreadWithLifecycleEffectsArgs["thread"],
  ) => ArchiveThreadEnvironment | null,
  actorThreadId: string | null,
): string[] {
  const threads = listArchiveCandidates(deps.db, roots);
  for (const root of roots)
    archiveThread(
      deps.db,
      deps.hub,
      root.id,
      releaseActorFor(actorThreadId, root.id),
    );
  const archivedThreadIds: string[] = [];

  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;
    if (thread.archivedAt !== null) {
      recordThreadEnvironmentReleases(
        deps.db,
        [thread.id],
        releaseActorFor(actorThreadId, thread.id),
      );
      if (!archiveUndoGraceKeepsTurnRunning(thread, Date.now()))
        requestThreadStopForCurrentState(
          deps,
          thread,
          thread.environmentId === null ? null : resolveEnvironment(thread),
        );
      continue;
    }
    const environment = resolveEnvironment(thread);
    const result = archiveThreadWithLifecycleEffects(deps, {
      actorThreadId,
      environment,
      thread,
    });
    if (!result) {
      continue;
    }
    archivedThreadIds.push(result.id);
  }

  return archivedThreadIds;
}

export function countUnarchivedThreadDescendants(
  db: AppDeps["db"],
  thread: Thread,
): number {
  return listArchiveCandidates(db, [thread]).filter(
    (candidate) =>
      candidate.id !== thread.id &&
      candidate.visibility === "visible" &&
      candidate.deletedAt === null &&
      candidate.archivedAt === null,
  ).length;
}

function listArchiveCandidates(db: AppDeps["db"], roots: Thread[]) {
  type ArchiveCandidate = Pick<
    Thread,
    | "id"
    | "environmentId"
    | "status"
    | "archivedAt"
    | "deletedAt"
    | "visibility"
  >;
  const pending: { thread: ArchiveCandidate; expanded: boolean }[] = [...roots]
    .reverse()
    .map((thread) => ({ thread, expanded: false }));
  const visited = new Set<string>();
  const threads: ArchiveCandidate[] = [];

  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) {
      break;
    }
    const { thread, expanded } = entry;
    if (expanded) {
      threads.push(thread);
      continue;
    }
    if (visited.has(thread.id)) {
      continue;
    }
    visited.add(thread.id);
    pending.push({ thread, expanded: true });
    const descendants = [
      ...listLifecycleThreadDependents(db, thread.id),
      ...listNonDeletedChildThreads(db, {
        parentThreadId: thread.id,
      }),
      ...listNonDeletedHiddenSourceThreads(db, {
        sourceThreadId: thread.id,
      }),
    ];
    for (const descendant of descendants.reverse()) {
      pending.push({ thread: descendant, expanded: false });
    }
  }
  return threads;
}
