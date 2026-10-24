import {
  archiveThread,
  environments,
  getEnvironment,
  getPreparingEnvironment,
  getThread,
  threads,
  SYSTEM_RELEASE_ACTOR,
} from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import type { PluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelProviderEnvironmentCreation } from "../../../src/services/environments/environment-engine.js";
import { invokePluginInline } from "../../../src/services/plugins/plugin-hook-registry.js";
import { setPluginEnvironmentProviderBridge } from "../../../src/services/plugins/plugin-environment-provider-registry.js";
import {
  prepareProviderEnvironment,
  resolveProviderOperationContext,
} from "../../../src/services/threads/thread-environment-placement.js";
import { registerTestHostRpcCapture } from "../../helpers/commands.js";
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

const PLUGIN_ID = "branch-holders";
const PROVIDER_ID = "branch-holders-provider";
const BRANCH = "bb/shared-branch";

afterEach(() => {
  setPluginEnvironmentProviderBridge(undefined);
});

function installProvider(overrides: {
  remove?: PluginEnvironmentProviderDeclaration["remove"];
}) {
  const create = vi.fn<PluginEnvironmentProviderDeclaration["create"]>(
    async () => ({
      status: "created",
      path: "/tmp/branch-holders-new",
      ownsPath: true,
    }),
  );
  const restore = vi.fn<
    NonNullable<PluginEnvironmentProviderDeclaration["restore"]>
  >(async () => ({
    status: "created",
    path: "/tmp/branch-holders-restored",
    ownsPath: true,
  }));
  const removeSpy = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
    async () => ({ status: "removed" }),
  );
  const remove = overrides.remove ?? removeSpy;
  const record = {
    pluginId: PLUGIN_ID,
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Branch holders",
      description: "Exercises branch holder handling.",
      icon: "Folder",
      create,
      restore,
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
  return { record, create, restore, remove, removeSpy };
}

function seedFixture(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host_branch_holders",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/branch-holders-project",
  });
  registerTestHostRpcCapture(harness.deps, {
    hostId: host.id,
    sessionId: session.id,
    onEnvironmentHook: async () => {},
  });
  return { host, project };
}

function seedHolder(
  harness: TestAppHarness,
  args: {
    hostId: string;
    projectId: string;
    status?: "ready" | "error" | "creating";
  },
) {
  return seedEnvironment(harness.deps, {
    hostId: args.hostId,
    projectId: args.projectId,
    path: "/tmp/branch-holders-holder",
    status: args.status ?? "ready",
    branchName: BRANCH,
    providerOwnsPath: true,
    environmentProviderId: PROVIDER_ID,
    environmentProviderPluginId: PLUGIN_ID,
    environmentProviderInstanceKey: "holder-key",
  });
}

async function startCreate(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedFixture>,
  record: ReturnType<typeof installProvider>["record"],
  args: { environmentId?: string } = {},
) {
  const requester = seedThread(harness.deps, {
    projectId: fixture.project.id,
    status: "starting",
    ...(args.environmentId === undefined
      ? {}
      : { environmentId: args.environmentId }),
  });
  const context = await resolveProviderOperationContext(
    harness.deps,
    requester,
    {
      type: "provider",
      environmentProviderId: PROVIDER_ID,
      machine: { type: "existing", hostId: fixture.host.id },
      inputs: null,
      selectionResolved: true,
    },
    record,
  );
  if (context === null) throw new Error("Missing operation context");
  prepareProviderEnvironment(harness.deps, record, {
    ...context,
    suggestedBranchName: BRANCH,
  });
  return requester;
}

async function settled(harness: TestAppHarness, threadId: string) {
  await expect
    .poll(() => {
      const row = getPreparingEnvironment(harness.db, threadId);
      if (row === null) return "missing";
      if (row.status === "creating") return "pending";
      if (row.status === "error" && row.statusMessage === null)
        return "pending";
      return "settled";
    })
    .toBe("settled");
  return getPreparingEnvironment(harness.db, threadId);
}

async function unarchiveRoute(harness: TestAppHarness, threadId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/unarchive`, {
    method: "POST",
  });
}

describe("a create or restore on a branch another workspace still holds", () => {
  it.each([
    ["an unarchived idle thread", { archived: false, status: "idle" }],
    [
      "an archived thread that is still active",
      { archived: true, status: "active" },
    ],
    [
      "an archived thread that is still stopping",
      { archived: true, status: "stopping" },
    ],
  ] as const)(
    "refuses a create while the holder has %s, naming it",
    async (_label, shape) =>
      withTestHarness(async (harness) => {
        const { create, remove, record } = installProvider({});
        const fixture = seedFixture(harness);
        const holder = seedHolder(harness, {
          hostId: fixture.host.id,
          projectId: fixture.project.id,
        });
        const owner = seedThread(harness.deps, {
          projectId: fixture.project.id,
          environmentId: holder.id,
          status: shape.status,
        });
        if (shape.archived) {
          harness.db
            .update(threads)
            .set({ archivedAt: Date.now() })
            .where(eq(threads.id, owner.id))
            .run();
        }

        const requester = await startCreate(harness, fixture, record);
        try {
          const preparing = await settled(harness, requester.id);

          expect(preparing).toMatchObject({
            status: "error",
            statusMessage: expect.stringContaining(owner.id),
          });
          expect(preparing?.statusMessage).toContain(BRANCH);
          expect(create).not.toHaveBeenCalled();
          expect(remove).not.toHaveBeenCalled();
          expect(getEnvironment(harness.db, holder.id)).toMatchObject({
            status: "ready",
            teardownStatus: null,
          });
        } finally {
          await cancelProviderEnvironmentCreation(harness.deps, requester.id);
        }
      }),
  );

  it("refuses a create while another thread is still preparing the holder", async () =>
    withTestHarness(async (harness) => {
      const { create, remove, record } = installProvider({});
      const fixture = seedFixture(harness);
      const holder = seedHolder(harness, {
        hostId: fixture.host.id,
        projectId: fixture.project.id,
        status: "creating",
      });
      const preparing = seedThread(harness.deps, {
        projectId: fixture.project.id,
        status: "starting",
      });
      harness.db
        .update(environments)
        .set({ ownerThreadId: preparing.id })
        .where(eq(environments.id, holder.id))
        .run();

      const requester = await startCreate(harness, fixture, record);
      try {
        const row = await settled(harness, requester.id);

        expect(row).toMatchObject({
          status: "error",
          statusMessage: expect.stringContaining(preparing.id),
        });
        expect(create).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      } finally {
        await cancelProviderEnvironmentCreation(harness.deps, requester.id);
      }
    }));

  it("refuses a restore while the holder has a live thread, naming it", async () =>
    withTestHarness(async (harness) => {
      const { restore, remove, record } = installProvider({});
      const fixture = seedFixture(harness);
      const holder = seedHolder(harness, {
        hostId: fixture.host.id,
        projectId: fixture.project.id,
      });
      const owner = seedThread(harness.deps, {
        projectId: fixture.project.id,
        environmentId: holder.id,
        status: "idle",
      });
      const destroyed = seedEnvironment(harness.deps, {
        hostId: fixture.host.id,
        projectId: fixture.project.id,
        path: "/tmp/branch-holders-gone",
        status: "destroyed",
        branchName: BRANCH,
        providerOwnsPath: true,
        environmentProviderId: PROVIDER_ID,
        environmentProviderPluginId: PLUGIN_ID,
        environmentProviderInstanceKey: "destroyed-key",
      });
      harness.db
        .update(environments)
        .set({ teardownStatus: "removed" })
        .where(eq(environments.id, destroyed.id))
        .run();

      const requester = await startCreate(harness, fixture, record, {
        environmentId: destroyed.id,
      });
      try {
        const row = await settled(harness, requester.id);

        expect(row).toMatchObject({
          status: "error",
          statusMessage: expect.stringContaining(owner.id),
        });
        expect(restore).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(getThread(harness.db, owner.id)?.archivedAt).toBeNull();
      } finally {
        await cancelProviderEnvironmentCreation(harness.deps, requester.id);
      }
    }));

  it("retires an idle archived holder through the normal removal before it creates, and refuses its owner's unarchive meanwhile", async () =>
    withTestHarness(async (harness) => {
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => {
          entered.resolve();
          await release.promise;
          return { status: "removed" };
        },
      );
      const { create, record } = installProvider({ remove });
      const fixture = seedFixture(harness);
      const holder = seedHolder(harness, {
        hostId: fixture.host.id,
        projectId: fixture.project.id,
      });
      const owner = seedThread(harness.deps, {
        projectId: fixture.project.id,
        environmentId: holder.id,
        status: "idle",
      });
      archiveThread(harness.db, harness.hub, owner.id, SYSTEM_RELEASE_ACTOR);

      const requester = await startCreate(harness, fixture, record);
      try {
        await entered.promise;
        const refused = await unarchiveRoute(harness, owner.id);

        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ code: "workspace_busy" });
        expect(getThread(harness.db, owner.id)?.archivedAt).not.toBeNull();
        expect(create).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
      try {
        await expect.poll(() => create.mock.calls.length).toBe(1);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
          create.mock.invocationCallOrder[0] ?? 0,
        );
        expect(getEnvironment(harness.db, holder.id)).toMatchObject({
          status: "destroyed",
          teardownStatus: "removed",
        });
        expect(getThread(harness.db, owner.id)?.archivedAt).not.toBeNull();
      } finally {
        await cancelProviderEnvironmentCreation(harness.deps, requester.id);
      }
    }));

  it("refuses to create when the idle archived holder cannot be removed, naming where it is and why", async () =>
    withTestHarness(async (harness) => {
      const { create, record } = installProvider({
        remove: async (context) =>
          context.path === "/tmp/branch-holders-holder"
            ? {
                status: "retained",
                message:
                  "Kept /tmp/branch-holders-holder: has uncommitted changes.",
              }
            : { status: "removed" },
      });
      const fixture = seedFixture(harness);
      const holder = seedHolder(harness, {
        hostId: fixture.host.id,
        projectId: fixture.project.id,
      });
      const owner = seedThread(harness.deps, {
        projectId: fixture.project.id,
        environmentId: holder.id,
        status: "idle",
      });
      archiveThread(harness.db, harness.hub, owner.id, SYSTEM_RELEASE_ACTOR);

      const requester = await startCreate(harness, fixture, record);
      try {
        const row = await settled(harness, requester.id);

        expect(row).toMatchObject({ status: "error" });
        expect(row?.statusMessage).toContain("/tmp/branch-holders-holder");
        expect(row?.statusMessage).toContain("uncommitted changes");
        expect(create).not.toHaveBeenCalled();
        expect(getEnvironment(harness.db, holder.id)?.status).not.toBe(
          "destroyed",
        );
      } finally {
        await cancelProviderEnvironmentCreation(harness.deps, requester.id);
      }
    }));
});
