import { randomUUID } from "node:crypto";
import {
  getEnvironment,
  heartbeatWorkspaceWriteClaims,
  listWorkspaceWriteClaimThreadIds,
  releaseAllWorkspaceWriteClaims,
  releaseWorkspaceWriteClaims,
  tryClaimWorkspaceWrite,
} from "@bb/db";
import type { DbQueryConnection } from "@bb/db";
import type { Environment, Thread } from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { toEnvironmentResponse } from "../environments/environment-response.js";
import { readThreadProvisionContext } from "./thread-startup-store.js";
import { getActiveTurnId } from "./thread-events.js";
import { z } from "zod";

const ownerToken = randomUUID();
const heartbeatInterval = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function workspaceWriteTarget(
  environment: Environment | null,
): { hostId: string; workspacePath: string } | null {
  if (
    environment === null ||
    environment.workspaceProvisionType !== "unmanaged" ||
    environment.path === null
  )
    return null;
  return { hostId: environment.hostId, workspacePath: environment.path };
}

export function claimWorkspaceForTurn(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: { environment: Environment | null; threadId: string },
): { acquired: true } | { acquired: false; holderThreadId: string } {
  const target =
    workspaceWriteTarget(args.environment) ??
    (args.environment === null
      ? pendingWorkspaceWriteTarget(deps, args.threadId)
      : null);
  if (target === null) return { acquired: true };
  return tryClaimWorkspaceWrite(deps.db, {
    ...target,
    ownerToken,
    threadId: args.threadId,
  });
}

function pendingWorkspaceWriteTarget(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  threadId: string,
): { hostId: string; workspacePath: string } | null {
  const context = readThreadProvisionContext(deps.db, threadId);
  if (context === null) return null;
  const { environmentIntent } = context.request;
  if (environmentIntent.type === "reuse") {
    const environment = getEnvironment(
      deps.db,
      environmentIntent.environmentId,
    );
    return workspaceWriteTarget(
      environment === null
        ? null
        : toEnvironmentResponse(deps.db, environment),
    );
  }
  if (environmentIntent.machine.type !== "existing") return null;
  const inputs = z
    .object({ path: z.string().min(1) })
    .passthrough()
    .safeParse(environmentIntent.inputs);
  if (!inputs.success) return null;
  return {
    hostId: environmentIntent.machine.hostId,
    workspacePath: inputs.data.path,
  };
}

export function releaseWorkspaceForThread(
  deps: { db: DbQueryConnection },
  thread: Pick<Thread, "id">,
): void {
  releaseWorkspaceWriteClaims(deps.db, { ownerToken, threadId: thread.id });
}

export function resetWorkspaceWriteClaims(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): void {
  releaseAllWorkspaceWriteClaims(deps.db);
}

export function startWorkspaceWriteClaimHeartbeat(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): void {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => {
    const activeThreadIds = listWorkspaceWriteClaimThreadIds(deps.db, {
      ownerToken,
    }).filter((threadId) => getActiveTurnId(deps, threadId) !== null);
    heartbeatWorkspaceWriteClaims(deps.db, { activeThreadIds, ownerToken });
  }, heartbeatInterval);
  heartbeatTimer.unref();
}

export function stopWorkspaceWriteClaimHeartbeat(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  releaseAllWorkspaceWriteClaims(deps.db);
}
