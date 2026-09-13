import { randomUUID } from "node:crypto";
import {
  getThreadPendingStartContext,
  heartbeatWorkspaceWriteClaims,
  releaseAllWorkspaceWriteClaims,
  releaseWorkspaceWriteClaims,
  tryClaimWorkspaceWrite,
} from "@bb/db";
import type { Environment, Thread } from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { threadProvisionEnvironmentIntentSchema } from "./thread-provisioning-context.js";
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
  const raw = getThreadPendingStartContext(deps.db, threadId);
  if (raw === null) return null;
  const parsed = z
    .object({ environmentIntent: z.unknown() })
    .safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  const intent = threadProvisionEnvironmentIntentSchema.safeParse(
    parsed.data.environmentIntent,
  );
  if (!intent.success || !("path" in intent.data)) return null;
  return { hostId: intent.data.hostId, workspacePath: intent.data.path };
}

export function releaseWorkspaceForThread(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
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
    heartbeatWorkspaceWriteClaims(deps.db, { ownerToken });
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
