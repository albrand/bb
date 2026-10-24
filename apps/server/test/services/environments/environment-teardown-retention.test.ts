import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeferredPromise } from "@bb/test-helpers";
import {
  claimEnvironmentTeardown,
  createConnection,
  environmentHookOperations,
  environments,
  getEnvironment,
  getHost,
  getThread,
  recordThreadEnvironmentReleases,
  releaseCancelledEnvironmentOwner,
  revokeThreadEnvironmentReleases,
  threads,
  updateHost,
} from "@bb/db";
import type { PluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderRemoveResult } from "@get-bb/plugin-sdk/environment-provider";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { validatePluginMachineProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupEnvironment,
  settleUnclaimedEnvironmentTeardown,
  sweepProviderEnvironment,
} from "../../../src/services/environments/environment-engine.js";
import { toEnvironmentResponse } from "../../../src/services/environments/environment-response.js";
import { sweepProviderMachine } from "../../../src/services/machines/provider-orchestration.js";
import { invokePluginInline } from "../../../src/services/plugins/plugin-hook-registry.js";
import { setPluginEnvironmentProviderBridge } from "../../../src/services/plugins/plugin-environment-provider-registry.js";
import { setPluginMachineProviderBridge } from "../../../src/services/plugins/plugin-machine-provider-registry.js";
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

const PLUGIN_ID = "retention";
const PROVIDER_ID = "retention-provider";
const KEPT = "Kept /tmp/retention: has uncommitted changes.";

afterEach(() => {
  setPluginEnvironmentProviderBridge(undefined);
  setPluginMachineProviderBridge(undefined);
});

function installProvider(
  overrides: Partial<PluginEnvironmentProviderDeclaration> = {},
) {
  const record = {
    pluginId: PLUGIN_ID,
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Retention",
      description: "Exercises removal outcomes.",
      icon: "Folder",
      create: async () => {
        throw new Error("Unexpected create");
      },
      remove: async () => ({ status: "removed" }),
      ...overrides,
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
  return record;
}

function seedRetiring(
  harness: TestAppHarness,
  args: {
    providerOwnsPath?: boolean;
    path?: string | null;
    archivedThread?: boolean;
  } = {},
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host_retention",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/retention-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: args.path === undefined ? "/tmp/retention" : args.path,
    environmentProviderId: PROVIDER_ID,
    environmentProviderPluginId: PLUGIN_ID,
    environmentProviderInstanceKey: "retention-key",
    providerOwnsPath: args.providerOwnsPath ?? false,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  if (args.archivedThread !== false) archive(harness, thread.id);
  return { environment, host, project, session, thread };
}

function archive(harness: TestAppHarness, threadId: string): void {
  harness.db
    .update(threads)
    .set({ archivedAt: Date.now() })
    .where(eq(threads.id, threadId))
    .run();
  recordThreadEnvironmentReleases(harness.db, [threadId], {
    kind: "system",
    threadId: null,
  });
}

function unarchiveDirectly(harness: TestAppHarness, threadId: string): void {
  harness.db
    .update(threads)
    .set({ archivedAt: null })
    .where(eq(threads.id, threadId))
    .run();
  revokeThreadEnvironmentReleases(harness.db, threadId);
}

function patch(
  harness: TestAppHarness,
  environmentId: string,
  change: Partial<typeof environments.$inferInsert>,
): void {
  harness.db
    .update(environments)
    .set(change)
    .where(eq(environments.id, environmentId))
    .run();
}

function row(harness: TestAppHarness, environmentId: string) {
  const value = getEnvironment(harness.db, environmentId);
  if (value === null) throw new Error("Missing environment");
  return value;
}

function retireNow(harness: TestAppHarness, environmentId: string): void {
  patch(harness, environmentId, { retireAt: Date.now() - 1 });
}

describe("retained environment removal", () => {
  it("restores the earlier state, keeps the message, backs off, and retires again once the provider lets go", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "retained", message: KEPT })
        .mockResolvedValue({ status: "removed" });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness);
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
        teardownPriorStatus: null,
      });
      expect(row(harness, environment.id).retireAt).toBeGreaterThan(
        Date.now() + 30_000,
      );
      expect(
        toEnvironmentResponse(harness.db, row(harness, environment.id))
          .lifecycle,
      ).toMatchObject({ phase: "retiring", message: KEPT, teardown: null });

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(remove).toHaveBeenCalledTimes(1);

      unarchiveDirectly(harness, thread.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        retireAt: null,
      });
      expect(
        toEnvironmentResponse(harness.db, row(harness, environment.id))
          .lifecycle.message,
      ).toBeUndefined();

      archive(harness, thread.id);
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(row(harness, environment.id)).toMatchObject({
        teardownStatus: "removed",
        teardownMessage: null,
        teardownPriorStatus: null,
      });
    }));

  it("does not count kept attempts toward the five failures that need recovery", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "retained", message: KEPT })
        .mockResolvedValueOnce({ status: "retained", message: KEPT })
        .mockResolvedValueOnce({ status: "retained", message: KEPT })
        .mockResolvedValueOnce({ status: "retained", message: KEPT })
        .mockResolvedValue({ status: "failed", message: "rm: busy" });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment } = seedRetiring(harness);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        retireNow(harness, environment.id);
        await sweepProviderEnvironment(harness.deps, environment.id);
      }

      expect(remove).toHaveBeenCalledTimes(5);
      const current = row(harness, environment.id);
      expect(current.teardownAttempt).toBe(5);
      expect(current.teardownFailures).toBe(1);
      expect(current).toMatchObject({
        teardownStatus: "failed",
        teardownMessage: "rm: busy",
      });
      expect(current.retireAt).not.toBeNull();
    }));

  it("needs recovery after five failures, with no more retries scheduled", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValue({ status: "failed", message: "rm: busy" });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment } = seedRetiring(harness);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        retireNow(harness, environment.id);
        await sweepProviderEnvironment(harness.deps, environment.id);
      }

      const current = row(harness, environment.id);
      expect(current.teardownFailures).toBe(5);
      expect(current.retireAt).toBeNull();
      expect(current.teardownMessage).toContain("Needs recovery");
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(remove).toHaveBeenCalledTimes(5);
    }));

  it("keeps an ordinary failure failed with the environment in error", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "failed", message: "rm: busy" }),
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: "rm: busy",
        teardownPriorStatus: null,
      });
    }));

  it("skips the teardown script and the removal when the preflight retains", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({
        remove,
        experimental_preflightRemove: async () => ({
          status: "retained",
          message: KEPT,
        }),
        policy: { retireGraceMs: 0 },
      });
      const { environment, host, session } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      const hooks = vi.fn(async () => {});
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHook: hooks,
      });
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(hooks).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(harness.db.select().from(environmentHookOperations).all()).toEqual(
        [],
      );
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
      });
    }));

  it("records a failure instead of a retention once the teardown script has started", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "retained", message: KEPT }),
        policy: { retireGraceMs: 0 },
      });
      const { environment, host, session } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHook: async () => {},
      });
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: expect.stringContaining(
          "teardown script had already started",
        ),
      });
      expect(row(harness, environment.id).teardownMessage).toContain(KEPT);
    }));

  it("lets a later retention restore the error a failed attempt left, never the original ready", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "failed", message: "rm: partial" })
        .mockResolvedValueOnce({ status: "retained", message: KEPT });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownAttempt: 1,
      });

      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).toHaveBeenCalledTimes(2);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: null,
        teardownMessage: KEPT,
        teardownPriorStatus: null,
      });
    }));

  it("restores ready for an interrupted attempt whose snapshot survived, but fails closed without one", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        experimental_preflightRemove: async () => ({
          status: "retained",
          message: KEPT,
        }),
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness, { providerOwnsPath: true });
      patch(harness, environment.id, {
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
        retireAt: Date.now() - 1,
      });
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
      });

      const migrated = seedEnvironment(harness.deps, {
        hostId: environment.hostId,
        projectId: environment.projectId,
        path: "/tmp/retention-migrated",
        environmentProviderId: PROVIDER_ID,
        environmentProviderPluginId: PLUGIN_ID,
        environmentProviderInstanceKey: "migrated-key",
        providerOwnsPath: true,
      });
      patch(harness, migrated.id, {
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: null,
        retireAt: Date.now() - 1,
      });
      await sweepProviderEnvironment(harness.deps, migrated.id);
      expect(row(harness, migrated.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: expect.stringContaining("unknown"),
      });
    }));

  it("fails closed when a resumed attempt belongs to a provider that does not record a teardown-script row", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        experimental_preflightRemove: async () => ({
          status: "retained",
          message: KEPT,
        }),
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness, {
        providerOwnsPath: false,
      });
      patch(harness, environment.id, {
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
        retireAt: Date.now() - 1,
      });

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(environment.path).toBe("/tmp/retention");
      expect(harness.db.select().from(environmentHookOperations).all()).toEqual(
        [],
      );
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownPriorStatus: null,
        teardownMessage: expect.stringContaining("does not own the path"),
      });
    }));

  it("fails instead of restoring ready when a path-less attempt resumed after an interruption", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "retained", message: KEPT }),
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness, {
        path: null,
        providerOwnsPath: true,
      });
      patch(harness, environment.id, {
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
        retireAt: Date.now() - 1,
      });

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: expect.stringContaining(
          "no record shows which workspaces were already removed",
        ),
      });
    }));

  it("ignores a late result from an attempt that a newer attempt superseded", async () =>
    withTestHarness(async (harness) => {
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      installProvider({
        remove: async () => {
          entered.resolve();
          await release.promise;
          return { status: "removed" };
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);

      const sweeping = sweepProviderEnvironment(harness.deps, environment.id);
      await entered.promise;
      expect(row(harness, environment.id)).toMatchObject({
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
      });
      patch(harness, environment.id, { teardownAttempt: 2 });
      release.resolve();
      await sweeping;

      expect(row(harness, environment.id)).toMatchObject({
        teardownStatus: "running",
        teardownAttempt: 2,
      });
    }));

  it("keeps the environment when a thread becomes live between the claim and the removal", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      const state: { revive: () => void } = { revive: () => {} };
      installProvider({
        remove,
        experimental_preflightRemove: async () => {
          state.revive();
          return { status: "removable" };
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment, thread } = seedRetiring(harness);
      state.revive = () => unarchiveDirectly(harness, thread.id);
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).not.toHaveBeenCalled();
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: expect.stringContaining(
          "started using this workspace",
        ),
      });
    }));

  it("refuses to unarchive a thread while its environment is being removed", async () =>
    withTestHarness(async (harness) => {
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      installProvider({
        remove: async () => {
          entered.resolve();
          await release.promise;
          return { status: "removed" };
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment, thread } = seedRetiring(harness);
      retireNow(harness, environment.id);

      const sweeping = sweepProviderEnvironment(harness.deps, environment.id);
      await entered.promise;
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "workspace_busy",
      });
      expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
      release.resolve();
      await sweeping;
      expect(row(harness, environment.id).teardownStatus).toBe("removed");
    }));

  it("does not claim an environment a live thread uses", async () =>
    withTestHarness(async (harness) => {
      const { environment, thread } = seedRetiring(harness);
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, {
        teardownStatus: "running",
        retireAt: Date.now(),
      });
      const queued = row(harness, environment.id);

      expect(
        claimEnvironmentTeardown(harness.db, {
          row: queued,
          attempt: 1,
          resumed: false,
        }),
      ).toBe(false);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: "running",
        teardownAttempt: 0,
      });
      archive(harness, thread.id);
      expect(
        claimEnvironmentTeardown(harness.db, {
          row: queued,
          attempt: 1,
          resumed: false,
        }),
      ).toBe(true);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
      });
    }));
});

describe("a claim that matched no row because a thread went live", () => {
  const INTERRUPTED = {
    status: "error",
    teardownStatus: "running",
    teardownAttempt: 1,
    teardownMessage: null,
    teardownPriorStatus: "ready",
    retireAt: Date.now() - 1,
  } as const;

  function settle(harness: TestAppHarness, environmentId: string): void {
    settleUnclaimedEnvironmentTeardown(
      harness.deps,
      row(harness, environmentId),
    );
  }

  it("fails closed for an interrupted attempt that ran the teardown script", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, INTERRUPTED);
      harness.db
        .insert(environmentHookOperations)
        .values({
          id: `environment:${environment.id}:retention-key:teardown`,
          operationId: "hook-1",
          hostId: environment.hostId,
          path: "/tmp/retention",
          kind: "teardown",
          startedAt: Date.now(),
        })
        .run();

      settle(harness, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownPriorStatus: null,
      });
    }));

  it("fails closed for an interrupted path-less attempt", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        path: null,
        providerOwnsPath: true,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, INTERRUPTED);

      settle(harness, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
      });
    }));

  it("fails closed for an interrupted attempt that has no snapshot", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, {
        ...INTERRUPTED,
        teardownPriorStatus: null,
      });

      settle(harness, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
      });
    }));

  it("fails closed for an interrupted preparing-owner row that never became ready", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, {
        ...INTERRUPTED,
        teardownPriorStatus: "creating",
        ownerThreadId: thread.id,
      });

      settle(harness, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        ownerThreadId: thread.id,
      });
    }));

  it("restores the snapshot for an interrupted attempt with complete no-side-effect evidence", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, INTERRUPTED);

      settle(harness, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownPriorStatus: null,
        teardownMessage: expect.stringContaining("thread"),
      });
    }));

  it("fails closed for an interrupted attempt of a provider that does not own the path", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        providerOwnsPath: false,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, INTERRUPTED);

      settle(harness, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownPriorStatus: null,
      });
    }));

  it("releases a removal that was queued but never started, leaving the status alone", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, {
        teardownStatus: "running",
        retireAt: Date.now(),
      });

      settle(harness, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownAttempt: 0,
        retireAt: null,
      });
    }));

  it("releases a removal queued after an earlier retention instead of calling it interrupted", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, {
        teardownStatus: "running",
        teardownAttempt: 2,
        teardownMessage: KEPT,
        retireAt: Date.now(),
      });

      settle(harness, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownAttempt: 2,
        retireAt: null,
      });
    }));

  it("writes nothing when a newer attempt already owns the row", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        path: null,
        providerOwnsPath: true,
      });
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, INTERRUPTED);
      const stale = row(harness, environment.id);
      patch(harness, environment.id, { teardownAttempt: 2 });

      settleUnclaimedEnvironmentTeardown(harness.deps, stale);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 2,
      });
    }));
});

describe("what a failed attempt remembers about the earlier state", () => {
  it("restores ready when a preflight that threw once later retains", async () =>
    withTestHarness(async (harness) => {
      const preflight = vi
        .fn<
          NonNullable<
            PluginEnvironmentProviderDeclaration["experimental_preflightRemove"]
          >
        >()
        .mockRejectedValueOnce(new Error("host unavailable"))
        .mockResolvedValue({ status: "retained", message: KEPT });
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({
        remove,
        experimental_preflightRemove: preflight,
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: "host unavailable",
        teardownPriorStatus: "ready",
      });

      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).not.toHaveBeenCalled();
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
        teardownPriorStatus: null,
      });
    }));

  it("keeps an environment that was already in error in error", async () =>
    withTestHarness(async (harness) => {
      const preflight = vi
        .fn<
          NonNullable<
            PluginEnvironmentProviderDeclaration["experimental_preflightRemove"]
          >
        >()
        .mockRejectedValueOnce(new Error("host unavailable"))
        .mockResolvedValue({ status: "retained", message: KEPT });
      installProvider({
        experimental_preflightRemove: preflight,
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      patch(harness, environment.id, { status: "error" });
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: null,
        teardownMessage: KEPT,
      });
    }));

  it("does not restore ready after a removal that was dispatched and failed", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "failed", message: "rm: partial" })
        .mockResolvedValue({ status: "retained", message: KEPT });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id).teardownPriorStatus).toBeNull();
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: null,
      });
    }));

  it("does not restore ready after the teardown script started and the removal then threw", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockRejectedValueOnce(new Error("connection lost"))
        .mockResolvedValue({ status: "retained", message: KEPT });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment, host, session } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHook: async () => {},
      });
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        teardownStatus: "failed",
        teardownPriorStatus: null,
      });
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: expect.stringContaining(
          "teardown script had already started",
        ),
      });
    }));

  it("drops the snapshot when a preflight throws although an earlier attempt left a teardown-script row", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        experimental_preflightRemove: async () => {
          throw new Error("host unavailable");
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness, { providerOwnsPath: true });
      harness.db
        .insert(environmentHookOperations)
        .values({
          id: `environment:${environment.id}:retention-key:teardown`,
          operationId: "hook-1",
          hostId: environment.hostId,
          path: "/tmp/retention",
          kind: "teardown",
          startedAt: Date.now(),
        })
        .run();
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownPriorStatus: null,
      });
    }));

  it("drops the snapshot when the teardown-script row appears between the start of the attempt and the failure write", async () =>
    withTestHarness(async (harness) => {
      const state: { appear: () => void } = { appear: () => {} };
      installProvider({
        experimental_preflightRemove: async () => {
          state.appear();
          throw new Error("host unavailable");
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment, thread } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      state.appear = () => {
        expect(row(harness, environment.id).teardownPriorStatus).toBe("ready");
        harness.db
          .insert(environmentHookOperations)
          .values({
            id: `environment:${environment.id}:retention-key:teardown`,
            operationId: "hook-late",
            hostId: environment.hostId,
            path: "/tmp/retention",
            kind: "teardown",
            startedAt: Date.now(),
          })
          .run();
      };
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: "host unavailable",
        teardownPriorStatus: null,
      });
      unarchiveDirectly(harness, thread.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
      });
    }));

  it("does not trust a snapshot across a resumed attempt whose preflight threw", async () =>
    withTestHarness(async (harness) => {
      const preflight = vi
        .fn<
          NonNullable<
            PluginEnvironmentProviderDeclaration["experimental_preflightRemove"]
          >
        >()
        .mockRejectedValueOnce(new Error("host unavailable"))
        .mockResolvedValue({ status: "retained", message: KEPT });
      installProvider({
        experimental_preflightRemove: preflight,
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      patch(harness, environment.id, {
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownMessage: null,
        teardownPriorStatus: "ready",
        retireAt: Date.now() - 1,
      });

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        teardownStatus: "failed",
        teardownPriorStatus: null,
      });
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: null,
      });
    }));

  it("snapshots a removal queued after an earlier retention instead of calling it resumed", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValue({ status: "retained", message: KEPT });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownAttempt: 1,
      });

      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).toHaveBeenCalledTimes(2);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownAttempt: 2,
        teardownMessage: KEPT,
      });
    }));
});

describe("a cancelled preparing owner's release", () => {
  it("does not leave the earlier attempt's snapshot for a later claim to restore", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "retained", message: KEPT }),
        policy: { retireGraceMs: 0 },
      });
      const { environment, thread } = seedRetiring(harness, {
        archivedThread: false,
      });
      patch(harness, environment.id, {
        ownerThreadId: thread.id,
        claimPath: "/tmp/retention",
        status: "error",
        teardownStatus: "failed",
        teardownAttempt: 1,
        teardownMessage: "rm: busy",
        teardownPriorStatus: "ready",
        retireAt: Date.now() - 1,
      });

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        ownerThreadId: null,
        claimPath: null,
        teardownStatus: null,
        teardownPriorStatus: null,
        retireAt: null,
      });

      archive(harness, thread.id);
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: null,
        teardownMessage: KEPT,
      });
    }));

  it("leaves a newer attempt's snapshot alone", async () =>
    withTestHarness(async (harness) => {
      installProvider({ policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness, {
        archivedThread: false,
      });
      patch(harness, environment.id, {
        ownerThreadId: thread.id,
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
      });
      const stale = row(harness, environment.id);
      patch(harness, environment.id, { teardownAttempt: 2 });

      expect(releaseCancelledEnvironmentOwner(harness.db, stale)).toBe(false);

      expect(row(harness, environment.id)).toMatchObject({
        ownerThreadId: thread.id,
        teardownStatus: "running",
        teardownAttempt: 2,
        teardownPriorStatus: "ready",
      });
    }));
});

describe("a crash between the removal call and its result", () => {
  it("never restores an environment whose removal the crashed attempt may have run, even when the resumed preflight retains", async () =>
    withTestHarness(async (harness) => {
      const resourceDir = await mkdtemp(join(tmpdir(), "bb-retention-crash-"));
      const resourceFile = join(resourceDir, "data.txt");
      await writeFile(resourceFile, "recoverable\n");
      const entered = createDeferredPromise<void>();
      const interrupted = createDeferredPromise<void>();
      const observed = { removeCalls: 0, hookRowsWhenRemoveStarted: -1 };
      const preflight = vi
        .fn<
          NonNullable<
            PluginEnvironmentProviderDeclaration["experimental_preflightRemove"]
          >
        >()
        .mockResolvedValueOnce({ status: "removable" })
        .mockResolvedValue({ status: "retained", message: KEPT });
      installProvider({
        experimental_preflightRemove: preflight,
        remove: async () => {
          observed.removeCalls += 1;
          observed.hookRowsWhenRemoveStarted = harness.db
            .select()
            .from(environmentHookOperations)
            .all().length;
          await rm(resourceFile);
          entered.resolve();
          await interrupted.promise;
          return { status: "removed" };
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment, host, session } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHook: async () => {},
      });
      retireNow(harness, environment.id);

      const firstAttempt = sweepProviderEnvironment(
        harness.deps,
        environment.id,
      );
      let restarted: ReturnType<typeof createConnection> | null = null;
      try {
        await entered.promise;
        expect(observed.hookRowsWhenRemoveStarted).toBe(1);
        restarted = createConnection(harness.db.$client.serialize());
        const resumedDeps = { ...harness.deps, db: restarted };
        const readCrashed = () => {
          const found = restarted!
            .select()
            .from(environments)
            .where(eq(environments.id, environment.id))
            .get();
          if (found === undefined) throw new Error("Missing environment");
          return found;
        };
        expect(readCrashed()).toMatchObject({
          status: "error",
          teardownStatus: "running",
          teardownAttempt: 1,
          teardownMessage: null,
          teardownPriorStatus: "ready",
        });
        expect(
          restarted.select().from(environmentHookOperations).all(),
        ).toHaveLength(1);
        await expect(stat(resourceFile)).rejects.toThrow();

        await sweepProviderEnvironment(resumedDeps, environment.id);

        expect(preflight).toHaveBeenCalledTimes(2);
        expect(observed.removeCalls).toBe(1);
        expect(readCrashed()).toMatchObject({
          status: "error",
          teardownStatus: "failed",
          teardownPriorStatus: null,
          teardownMessage: expect.stringContaining(
            "teardown script had already started",
          ),
        });
        await expect(readFile(resourceFile, "utf8")).rejects.toThrow();
      } finally {
        interrupted.resolve();
        await firstAttempt.catch(() => undefined);
        restarted?.$client.close();
        await rm(resourceDir, { recursive: true, force: true });
      }
    }));
});

describe("retry delays", () => {
  const MINUTE = 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("doubles the delay after each failed or retained attempt up to a ceiling", async () =>
    withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = new Date("2026-10-21T12:00:00Z").getTime();
      vi.setSystemTime(now);
      const outcomes: PluginEnvironmentProviderRemoveResult[] = [];
      installProvider({
        remove: async () => outcomes.shift() ?? { status: "removed" },
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      const delays: number[] = [];
      for (let attempt = 1; attempt <= 9; attempt += 1) {
        outcomes.push(
          attempt % 2 === 0
            ? { status: "failed", message: "rm: busy" }
            : { status: "retained", message: KEPT },
        );
        patch(harness, environment.id, { retireAt: now - 1 });
        await sweepProviderEnvironment(harness.deps, environment.id);
        delays.push(row(harness, environment.id).retireAt! - now);
      }
      expect(delays.map((delay) => delay / MINUTE)).toEqual([
        1, 2, 4, 8, 16, 32, 60, 60, 60,
      ]);
    }));

  it("lets an explicit cleanup retry a backed-off failure at once", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "failed", message: "rm: busy" })
        .mockResolvedValue({ status: "removed" });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment, host, session } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHook: async () => {},
      });
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id).teardownStatus).toBe("failed");
      expect(row(harness, environment.id).retireAt).toBeGreaterThan(Date.now());

      expect(cleanupEnvironment(harness.deps, environment.id)).toBe(true);

      await vi.waitFor(() =>
        expect(row(harness, environment.id).teardownStatus).toBe("removed"),
      );
    }));
});

describe("removal while the machine is being removed", () => {
  function installMachine(): void {
    const machine = {
      pluginId: "cloud",
      provider: validatePluginMachineProviderDeclaration({
        id: "retention-machine",
        displayName: "Retention machine",
        description: "Test machine",
        icon: "Terminal",
        create: async () => {
          throw new Error("Unexpected machine allocation");
        },
        reconcileCleanup: async () => ({ status: "removed" }),
        remove: async () => ({ status: "removed" }),
      }),
    };
    setPluginMachineProviderBridge({
      listMachineProviders: () => [machine],
      getMachineProvider: (id) =>
        id === machine.provider.id ? machine : undefined,
      invokeProvider: async (_pluginId, _label, run) => ({
        ok: true,
        value: await run(),
      }),
      decisionTimeoutMs: 10_000,
    });
  }

  function markRemoving(harness: TestAppHarness, hostId: string): void {
    updateHost(harness.db, harness.hub, hostId, {
      machineProviderId: "retention-machine",
      phase: "removing",
      removeRetryAt: Date.now() - 1,
    });
  }

  async function seedDisposableFile(): Promise<{
    directory: string;
    file: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "retention-machine-"));
    const file = join(directory, "work.txt");
    await writeFile(file, "unsaved work");
    return { directory, file };
  }

  async function exists(file: string): Promise<boolean> {
    return stat(file).then(
      () => true,
      () => false,
    );
  }

  it("keeps a live thread's workspace for every provider, names the thread, and finishes once the owner is released", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableFile();
      try {
        const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
          async ({ path }) => {
            if (path !== null) await rm(path, { recursive: true });
            return { status: "removed" };
          },
        );
        installProvider({ remove });
        installMachine();
        const { environment, host, thread } = seedRetiring(harness, {
          archivedThread: false,
          providerOwnsPath: true,
          path: directory,
        });
        markRemoving(harness, host.id);

        await sweepProviderMachine(harness.deps, host.id);

        expect(remove).not.toHaveBeenCalled();
        expect(await exists(file)).toBe(true);
        expect(row(harness, environment.id)).toMatchObject({
          status: "ready",
          teardownStatus: null,
        });
        expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
          statusMessage: expect.stringContaining(thread.id),
        });

        archive(harness, thread.id);
        markRemoving(harness, host.id);
        await sweepProviderMachine(harness.deps, host.id);

        expect(remove).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(false);
        expect(row(harness, environment.id)).toMatchObject({
          status: "destroyed",
          teardownStatus: "removed",
        });
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "destroyed",
          statusMessage: null,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("keeps the workspace of an archived thread that is still running", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({ remove });
      installMachine();
      const { environment, host, thread } = seedRetiring(harness);
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, thread.id))
        .run();
      markRemoving(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);

      expect(remove).not.toHaveBeenCalled();
      expect(row(harness, environment.id).teardownStatus).toBeNull();
      expect(getHost(harness.db, host.id)).toMatchObject({
        teardownStatus: "failed",
        statusMessage: expect.stringContaining(thread.id),
      });
    }));

  function unarchiveRequest(harness: TestAppHarness, threadId: string) {
    return harness.app.request(`/api/v1/threads/${threadId}/unarchive`, {
      method: "POST",
    });
  }

  function hookRows(harness: TestAppHarness): number {
    return harness.db.select().from(environmentHookOperations).all().length;
  }

  function captureHooks(
    harness: TestAppHarness,
    seeded: ReturnType<typeof seedRetiring>,
  ) {
    const hooks = vi.fn(async () => {});
    registerTestHostRpcCapture(harness.deps, {
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      onEnvironmentHook: hooks,
    });
    return hooks;
  }

  async function expectUnarchiveBusy(
    harness: TestAppHarness,
    threadId: string,
    file: string,
  ): Promise<void> {
    const refused = await unarchiveRequest(harness, threadId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "workspace_busy" });
    expect(getThread(harness.db, threadId)?.archivedAt).not.toBeNull();
    expect(await exists(file)).toBe(true);
  }

  it("keeps an owned worktree a preflight retained, lets its owner unarchive it afterwards, and then holds the machine for that owner", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableFile();
      try {
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
          async () => ({ status: "removed" }),
        );
        const preflight = vi.fn<
          NonNullable<
            PluginEnvironmentProviderDeclaration["experimental_preflightRemove"]
          >
        >(async () => {
          entered.resolve();
          await release.promise;
          return { status: "retained", message: KEPT };
        });
        installProvider({ remove, experimental_preflightRemove: preflight });
        installMachine();
        const seeded = seedRetiring(harness, {
          providerOwnsPath: true,
          path: directory,
        });
        const { environment, host, thread } = seeded;
        const hooks = captureHooks(harness, seeded);
        markRemoving(harness, host.id);

        const sweeping = sweepProviderMachine(harness.deps, host.id);
        try {
          await entered.promise;
          await expectUnarchiveBusy(harness, thread.id, file);
        } finally {
          release.resolve();
          await sweeping;
        }

        expect(preflight).toHaveBeenCalledTimes(1);
        expect(hooks).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(hookRows(harness)).toBe(0);
        expect(row(harness, environment.id)).toMatchObject({
          status: "ready",
          teardownStatus: null,
          teardownMessage: KEPT,
        });
        const accepted = await unarchiveRequest(harness, thread.id);
        expect(accepted.status).toBe(200);
        expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();

        markRemoving(harness, host.id);
        retireNow(harness, environment.id);
        await sweepProviderMachine(harness.deps, host.id);

        expect(preflight).toHaveBeenCalledTimes(1);
        expect(remove).not.toHaveBeenCalled();
        expect(hooks).not.toHaveBeenCalled();
        expect(hookRows(harness)).toBe(0);
        expect(await exists(file)).toBe(true);
        expect(row(harness, environment.id)).toMatchObject({
          status: "ready",
          teardownStatus: null,
        });
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
          statusMessage: expect.stringContaining(thread.id),
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("fails closed when an owned worktree retains only after its teardown hook ran, and refuses to unarchive while the removal is pending", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableFile();
      try {
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        const observed = { hookRowsWhenRemoveStarted: -1 };
        const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
          async () => {
            observed.hookRowsWhenRemoveStarted = hookRows(harness);
            entered.resolve();
            await release.promise;
            return { status: "retained", message: KEPT };
          },
        );
        installProvider({ remove });
        installMachine();
        const seeded = seedRetiring(harness, {
          providerOwnsPath: true,
          path: directory,
        });
        const { environment, host, thread } = seeded;
        captureHooks(harness, seeded);
        markRemoving(harness, host.id);

        const sweeping = sweepProviderMachine(harness.deps, host.id);
        try {
          await entered.promise;
          expect(observed.hookRowsWhenRemoveStarted).toBe(1);
          await expectUnarchiveBusy(harness, thread.id, file);
        } finally {
          release.resolve();
          await sweeping;
        }

        expect(remove).toHaveBeenCalledTimes(1);
        expect(hookRows(harness)).toBe(1);
        expect(await exists(file)).toBe(true);
        expect(row(harness, environment.id)).toMatchObject({
          status: "error",
          teardownStatus: "failed",
        });
        expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("destroys an owned worktree only after a pending removal finishes for a still archived owner", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableFile();
      try {
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
          async () => {
            entered.resolve();
            await release.promise;
            await rm(directory, { recursive: true });
            return { status: "removed" };
          },
        );
        installProvider({ remove });
        installMachine();
        const seeded = seedRetiring(harness, {
          providerOwnsPath: true,
          path: directory,
        });
        const { environment, host, thread } = seeded;
        captureHooks(harness, seeded);
        markRemoving(harness, host.id);

        const sweeping = sweepProviderMachine(harness.deps, host.id);
        try {
          await entered.promise;
          await expectUnarchiveBusy(harness, thread.id, file);
        } finally {
          release.resolve();
          await sweeping;
        }

        expect(remove).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(false);
        expect(row(harness, environment.id)).toMatchObject({
          status: "destroyed",
          teardownStatus: "removed",
        });
        expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");
        expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("non-owned control: lets the owner unarchive a worktree whose removal retained after the pending window", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableFile();
      try {
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
          async () => {
            entered.resolve();
            await release.promise;
            return { status: "retained", message: KEPT };
          },
        );
        installProvider({ remove });
        installMachine();
        const { environment, host, thread } = seedRetiring(harness, {
          path: directory,
        });
        markRemoving(harness, host.id);

        const sweeping = sweepProviderMachine(harness.deps, host.id);
        try {
          await entered.promise;
          await expectUnarchiveBusy(harness, thread.id, file);
        } finally {
          release.resolve();
          await sweeping;
        }

        expect(row(harness, environment.id)).toMatchObject({
          status: "ready",
          teardownStatus: null,
        });
        const accepted = await unarchiveRequest(harness, thread.id);
        expect(accepted.status).toBe(200);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("refuses to unarchive between the teardown-running write and the claim of a persistent machine", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({ remove });
      installMachine();
      const { environment, host, thread } = seedRetiring(harness);
      markRemoving(harness, host.id);
      patch(harness, environment.id, {
        teardownStatus: "running",
        retireAt: Date.now(),
      });

      const refused = await unarchiveRequest(harness, thread.id);

      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "workspace_busy" });
      expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
      expect(remove).not.toHaveBeenCalled();
    }));

  it("revives a failed teardown whose owner is live when the sweep finds it, instead of leaving it failed", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({ remove });
      installMachine();
      const { environment, host, thread } = seedRetiring(harness, {
        archivedThread: false,
      });
      patch(harness, environment.id, {
        status: "error",
        teardownStatus: "failed",
        teardownPriorStatus: "ready",
        teardownAttempt: 1,
        teardownMessage: "Workspace cleanup temporarily failed",
        retireAt: Date.now() - 1,
      });
      markRemoving(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);

      expect(remove).not.toHaveBeenCalled();
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
      });
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "removing",
        statusMessage: expect.stringContaining(thread.id),
      });
    }));

  it("keeps an environment its starting owner is still preparing on a machine being removed, through the starting-owner arm of the request boundary", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({ remove });
      installMachine();
      const { environment, host, thread } = seedRetiring(harness, {
        archivedThread: false,
      });
      harness.db
        .update(threads)
        .set({ status: "starting", environmentId: null })
        .where(eq(threads.id, thread.id))
        .run();
      patch(harness, environment.id, {
        ownerThreadId: thread.id,
        status: "provisioning",
      });
      markRemoving(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);

      expect(remove).not.toHaveBeenCalled();
      expect(row(harness, environment.id)).toMatchObject({
        ownerThreadId: thread.id,
        teardownStatus: null,
      });
      expect(row(harness, environment.id).status).not.toBe("destroyed");
    }));

  it("reports a retained environment's own message on the machine", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "retained", message: KEPT }),
      });
      installMachine();
      const { environment, host } = seedRetiring(harness);
      markRemoving(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
      });
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "removing",
        teardownStatus: "failed",
        statusMessage: KEPT,
      });
    }));
});
