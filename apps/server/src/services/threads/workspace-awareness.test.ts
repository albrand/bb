import { describe, expect, it } from "vitest";
import {
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  recordWorkspaceFileChanges,
  upsertHost,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import {
  clearWorkspaceAwarenessCache,
  workspaceAwarenessInput,
} from "./workspace-awareness.js";

function setup(): {
  db: DbConnection;
  unmanagedEnvironment: ReturnType<typeof createEnvironment>;
  managedEnvironment: ReturnType<typeof createEnvironment>;
  currentThread: ReturnType<typeof createThread>;
  neighbourThread: ReturnType<typeof createThread>;
} {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const firstProject = createProject(db, noopNotifier, {
    name: "first-project",
    source: { type: "local_path", hostId: host.id, path: "/repo" },
  }).project;
  const secondProject = createProject(db, noopNotifier, {
    name: "second-project",
    source: { type: "local_path", hostId: host.id, path: "/repo" },
  }).project;
  const unmanagedEnvironment = createEnvironment(db, noopNotifier, {
    projectId: firstProject.id,
    hostId: host.id,
    path: "/repo",
    workspaceProvisionType: "unmanaged",
    status: "ready",
  });
  const managedEnvironment = createEnvironment(db, noopNotifier, {
    projectId: secondProject.id,
    hostId: host.id,
    path: "/managed",
    workspaceProvisionType: "managed-worktree",
    status: "ready",
  });
  const currentThread = createThread(db, noopNotifier, {
    projectId: firstProject.id,
    environmentId: unmanagedEnvironment.id,
    providerId: "test-provider",
    title: "Current turn",
    status: "active",
  });
  const neighbourThread = createThread(db, noopNotifier, {
    projectId: secondProject.id,
    environmentId: unmanagedEnvironment.id,
    providerId: "test-provider",
    title: "Neighbour turn",
    status: "active",
  });
  return {
    db,
    unmanagedEnvironment,
    managedEnvironment,
    currentThread,
    neighbourThread,
  };
}

describe("workspace awareness", () => {
  it("includes active neighbours and candidate file attribution for an unmanaged workspace", () => {
    const { db, unmanagedEnvironment, currentThread, neighbourThread } =
      setup();
    clearWorkspaceAwarenessCache();
    try {
      recordWorkspaceFileChanges(db, {
        hostId: unmanagedEnvironment.hostId,
        workspacePath: "/repo",
        filePaths: ["src/shared.ts"],
        candidateThreadIds: [currentThread.id, neighbourThread.id],
        now: 1_000,
      });
      const [input] = workspaceAwarenessInput(db, {
        environment: unmanagedEnvironment,
        thread: currentThread,
        now: 1_001,
      });
      expect(input).toMatchObject({ type: "text", visibility: "agent-only" });
      expect(input).toMatchObject({
        text: expect.stringContaining("1 other bb thread is currently active"),
      });
      expect(input).toMatchObject({
        text: expect.stringContaining(`Neighbour turn (${neighbourThread.id})`),
      });
      expect(input).toMatchObject({
        text: expect.stringContaining(
          `src/shared.ts [${[currentThread.id, neighbourThread.id].sort().join(", ")}]`,
        ),
      });
    } finally {
      db.$client.close();
      clearWorkspaceAwarenessCache();
    }
  });

  it("does not add awareness context for a managed worktree", () => {
    const { db, managedEnvironment, currentThread } = setup();
    clearWorkspaceAwarenessCache();
    try {
      expect(
        workspaceAwarenessInput(db, {
          environment: managedEnvironment,
          thread: currentThread,
          now: 1_001,
        }),
      ).toEqual([]);
    } finally {
      db.$client.close();
      clearWorkspaceAwarenessCache();
    }
  });
});
