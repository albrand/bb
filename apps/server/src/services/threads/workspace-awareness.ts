import type { PromptInput, Thread } from "@bb/domain";
import { listRecentWorkspaceFiles, type DbConnection } from "@bb/db";

const MAX_NEIGHBOURS = 16;
const CACHE_TTL_MS = 500;

export const SHARED_WORKSPACE_ISOLATION_INSTRUCTION =
  "Before changing files, create or choose a dedicated worktree outside this shared path, call update_environment_directory with its absolute path, and end this turn. Do not write in this shared workspace.";

interface WorkspaceNeighbour {
  id: string;
  title: string | null;
  status: string;
}

interface WorkspaceAwarenessCacheEntry {
  expiresAt: number;
  note: PromptInput[];
}

interface WorkspaceAwarenessEnvironment {
  hostId: string;
  path: string | null;
  managed?: boolean;
  providerOwnsPath?: boolean;
}

function environmentProviderOwnsPath(
  environment: WorkspaceAwarenessEnvironment,
): boolean | undefined {
  return environment.providerOwnsPath ?? environment.managed;
}

let cachesByDatabase = new WeakMap<
  object,
  Map<string, WorkspaceAwarenessCacheEntry>
>();

function getCache(
  db: Pick<DbConnection, "$client">,
): Map<string, WorkspaceAwarenessCacheEntry> {
  const database = db.$client as object;
  const existing = cachesByDatabase.get(database);
  if (existing) return existing;
  const cache = new Map<string, WorkspaceAwarenessCacheEntry>();
  cachesByDatabase.set(database, cache);
  return cache;
}

function cacheKey(environment: WorkspaceAwarenessEnvironment): string | null {
  return environment.path === null
    ? null
    : `${environment.hostId}\0${environment.path}`;
}

function readNeighbours(
  db: Pick<DbConnection, "$client">,
  environment: WorkspaceAwarenessEnvironment,
  threadId: string,
): WorkspaceNeighbour[] {
  if (
    environment.path === null ||
    environmentProviderOwnsPath(environment) !== false
  ) {
    return [];
  }
  return db.$client
    .prepare<[string, string, string], WorkspaceNeighbour>(
      `SELECT t.id AS id, t.title AS title, t.status AS status
       FROM threads t
       INNER JOIN environments e ON e.id = t.environment_id
       WHERE e.host_id = ? AND e.path = ? AND e.provider_owns_path = 0
         AND t.id <> ? AND t.status IN ('starting', 'active')
         AND t.archived_at IS NULL AND t.deleted_at IS NULL
       ORDER BY t.updated_at DESC
       LIMIT ${MAX_NEIGHBOURS}`,
    )
    .all(environment.hostId, environment.path, threadId);
}

function buildNote(
  neighbours: readonly WorkspaceNeighbour[],
  recentFiles: ReturnType<typeof listRecentWorkspaceFiles>,
): PromptInput[] {
  if (neighbours.length === 0) return [];
  const labels = neighbours.map(
    (neighbour) => `${neighbour.title?.trim() || "Untitled"} (${neighbour.id})`,
  );
  const neighbourText =
    neighbours.length === 0
      ? "No other bb threads are currently active"
      : `${neighbours.length} other bb thread${neighbours.length === 1 ? " is" : "s are"} currently active: ${labels.join(
          ", ",
        )}`;
  const filesText =
    recentFiles.length === 0
      ? "No recently observed file changes"
      : `Recently observed files: ${recentFiles
          .map((file) => `${file.filePath} [${file.threadIds.join(", ")}]`)
          .join(", ")}`;
  const text =
    `Workspace awareness: this is an unmanaged shared workspace. ` +
    `${neighbourText}. ${filesText}. Treat their changes as shared workspace state. ` +
    SHARED_WORKSPACE_ISOLATION_INSTRUCTION;
  return [{ type: "text", text, mentions: [], visibility: "agent-only" }];
}

export function workspaceAwarenessInput(
  db: Pick<DbConnection, "$client">,
  args: {
    environment: Pick<
      WorkspaceAwarenessEnvironment,
      "hostId" | "path" | "managed" | "providerOwnsPath"
    >;
    thread: Pick<Thread, "id">;
    now?: number;
  },
): PromptInput[] {
  const key = cacheKey(args.environment);
  const workspacePath = args.environment.path;
  if (
    key === null ||
    workspacePath === null ||
    environmentProviderOwnsPath(args.environment) !== false
  ) {
    return [];
  }
  const now = args.now ?? Date.now();
  const cache = getCache(db);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.note;
  const note = buildNote(
    readNeighbours(db, args.environment, args.thread.id),
    listRecentWorkspaceFiles(db, {
      hostId: args.environment.hostId,
      workspacePath,
      now,
      limit: 16,
    }),
  );
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, note });
  return note;
}

export function workspaceAwarenessInstructions(
  db: Pick<DbConnection, "$client">,
  args: {
    environment: Pick<
      WorkspaceAwarenessEnvironment,
      "hostId" | "path" | "managed" | "providerOwnsPath"
    >;
    thread: Pick<Thread, "id">;
    now?: number;
  },
): string | null {
  const [input] = workspaceAwarenessInput(db, args);
  return input?.type === "text" ? input.text : null;
}

export function clearWorkspaceAwarenessCache(): void {
  cachesByDatabase = new WeakMap();
}

export function listSharedWorkspaceActiveThreadIds(
  db: Pick<DbConnection, "$client">,
  environment: WorkspaceAwarenessEnvironment,
): string[] {
  return readNeighbours(db, environment, "").map((neighbour) => neighbour.id);
}
