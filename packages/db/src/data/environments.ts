import { prepareCachedQuery } from "../connection.js";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, placeholder, sql } from "drizzle-orm";
import type {
  DiscoveredWorkspaceProperties,
  EnvironmentChangeKind,
  EnvironmentLifecycleEvent,
  EnvironmentLifecycleNoopReason,
  EnvironmentProviderSelection,
  EnvironmentStatus,
} from "@bb/domain";
import { areHostPathsEqual, evaluateEnvironmentLifecycleEvent } from "@bb/domain";
import type { DbConnection, DbTransaction, DbQueryConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { environmentHookOperations, environments, queuedThreadMessages, threads } from "../schema.js";
import { createEnvironmentId } from "../ids.js";
import { hostPathContains, hostPathEquals } from "./host-path-sql.js";

type EnvironmentReadConnection = DbConnection | DbTransaction;
type EnvironmentWriteConnection = DbConnection | DbTransaction;
export type EnvironmentRow = typeof environments.$inferSelect;

export interface CreateEnvironmentInput {
  name?: string | null;
  projectId: string;
  hostId: string;
  path?: string | null;
  isGitRepo?: boolean;
  branchName?: string | null;
  baseBranch?: string | null;
  defaultBranch?: string | null;
  mergeBaseBranch?: string | null;
  status?: EnvironmentStatus;
  providerOwnsPath: boolean;
  environmentProvider?: {
    environmentProviderId: string;
    pluginId?: string;
    instanceKey: string | null;
    selection: EnvironmentProviderSelection;
  } | null;
}

export function createEnvironment(
  db: EnvironmentWriteConnection,
  notifier: DbNotifier,
  input: CreateEnvironmentInput,
) {
  const now = Date.now();
  const id = createEnvironmentId();
  const row = db
    .insert(environments)
    .values({
      id,
      name: input.name ?? null,
      projectId: input.projectId,
      hostId: input.hostId,
      path: input.path ?? null,
      isGitRepo: input.isGitRepo ?? false,
      branchName: input.branchName ?? null,
      baseBranch: input.baseBranch ?? null,
      defaultBranch: input.defaultBranch ?? null,
      mergeBaseBranch: input.mergeBaseBranch ?? null,
      environmentProviderId:
        input.environmentProvider?.environmentProviderId ?? null,
      environmentProviderPluginId: input.environmentProvider?.pluginId ?? null,
      environmentProviderSelection:
        input.environmentProvider?.selection ?? null,
      environmentProviderInstanceKey:
        input.environmentProvider?.instanceKey ?? null,
      providerOwnsPath: input.providerOwnsPath,
      status: input.status ?? "provisioning",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  notifier.notifyEnvironment(id, ["environment-created"]);
  return row;
}

const prepareGetEnvironment = (db: DbQueryConnection) =>
  db
    .select()
    .from(environments)
    .where(eq(environments.id, placeholder("id")))
    .prepare();

export function getEnvironment(db: EnvironmentReadConnection, id: string) {
  return prepareCachedQuery(db, prepareGetEnvironment).get({ id }) ?? null;
}

export function reviveDestroyedEnvironment(
  db: EnvironmentWriteConnection,
  notifier: DbNotifier,
  args: {
    environmentId: string;
    path: string;
    projectCheckoutProviderId: string;
  },
) {
  const updated = db.transaction(
    (tx) =>
      tx
        .update(environments)
        .set({
          path: args.path,
          status: "ready",
          teardownStatus: null,
          teardownMessage: null,
          retireAt: null,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(environments.id, args.environmentId),
            eq(environments.status, "destroyed"),
            or(
              isNull(environments.environmentProviderId),
              and(
                eq(
                  environments.environmentProviderId,
                  args.projectCheckoutProviderId,
                ),
                eq(environments.providerOwnsPath, false),
              ),
            ),
          ),
        )
        .returning()
        .get() ?? null,
    { behavior: "immediate" },
  );
  if (updated !== null) {
    notifier.notifyEnvironment(updated.id, [
      "metadata-changed",
      "status-changed",
    ]);
  }
  return updated;
}

export function findProjectEnvironmentByHostPath(
  db: EnvironmentReadConnection,
  projectId: string,
  hostId: string,
  path: string,
) {
  return (
    db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.projectId, projectId),
          eq(environments.hostId, hostId),
          hostPathEquals(environments.path, path),
        ),
      )
      .get() ?? null
  );
}

export function transferManagedEnvironmentProject(
  db: EnvironmentWriteConnection,
  notifier: DbNotifier,
  args: {
    environmentId: string;
    movingThreadId: string;
    sourceProjectId: string;
    targetProjectId: string;
  },
): "transferred" | "shared" | "changed" {
  const environment = getEnvironment(db, args.environmentId);
  if (!environment || environment.projectId !== args.sourceProjectId) {
    return "changed";
  }
  const sourceProjectUsers = db
    .select({ value: count() })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, args.environmentId),
        eq(threads.projectId, args.sourceProjectId),
        ne(threads.id, args.movingThreadId),
      ),
    )
    .get()?.value;
  if (sourceProjectUsers !== 0) return "shared";
  const updated = db
    .update(environments)
    .set({ projectId: args.targetProjectId, updatedAt: Date.now() })
    .where(
      and(
        eq(environments.id, args.environmentId),
        eq(environments.projectId, args.sourceProjectId),
      ),
    )
    .returning({ id: environments.id })
    .get();
  if (!updated) return "changed";
  notifier.notifyEnvironment(args.environmentId, ["metadata-changed"]);
  return "transferred";
}

export interface FindForeignManagedEnvironmentAtHostPathArgs {
  hostId: string;
  path: string;
  projectId: string;
}

export function findProviderEnvironmentContainingPath(
  db: DbConnection,
  path: string,
) {
  return (
    db
      .select()
      .from(environments)
      .where(
        and(
          hostPathContains(environments.path, path),
          eq(environments.providerOwnsPath, true),
          ne(environments.status, "destroyed"),
        ),
      )
      .get() ?? null
  );
}

export function findForeignManagedEnvironmentAtHostPath(
  db: DbConnection,
  args: FindForeignManagedEnvironmentAtHostPathArgs,
) {
  return (
    db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.hostId, args.hostId),
          hostPathContains(environments.path, args.path),
          eq(environments.providerOwnsPath, true),
          ne(environments.projectId, args.projectId),
          ne(environments.status, "destroyed"),
        ),
      )
      .get() ?? null
  );
}

export interface ListEnvironmentsFilters {
  environmentProviderId?: string;
  hostId?: string;
  instanceKey?: string;
  limit?: number;
  offset?: number;
  path?: string;
  projectId?: string;
  statuses?: readonly EnvironmentStatus[];
}

export function listEnvironments(
  db: DbConnection,
  filters: ListEnvironmentsFilters = {},
) {
  const conditions = [
    filters.projectId === undefined
      ? undefined
      : eq(environments.projectId, filters.projectId),
    filters.hostId === undefined
      ? undefined
      : eq(environments.hostId, filters.hostId),
    filters.environmentProviderId === undefined
      ? undefined
      : eq(environments.environmentProviderId, filters.environmentProviderId),
    filters.instanceKey === undefined
      ? undefined
      : eq(environments.environmentProviderInstanceKey, filters.instanceKey),
    filters.path === undefined
      ? undefined
      : hostPathEquals(environments.path, filters.path),
    filters.statuses === undefined
      ? undefined
      : inArray(environments.status, [...filters.statuses]),
  ].filter((condition) => condition !== undefined);
  const query = db
    .select()
    .from(environments)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(environments.createdAt), asc(environments.id))
    .$dynamic();
  const limited =
    filters.limit === undefined ? query : query.limit(filters.limit);
  const paged =
    filters.offset === undefined ? limited : limited.offset(filters.offset);
  return paged.all();
}

export function markHostEnvironmentsDestroyed(
  db: EnvironmentWriteConnection,
  notifier: DbNotifier,
  hostId: string,
): EnvironmentRow[] {
  const updated = db
    .update(environments)
    .set({
      path: null,
      resource: null,
      retireAt: null,
      status: "destroyed",
      teardownMessage: null,
      teardownStatus: "removed",
      updatedAt: Date.now(),
    })
    .where(eq(environments.hostId, hostId))
    .returning()
    .all();
  for (const environment of updated) {
    notifier.notifyEnvironment(environment.id, [
      "metadata-changed",
      "status-changed",
    ]);
  }
  return updated;
}

interface EnvironmentMetadataUpdateColumns {
  baseBranch?: string | null;
  branchName?: string | null;
  defaultBranch?: string | null;
  isGitRepo?: boolean;
  isWorktree?: boolean;
  mergeBaseBranch?: string | null;
  name?: string | null;
  path?: string | null;
}

interface EnvironmentMetadataChangeArgs {
  existing: EnvironmentRow;
  metadata: EnvironmentMetadataUpdateColumns;
  updated: EnvironmentRow;
}

export interface UpdateEnvironmentMetadataInput {
  mergeBaseBranch?: string | null;
  name?: string | null;
}

export interface RecordEnvironmentCurrentBranchInput {
  branchName: string | null;
  defaultBranch?: string | null;
}

export interface ListRetiredLoadedEnvironmentIdsOnHostArgs {
  environmentIds: readonly string[];
  hostId: string;
}

export function listRetiredLoadedEnvironmentIdsOnHost(
  db: EnvironmentReadConnection,
  args: ListRetiredLoadedEnvironmentIdsOnHostArgs,
): string[] {
  const environmentIds = [...new Set(args.environmentIds)];
  if (environmentIds.length === 0) {
    return [];
  }

  const retainedRows = db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        inArray(environments.id, environmentIds),
        eq(environments.hostId, args.hostId),
        ne(environments.status, "destroyed"),
      ),
    )
    .all();
  const retainedEnvironmentIds = new Set(
    retainedRows.map((environment) => environment.id),
  );

  return environmentIds.filter(
    (environmentId) => !retainedEnvironmentIds.has(environmentId),
  );
}

function buildEnvironmentMetadataUpdateSet(
  input: EnvironmentMetadataUpdateColumns,
): EnvironmentMetadataUpdateColumns {
  const set: EnvironmentMetadataUpdateColumns = {};
  if ("baseBranch" in input) set.baseBranch = input.baseBranch;
  if ("path" in input) set.path = input.path;
  if ("isGitRepo" in input) set.isGitRepo = input.isGitRepo;
  if ("isWorktree" in input) set.isWorktree = input.isWorktree;
  if ("branchName" in input) set.branchName = input.branchName;
  if ("defaultBranch" in input) set.defaultBranch = input.defaultBranch;
  if ("mergeBaseBranch" in input) set.mergeBaseBranch = input.mergeBaseBranch;
  if ("name" in input) set.name = input.name;
  return set;
}

function environmentMetadataChanged(
  args: EnvironmentMetadataChangeArgs,
): boolean {
  return (
    ("baseBranch" in args.metadata &&
      args.updated.baseBranch !== args.existing.baseBranch) ||
    ("path" in args.metadata && args.updated.path !== args.existing.path) ||
    ("isGitRepo" in args.metadata &&
      args.updated.isGitRepo !== args.existing.isGitRepo) ||
    ("isWorktree" in args.metadata &&
      args.updated.isWorktree !== args.existing.isWorktree) ||
    ("branchName" in args.metadata &&
      args.updated.branchName !== args.existing.branchName) ||
    ("defaultBranch" in args.metadata &&
      args.updated.defaultBranch !== args.existing.defaultBranch) ||
    ("mergeBaseBranch" in args.metadata &&
      args.updated.mergeBaseBranch !== args.existing.mergeBaseBranch) ||
    ("name" in args.metadata && args.updated.name !== args.existing.name)
  );
}

function updateEnvironmentMetadataRecord(
  db: EnvironmentWriteConnection,
  notifier: DbNotifier,
  id: string,
  metadataInput: EnvironmentMetadataUpdateColumns,
) {
  const existing = getEnvironment(db, id);
  if (!existing) return null;

  const metadata = buildEnvironmentMetadataUpdateSet(metadataInput);
  const updated = db
    .update(environments)
    .set({
      ...metadata,
      updatedAt: Date.now(),
    })
    .where(eq(environments.id, id))
    .returning()
    .get();

  if (!updated) {
    return null;
  }

  if (environmentMetadataChanged({ existing, metadata, updated })) {
    notifier.notifyEnvironment(id, ["metadata-changed"]);
  }

  return updated;
}

export function updateEnvironmentMetadata(
  db: EnvironmentWriteConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateEnvironmentMetadataInput,
) {
  return updateEnvironmentMetadataRecord(db, notifier, id, input);
}

export function recordEnvironmentCurrentBranch(
  db: EnvironmentWriteConnection,
  notifier: DbNotifier,
  id: string,
  input: RecordEnvironmentCurrentBranchInput,
) {
  return updateEnvironmentMetadataRecord(db, notifier, id, {
    branchName: input.branchName,
    ...(input.defaultBranch !== undefined
      ? { defaultBranch: input.defaultBranch }
      : {}),
  });
}

export interface RecordProvisionedEnvironmentWorkspaceInput extends DiscoveredWorkspaceProperties {
  baseBranch?: string | null;
  mergeBaseBranch?: string | null;
}

export function recordProvisionedEnvironmentWorkspace(
  db: EnvironmentWriteConnection,
  notifier: DbNotifier,
  id: string,
  input: RecordProvisionedEnvironmentWorkspaceInput,
) {
  return updateEnvironmentMetadataRecord(db, notifier, id, {
    path: input.path,
    isGitRepo: input.isGitRepo,
    isWorktree: input.isWorktree,
    branchName: input.branchName,
    defaultBranch: input.defaultBranch,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.mergeBaseBranch !== undefined
      ? { mergeBaseBranch: input.mergeBaseBranch }
      : {}),
  });
}

export type ApplyEnvironmentLifecycleEventNoopReason =
  | EnvironmentLifecycleNoopReason
  | "not-found"
  | "cas-conflict";

export type ApplyEnvironmentLifecycleEventOutcome =
  | {
      applied: true;
      changes: EnvironmentChangeKind[];
      environment: EnvironmentRow;
    }
  | {
      applied: false;
      detail: string;
      reason: ApplyEnvironmentLifecycleEventNoopReason;
    };

export interface ApplyEnvironmentLifecycleEventArgs {
  environmentId: string;
  event: EnvironmentLifecycleEvent;
}

export function applyEnvironmentLifecycleEventInTransaction(
  db: DbTransaction,
  args: ApplyEnvironmentLifecycleEventArgs,
): ApplyEnvironmentLifecycleEventOutcome {
  const environment = getEnvironment(db, args.environmentId);
  if (!environment) {
    return {
      applied: false,
      detail: `environment not found: ${args.environmentId}`,
      reason: "not-found",
    };
  }

  const evaluation = evaluateEnvironmentLifecycleEvent({
    environment,
    event: args.event,
  });
  if ("noop" in evaluation) {
    return {
      applied: false,
      detail: evaluation.detail,
      reason: evaluation.noop,
    };
  }

  const now = Date.now();
  const set: Partial<typeof environments.$inferInsert> = {
    status: evaluation.to,
    updatedAt: now,
  };
  if (evaluation.to === "destroyed") {
    set.path = null;
  }

  const conditions = [
    eq(environments.id, args.environmentId),
    eq(environments.status, environment.status),
  ];
  if (args.event.type === "destroy.recorded") {
    conditions.push(
      sql`(
        EXISTS (
          SELECT 1 FROM hosts
          WHERE hosts.id = ${environments.hostId}
          AND hosts.phase = 'removing'
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM threads
            WHERE threads.environment_id = ${environments.id}
            AND threads.archived_at IS NULL
            AND threads.deleted_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM threads
            WHERE threads.environment_id = ${environments.id}
            AND threads.status = 'stopping'
          )
        )
      )`,
    );
  }

  const updated = db
    .update(environments)
    .set(set)
    .where(and(...conditions))
    .returning()
    .get();
  if (!updated) {
    return {
      applied: false,
      detail: `state changed while applying ${args.event.type} from status ${environment.status}`,
      reason: "cas-conflict",
    };
  }

  return { applied: true, changes: ["status-changed"], environment: updated };
}

export function applyEnvironmentLifecycleEvent(
  db: DbConnection,
  notifier: DbNotifier,
  args: ApplyEnvironmentLifecycleEventArgs,
): ApplyEnvironmentLifecycleEventOutcome {
  const outcome = db.transaction(
    (tx) => applyEnvironmentLifecycleEventInTransaction(tx, args),
    { behavior: "immediate" },
  );
  if (outcome.applied) {
    notifier.notifyEnvironment(args.environmentId, outcome.changes);
  }
  return outcome;
}

export function getPreparingEnvironment(db: EnvironmentWriteConnection, threadId: string) {
  return db.select().from(environments).where(eq(environments.ownerThreadId, threadId)).get() ?? null;
}

export function reserveEnvironment(db: EnvironmentWriteConnection, input: Omit<typeof environments.$inferInsert, "id" | "createdAt" | "updatedAt">) {
  return db.transaction((tx) => {
    if (input.ownerThreadId == null) throw new Error("Missing environment preparation owner");
    const existing = getPreparingEnvironment(tx, input.ownerThreadId);
    const now = Date.now();
    if (existing !== null) {
      if (existing.teardownStatus !== "removed") throw new Error("Previous environment cleanup is incomplete");
      return tx.update(environments).set({ ...input, path: null, resource: null, claimPath: null, teardownStatus: null, teardownMessage: null, teardownAttempt: 0, teardownFailures: 0, retireAt: null, pendingLog: "", updatedAt: now }).where(eq(environments.id, existing.id)).returning().get()!;
    }
    return tx.insert(environments).values({ ...input, id: createEnvironmentId(), createdAt: now, updatedAt: now }).returning().get();
  });
}

export function updatePreparingEnvironment(db: EnvironmentWriteConnection, row: EnvironmentRow): boolean {
  return db.update(environments).set({ ...row, updatedAt: Date.now() }).where(and(eq(environments.id, row.id), row.ownerThreadId === null ? isNull(environments.ownerThreadId) : eq(environments.ownerThreadId, row.ownerThreadId), eq(environments.attempt, row.attempt))).run().changes > 0;
}

export function listProviderLifecycleEnvironments(
  db: EnvironmentWriteConnection,
  providerId: string | null,
  blocked?: { pluginId: string; teardownMessage: string },
) {
  return db
    .select()
    .from(environments)
    .where(
      and(
        providerId === null
          ? isNull(environments.environmentProviderId)
          : eq(environments.environmentProviderId, providerId),
        providerId === null
          ? undefined
          : or(
              isNull(environments.ownerThreadId),
              sql`${environments.teardownStatus} is not null`,
            ),
        blocked === undefined
          ? undefined
          : sql`not (${environments.ownerThreadId} is null and ${environments.teardownStatus} is 'failed' and ${environments.teardownMessage} is ${blocked.teardownMessage} and ${environments.environmentProviderPluginId} is not ${blocked.pluginId})`,
        sql`(${environments.retireAt} is not null or ${environments.teardownStatus} is not null or not exists (select 1 from ${threads} where ${threads.environmentId} = ${environments.id} and ${threads.archivedAt} is null and ${threads.deletedAt} is null))`,
        sql`(${environments.status} <> 'destroyed' OR ${environments.teardownStatus} IS NOT 'removed')`,
      ),
    )
    .all();
}

const liveThreadStates = or(
  and(isNull(threads.archivedAt), isNull(threads.deletedAt)),
  eq(threads.status, "stopping"),
  eq(threads.status, "active"),
  sql`exists (select 1 from ${queuedThreadMessages} where ${queuedThreadMessages.threadId} = ${threads.id} and ${queuedThreadMessages.state} = 'claimed')`,
);

export function environmentHasLiveThreads(db: EnvironmentWriteConnection, environmentId: string): boolean {
  return db.select({ id: threads.id }).from(threads).where(and(eq(threads.environmentId, environmentId), liveThreadStates)).limit(1).get() !== undefined;
}

export function listEnvironmentReferencingThreadIds(db: EnvironmentWriteConnection, environmentId: string): string[] {
  return db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.environmentId, environmentId), isNull(threads.deletedAt)))
    .all()
    .map((thread) => thread.id);
}

export function listBranchHolderEnvironments(
  db: EnvironmentWriteConnection,
  args: {
    hostId: string;
    branchName: string;
    environmentProviderId: string;
    excludeEnvironmentIds: readonly string[];
  },
): EnvironmentRow[] {
  return db
    .select()
    .from(environments)
    .where(
      and(
        eq(environments.hostId, args.hostId),
        eq(environments.branchName, args.branchName),
        eq(environments.environmentProviderId, args.environmentProviderId),
        eq(environments.providerOwnsPath, true),
        isNotNull(environments.path),
        ne(environments.status, "destroyed"),
        or(isNull(environments.teardownStatus), ne(environments.teardownStatus, "removed")),
        args.excludeEnvironmentIds.length === 0 ? undefined : notInArray(environments.id, [...args.excludeEnvironmentIds]),
      ),
    )
    .orderBy(asc(environments.createdAt))
    .all();
}

export function listEnvironmentLiveThreadIds(db: EnvironmentWriteConnection, environmentId: string): string[] {
  return db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.environmentId, environmentId), liveThreadStates))
    .orderBy(desc(threads.createdAt))
    .all()
    .map((thread) => thread.id);
}

const liveThreadsPredicate = (environmentId: string) =>
  sql`exists (select 1 from ${threads} where ${threads.environmentId} = ${environmentId} and ((${threads.archivedAt} is null and ${threads.deletedAt} is null) or ${threads.status} = 'stopping' or ${threads.status} = 'active' or exists (select 1 from ${queuedThreadMessages} where ${queuedThreadMessages.threadId} = ${threads.id} and ${queuedThreadMessages.state} = 'claimed')))`;

export interface EnvironmentTeardownClaimInput {
  row: EnvironmentRow;
  attempt: number;
  resumed: boolean;
}

export function claimEnvironmentTeardown(db: EnvironmentWriteConnection, input: EnvironmentTeardownClaimInput): boolean {
  const { row, attempt, resumed } = input;
  return (
    db
      .update(environments)
      .set({
        status: row.status === "destroyed" ? "destroyed" : "error",
        teardownStatus: "running",
        teardownAttempt: attempt,
        teardownMessage: null,
        ...(resumed ? {} : { teardownPriorStatus: sql`coalesce(${environments.teardownPriorStatus}, ${environments.status})` }),
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(environments.id, row.id),
          eq(environments.teardownAttempt, row.teardownAttempt),
          row.teardownStatus === null ? isNull(environments.teardownStatus) : eq(environments.teardownStatus, row.teardownStatus),
          eq(environments.status, row.status),
          sql`not ${liveThreadsPredicate(row.id)}`,
        ),
      )
      .run().changes > 0
  );
}

export function releaseUnstartedEnvironmentTeardown(db: EnvironmentWriteConnection, row: EnvironmentRow): boolean {
  return (
    db
      .update(environments)
      .set({ teardownStatus: null, retireAt: null, updatedAt: Date.now() })
      .where(
        and(
          eq(environments.id, row.id),
          eq(environments.teardownStatus, "running"),
          eq(environments.teardownAttempt, row.teardownAttempt),
          eq(environments.status, row.status),
          isNull(environments.teardownPriorStatus),
        ),
      )
      .run().changes > 0
  );
}

export function releaseCancelledEnvironmentOwner(db: EnvironmentWriteConnection, row: EnvironmentRow): boolean {
  if (row.ownerThreadId === null || row.teardownStatus === null) return false;
  return (
    db
      .update(environments)
      .set({ ownerThreadId: null, claimPath: null, retireAt: null, teardownStatus: null, teardownPriorStatus: null, updatedAt: Date.now() })
      .where(
        and(
          eq(environments.id, row.id),
          eq(environments.ownerThreadId, row.ownerThreadId),
          eq(environments.teardownStatus, row.teardownStatus),
          eq(environments.teardownAttempt, row.teardownAttempt),
        ),
      )
      .run().changes > 0
  );
}

export function reviveFailedEnvironmentTeardown(db: EnvironmentWriteConnection, environmentId: string): boolean {
  const row = getEnvironment(db, environmentId);
  if (row === null || row.teardownStatus !== "failed" || row.teardownPriorStatus === null) return false;
  return (
    db
      .update(environments)
      .set({
        status: sql`${environments.teardownPriorStatus}`,
        teardownStatus: null,
        teardownPriorStatus: null,
        retireAt: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(environments.id, environmentId),
          eq(environments.teardownStatus, "failed"),
          eq(environments.teardownAttempt, row.teardownAttempt),
          isNotNull(environments.teardownPriorStatus),
          isNull(environments.ownerThreadId),
          sql`not exists (select 1 from ${environmentHookOperations} where ${environmentHookOperations.id} = 'environment:' || ${environments.id} || ':' || coalesce(${environments.environmentProviderInstanceKey}, 'null') || ':teardown')`,
        ),
      )
      .run().changes > 0
  );
}

export function updateRunningEnvironmentTeardown(
  db: EnvironmentWriteConnection,
  input: { environmentId: string; attempt: number },
  change: Partial<EnvironmentRow>,
): boolean {
  return (
    db
      .update(environments)
      .set({ ...change, updatedAt: Date.now() })
      .where(and(eq(environments.id, input.environmentId), eq(environments.teardownStatus, "running"), eq(environments.teardownAttempt, input.attempt)))
      .run().changes > 0
  );
}

export function failRunningEnvironmentTeardown(
  db: EnvironmentWriteConnection,
  input: { environmentId: string; attempt: number; message: string; retireAt: number | null; keepSnapshot: boolean },
): boolean {
  return (
    db
      .update(environments)
      .set({
        teardownStatus: "failed",
        teardownMessage: input.message,
        teardownFailures: sql`${environments.teardownFailures} + 1`,
        teardownPriorStatus: input.keepSnapshot
          ? sql`case when exists (select 1 from ${environmentHookOperations} where ${environmentHookOperations.id} = 'environment:' || ${environments.id} || ':' || coalesce(${environments.environmentProviderInstanceKey}, 'null') || ':teardown') then null else ${environments.teardownPriorStatus} end`
          : null,
        retireAt: input.retireAt,
        updatedAt: Date.now(),
      })
      .where(and(eq(environments.id, input.environmentId), eq(environments.teardownStatus, "running"), eq(environments.teardownAttempt, input.attempt)))
      .run().changes > 0
  );
}

export function retainRunningEnvironmentTeardown(
  db: EnvironmentWriteConnection,
  input: { environmentId: string; attempt: number; message: string; retireAt: number },
): boolean {
  return (
    db
      .update(environments)
      .set({
        status: sql`${environments.teardownPriorStatus}`,
        teardownStatus: null,
        teardownMessage: input.message,
        teardownPriorStatus: null,
        retireAt: input.retireAt,
        ownerThreadId: sql`case when ${environments.ownerThreadId} is not null and ${environments.teardownPriorStatus} = 'ready' and ${environments.path} is not null then null else ${environments.ownerThreadId} end`,
        claimPath: sql`case when ${environments.ownerThreadId} is not null and ${environments.teardownPriorStatus} = 'ready' and ${environments.path} is not null then null else ${environments.claimPath} end`,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(environments.id, input.environmentId),
          eq(environments.teardownStatus, "running"),
          eq(environments.teardownAttempt, input.attempt),
          isNotNull(environments.teardownPriorStatus),
        ),
      )
      .run().changes > 0
  );
}

export function releaseFinishedEnvironmentPreparationOwners(db: EnvironmentWriteConnection): void {
  db.update(environments).set({ ownerThreadId: null }).where(and(isNotNull(environments.ownerThreadId), eq(environments.teardownStatus, "removed"), sql`not exists (select 1 from ${threads} where ${threads.id} = ${environments.ownerThreadId} and ${threads.deletedAt} is null)`)).run();
}

export function claimEnvironmentPath(db: DbConnection, provisioning: EnvironmentRow, path: string, allowCancelled = false): boolean {
  return db.transaction((tx) => {
    const current = getEnvironment(tx, provisioning.id);
    if (current === null || current.attempt !== provisioning.attempt || current.ownerThreadId !== provisioning.ownerThreadId || (current.status !== "creating" && !(allowCancelled && current.teardownStatus === "running"))) return false;
    if (current.claimPath !== null && !areHostPathsEqual(current.claimPath, path)) return false;
    if (findEnvironmentPathClaim(tx, current.hostId, path, current) !== null) return false;
    return updatePreparingEnvironment(tx, { ...current, claimPath: path });
  }, { behavior: "immediate" });
}

export function findEnvironmentPathClaim(db: EnvironmentWriteConnection, hostId: string, path: string | null, owner: EnvironmentRow | null): EnvironmentRow | null {
  return db.select().from(environments).where(and(
    eq(environments.hostId, hostId),
    path === null ? sql`${environments.claimPath} is not null` : hostPathEquals(environments.claimPath, path),
    owner === null ? undefined : ne(environments.id, owner.id),
    ne(environments.status, "destroyed"),
  )).limit(1).get() ?? null;
}

export function bindEnvironmentPath(db: DbConnection, provisioning: EnvironmentRow, path: string): EnvironmentRow {
  return db.transaction((tx) => {
    const current = getEnvironment(tx, provisioning.id);
    if (current === null || current.attempt !== provisioning.attempt || current.ownerThreadId !== provisioning.ownerThreadId) throw new Error("Environment preparation is no longer current");
    const existing = tx.select().from(environments).where(and(eq(environments.hostId, current.hostId), hostPathEquals(environments.path, path), eq(environments.projectId, current.projectId))).get();
    if (existing === undefined || existing.id === current.id) return current;
    if (existing.teardownStatus !== null || (existing.status !== "ready" && existing.status !== "provisioning")) throw new Error("Workspace is not ready or cleanup is still pending");
    if (existing.ownerThreadId !== null) throw new Error("Workspace is still being prepared by another thread");
    tx.update(environments).set({ ownerThreadId: null, status: "destroyed", teardownStatus: "removed", claimPath: null, resource: null, path: null }).where(eq(environments.id, current.id)).run();
    return tx.update(environments).set({ ownerThreadId: current.ownerThreadId, attempt: current.attempt, status: existing.status === "ready" ? "ready" : current.status, teardownStatus: current.teardownStatus, retireAt: current.retireAt, statusMessage: current.statusMessage, pendingLog: current.pendingLog, claimPath: current.claimPath, environmentProviderId: existing.environmentProviderId ?? current.environmentProviderId, environmentProviderPluginId: existing.environmentProviderId === null ? current.environmentProviderPluginId : existing.environmentProviderPluginId, environmentProviderSelection: existing.environmentProviderId === null ? current.environmentProviderSelection : existing.environmentProviderSelection, environmentProviderInstanceKey: existing.environmentProviderId === null ? current.environmentProviderInstanceKey : existing.environmentProviderInstanceKey }).where(eq(environments.id, existing.id)).returning().get()!;
  }, { behavior: "immediate" });
}
