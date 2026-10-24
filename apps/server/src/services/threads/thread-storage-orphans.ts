import { joinHostPathSegments } from "../lib/host-path.js";
import { performance } from "node:perf_hooks";
import {
  getDatabaseMaintenanceActivity,
  getHost,
  isDatabaseMaintenanceIdle,
  listExistingThreadIds,
} from "@bb/db";
import { isRawThreadId } from "@bb/domain";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { callHostOnlineRpc } from "../hosts/online-rpc.js";
import {
  assertPathAvoidsProtectedWorkspaces,
  refuseUnprovenMutation,
} from "../environments/protected-paths.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";
import { isServerMoveFrozen } from "../server-move/freeze-state.js";

const THREAD_ID_LOOKUP_BATCH_SIZE = 1_000;

export const THREAD_STORAGE_ORPHAN_SWEEP_CADENCE_MS = 60_000;
export const THREAD_STORAGE_ORPHAN_PASS_LIMITS: ThreadStorageOrphanPassLimits =
  {
    elapsedBudgetMs: 10_000,
    maxRemovals: 100,
  };

export interface ThreadStorageOrphanPassLimits {
  elapsedBudgetMs: number;
  maxRemovals: number;
}

interface HostOrphanQueue {
  parked: boolean;
  rootPath: string;
  sessionId: string;
  threadIds: string[];
}

const runningHostIds = new Set<string>();
const orphanQueueByHostId = new Map<string, HostOrphanQueue>();

export function runThreadStorageOrphanSweep(deps: LoggedWorkSessionDeps): void {
  const activity = getDatabaseMaintenanceActivity(deps.db);
  if (!isDatabaseMaintenanceIdle(activity)) {
    deps.logger.debug(
      { activity },
      "Thread storage orphan cleanup skipped while app work is active",
    );
    return;
  }
  for (const hostId of deps.hub.listConnectedHostIds()) {
    const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
    const queue = orphanQueueByHostId.get(hostId);
    if (
      sessionId === null ||
      runningHostIds.has(hostId) ||
      (queue?.sessionId === sessionId &&
        (queue.parked || queue.threadIds.length === 0))
    ) {
      continue;
    }
    runningHostIds.add(hostId);
    void removeOrphanedThreadStorage(deps, {
      hostId,
      limits: THREAD_STORAGE_ORPHAN_PASS_LIMITS,
    })
      .catch((error) => {
        deps.logger.warn(
          { err: error, hostId },
          "Thread storage orphan cleanup failed",
        );
      })
      .finally(() => {
        runningHostIds.delete(hostId);
      });
  }
}

export async function removeOrphanedThreadStorage(
  deps: LoggedWorkSessionDeps,
  args: { hostId: string; limits: ThreadStorageOrphanPassLimits },
): Promise<void> {
  const { hostId } = args;
  if (
    isServerMoveFrozen(deps.db) ||
    !deps.hub.hasDaemonForHost(hostId) ||
    getHost(deps.db, hostId)?.phase !== "active"
  ) {
    return;
  }
  const session = requireConnectedHostSession(deps, hostId);
  let queue = orphanQueueByHostId.get(hostId);
  if (queue === undefined || queue.sessionId !== session.id) {
    queue = await listOrphanedThreadStorage(deps, {
      dataDir: session.dataDir,
      hostId,
      sessionId: session.id,
    });
    orphanQueueByHostId.set(hostId, queue);
  }
  if (queue.parked) return;
  const startedAt = performance.now();
  let attempted = 0;
  while (
    attempted < args.limits.maxRemovals &&
    performance.now() - startedAt < args.limits.elapsedBudgetMs &&
    !isServerMoveFrozen(deps.db) &&
    deps.hub.getDaemonSessionIdForHost(hostId) === session.id &&
    isDatabaseMaintenanceIdle(getDatabaseMaintenanceActivity(deps.db))
  ) {
    const threadId = queue.threadIds.shift();
    if (threadId === undefined) break;
    attempted += 1;
    try {
      assertPathAvoidsProtectedWorkspaces(deps, {
        hostId,
        path: joinHostPathSegments(queue.rootPath, threadId),
        action: "remove",
      });
      refuseUnprovenMutation({
        action: "remove",
        path: joinHostPathSegments(queue.rootPath, threadId),
        reason:
          "the folder of a thread with no record is removed recursively, and the removal cannot be proven to avoid a workspace",
      });
    } catch (error) {
      deps.logger.warn(
        { err: error, hostId, threadId },
        "Kept orphaned thread storage: its removal is refused",
      );
      if (
        !(error instanceof ApiError) ||
        error.body.code === "command_timeout" ||
        error.body.code === "host_unavailable"
      ) {
        queue.parked = true;
        break;
      }
    }
  }
}

async function listOrphanedThreadStorage(
  deps: LoggedWorkSessionDeps,
  args: { dataDir: string; hostId: string; sessionId: string },
): Promise<HostOrphanQueue> {
  const rootPath = joinHostPathSegments(args.dataDir, "thread-storage");
  const listing = await callHostOnlineRpc(deps, {
    command: { type: "host.browse_directory", path: rootPath },
    hostId: args.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const storedThreadIds = listing.entries
    .filter((entry) => entry.kind === "directory" && isRawThreadId(entry.name))
    .map((entry) => entry.name);
  const existingThreadIds = new Set<string>();
  for (
    let start = 0;
    start < storedThreadIds.length;
    start += THREAD_ID_LOOKUP_BATCH_SIZE
  ) {
    for (const threadId of listExistingThreadIds(
      deps.db,
      storedThreadIds.slice(start, start + THREAD_ID_LOOKUP_BATCH_SIZE),
    )) {
      existingThreadIds.add(threadId);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return {
    parked: false,
    rootPath,
    sessionId: args.sessionId,
    threadIds: storedThreadIds.filter(
      (threadId) => !existingThreadIds.has(threadId),
    ),
  };
}
