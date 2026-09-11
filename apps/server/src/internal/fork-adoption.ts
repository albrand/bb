import { getActiveStoredTurnId, recordDetachedThreads } from "@bb/db";
import {
  hostDaemonActiveTurnsRequestSchema,
  hostDaemonDetachNoticeRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import type { AppDeps } from "../types.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

export const DETACHED_THREAD_ADOPTION_WINDOW_MS = 10 * 60_000;

function ownedThreadIds(
  deps: Pick<AppDeps, "db">,
  args: { hostId: string; threadIds: readonly string[] },
): string[] {
  return args.threadIds.filter((threadId) => {
    try {
      return (
        requireThreadEnvironment(deps.db, threadId).environment.hostId ===
        args.hostId
      );
    } catch {
      return false;
    }
  });
}

export function registerInternalForkAdoptionRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/fork/active-turns",
    hostDaemonActiveTurnsRequestSchema,
    async (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });
      const threads = ownedThreadIds(deps, {
        hostId: session.hostId,
        threadIds: payload.threadIds,
      }).map((threadId) => ({
        threadId,
        activeTurnId: getActiveStoredTurnId(deps.db, threadId),
      }));
      return context.json({ threads });
    },
  );

  post(
    "/session/fork/detach-notice",
    hostDaemonDetachNoticeRequestSchema,
    async (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });
      const recordedThreadIds = ownedThreadIds(deps, {
        hostId: session.hostId,
        threadIds: payload.threadIds,
      });
      const expectAdoptionUntil =
        Date.now() + DETACHED_THREAD_ADOPTION_WINDOW_MS;
      recordDetachedThreads(deps.db, {
        hostId: session.hostId,
        threadIds: recordedThreadIds,
        expiresAt: expectAdoptionUntil,
      });
      return context.json({ recordedThreadIds, expectAdoptionUntil });
    },
  );
}
