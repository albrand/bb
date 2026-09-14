import { eq, inArray } from "drizzle-orm";
import type {
  ProjectExecutionDefaults,
  PermissionMode,
  ReasoningLevel,
  ServiceTier,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";
import { projectExecutionDefaults } from "../schema.js";

export interface GetProjectExecutionDefaultsArgs {
  projectId: string;
  providerId?: string;
}

export interface ListProjectExecutionDefaultsByProjectIdsArgs {
  projectIds: readonly string[];
}

export interface UpsertProjectExecutionDefaultsArgs extends GetProjectExecutionDefaultsArgs {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  serviceTier: ServiceTier;
  updatedAt?: number;
}

const PER_PROVIDER_TABLE = "fork_project_provider_execution_defaults";

interface PerProviderRow {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  serviceTier: ServiceTier;
}

const perProviderTableReady = new WeakSet<object>();

function ensurePerProviderTable(db: DbConnection): void {
  if (perProviderTableReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${PER_PROVIDER_TABLE} (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      service_tier TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, provider_id)
    )
  `);
  perProviderTableReady.add(db.$client);
}

function getPerProviderExecutionDefaults(
  db: DbConnection,
  args: { projectId: string; providerId: string },
): ProjectExecutionDefaults | null {
  ensurePerProviderTable(db);
  const row = db.$client
    .prepare<[string, string], PerProviderRow>(
      `
        SELECT provider_id AS providerId, model,
          reasoning_level AS reasoningLevel,
          permission_mode AS permissionMode,
          service_tier AS serviceTier
        FROM ${PER_PROVIDER_TABLE}
        WHERE project_id = ? AND provider_id = ?
      `,
    )
    .get(args.projectId, args.providerId);
  return row === undefined ? null : { ...row };
}

function upsertPerProviderExecutionDefaults(
  db: DbConnection,
  args: UpsertProjectExecutionDefaultsArgs & { updatedAt: number },
): void {
  ensurePerProviderTable(db);
  db.$client
    .prepare<[string, string, string, string, string, string, number]>(
      `
        INSERT INTO ${PER_PROVIDER_TABLE} (project_id, provider_id, model,
          reasoning_level, permission_mode, service_tier, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, provider_id) DO UPDATE SET
          model = excluded.model,
          reasoning_level = excluded.reasoning_level,
          permission_mode = excluded.permission_mode,
          service_tier = excluded.service_tier,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      args.projectId,
      args.providerId,
      args.model,
      args.reasoningLevel,
      args.permissionMode,
      args.serviceTier,
      args.updatedAt,
    );
}

export function getProjectExecutionDefaults(
  db: DbConnection,
  args: GetProjectExecutionDefaultsArgs,
): ProjectExecutionDefaults | null {
  const latest = getLatestProjectExecutionDefaults(db, args.projectId);
  if (args.providerId === undefined || latest?.providerId === args.providerId) {
    return latest;
  }
  return getPerProviderExecutionDefaults(db, {
    projectId: args.projectId,
    providerId: args.providerId,
  });
}

function getLatestProjectExecutionDefaults(
  db: DbConnection,
  projectId: string,
): ProjectExecutionDefaults | null {
  const row = db
    .select({
      providerId: projectExecutionDefaults.providerId,
      model: projectExecutionDefaults.model,
      reasoningLevel: projectExecutionDefaults.reasoningLevel,
      permissionMode: projectExecutionDefaults.permissionMode,
      serviceTier: projectExecutionDefaults.serviceTier,
    })
    .from(projectExecutionDefaults)
    .where(eq(projectExecutionDefaults.projectId, projectId))
    .get();

  return row ?? null;
}

export function listProjectExecutionDefaultsByProjectIds(
  db: DbConnection,
  args: ListProjectExecutionDefaultsByProjectIdsArgs,
): Map<string, ProjectExecutionDefaults> {
  const byProjectId = new Map<string, ProjectExecutionDefaults>();
  if (args.projectIds.length === 0) {
    return byProjectId;
  }

  const rows = db
    .select({
      projectId: projectExecutionDefaults.projectId,
      providerId: projectExecutionDefaults.providerId,
      model: projectExecutionDefaults.model,
      reasoningLevel: projectExecutionDefaults.reasoningLevel,
      permissionMode: projectExecutionDefaults.permissionMode,
      serviceTier: projectExecutionDefaults.serviceTier,
    })
    .from(projectExecutionDefaults)
    .where(inArray(projectExecutionDefaults.projectId, [...args.projectIds]))
    .all();

  for (const row of rows) {
    const { projectId, ...defaults } = row;
    byProjectId.set(projectId, defaults);
  }
  return byProjectId;
}

export function upsertProjectExecutionDefaults(
  db: DbConnection,
  args: UpsertProjectExecutionDefaultsArgs,
): ProjectExecutionDefaults {
  const updatedAt = args.updatedAt ?? Date.now();
  const row = db
    .insert(projectExecutionDefaults)
    .values({
      projectId: args.projectId,
      providerId: args.providerId,
      model: args.model,
      reasoningLevel: args.reasoningLevel,
      permissionMode: args.permissionMode,
      serviceTier: args.serviceTier,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [projectExecutionDefaults.projectId],
      set: {
        providerId: args.providerId,
        model: args.model,
        reasoningLevel: args.reasoningLevel,
        permissionMode: args.permissionMode,
        serviceTier: args.serviceTier,
        updatedAt,
      },
    })
    .returning({
      providerId: projectExecutionDefaults.providerId,
      model: projectExecutionDefaults.model,
      reasoningLevel: projectExecutionDefaults.reasoningLevel,
      permissionMode: projectExecutionDefaults.permissionMode,
      serviceTier: projectExecutionDefaults.serviceTier,
    })
    .get();
  upsertPerProviderExecutionDefaults(db, { ...args, updatedAt });

  return row;
}
