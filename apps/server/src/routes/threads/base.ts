import { countUnarchivedThreadDescendants } from "../../services/threads/thread-archive.js";
import { eq } from "drizzle-orm";
import { cancelAbandonedProviderCreations } from "../../services/threads/thread-environment-providers.js";
import {
  THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT,
  THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
  countNonDeletedAssignedChildThreads,
  countThreads,
  createEnvironment,
  findProjectEnvironmentByHostPath,
  getEnvironment,
  getHost,
  getThread,
  getThreadExecutionOverride,
  getThreadSpawner,
  isNativeTerminalThread,
  setThreadExecutionOverride,
  getThreadSectionById,
  ensureSpendTables,
  listThreadMentionRowsByIds,
  listNonDeletedChildThreads,
  listSpendRollupRows,
  listThreadsWithPendingInteractionState,
  markThreadDeleted,
  listThreadDeletionTree,
  listPluginThreadMetadata,
  queuedThreadMessages,
  listThreadAncestors,
  listThreadDescendants,
  searchThreadsWithPendingInteractionState,
  transferManagedEnvironmentProject,
  updateThread,
  type ThreadSearchResultGroup as DbThreadSearchResultGroup,
  type UpdateThreadInput,
} from "@bb/db";
import {
  PROMPT_HISTORY_SEARCH_LIMIT_DEFAULT,
  PROMPT_HISTORY_SEARCH_LIMIT_MAX,
  type Environment,
  type Thread,
  type ThreadListEntry,
} from "@bb/domain";
import { toEnvironmentResponse } from "../../services/environments/environment-response.js";
import {
  DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
  threadIncludeOptionSchema,
  THREAD_COUNT_ROOT_PARENT,
  publicApiRoutes,
  typedRoutes,
  type ThreadGetQuery,
  type ThreadIncludeOption,
  type ThreadChildSummaryResponse,
  type ThreadCountResponse,
  type PluginThreadMetadataListResponse,
  type ThreadAncestorsListResponse,
  type ThreadDescendantsListResponse,
  type ThreadRunningResponse,
  type ThreadSearchResponse,
  type ThreadWithIncludesResponse,
  type PublicApiSchema,
  type ResolveThreadMentionsResponse,
  parseThreadListThreadIds,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import type { PluginService } from "../../services/plugins/plugin-service.js";
import {
  clearCurrentThreadListSlowQueryContext,
  setCurrentThreadListSlowQueryContext,
} from "../../services/system/event-loop-work.js";
import { ApiError } from "../../errors.js";
import {
  parseBoundedPositiveOptionalInteger,
  parseInteger,
  parsePaginationQuery,
} from "../../services/lib/validation.js";
import { searchPromptHistory } from "../../services/prompt-history-search.js";
import {
  getNonDestroyedHostWithStatus,
  requireEnvironment,
  requirePublicProject,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { listRunningThreadsWithIntendedHosts } from "../../services/threads/dispatch-attempt.js";
import { dispatchThreadRenameCommand } from "../../services/threads/thread-commands.js";
import { requestThreadStorageDeletion } from "../../services/threads/thread-lifecycle.js";
import { createThreadFromRequest } from "../../services/threads/thread-create.js";
import { createThreadForkFromRequest } from "../../services/threads/thread-fork.js";
import { requireChildThreadsConfirmation } from "../../services/threads/child-thread-confirmation.js";
import {
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../../services/threads/thread-runtime-display.js";
import { assertValidParentThread } from "../../services/threads/thread-parent.js";
import { handleThreadOwnershipChange } from "../../services/threads/thread-ownership.js";
import {
  applyThreadExecutionOverride,
  loadThreadProviderModels,
  resolveFallbackModel,
  resolveThreadExecutionOverrideUpdate,
} from "../../services/threads/thread-execution-override.js";
import {
  applyThreadSessionOptionPatch,
  resolveThreadSessionOptionPatch,
} from "../../services/threads/thread-session-options.js";
import {
  assertRequestedModelAllowed,
  childThreadModel,
} from "../../services/threads/child-thread-model.js";
import { emitPluginThreadDeleted } from "../../services/plugins/plugin-thread-events.js";
import { NotificationBuffer } from "../../services/lib/notification-buffer.js";
import { getActiveTurnId } from "../../services/threads/thread-events.js";

function parseThreadIncludes(query: ThreadGetQuery): Set<ThreadIncludeOption> {
  const includes = new Set<ThreadIncludeOption>();
  if (!query.include) {
    return includes;
  }
  for (const value of query.include.split(",")) {
    includes.add(threadIncludeOptionSchema.parse(value));
  }
  return includes;
}

interface BuildThreadResponseArgs {
  includes: Set<ThreadIncludeOption>;
  thread: Thread;
}

type ThreadSearchResultGroupResponse = ThreadSearchResponse["active"];

interface BuildThreadSearchGroupResponseArgs {
  group: DbThreadSearchResultGroup;
}

interface BuildThreadSearchResponseArgs {
  active: DbThreadSearchResultGroup;
  archived: DbThreadSearchResultGroup;
}

function resolveIncludedThreadEnvironment(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
): Environment | null {
  if (thread.environmentId === null) {
    return null;
  }
  const environment = getEnvironment(deps.db, thread.environmentId);
  return environment === null
    ? null
    : toEnvironmentResponse(deps.db, environment);
}

function buildThreadResponse(
  deps: AppDeps,
  args: BuildThreadResponseArgs,
): ThreadWithIncludesResponse {
  const response: ThreadWithIncludesResponse = toThreadResponseFromThread(
    deps,
    {
      thread: args.thread,
    },
  );
  const shouldResolveEnvironment =
    args.includes.has("environment") || args.includes.has("host");
  const environment = shouldResolveEnvironment
    ? resolveIncludedThreadEnvironment(deps, args.thread)
    : null;

  if (args.includes.has("environment")) {
    response.environment = environment;
  }
  if (args.includes.has("host")) {
    response.host = environment
      ? getNonDestroyedHostWithStatus(deps, environment.hostId)
      : null;
    response.environmentHostName = environment
      ? (getHost(deps.db, environment.hostId)?.name ?? null)
      : null;
  }
  return response;
}

function countNonWhitespaceChars(value: string): number {
  return value.replaceAll(/\s/gu, "").length;
}

function threadMentionLabel(thread: {
  id: string;
  title: string | null;
  titleFallback: string | null;
}): string {
  if (thread.title && thread.title.trim().length > 0) {
    return thread.title;
  }
  if (thread.titleFallback && thread.titleFallback.trim().length > 0) {
    return thread.titleFallback;
  }
  return `Thread ${thread.id.slice(0, 8)}`;
}

function parseSearchLimitPerGroup(value: string | undefined): number {
  const limit =
    value === undefined
      ? THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT
      : parseInteger(value, "limitPerGroup");
  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "limitPerGroup must be positive",
    );
  }
  if (limit > THREAD_SEARCH_LIMIT_PER_GROUP_MAX) {
    throw new ApiError(
      400,
      "invalid_request",
      `limitPerGroup must be at most ${THREAD_SEARCH_LIMIT_PER_GROUP_MAX}`,
    );
  }
  return limit;
}

function requireThreadSection(
  deps: Pick<AppDeps, "db">,
  sectionId: string,
): void {
  if (!getThreadSectionById(deps.db, sectionId)) {
    throw new ApiError(404, "section_not_found", "Section not found");
  }
}

function buildThreadSearchGroupResponse(
  deps: AppDeps,
  args: BuildThreadSearchGroupResponseArgs,
): ThreadSearchResultGroupResponse {
  const threadEntries = toThreadListEntryResponses(deps, {
    threads: args.group.results.map((result) => result.thread),
  });
  const threadEntriesById = new Map(
    threadEntries.map((thread) => [thread.id, thread]),
  );

  return {
    total: args.group.total,
    results: args.group.results.flatMap((result) => {
      const thread = threadEntriesById.get(result.thread.id);
      if (thread === undefined) {
        return [];
      }
      return [{ thread, matches: result.matches }];
    }),
  };
}

function buildThreadSearchResponse(
  deps: AppDeps,
  args: BuildThreadSearchResponseArgs,
): ThreadSearchResponse {
  return {
    active: buildThreadSearchGroupResponse(deps, { group: args.active }),
    archived: buildThreadSearchGroupResponse(deps, { group: args.archived }),
  };
}

export function registerThreadBaseRoutes(
  app: Hono,
  deps: AppDeps,
  pluginService: Pick<PluginService, "resolveRpcCaller">,
): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threads;

  get(routes.count, (context, query) => {
    if (query.projectId) {
      requirePublicProject(deps.db, query.projectId);
    }
    const result = countThreads(deps.db, {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
      ...(query.providerId !== undefined
        ? { providerId: query.providerId }
        : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.parentThreadId === undefined
        ? {}
        : {
            parent:
              query.parentThreadId === THREAD_COUNT_ROOT_PARENT
                ? { kind: "root" as const }
                : {
                    kind: "id" as const,
                    parentThreadId: query.parentThreadId,
                  },
          }),
      ...(query.groupBy !== undefined ? { groupBy: query.groupBy } : {}),
      includeArchived: query.includeArchived === "true",
      includeHidden: query.includeHidden === "true",
    });
    const response: ThreadCountResponse = {
      total: result.total,
      ...(result.groups !== undefined ? { groups: result.groups } : {}),
    };
    return context.json(response);
  });

  post(routes.ancestors, (context, payload) => {
    return context.json({
      threads: listThreadAncestors(deps.db, payload.threadIds),
    } satisfies ThreadAncestorsListResponse);
  });

  post(routes.descendants, (context, payload) => {
    return context.json({
      threads: listThreadDescendants(deps.db, payload.threadIds, {
        includeArchived: payload.includeArchived ?? false,
        includeHidden: payload.includeHidden ?? false,
      }),
    } satisfies ThreadDescendantsListResponse);
  });

  post(routes.pluginMetadata.list, (context, payload) => {
    const { threads, corruptThreadIds } = listPluginThreadMetadata(
      deps.db,
      payload.pluginId,
      payload.threadIds,
    );
    for (const threadId of corruptThreadIds) {
      deps.logger.warn(
        `Ignoring corrupt plugin metadata for thread ${threadId}, plugin ${payload.pluginId}`,
      );
    }
    return context.json({ threads } satisfies PluginThreadMetadataListResponse);
  });

  get(routes.running, (context) => {
    return context.json(
      listRunningThreadsWithIntendedHosts(deps) satisfies ThreadRunningResponse,
    );
  });

  get(routes.list, (context, query) => {
    const { limit, offset } = parsePaginationQuery({
      limit: query.limit,
      offset: query.offset,
    });
    setCurrentThreadListSlowQueryContext(
      context,
      query,
      limit,
      offset,
      pluginService,
    );
    try {
      if (query.projectId) {
        requirePublicProject(deps.db, query.projectId);
      }
      if (query.sectionId && query.unsectioned === "true") {
        throw new ApiError(
          400,
          "invalid_request",
          "sectionId and unsectioned cannot be used together",
        );
      }
      if (query.sectionId) {
        requireThreadSection(deps, query.sectionId);
      }
      const threads = listThreadsWithPendingInteractionState(deps.db, {
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.environmentId ? { environmentId: query.environmentId } : {}),
        ...(query.hostId ? { hostId: query.hostId } : {}),
        ...(query.parentThreadId
          ? { parentThreadId: query.parentThreadId }
          : {}),
        ...(query.sourceThreadId
          ? { sourceThreadId: query.sourceThreadId }
          : {}),
        ...(query.sectionId ? { sectionId: query.sectionId } : {}),
        ...(query.unsectioned === "true" ? { unsectioned: true } : {}),
        ...(query.originKind ? { originKind: query.originKind } : {}),
        ...(query.originPluginId
          ? { originPluginId: query.originPluginId }
          : {}),
        ...(query.threadIds === undefined
          ? {}
          : { threadIds: parseThreadListThreadIds(query.threadIds) }),
        includeHidden: query.includeHidden === "true",
        archived:
          query.archived === undefined ? undefined : query.archived === "true",
        hasParent:
          query.hasParent === undefined
            ? undefined
            : query.hasParent === "true",
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      return context.json(
        toThreadListEntryResponses(deps, {
          threads,
        }) satisfies ThreadListEntry[],
      );
    } finally {
      clearCurrentThreadListSlowQueryContext();
    }
  });

  get(routes.searchPromptHistory, (context, query) => {
    if (query.projectId !== undefined) {
      requirePublicProject(deps.db, query.projectId);
    }
    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_SEARCH_LIMIT_DEFAULT,
      max: PROMPT_HISTORY_SEARCH_LIMIT_MAX,
      name: "limit",
      value: query.limit,
    });
    return context.json(
      searchPromptHistory(deps, {
        limit,
        projectId: query.projectId ?? null,
        query: query.query ?? "",
      }),
    );
  });

  get(routes.search, (context, query) => {
    const searchQuery = query.query.trim();
    if (countNonWhitespaceChars(searchQuery) < 2) {
      throw new ApiError(
        400,
        "invalid_request",
        "query must contain at least two non-whitespace characters",
      );
    }
    const limitPerGroup = parseSearchLimitPerGroup(query.limitPerGroup);
    return context.json(
      buildThreadSearchResponse(deps, {
        ...searchThreadsWithPendingInteractionState(deps.db, {
          query: searchQuery,
          limitPerGroup,
        }),
      }) satisfies ThreadSearchResponse,
    );
  });

  post(routes.resolveMentions, (context, payload) => {
    const uniqueThreadIds = [...new Set(payload.threadIds)];
    const rowsById = new Map(
      listThreadMentionRowsByIds(deps.db, uniqueThreadIds).map((thread) => [
        thread.id,
        thread,
      ]),
    );
    const resolved = uniqueThreadIds.flatMap((threadId) => {
      const thread = rowsById.get(threadId);
      if (thread === undefined) {
        return [];
      }
      return [
        {
          threadId: thread.id,
          projectId: thread.projectId,
          label: threadMentionLabel(thread),
        },
      ];
    });
    return context.json(resolved satisfies ResolveThreadMentionsResponse);
  });

  post(routes.create, async (context, payload) => {
    if (payload.sectionId) {
      requireThreadSection(deps, payload.sectionId);
    }
    const thread = await createThreadFromRequest(
      deps,
      {
        ...payload,
        origin: payload.origin,
      },
      {
        ...(context.req.header(DEVICE_HANDOFF_CLIENT_TOKEN_HEADER) === undefined
          ? {}
          : {
              deviceHandoffClientToken: context.req.header(
                DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
              ),
            }),
      },
    );
    return context.json(toThreadResponseFromThread(deps, { thread }), 201);
  });

  post(routes.fork, async (context, payload) => {
    const thread = await createThreadForkFromRequest(deps, payload, {
      ...(context.req.header(DEVICE_HANDOFF_CLIENT_TOKEN_HEADER) === undefined
        ? {}
        : {
            deviceHandoffClientToken: context.req.header(
              DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
            ),
          }),
    });
    return context.json(toThreadResponseFromThread(deps, { thread }), 201);
  });

  get(routes.get, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      buildThreadResponse(deps, {
        includes: parseThreadIncludes(query),
        thread,
      }),
    );
  });

  function getThreadChildSummary(thread: Thread): ThreadChildSummaryResponse {
    ensureSpendTables(deps.db);
    const children = listNonDeletedChildThreads(deps.db, {
      parentThreadId: thread.id,
    });
    const counts = { failed: 0, idle: 0, waiting: 0, working: 0 };
    for (const child of children) {
      if (child.status === "error") counts.failed += 1;
      else if (child.status === "idle") counts.idle += 1;
      else if (child.status === "pending") counts.waiting += 1;
      else counts.working += 1;
    }
    const totalTokens = children.reduce((total: number | null, child) => {
      const rows = listSpendRollupRows(deps.db, { threadId: child.id });
      if (rows.length === 0 || total === null) return null;
      return (
        total +
        rows.reduce((childTotal, row) => childTotal + row.totalTokens, 0)
      );
    }, 0);
    const nonDeletedChildCount = countNonDeletedAssignedChildThreads(deps.db, {
      parentThreadId: thread.id,
    });
    return {
      nonDeletedChildCount,
      ...counts,
      totalTokens,
      children: children.map(({ id, status, title }) => ({
        id,
        status,
        title,
      })),
      unarchivedDescendantCount: countUnarchivedThreadDescendants(
        deps.db,
        thread,
      ),
    };
  }

  get(routes.childSummary, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(getThreadChildSummary(thread));
  });

  patch(routes.update, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (payload.projectId !== undefined) {
      if (Object.keys(payload).length !== 1) {
        throw new ApiError(
          400,
          "invalid_request",
          "Move a thread to a project in a separate update.",
        );
      }
      const targetProject = requirePublicProject(deps.db, payload.projectId);
      if (targetProject.id === thread.projectId) {
        return context.json(toThreadResponseFromThread(deps, { thread }));
      }
      const notifications = new NotificationBuffer();
      const movedThread = deps.db.transaction(
        (tx) => {
          const current = getThread(tx, thread.id);
          if (!current || current.deletedAt !== null) {
            throw new ApiError(404, "thread_not_found", "Thread not found");
          }
          if (current.projectId === targetProject.id) return current;
          if (
            current.status === "starting" ||
            current.status === "active" ||
            current.status === "stopping" ||
            getActiveTurnId({ db: tx }, current.id) !== null
          ) {
            throw new ApiError(
              409,
              "invalid_request",
              "Cannot move a running thread. Wait for its turn to finish or stop it, then move it again.",
            );
          }

          let environmentId = current.environmentId;
          if (environmentId !== null) {
            const environment = getEnvironment(tx, environmentId);
            if (!environment) {
              throw new ApiError(
                409,
                "invalid_request",
                "Cannot move this thread because its environment no longer exists.",
              );
            }
            if (environment.providerOwnsPath) {
              if (environment.projectId === current.projectId) {
                const result = transferManagedEnvironmentProject(
                  tx,
                  notifications,
                  {
                    environmentId: environment.id,
                    movingThreadId: current.id,
                    sourceProjectId: current.projectId,
                    targetProjectId: targetProject.id,
                  },
                );
                if (result === "shared") {
                  throw new ApiError(
                    409,
                    "invalid_request",
                    "Cannot move this thread because another thread in the source project uses its managed worktree. Move those threads first or detach this thread from the worktree.",
                  );
                }
                if (result === "changed") {
                  throw new ApiError(
                    409,
                    "invalid_request",
                    "Cannot move this thread because its managed environment ownership changed. Refresh the thread and try again.",
                  );
                }
              } else if (environment.projectId !== targetProject.id) {
                throw new ApiError(
                  409,
                  "invalid_request",
                  "Cannot move this thread because its managed worktree belongs to another project.",
                );
              }
            } else {
              if (environment.path === null) {
                throw new ApiError(
                  409,
                  "invalid_request",
                  "Cannot move this thread because its unmanaged environment has no path. Restore or detach the environment first.",
                );
              }
              const targetEnvironment = findProjectEnvironmentByHostPath(
                tx,
                targetProject.id,
                environment.hostId,
                environment.path,
              );
              if (targetEnvironment) {
                environmentId = targetEnvironment.id;
              } else {
                const created = createEnvironment(tx, notifications, {
                  projectId: targetProject.id,
                  hostId: environment.hostId,
                  path: environment.path,
                  isGitRepo: environment.isGitRepo,
                  branchName: environment.branchName,
                  baseBranch: environment.baseBranch,
                  defaultBranch: environment.defaultBranch,
                  mergeBaseBranch: environment.mergeBaseBranch,
                  providerOwnsPath: false,
                  status: "ready",
                });
                environmentId = created.id;
              }
            }
          }

          const updated = updateThread(tx, notifications, current.id, {
            environmentId,
            projectId: targetProject.id,
            sectionId: null,
          });
          if (!updated) {
            throw new ApiError(404, "thread_not_found", "Thread not found");
          }
          notifications.notifyProject(current.projectId, ["threads-changed"]);
          notifications.notifyProject(targetProject.id, ["threads-changed"]);
          return updated;
        },
        { behavior: "immediate" },
      );
      notifications.flushInto(deps.hub);
      return context.json(
        toThreadResponseFromThread(deps, { thread: movedThread }),
      );
    }
    if (payload.parentThreadId) {
      assertValidParentThread(deps, {
        childThreadId: thread.id,
        parentThreadId: payload.parentThreadId,
      });
    }

    const sectionId = payload.sectionId;
    if (sectionId !== undefined && sectionId !== null) {
      requireThreadSection(deps, sectionId);
    }
    if (payload.sessionOptions !== undefined) {
      resolveThreadSessionOptionPatch(deps, {
        thread,
        patch: payload.sessionOptions,
      });
    }
    const hasParentChange =
      "parentThreadId" in payload &&
      payload.parentThreadId !== thread.parentThreadId;
    const nativeTerminal = isNativeTerminalThread(deps.db, thread.id);
    const executionPatch = {
      ...("model" in payload ? { model: payload.model } : {}),
      ...("reasoningLevel" in payload
        ? { reasoningLevel: payload.reasoningLevel }
        : {}),
    };
    if (
      !nativeTerminal &&
      (hasParentChange || typeof payload.model === "string")
    ) {
      const requestedModel =
        payload.model === null
          ? null
          : typeof payload.model === "string"
            ? payload.model
            : getThreadExecutionOverride(deps.db, thread.id)?.modelOverride;
      const parentThreadId = hasParentChange
        ? payload.parentThreadId
        : thread.parentThreadId;
      const childScope = parentThreadId
        ? "parent"
        : getThreadSpawner(deps.db, thread.id) === null
          ? null
          : "spawner";
      await assertRequestedModelAllowed(deps, {
        childScope,
        model: requestedModel,
        providerId: thread.providerId,
        sources: undefined,
      });
    }

    const metadataUpdate: UpdateThreadInput = {};
    if ("title" in payload) metadataUpdate.title = payload.title;
    if (sectionId !== undefined) {
      metadataUpdate.sectionId = sectionId;
    } else if (
      payload.parentThreadId === null &&
      thread.parentThreadId !== null
    ) {
      metadataUpdate.sectionId =
        getThread(deps.db, thread.parentThreadId)?.sectionId ?? null;
    }
    if ("parentThreadId" in payload) {
      metadataUpdate.parentThreadId = payload.parentThreadId;
    }
    if ("visibility" in payload) metadataUpdate.visibility = payload.visibility;
    if ("parentNotifications" in payload) {
      metadataUpdate.parentNotifications = payload.parentNotifications;
    }

    let updated: Thread | null;
    if (hasParentChange && !nativeTerminal) {
      await deps.providerRegistry.whenRegistrationsSettled();
      const spawnerThreadId = getThreadSpawner(deps.db, thread.id);
      const models =
        "model" in payload || "reasoningLevel" in payload
          ? await loadThreadProviderModels(
              deps,
              thread,
              typeof payload.model === "string" ? payload.model : null,
            )
          : null;
      const notifications = new NotificationBuffer();
      updated = deps.db.transaction(
        (tx) => {
          const current = getThread(tx, thread.id);
          if (!current) {
            throw new ApiError(404, "thread_not_found", "Thread not found");
          }
          if (current.parentThreadId !== thread.parentThreadId) {
            throw new ApiError(
              409,
              "thread_scope_changed",
              "Thread scope changed while this update was being prepared. Retry the update.",
            );
          }
          if (typeof payload.parentThreadId === "string") {
            assertValidParentThread(
              { db: tx },
              {
                childThreadId: current.id,
                parentThreadId: payload.parentThreadId,
              },
            );
          }
          const existing = getThreadExecutionOverride(tx, thread.id) ?? {
            modelOverride: null,
            reasoningLevelOverride: null,
          };
          const next = models
            ? resolveThreadExecutionOverrideUpdate(deps.providerRegistry, {
                existing,
                patch: executionPatch,
                models,
                providerId: current.providerId,
                fallbackModel: resolveFallbackModel(deps, current),
              })
            : existing;
          const declaredChildModel = deps.providerRegistry.get(
            current.providerId,
          )?.childThreadModel;
          const beforePolicy = childThreadModel({
            parentThreadId: current.parentThreadId ?? spawnerThreadId,
            declaredChildModel,
          });
          const afterPolicy = childThreadModel({
            parentThreadId: payload.parentThreadId ?? spawnerThreadId,
            declaredChildModel,
          });
          if (
            afterPolicy !== null &&
            next.modelOverride !== null &&
            next.modelOverride !== afterPolicy
          ) {
            throw new ApiError(
              400,
              "child_model_conflict",
              `Child threads for ${current.providerId} must use ${afterPolicy}; clear or choose the compatible model before changing the parent.`,
              {
                details: {
                  providerId: current.providerId,
                  requestedModel: next.modelOverride,
                  childThreadModel: afterPolicy,
                  reason: "parent",
                },
              },
            );
          }
          if (afterPolicy !== null && afterPolicy !== beforePolicy) {
            const conflictingQueuedRows = tx
              .select({
                id: queuedThreadMessages.id,
                model: queuedThreadMessages.model,
              })
              .from(queuedThreadMessages)
              .where(eq(queuedThreadMessages.threadId, current.id))
              .all()
              .filter((row) => row.model !== afterPolicy);
            const conflictingQueuedMessageIds = conflictingQueuedRows.map(
              (row) => row.id,
            );
            if (conflictingQueuedMessageIds.length > 0) {
              throw new ApiError(
                400,
                "child_model_conflict",
                "Changing the parent would change the model for accepted queued work.",
                {
                  details: {
                    providerId: current.providerId,
                    requestedModel: conflictingQueuedRows[0]!.model,
                    childThreadModel: afterPolicy,
                    reason: "parent",
                    queuedMessageIds: conflictingQueuedMessageIds,
                  },
                },
              );
            }
          }
          if (models) {
            setThreadExecutionOverride(tx, {
              threadId: current.id,
              modelOverride: next.modelOverride,
              reasoningLevelOverride: next.reasoningLevelOverride,
            });
          }
          return updateThread(tx, notifications, current.id, metadataUpdate);
        },
        { behavior: "immediate" },
      );
      notifications.flushInto(deps.hub);
    } else {
      if ("model" in payload || "reasoningLevel" in payload) {
        await applyThreadExecutionOverride(deps, {
          thread,
          patch: executionPatch,
        });
      }
      updated =
        Object.keys(metadataUpdate).length > 0
          ? updateThread(deps.db, deps.hub, thread.id, metadataUpdate)
          : requirePublicThread(deps.db, thread.id);
    }

    if (payload.sessionOptions !== undefined) {
      applyThreadSessionOptionPatch(deps, {
        thread,
        patch: payload.sessionOptions,
      });
    }

    if (!updated) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    if (
      payload.title &&
      payload.title !== thread.title &&
      updated.environmentId
    ) {
      const environment = requireEnvironment(deps.db, updated.environmentId);
      if (environment.status === "ready" && environment.path) {
        dispatchThreadRenameCommand(deps, {
          environment: {
            id: environment.id,
            hostId: environment.hostId,
          },
          providerId: updated.providerId,
          threadId: updated.id,
          title: payload.title,
        });
      }
    }

    if (
      "parentThreadId" in payload &&
      payload.parentThreadId !== thread.parentThreadId
    ) {
      await handleThreadOwnershipChange(deps, {
        previousThread: thread,
        updatedThread: updated,
      });
    }

    return context.json(toThreadResponseFromThread(deps, { thread: updated }));
  });

  del(routes.delete, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    requireChildThreadsConfirmation({
      action: "delete",
      confirmed: payload.childThreadsConfirmed,
      deps,
      thread,
    });
    const dependents = listThreadDeletionTree(deps.db, thread.id);
    markThreadDeleted(deps.db, deps.hub, { threadId: thread.id });
    for (const dependent of dependents) {
      const deleted = getThread(deps.db, dependent.id);
      if (!deleted) continue;
      if (dependent.deletedAt === null) emitPluginThreadDeleted(deleted);
      cancelAbandonedProviderCreations(deps, deleted.id);
      deps.terminalSessions.closeDeletedThreadTerminals({
        threadId: deleted.id,
      });
      requestThreadStorageDeletion(
        deps,
        deleted,
        deleted.environmentId === null
          ? null
          : getEnvironment(deps.db, deleted.environmentId),
      );
    }
    return context.json({ ok: true });
  });
}
