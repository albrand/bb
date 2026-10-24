import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveThread,
  createEnvironment,
  environments,
  getHost,
  getNonDestroyedHostByLaunchKey,
  threads,
  getThread,
  updateHost,
  SYSTEM_RELEASE_ACTOR,
} from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import { eq } from "drizzle-orm";
import type { PluginMachineProviderDeclaration } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askMachineLaunch,
  sweepProviderMachine,
} from "../../../src/services/machines/provider-orchestration.js";
import { setPluginMachineProviderBridge } from "../../../src/services/plugins/plugin-machine-provider-registry.js";
import { readJson } from "../../helpers/json.js";
import { installMachineProvider } from "../../helpers/machine-provider.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

afterEach(() => {
  vi.restoreAllMocks();
  setPluginMachineProviderBridge(undefined);
});

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function seedDisposableWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), "ephemeral-removal-"));
  const file = join(directory, "work.txt");
  await writeFile(file, "unsaved work");
  return { directory, file };
}

function seedEphemeralMachine(
  harness: TestAppHarness,
  args: { directory: string; archived: boolean },
) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = createEnvironment(harness.db, harness.hub, {
    projectId: project.id,
    hostId: host.id,
    path: args.directory,
    providerOwnsPath: false,
    status: "ready",
    environmentProvider: null,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  if (args.archived)
    archiveThread(harness.db, harness.hub, thread.id, SYSTEM_RELEASE_ACTOR);
  updateHost(harness.db, harness.hub, host.id, {
    type: "ephemeral",
    machineProviderId: "test-machine",
    phase: "active",
    resource: { allocation: "ephemeral" },
  });
  return { host, thread };
}

function unarchive(harness: TestAppHarness, threadId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/unarchive`, {
    method: "POST",
  });
}

describe("an ephemeral machine being removed", () => {
  it("refuses to unarchive an owner while the provider removal is in flight and destroys the machine for the archived owner", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        const remove = vi.fn<PluginMachineProviderDeclaration["remove"]>(
          async () => {
            entered.resolve();
            await release.promise;
            await rm(directory, { recursive: true });
            return { status: "removed" };
          },
        );
        installMachineProvider({ ephemeral: true, remove });
        const { host, thread } = seedEphemeralMachine(harness, {
          directory,
          archived: true,
        });

        const sweeping = sweepProviderMachine(harness.deps, host.id);
        try {
          await entered.promise;
          const response = await unarchive(harness, thread.id);

          expect(response.status).toBe(409);
          expect(await readJson(response)).toMatchObject({
            code: "machine_removing",
          });
          expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
        } finally {
          release.resolve();
          await sweeping;
        }

        expect(remove).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(false);
        expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");
        expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("keeps refusing to unarchive an owner after a failed removal left the machine waiting to retry", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const remove = vi.fn<PluginMachineProviderDeclaration["remove"]>(
          async () => {
            if (remove.mock.calls.length === 1)
              return { status: "failed", message: "provider unavailable" };
            await rm(directory, { recursive: true });
            return { status: "removed" };
          },
        );
        installMachineProvider({ ephemeral: true, remove });
        const { host, thread } = seedEphemeralMachine(harness, {
          directory,
          archived: true,
        });

        await sweepProviderMachine(harness.deps, host.id);
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
        });
        const response = await unarchive(harness, thread.id);

        expect(response.status).toBe(409);
        expect(await readJson(response)).toMatchObject({
          code: "machine_removing",
        });
        expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
        expect(await exists(file)).toBe(true);

        updateHost(harness.db, harness.hub, host.id, {
          removeRetryAt: Date.now() - 1,
        });
        await sweepProviderMachine(harness.deps, host.id);

        expect(remove).toHaveBeenCalledTimes(2);
        expect(await exists(file)).toBe(false);
        expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("does not destroy a machine an unarchived idle owner uses, even when the delete is explicit, until the owner is archived", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const remove = vi.fn<PluginMachineProviderDeclaration["remove"]>(
          async () => {
            await rm(directory, { recursive: true });
            return { status: "removed" };
          },
        );
        installMachineProvider({ ephemeral: true, remove });
        const { host, thread } = seedEphemeralMachine(harness, {
          directory,
          archived: false,
        });

        const response = await harness.app.request(`/api/v1/hosts/${host.id}`, {
          method: "DELETE",
        });

        expect(response.status).toBe(200);
        expect(remove).not.toHaveBeenCalled();
        expect(await exists(file)).toBe(true);
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
          statusMessage: expect.stringContaining(thread.id),
        });
        expect(getHost(harness.db, host.id)?.statusMessage).toContain(
          "archive",
        );

        archiveThread(harness.db, harness.hub, thread.id, SYSTEM_RELEASE_ACTOR);
        updateHost(harness.db, harness.hub, host.id, {
          removeRetryAt: Date.now() - 1,
        });
        await sweepProviderMachine(harness.deps, host.id);

        expect(remove).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(false);
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "destroyed",
          statusMessage: null,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));
});

type LauncherShape =
  | "bare"
  | "creating-environment"
  | "failed"
  | "active"
  | "stopping"
  | "ready-environment"
  | "pathful-environment";

async function seedCreateFailedMachine(
  harness: TestAppHarness,
  args: { directory: string; launcher: LauncherShape },
) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const launcherEnvironment =
    args.launcher === "bare" ||
    args.launcher === "active" ||
    args.launcher === "stopping"
      ? null
      : createEnvironment(harness.db, harness.hub, {
          projectId: project.id,
          hostId: host.id,
          path:
            args.launcher === "creating-environment" ||
            args.launcher === "failed"
              ? null
              : args.directory,
          providerOwnsPath: false,
          status:
            args.launcher === "ready-environment"
              ? "ready"
              : args.launcher === "pathful-environment" ||
                  args.launcher === "failed"
                ? "error"
                : "creating",
          environmentProvider: null,
        });
  const launcher = seedThread(harness.deps, {
    projectId: project.id,
    status:
      args.launcher === "active" || args.launcher === "stopping"
        ? args.launcher
        : args.launcher === "failed"
          ? "error"
          : "idle",
    environmentId:
      args.launcher === "ready-environment"
        ? (launcherEnvironment?.id ?? null)
        : null,
  });
  if (launcherEnvironment !== null && args.launcher !== "ready-environment") {
    harness.db
      .update(environments)
      .set({ ownerThreadId: launcher.id })
      .where(eq(environments.id, launcherEnvironment.id))
      .run();
  }
  updateHost(harness.db, harness.hub, host.id, {
    type: "ephemeral",
    machineProviderId: "test-machine",
    phase: "removing",
    resource: null,
    launchKey: launcher.id,
    teardownAttempt: 0,
    teardownStatus: "failed",
    statusMessage: "Cloud quota exceeded",
    removeRetryAt: Date.now() - 1,
  });
  return { host, project, launcher };
}

function seedSecondOwner(
  harness: TestAppHarness,
  args: { hostId: string; projectId: string; directory: string },
  shape: "ready" | "creating",
) {
  const environment = createEnvironment(harness.db, harness.hub, {
    projectId: args.projectId,
    hostId: args.hostId,
    path: shape === "ready" ? args.directory : null,
    providerOwnsPath: false,
    status: shape === "ready" ? "ready" : "creating",
    environmentProvider: null,
  });
  return seedThread(harness.deps, {
    projectId: args.projectId,
    environmentId: environment.id,
    status: "idle",
  });
}

function destroyingProvider(directory: string, failFirst: boolean) {
  let calls = 0;
  const destroy = vi.fn(async () => {
    calls += 1;
    if (failFirst && calls === 1)
      return { status: "failed" as const, message: "provider unavailable" };
    await rm(directory, { recursive: true, force: true });
    return { status: "removed" as const };
  });
  const record = installMachineProvider({
    ephemeral: true,
    remove: destroy,
    reconcileCleanup: destroy,
  });
  return Object.assign(destroy, { record });
}

function retryNow(harness: TestAppHarness, hostId: string): void {
  updateHost(harness.db, harness.hub, hostId, {
    removeRetryAt: Date.now() - 1,
  });
}

describe("an ephemeral machine whose creation failed", () => {
  it("never destroys a machine a second live owner with a ready environment uses, and names that owner", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const destroy = destroyingProvider(directory, false);
        const { host, project, launcher } = await seedCreateFailedMachine(
          harness,
          { directory, launcher: "bare" },
        );
        const second = seedSecondOwner(
          harness,
          { hostId: host.id, projectId: project.id, directory },
          "ready",
        );

        await sweepProviderMachine(harness.deps, host.id);

        expect(destroy).not.toHaveBeenCalled();
        expect(await exists(file)).toBe(true);
        const message = getHost(harness.db, host.id)?.statusMessage ?? "";
        expect(message).toContain(second.id);
        expect(message).not.toContain(launcher.id);
        expect(message).toContain("; machine creation failed:");
        expect(message).toContain("Cloud quota exceeded");
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
        });

        archiveThread(harness.db, harness.hub, second.id, SYSTEM_RELEASE_ACTOR);
        retryNow(harness, host.id);
        await sweepProviderMachine(harness.deps, host.id);

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(false);
        expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it.each(["ready", "creating"] as const)(
    "never exempts a second owner whose environment is %s",
    async (shape) =>
      withTestHarness(async (harness) => {
        const { directory, file } = await seedDisposableWorkspace();
        try {
          const destroy = destroyingProvider(directory, false);
          const { host, project } = await seedCreateFailedMachine(harness, {
            directory,
            launcher: "bare",
          });
          const second = seedSecondOwner(
            harness,
            { hostId: host.id, projectId: project.id, directory },
            shape,
          );

          await sweepProviderMachine(harness.deps, host.id);

          expect(destroy).not.toHaveBeenCalled();
          expect(await exists(file)).toBe(true);
          expect(getHost(harness.db, host.id)?.statusMessage).toContain(
            second.id,
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }),
  );

  it.each(["bare", "creating-environment", "failed"] as const)(
    "retries after a failed removal without the %s launcher blocking itself",
    async (launcherShape) =>
      withTestHarness(async (harness) => {
        const { directory, file } = await seedDisposableWorkspace();
        try {
          const destroy = destroyingProvider(directory, true);
          const { host, launcher } = await seedCreateFailedMachine(harness, {
            directory,
            launcher: launcherShape,
          });

          await sweepProviderMachine(harness.deps, host.id);

          expect(destroy).toHaveBeenCalledTimes(1);
          expect(await exists(file)).toBe(true);
          expect(getHost(harness.db, host.id)).toMatchObject({
            phase: "removing",
            teardownStatus: "failed",
            statusMessage: "provider unavailable",
          });
          expect(getHost(harness.db, host.id)?.statusMessage).not.toContain(
            launcher.id,
          );

          retryNow(harness, host.id);
          await sweepProviderMachine(harness.deps, host.id);

          expect(destroy).toHaveBeenCalledTimes(2);
          expect(await exists(file)).toBe(false);
          expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");

          const next = askMachineLaunch(harness.deps, {
            key: launcher.id,
            lifetime: "thread",
            record: destroy.record,
            inputs: null,
          });
          expect(next.action).not.toBe("reject");
          const relaunched = getNonDestroyedHostByLaunchKey(
            harness.db,
            launcher.id,
          );
          expect(relaunched).not.toBeNull();
          expect(relaunched?.id).not.toBe(host.id);
          await expect
            .poll(() => getHost(harness.db, relaunched?.id ?? "")?.phase)
            .toBe("active");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }),
  );

  it.each(["bare", "creating-environment", "failed"] as const)(
    "completes an explicit delete when only the safely exempt %s launcher exists",
    async (launcherShape) =>
      withTestHarness(async (harness) => {
        const { directory, file } = await seedDisposableWorkspace();
        try {
          const destroy = destroyingProvider(directory, false);
          const { host } = await seedCreateFailedMachine(harness, {
            directory,
            launcher: launcherShape,
          });

          const response = await harness.app.request(
            `/api/v1/hosts/${host.id}`,
            {
              method: "DELETE",
            },
          );

          expect(response.status).toBe(200);
          expect(destroy).toHaveBeenCalledTimes(1);
          expect(await exists(file)).toBe(false);
          expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }),
  );

  it.each([
    "active",
    "stopping",
    "ready-environment",
    "pathful-environment",
  ] as const)(
    "keeps the machine while the launching thread is %s",
    async (launcherShape) =>
      withTestHarness(async (harness) => {
        const { directory, file } = await seedDisposableWorkspace();
        try {
          const destroy = destroyingProvider(directory, false);
          const { host, launcher } = await seedCreateFailedMachine(harness, {
            directory,
            launcher: launcherShape,
          });

          await sweepProviderMachine(harness.deps, host.id);

          expect(destroy).not.toHaveBeenCalled();
          expect(await exists(file)).toBe(true);
          expect(getHost(harness.db, host.id)?.statusMessage).toContain(
            launcher.id,
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }),
  );
});

describe("an ephemeral machine an ordinary owner keeps using", () => {
  it("stays intact across repeated sweeps and is destroyed once the owner is archived", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const destroy = destroyingProvider(directory, false);
        const { host, thread } = seedEphemeralMachine(harness, {
          directory,
          archived: false,
        });

        const deleted = await harness.app.request(`/api/v1/hosts/${host.id}`, {
          method: "DELETE",
        });
        expect(deleted.status).toBe(200);
        const first = getHost(harness.db, host.id);
        retryNow(harness, host.id);
        await sweepProviderMachine(harness.deps, host.id);
        const second = getHost(harness.db, host.id);

        expect(destroy).not.toHaveBeenCalled();
        expect(await exists(file)).toBe(true);
        expect(first).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
          teardownAttempt: 1,
          statusMessage: expect.stringContaining(thread.id),
        });
        expect(second).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
          teardownAttempt: 2,
          statusMessage: first?.statusMessage ?? "",
        });

        archiveThread(harness.db, harness.hub, thread.id, SYSTEM_RELEASE_ACTOR);
        retryNow(harness, host.id);
        await sweepProviderMachine(harness.deps, host.id);

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(false);
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "destroyed",
          statusMessage: null,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("keeps the machine of an archived thread that is still active", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const destroy = destroyingProvider(directory, false);
        const { host, thread } = seedEphemeralMachine(harness, {
          directory,
          archived: true,
        });
        harness.db
          .update(threads)
          .set({ status: "active" })
          .where(eq(threads.id, thread.id))
          .run();
        updateHost(harness.db, harness.hub, host.id, {
          phase: "removing",
          removeRetryAt: Date.now() - 1,
        });

        await sweepProviderMachine(harness.deps, host.id);

        expect(destroy).not.toHaveBeenCalled();
        expect(await exists(file)).toBe(true);
        expect(getHost(harness.db, host.id)?.statusMessage).toContain(
          thread.id,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));
});
