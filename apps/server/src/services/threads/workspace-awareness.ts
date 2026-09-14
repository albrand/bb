import type { Environment, PromptInput, Thread } from "@bb/domain";
import { listRecentWorkspaceFiles, type DbConnection } from "@bb/db";

const MAX_NEIGHBOURS = 16;
const CACHE_TTL_MS = 500;

interface WorkspaceNeighbour {
  id: string;
  title: string | null;
  status: string;
}

interface WorkspaceAwarenessCacheEntry {
  expiresAt: number;
  note: PromptInput[];
}

const cache = new Map<string, WorkspaceAwarenessCacheEntry>();

function cacheKey(
  environment: Pick<Environment, "hostId" | "path">,
): string | null {
  return environment.path === null
    ? null
    : `${environment.hostId}\0${environment.path}`;
}

function readNeighbours(
  db: Pick<DbConnection, "$client">,
  environment: Pick<Environment, "hostId" | "path" | "workspaceProvisionType">,
  threadId: string,
): WorkspaceNeighbour[] {
  if (
    environment.path === null ||
    environment.workspaceProvisionType !== "unmanaged"
  ) {
    return [];
  }
  return db.$client
    .prepare<[string, string, string], WorkspaceNeighbour>(
      `SELECT t.id AS id, t.title AS title, t.status AS status
       FROM threads t
       INNER JOIN environments e ON e.id = t.environment_id
       WHERE e.host_id = ? AND e.path = ? AND e.workspace_provision_type = 'unmanaged'
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
    `${neighbourText}. ${filesText}. Treat their changes as shared workspace state.`;
  return [{ type: "text", text, mentions: [], visibility: "agent-only" }];
}

export function workspaceAwarenessInput(
  db: Pick<DbConnection, "$client">,
  args: {
    environment: Pick<
      Environment,
      "hostId" | "path" | "workspaceProvisionType"
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
    args.environment.workspaceProvisionType !== "unmanaged"
  ) {
    return [];
  }
  const now = args.now ?? Date.now();
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
      Environment,
      "hostId" | "path" | "workspaceProvisionType"
    >;
    thread: Pick<Thread, "id">;
    now?: number;
  },
): string | null {
  const [input] = workspaceAwarenessInput(db, args);
  return input?.type === "text" ? input.text : null;
}

export function clearWorkspaceAwarenessCache(): void {
  cache.clear();
}

export function listSharedWorkspaceActiveThreadIds(
  db: Pick<DbConnection, "$client">,
  environment: Pick<Environment, "hostId" | "path" | "workspaceProvisionType">,
): string[] {
  return readNeighbours(db, environment, "").map((neighbour) => neighbour.id);
}
