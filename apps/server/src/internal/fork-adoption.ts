import {
  getActiveStoredTurnId,
  getThread,
  listUncompletedTurnItemRows,
  recordDetachedThreads,
} from "@bb/db";
import { threadEventItemSchema, turnScope } from "@bb/domain";
import {
  hostDaemonActiveTurnsRequestSchema,
  hostDaemonDetachNoticeRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import { settleDanglingBackgroundTasksForStoppedThreadInTransaction } from "../services/threads/background-task-reconciliation.js";
import { appendThreadEventsInTransaction } from "../services/threads/thread-events.js";
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

export function closeItemsOrphanedByAdoption(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  args: {
    adoptedThreadIds: ReadonlySet<string>;
    runningTurnIds: ReadonlyMap<string, string>;
  },
): void {
  const closedThreadIds = new Set<string>();
  deps.db.transaction(
    (tx) => {
      for (const threadId of args.adoptedThreadIds) {
        settleDanglingBackgroundTasksForStoppedThreadInTransaction(
          { db: tx, hub: deps.hub, logger: deps.logger },
          { threadId },
        );
        const turnId = args.runningTurnIds.get(threadId);
        const thread = getThread(tx, threadId);
        if (turnId === undefined || thread === null) continue;
        const completions = listUncompletedTurnItemRows(tx, {
          threadId,
          turnId,
        }).flatMap((row) => {
          const item = threadEventItemSchema.safeParse({
            ...storedItem(row.data),
            status: "interrupted",
          });
          if (!item.success) {
            deps.logger.warn(
              { threadId, turnId },
              "Skipping an orphaned item with an unparsable payload",
            );
            return [];
          }
          const providerThreadId = row.providerThreadId ?? "";
          return [
            {
              threadId,
              environmentId: thread.environmentId,
              providerThreadId,
              type: "item/completed" as const,
              scope: turnScope(turnId),
              data: { providerThreadId, item: item.data },
            },
          ];
        });
        if (completions.length === 0) continue;
        appendThreadEventsInTransaction(tx, completions);
        closedThreadIds.add(threadId);
      }
    },
    { behavior: "immediate" },
  );
  for (const threadId of closedThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      eventTypes: ["item/completed"],
    });
  }
}

const storedItemDataSchema = z.object({ item: z.record(z.string(), z.unknown()) });

function storedItem(data: string): Record<string, unknown> {
  try {
    const parsed = storedItemDataSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data.item : {};
  } catch {
    return {};
  }
}
