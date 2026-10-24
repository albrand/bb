import {
  environmentHookOperations,
  environments,
  getEnvironment,
  getThread,
  listEvents,
  threads,
} from "@bb/db";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type { PluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sweepProviderEnvironment,
  type ProviderOperationContext,
} from "../../src/services/environments/environment-engine.js";
import { toEnvironmentResponse } from "../../src/services/environments/environment-response.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { invokePluginInline } from "../../src/services/plugins/plugin-hook-registry.js";
import { prepareProviderEnvironment } from "../../src/services/threads/thread-environment-placement.js";
import { toThreadResponseFromThread } from "../../src/services/threads/thread-runtime-display.js";
import { requireReadyThreadEnvironment } from "../../src/services/threads/thread-turn-dispatch.js";
import { clearAllThreadProvisionSchedules } from "../../src/services/threads/thread-startup-store.js";
import { registerTestHostRpcCapture } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PLUGIN_ID = "recovery";
const PROVIDER_ID = "recovery-provider";
const PATH = "/tmp/recovery-worktree";
const PARTIAL = "rm: could not remove src/";

afterEach(() => {
  clearAllThreadProvisionSchedules();
  setPluginEnvironmentProviderBridge(undefined);
});

function installProvider(
  overrides: Partial<PluginEnvironmentProviderDeclaration> = {},
) {
  const record = {
    pluginId: PLUGIN_ID,
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Recovery",
      description: "Exercises failed teardown recovery.",
      icon: "Folder",
      policy: { retireGraceMs: 0, pathKeys: "per-attempt" },
      create: async () => ({ status: "created", path: PATH, ownsPath: true }),
      restore: async () => ({ status: "created", path: PATH, ownsPath: true }),
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

function seedLiveCandidate(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host_recovery",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/recovery-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: PATH,
    environmentProviderId: PROVIDER_ID,
    environmentProviderPluginId: PLUGIN_ID,
    environmentProviderInstanceKey: "recovery-key",
    providerOwnsPath: true,
    branchName: "bb/recovery",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "prov-recovery",
    threadId: thread.id,
  });
  registerTestHostRpcCapture(harness.deps, {
    hostId: host.id,
    sessionId: session.id,
    onEnvironmentHook: async () => {},
  });
  return { environment, host, project, thread };
}

function row(harness: TestAppHarness, environmentId: string) {
  const value = getEnvironment(harness.db, environmentId);
  if (value === null) throw new Error("Missing environment");
  return value;
}

function retireNow(harness: TestAppHarness, environmentId: string): void {
  harness.db
    .update(environments)
    .set({ retireAt: Date.now() - 1 })
    .where(eq(environments.id, environmentId))
    .run();
}

async function archive(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/archive-all`,
    { method: "POST" },
  );
  expect(response.status).toBe(200);
}

function unarchive(harness: TestAppHarness, threadId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/unarchive`, {
    method: "POST",
  });
}

function restore(harness: TestAppHarness, threadId: string) {
  return harness.app.request(
    `/api/v1/threads/${threadId}/restore-environment`,
    {
      method: "POST",
    },
  );
}

function insertHookRow(harness: TestAppHarness, environmentId: string): void {
  const environment = row(harness, environmentId);
  harness.db
    .insert(environmentHookOperations)
    .values({
      id: `environment:${environment.id}:${environment.environmentProviderInstanceKey}:teardown`,
      operationId: "hook-1",
      hostId: environment.hostId,
      path: PATH,
      kind: "teardown",
      startedAt: Date.now(),
    })
    .run();
}

async function failBeforeAnyDispatch(
  harness: TestAppHarness,
  environmentId: string,
  threadId: string,
): Promise<void> {
  await archive(harness, threadId);
  await vi.waitFor(() =>
    expect(row(harness, environmentId)).toMatchObject({
      status: "error",
      teardownStatus: "failed",
      teardownMessage: "host unavailable",
      teardownPriorStatus: "ready",
    }),
  );
}

describe("a thread unarchived onto a failed teardown that never started", () => {
  function installThrowingPreflight() {
    const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
      async () => ({ status: "removed" }),
    );
    installProvider({
      remove,
      experimental_preflightRemove: async () => {
        throw new Error("host unavailable");
      },
    });
    return remove;
  }

  it("revives the original status and keeps the thread usable", async () =>
    withTestHarness(async (harness) => {
      const remove = installThrowingPreflight();
      const { environment, thread } = seedLiveCandidate(harness);
      await failBeforeAnyDispatch(harness, environment.id, thread.id);

      const response = await unarchive(harness, thread.id);

      expect(response.status).toBe(200);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownPriorStatus: null,
        retireAt: null,
        teardownMessage: "host unavailable",
      });
      expect(() =>
        requireReadyThreadEnvironment(row(harness, environment.id)),
      ).not.toThrow();
      expect(remove).not.toHaveBeenCalled();
    }));

  it("revives from the sweep when the thread went live some other way", async () =>
    withTestHarness(async (harness) => {
      installThrowingPreflight();
      const { environment, thread } = seedLiveCandidate(harness);
      await failBeforeAnyDispatch(harness, environment.id, thread.id);
      harness.db
        .update(threads)
        .set({ archivedAt: null })
        .where(eq(threads.id, thread.id))
        .run();

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownPriorStatus: null,
      });
    }));

  it("does not revive when the teardown script's durable row exists", async () =>
    withTestHarness(async (harness) => {
      installThrowingPreflight();
      const { environment, thread } = seedLiveCandidate(harness);
      await failBeforeAnyDispatch(harness, environment.id, thread.id);
      insertHookRow(harness, environment.id);

      expect((await unarchive(harness, thread.id)).status).toBe(200);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
      });
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
    }));
});

describe("a thread unarchived onto a failed teardown that may have changed the workspace", () => {
  async function failAfterDispatch(
    harness: TestAppHarness,
    remove: PluginEnvironmentProviderDeclaration["remove"],
  ) {
    const record = installProvider({ remove });
    const fixture = seedLiveCandidate(harness);
    await archive(harness, fixture.thread.id);
    await vi.waitFor(() =>
      expect(row(harness, fixture.environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: PARTIAL,
        teardownPriorStatus: null,
      }),
    );
    expect(
      harness.db
        .select({ id: environmentHookOperations.id })
        .from(environmentHookOperations)
        .all(),
    ).toEqual([
      {
        id: `environment:${fixture.environment.id}:recovery-key:teardown`,
      },
    ]);
    return { ...fixture, record };
  }

  function placementContext(
    harness: TestAppHarness,
    fixture: Awaited<ReturnType<typeof failAfterDispatch>>,
  ): ProviderOperationContext {
    const thread = getThread(harness.db, fixture.thread.id)!;
    return {
      thread: toThreadResponseFromThread(harness.deps, { thread }),
      project: fixture.project,
      host: makeHost({ id: fixture.host.id, name: fixture.host.name }),
      machine: { type: "existing", hostId: fixture.host.id },
      projectCheckout: null,
      gitRemote: null,
      inputs: null,
      suggestedBranchName: "bb/recovery",
      environment: toEnvironmentResponse(
        harness.db,
        row(harness, fixture.environment.id),
      ),
    };
  }

  it("fails fast with an actionable message instead of waiting, and never reuses the workspace", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "failed", message: PARTIAL })
        .mockResolvedValue({ status: "removed" });
      const fixture = await failAfterDispatch(harness, remove);
      expect((await unarchive(harness, fixture.thread.id)).status).toBe(200);

      const decision = prepareProviderEnvironment(
        harness.deps,
        fixture.record,
        placementContext(harness, fixture),
      );

      expect(decision).toMatchObject({
        action: "reject",
        message: expect.stringContaining(PARTIAL),
      });
      expect(decision).toMatchObject({
        message: expect.stringContaining(PATH),
      });
      expect(decision).toMatchObject({
        message: expect.stringContaining("Archive this thread"),
      });
      expect(row(harness, fixture.environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
      });
      await sweepProviderEnvironment(harness.deps, fixture.environment.id);
      expect(remove).toHaveBeenCalledTimes(1);

      const refused = await restore(harness, fixture.thread.id);
      expect(refused.status).toBe(409);
      expect(await readJson(refused)).toMatchObject({
        code: "environment_not_ready",
        message: expect.stringContaining(PARTIAL),
        details: { environmentStatus: "error", hasPath: true },
      });
    }));

  it("fails the real re-provisioning of a live thread within one pass instead of waiting", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "failed", message: PARTIAL })
        .mockResolvedValue({ status: "removed" });
      const fixture = await failAfterDispatch(harness, remove);
      expect((await unarchive(harness, fixture.thread.id)).status).toBe(200);

      const sent = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "carry on" }],
          }),
        },
      );
      expect(sent.status, await sent.clone().text()).toBe(200);

      await vi.waitFor(() =>
        expect(getThread(harness.db, fixture.thread.id)?.status).toBe("error"),
      );
      const diagnostics = JSON.stringify(
        listEvents(harness.db, { threadId: fixture.thread.id }),
      );
      expect(diagnostics).toContain(PARTIAL);
      expect(diagnostics).toContain(PATH);
      expect(diagnostics).toContain("Archive this thread");
      expect(row(harness, fixture.environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: PARTIAL,
      });
      expect(remove).toHaveBeenCalledTimes(1);
      const refused = await restore(harness, fixture.thread.id);
      expect(refused.status).toBe(409);
      expect(await readJson(refused)).toMatchObject({
        code: "environment_not_ready",
      });
    }));

  it("lets archiving finish the removal, after which unarchive and restore are accepted", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "failed", message: PARTIAL })
        .mockResolvedValue({ status: "removed" });
      const fixture = await failAfterDispatch(harness, remove);
      expect((await unarchive(harness, fixture.thread.id)).status).toBe(200);
      await archive(harness, fixture.thread.id);
      retireNow(harness, fixture.environment.id);

      await sweepProviderEnvironment(harness.deps, fixture.environment.id);

      expect(remove).toHaveBeenCalledTimes(2);
      expect(row(harness, fixture.environment.id).status).toBe("destroyed");
      expect((await unarchive(harness, fixture.thread.id)).status).toBe(200);
      const restored = await restore(harness, fixture.thread.id);
      expect(restored.status, await restored.clone().text()).toBe(200);
    }));
});
