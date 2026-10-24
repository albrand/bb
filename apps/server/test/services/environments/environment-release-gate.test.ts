import {
  archiveThread,
  getEnvironment,
  listEnvironmentReleaseConsents,
  markThreadDeleted,
  threads,
  SYSTEM_RELEASE_ACTOR,
} from "@bb/db";
import type { PluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestEnvironmentRemoval,
  sweepProviderEnvironment,
} from "../../../src/services/environments/environment-engine.js";
import { beginProjectDeletion } from "../../../src/services/projects/project-deletion.js";
import { createThreadFromRequest } from "../../../src/services/threads/thread-create.js";
import { invokePluginInline } from "../../../src/services/plugins/plugin-hook-registry.js";
import { setPluginEnvironmentProviderBridge } from "../../../src/services/plugins/plugin-environment-provider-registry.js";
import { registerTestHostRpcCapture } from "../../helpers/commands.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const PLUGIN_ID = "release-gate";
const PROVIDER_ID = "release-gate-provider";

afterEach(() => {
  setPluginEnvironmentProviderBridge(undefined);
});

function installProvider(
  preflight: { status: "retained"; message: string } | null = null,
) {
  const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
    async () => ({ status: "removed" }),
  );
  const record = {
    pluginId: PLUGIN_ID,
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Release gate",
      description: "Exercises the release check before a removal.",
      icon: "Folder",
      create: async () => ({
        status: "created",
        path: "/tmp/release-gate-new",
        ownsPath: true,
      }),
      ...(preflight === null
        ? {}
        : { experimental_preflightRemove: async () => preflight }),
      remove,
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
  return { remove };
}

function seedWorkspace(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host_release_gate",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/release-gate-project",
  });
  registerTestHostRpcCapture(harness.deps, {
    hostId: host.id,
    sessionId: session.id,
    onEnvironmentHook: async () => {},
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/release-gate-workspace",
    providerOwnsPath: true,
    environmentProviderId: PROVIDER_ID,
    environmentProviderPluginId: PLUGIN_ID,
    environmentProviderInstanceKey: "release-gate-key",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  return { environment, host, project, thread };
}

describe("removing a provider-owned workspace requires its threads' release", () => {
  it("keeps a workspace whose thread was archived without any release, and names the thread", async () =>
    withTestHarness(async (harness) => {
      const { remove } = installProvider();
      const { environment, thread } = seedWorkspace(harness);
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, thread.id))
        .run();

      expect(requestEnvironmentRemoval(harness.deps, environment.id)).toBe(
        true,
      );
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).not.toHaveBeenCalled();
      const kept = getEnvironment(harness.db, environment.id);
      expect(kept).toMatchObject({
        status: "ready",
        path: "/tmp/release-gate-workspace",
      });
      expect(kept?.teardownStatus).not.toBe("removed");
      expect(kept?.teardownMessage).toContain(thread.id);
      expect(kept?.teardownMessage).toContain(
        "no archive or delete through bb",
      );
    }));

  it.each([
    [
      "an archive that passes no release",
      (harness: TestAppHarness, threadId: string) =>
        archiveThread(harness.db, harness.hub, threadId, null),
    ],
    [
      "a delete that passes no release",
      (harness: TestAppHarness, threadId: string) =>
        markThreadDeleted(harness.db, harness.hub, {
          release: null,
          threadId,
        }),
    ],
  ])(
    "keeps the workspace, with its work, after %s, and names the thread",
    async (_name, act) =>
      withTestHarness(async (harness) => {
        const { remove } = installProvider();
        const { environment, thread } = seedWorkspace(harness);
        act(harness, thread.id);

        expect(
          listEnvironmentReleaseConsents(harness.db, environment.id),
        ).toEqual([]);
        expect(requestEnvironmentRemoval(harness.deps, environment.id)).toBe(
          true,
        );
        await sweepProviderEnvironment(harness.deps, environment.id);

        expect(remove).not.toHaveBeenCalled();
        const kept = getEnvironment(harness.db, environment.id);
        expect(kept).toMatchObject({
          status: "ready",
          path: "/tmp/release-gate-workspace",
        });
        expect(kept?.teardownStatus).not.toBe("removed");
        expect(kept?.teardownMessage).toContain(thread.id);
        expect(kept?.teardownMessage).toContain(
          "no archive or delete through bb",
        );
      }),
  );

  it("records a user release when a project is deleted, so its workspace can be removed", async () =>
    withTestHarness(async (harness) => {
      installProvider();
      const { environment, thread } = seedWorkspace(harness);
      const projectId = thread.projectId;

      beginProjectDeletion(harness.deps, { projectId });

      expect(
        listEnvironmentReleaseConsents(harness.db, environment.id),
      ).toMatchObject([
        { threadId: thread.id, actorKind: "user", actorThreadId: null },
      ]);
    }));

  it("removes the workspace once the thread's archive recorded the release", async () =>
    withTestHarness(async (harness) => {
      const { remove } = installProvider();
      const { environment, thread } = seedWorkspace(harness);
      archiveThread(harness.db, harness.hub, thread.id, {
        kind: "coordinator",
        threadId: "thr_coordinator",
      });

      expect(requestEnvironmentRemoval(harness.deps, environment.id)).toBe(
        true,
      );
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        status: "destroyed",
        teardownStatus: "removed",
      });
    }));

  it("keeps the workspace while any one of its threads has no release", async () =>
    withTestHarness(async (harness) => {
      const { remove } = installProvider();
      const { environment, thread } = seedWorkspace(harness);
      const sibling = seedThread(harness.deps, {
        projectId: environment.projectId,
        environmentId: environment.id,
        status: "idle",
      });
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, sibling.id))
        .run();
      archiveThread(harness.db, harness.hub, thread.id, SYSTEM_RELEASE_ACTOR);

      expect(requestEnvironmentRemoval(harness.deps, environment.id)).toBe(
        true,
      );
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).not.toHaveBeenCalled();
      expect(
        getEnvironment(harness.db, environment.id)?.teardownMessage,
      ).toContain(sibling.id);
    }));
});

describe("a create that fails after its thread exists", () => {
  async function failCreate(
    harness: TestAppHarness,
    args: { environmentId: string; projectId: string },
  ): Promise<string> {
    await expect(
      createThreadFromRequest(harness.deps, {
        environment: { type: "reuse", environmentId: args.environmentId },
        experimental_pluginCreateData: { "no-such-plugin": {} },
        input: textInput("Doomed launch"),
        origin: "sdk",
        projectId: args.projectId,
        providerId: "codex",
        startedOnBehalfOf: null,
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { code: "plugin_configuration_unavailable" },
    });
    const tombstoned = harness.db
      .select()
      .from(threads)
      .where(eq(threads.environmentId, args.environmentId))
      .all();
    expect(tombstoned).toHaveLength(1);
    expect(tombstoned[0]?.deletedAt).not.toBeNull();
    return tombstoned[0]?.id ?? "";
  }

  it("removes the workspace of a failed create once it is clean", async () =>
    withTestHarness(async (harness) => {
      const { remove } = installProvider();
      const { environment, project, thread } = seedWorkspace(harness);
      harness.db.delete(threads).where(eq(threads.id, thread.id)).run();

      await failCreate(harness, {
        environmentId: environment.id,
        projectId: project.id,
      });
      expect(requestEnvironmentRemoval(harness.deps, environment.id)).toBe(
        true,
      );
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        status: "destroyed",
      });
    }));

  it("records the failed-create actor in the consent row of the thread it deleted", async () =>
    withTestHarness(async (harness) => {
      installProvider();
      const { environment, project, thread } = seedWorkspace(harness);
      harness.db.delete(threads).where(eq(threads.id, thread.id)).run();

      const failedId = await failCreate(harness, {
        environmentId: environment.id,
        projectId: project.id,
      });

      expect(
        listEnvironmentReleaseConsents(harness.db, environment.id),
      ).toMatchObject([
        {
          threadId: failedId,
          actorKind: "system:failed-create",
          actorThreadId: null,
        },
      ]);
    }));

  it.each([
    [
      "a program is working in it",
      "it is still in use: process 4242 (node) has its working folder inside it",
    ],
    [
      "it holds changes that are not published",
      "it holds uncommitted changes, so it was kept",
    ],
  ])(
    "keeps the workspace with the provider's reason when %s",
    async (_name, message) =>
      withTestHarness(async (harness) => {
        const { remove } = installProvider({ status: "retained", message });
        const { environment, project, thread } = seedWorkspace(harness);
        harness.db.delete(threads).where(eq(threads.id, thread.id)).run();

        const failedId = await failCreate(harness, {
          environmentId: environment.id,
          projectId: project.id,
        });
        expect(requestEnvironmentRemoval(harness.deps, environment.id)).toBe(
          true,
        );
        await sweepProviderEnvironment(harness.deps, environment.id);

        expect(remove).not.toHaveBeenCalled();
        const kept = getEnvironment(harness.db, environment.id);
        expect(kept).toMatchObject({
          status: "ready",
          path: "/tmp/release-gate-workspace",
        });
        expect(kept?.teardownStatus).not.toBe("removed");
        expect(kept?.teardownMessage).toContain(message);
        expect(
          listEnvironmentReleaseConsents(harness.db, environment.id),
        ).toMatchObject([
          { threadId: failedId, actorKind: "system:failed-create" },
        ]);
      }),
  );
});
