import { getActiveStoredTurnId } from "@bb/db";
import {
  hostDaemonActiveTurnsRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import type { AppDeps } from "../types.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

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
      const threads = payload.threadIds.flatMap((threadId) => {
        let hostId: string;
        try {
          hostId = requireThreadEnvironment(deps.db, threadId).environment
            .hostId;
        } catch {
          return [];
        }
        if (hostId !== session.hostId) return [];
        return [
          { threadId, activeTurnId: getActiveStoredTurnId(deps.db, threadId) },
        ];
      });
      return context.json({ threads });
    },
  );
}
