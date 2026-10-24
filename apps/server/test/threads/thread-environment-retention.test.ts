import {
  deleteEnvironmentRetentionIntents,
  environmentRetentions,
  environments,
  getPreparingEnvironment,
  listEnvironmentRetentionTransitionsForEnvironment,
  listOpenEnvironmentRetentionsForHost,
  recordEnvironmentRetention,
} from "@bb/db";
import type { PluginEnvironmentProviderCreateResult } from "@get-bb/plugin-sdk/environment-provider";
import type {
  PluginEnvironmentProviderRestoreContext,
  PluginEnvironmentProviderRetentionProof,
  PluginEnvironmentProviderRetentionProofContext,
} from "@get-bb/plugin-sdk/environment-provider";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  reconcileEnvironmentRetentions,
  sweepProviderEnvironment,
} from "../../src/services/environments/environment-engine.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PROVIDER_ID = "test-retention-worktree";
const KEPT_PATH = "/tmp/kept-attempt";

function registerProvider(
  restore: (
    context: PluginEnvironmentProviderRestoreContext,
  ) => Promise<PluginEnvironmentProviderCreateResult>,
  prove?: (
    context: PluginEnvironmentProviderRetentionProofContext,
  ) => Promise<PluginEnvironmentProviderRetentionProof>,
) {
  const record = {
    pluginId: "test",
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Worktree",
      description: "Records what a failed create keeps.",
      icon: "Folder",
      policy: { retireGraceMs: 0, pathKeys: "per-attempt" },
      create: async () => {
        throw new Error("Unexpected create");
      },
      restore,
      ...(prove === undefined
        ? {}
        : { experimental_proveRetentionAbsent: prove }),
      remove: async () => ({ status: "removed" }),
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: async (_id, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
}

async function destroyedThread(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host_retention_rec" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/worktree",
    environmentProviderId: PROVIDER_ID,
    environmentProviderPluginId: "test",
    providerOwnsPath: true,
    branchName: "bb/important-work",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "prov-1",
    threadId: thread.id,
  });
  expect(
    (
      await harness.app.request(`/api/v1/threads/${thread.id}/archive-all`, {
        method: "POST",
      })
    ).status,
  ).toBe(200);
  await sweepProviderEnvironment(harness.deps, environment.id);
  expect(
    harness.db
      .select()
      .from(environments)
      .where(eq(environments.id, environment.id))
      .get()?.status,
  ).toBe("destroyed");
  await harness.app.request(`/api/v1/threads/${thread.id}/unarchive`, {
    method: "POST",
  });
  return { environment, host, thread };
}

async function restoreAndWait(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/restore-environment`,
    { method: "POST" },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await expect
    .poll(() => getPreparingEnvironment(harness.db, threadId)?.status)
    .toBe("error");
}

afterEach(() => {
  setPluginEnvironmentProviderBridge(undefined);
});

describe("a failed create records what it kept", () => {
  it("records a retained row for the path the provider reports, at the path it claimed", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(async (context) => {
        await context.experimental_claimPath(KEPT_PATH);
        return {
          status: "failed",
          message: "setup failed; the workspace stays in place",
          experimental_retained: { path: KEPT_PATH },
        };
      });
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);

      const rows = listOpenEnvironmentRetentionsForHost(harness.db, host.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "retained",
        keptPath: KEPT_PATH,
        originalPath: KEPT_PATH,
        providerId: PROVIDER_ID,
        ownerThreadId: thread.id,
      });
    });
  });

  it("leaves an unresolved row when the provider claimed a path and then threw", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(
        async (context) => {
          await context.experimental_claimPath(KEPT_PATH);
          throw new Error("connection lost");
        },
        async () => ({ absent: false, reason: "present" }),
      );
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);

      const rows = listOpenEnvironmentRetentionsForHost(harness.db, host.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "unresolved", keptPath: KEPT_PATH });
    });
  });

  it("leaves no row when a failed create says it kept nothing", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(async (context) => {
        await context.experimental_claimPath(KEPT_PATH);
        return {
          status: "failed",
          message: "git unavailable",
          experimental_retained: null,
        };
      });
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);

      expect(listOpenEnvironmentRetentionsForHost(harness.db, host.id)).toEqual(
        [],
      );
    });
  });

  it("treats a failed create that does not say what it kept as unresolved, even for a provider that never claims a path, when the provider can prove absence", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(
        async () => ({ status: "failed", message: "git unavailable" }),
        async () => ({ absent: false, reason: "present" }),
      );
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);

      const rows = listOpenEnvironmentRetentionsForHost(harness.db, host.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "unresolved", keptPath: null });
    });
  });

  it("keeps the base behavior for a provider that cannot prove absence: a failed create that says nothing, and a create that throws, leave no retention", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(async () => ({
        status: "failed",
        message: "git unavailable",
      }));
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);
      expect(listOpenEnvironmentRetentionsForHost(harness.db, host.id)).toEqual(
        [],
      );
    });
    await withTestHarness(async (harness) => {
      registerProvider(async () => {
        throw new Error("connection lost");
      });
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);
      expect(listOpenEnvironmentRetentionsForHost(harness.db, host.id)).toEqual(
        [],
      );
    });
  });

  it("never downgrades or deletes a retained row when the same environment is retried and fails without a kept path", async () => {
    await withTestHarness(async (harness) => {
      let calls = 0;
      registerProvider(async (context) => {
        calls += 1;
        await context.experimental_claimPath(KEPT_PATH);
        return calls === 1
          ? {
              status: "failed",
              message: "setup failed; the workspace stays in place",
              experimental_retained: { path: KEPT_PATH },
            }
          : {
              status: "failed",
              message: "target exists",
              experimental_retained: null,
            };
      });
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);
      const [first] = listOpenEnvironmentRetentionsForHost(harness.db, host.id);
      expect(first?.state).toBe("retained");
      if (first === undefined) return;

      recordEnvironmentRetention(harness.db, {
        environmentId: first.environmentId,
        projectId: first.projectId,
        hostId: first.hostId,
        ownerThreadId: first.ownerThreadId,
        providerId: first.providerId,
        originalPath: KEPT_PATH,
        keptPath: KEPT_PATH,
        state: "intent",
        message: "a retry claimed the same path",
      });
      deleteEnvironmentRetentionIntents(harness.db, first.environmentId);

      expect(
        listOpenEnvironmentRetentionsForHost(harness.db, host.id).map(
          (row) => [row.keptPath, row.state],
        ),
      ).toEqual([[KEPT_PATH, "retained"]]);
    });
  });

  it("refuses to start another create for a thread while an earlier attempt's kept work is open, and calls the provider only once", async () => {
    await withTestHarness(async (harness) => {
      let calls = 0;
      registerProvider(async () => {
        calls += 1;
        return { status: "failed", message: "never reached" };
      });
      const { host, thread, environment } = await destroyedThread(harness);
      recordEnvironmentRetention(harness.db, {
        environmentId: "env_earlier_attempt",
        projectId: environment.projectId,
        hostId: host.id,
        ownerThreadId: thread.id,
        providerId: PROVIDER_ID,
        originalPath: KEPT_PATH,
        keptPath: KEPT_PATH,
        state: "retained",
        message: "setup failed",
      });
      await restoreAndWait(harness, thread.id);

      expect(calls).toBe(0);
      expect(
        getPreparingEnvironment(harness.db, thread.id)?.statusMessage,
      ).toContain(KEPT_PATH);
    });
  });

  describe("closing a retention on host proof of absence", () => {
    const keptFailure = async (context: PluginEnvironmentProviderRestoreContext) => {
      await context.experimental_claimPath(KEPT_PATH);
      return {
        status: "failed" as const,
        message: "setup failed; the workspace stays in place",
        experimental_retained: { path: KEPT_PATH },
      };
    };

    it("closes the row, with the proof and time on it, when the provider proves the path absent, and it stops blocking", async () => {
      await withTestHarness(async (harness) => {
        const asked: PluginEnvironmentProviderRetentionProofContext[] = [];
        registerProvider(keptFailure, async (context) => {
          asked.push(context);
          return { absent: true, proof: "lstat ENOENT; no registered workspace" };
        });
        const { host, thread } = await destroyedThread(harness);
        await restoreAndWait(harness, thread.id);

        await reconcileEnvironmentRetentions(harness.deps);

        expect(asked.map((context) => context.path)).toEqual([KEPT_PATH]);
        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id),
        ).toEqual([]);
        const closed = harness.db.select().from(environmentRetentions).all();
        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatchObject({
          state: "closed",
          closedProof: expect.stringContaining("lstat ENOENT"),
        });
        expect(closed[0]?.closedProof).toContain(host.id);
        expect(closed[0]?.closedAt).toBeGreaterThan(0);
      });
    });

    it.each([
      [
        "the path is still present",
        async () => ({ absent: false as const, reason: "the path still exists" }),
      ],
      [
        "a workspace is still registered there",
        async () => ({
          absent: false as const,
          reason: "a workspace is still registered",
        }),
      ],
      [
        "the proof throws",
        async (): Promise<PluginEnvironmentProviderRetentionProof> => {
          throw new Error("host unreachable");
        },
      ],
    ])("keeps the row blocking when %s", async (_label, prove) => {
      await withTestHarness(async (harness) => {
        registerProvider(keptFailure, prove);
        const { host, thread } = await destroyedThread(harness);
        await restoreAndWait(harness, thread.id);

        await reconcileEnvironmentRetentions(harness.deps);

        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id).map(
            (row) => row.state,
          ),
        ).toEqual(["retained"]);
      });
    });

    it("does not apply a proof of absence to a row that was recorded again while the host was answering, and closes it on the next pass", async () => {
      await withTestHarness(async (harness) => {
        let answers = 0;
        registerProvider(keptFailure, async () => {
          answers += 1;
          if (answers === 1) {
            const [open] = harness.db
              .select()
              .from(environmentRetentions)
              .all();
            if (open === undefined) throw new Error("no retention row");
            recordEnvironmentRetention(harness.db, {
              environmentId: open.environmentId,
              projectId: open.projectId,
              hostId: open.hostId,
              ownerThreadId: open.ownerThreadId,
              providerId: open.providerId,
              originalPath: open.originalPath,
              keptPath: open.keptPath,
              state: "retained",
              message: open.message,
            });
          }
          return {
            absent: true,
            proof: "lstat ENOENT; no registered workspace",
          };
        });
        const { host, thread } = await destroyedThread(harness);
        await restoreAndWait(harness, thread.id);
        const [before] = harness.db.select().from(environmentRetentions).all();
        const transitionsBefore =
          listEnvironmentRetentionTransitionsForEnvironment(
            harness.db,
            before?.environmentId ?? "",
          ).length;

        await reconcileEnvironmentRetentions(harness.deps);

        expect(answers).toBe(1);
        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id).map(
            (row) => row.state,
          ),
        ).toEqual(["retained"]);
        expect(
          listEnvironmentRetentionTransitionsForEnvironment(
            harness.db,
            before?.environmentId ?? "",
          ),
        ).toHaveLength(transitionsBefore);

        await reconcileEnvironmentRetentions(harness.deps);

        expect(answers).toBe(2);
        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id),
        ).toEqual([]);
        expect(
          listEnvironmentRetentionTransitionsForEnvironment(
            harness.db,
            before?.environmentId ?? "",
          ),
        ).toHaveLength(transitionsBefore + 1);
      });
    });

    it("never closes a row whose provider cannot prove absence", async () => {
      await withTestHarness(async (harness) => {
        registerProvider(keptFailure);
        const { host, thread } = await destroyedThread(harness);
        await restoreAndWait(harness, thread.id);

        await reconcileEnvironmentRetentions(harness.deps);

        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id),
        ).toHaveLength(1);
      });
    });
  });

  describe("closing a retention with no recorded path", () => {
    const bare = async () => ({
      status: "failed" as const,
      message: "git unavailable",
    });

    it("closes it only when the provider proves the attempt's would-be path and branch absent, recording who checked, what and when", async () => {
      await withTestHarness(async (harness) => {
        const asked: PluginEnvironmentProviderRetentionProofContext[] = [];
        registerProvider(bare, async (context) => {
          asked.push(context);
          return { absent: true, proof: "no folder, nothing registered" };
        });
        const { host, thread } = await destroyedThread(harness);
        await restoreAndWait(harness, thread.id);

        await reconcileEnvironmentRetentions(harness.deps);

        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ path: null, hostId: host.id });
        expect(asked[0]?.pathKey).not.toBeNull();
        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id),
        ).toEqual([]);
        const [closed] = harness.db.select().from(environmentRetentions).all();
        expect(closed).toMatchObject({
          state: "closed",
          keptPath: null,
          closedProof: expect.stringContaining(`host ${host.id}`),
        });
        const history = listEnvironmentRetentionTransitionsForEnvironment(
          harness.db,
          closed!.environmentId,
        ).map((entry) => entry.toState);
        expect(history.at(-1)).toBe("closed");
      });
    });

    it.each([
      [
        "a directory is present",
        async (): Promise<PluginEnvironmentProviderRetentionProof> => ({
          absent: false,
          reason: "the folder exists",
        }),
      ],
      [
        "a worktree is registered",
        async (): Promise<PluginEnvironmentProviderRetentionProof> => ({
          absent: false,
          reason: "a workspace is registered",
        }),
      ],
      [
        "the host is unreachable",
        async (): Promise<PluginEnvironmentProviderRetentionProof> => {
          throw new Error("host unreachable");
        },
      ],
      [
        "the host times out",
        async (): Promise<PluginEnvironmentProviderRetentionProof> => {
          throw new DOMException("The operation timed out", "TimeoutError");
        },
      ],
    ])("keeps it open when %s", async (_label, prove) => {
      await withTestHarness(async (harness) => {
        registerProvider(bare, prove);
        const { host, thread } = await destroyedThread(harness);
        await restoreAndWait(harness, thread.id);

        await reconcileEnvironmentRetentions(harness.deps);

        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id).map(
            (row) => row.state,
          ),
        ).toEqual(["unresolved"]);
      });
    });

    it("does not close a row when a create for its environment starts while the proof is running", async () => {
      await withTestHarness(async (harness) => {
        registerProvider(bare, async () => ({ absent: true, proof: "gone" }));
        const { host, thread } = await destroyedThread(harness);
        await restoreAndWait(harness, thread.id);
        let running = false;

        await reconcileEnvironmentRetentions(harness.deps, {
          isOperationRunning: () => {
            const answer = running;
            running = true;
            return answer;
          },
        });

        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id).map(
            (row) => row.state,
          ),
        ).toEqual(["unresolved"]);
      });
    });

    it("does not close a row that was written again while the proof was running", async () => {
      await withTestHarness(async (harness) => {
        registerProvider(bare, async () => {
          const [row] = listOpenEnvironmentRetentionsForHost(
            harness.db,
            "host_retention_rec",
          );
          if (row === undefined) throw new Error("missing row");
          recordEnvironmentRetention(harness.db, {
            environmentId: row.environmentId,
            projectId: row.projectId,
            hostId: row.hostId,
            ownerThreadId: row.ownerThreadId,
            providerId: row.providerId,
            originalPath: null,
            keptPath: null,
            state: "unresolved",
            message: "another create finished",
          });
          return { absent: true, proof: "gone" };
        });
        const { host, thread } = await destroyedThread(harness);
        await restoreAndWait(harness, thread.id);

        await reconcileEnvironmentRetentions(harness.deps);

        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id),
        ).toHaveLength(1);
      });
    });

    it("asks with the environment id as the path key when the environment has no instance key, so the row can close", async () => {
      await withTestHarness(async (harness) => {
        const asked: PluginEnvironmentProviderRetentionProofContext[] = [];
        registerProvider(bare, async (context) => {
          asked.push(context);
          return { absent: true, proof: "gone" };
        });
        const { host, thread, environment } = await destroyedThread(harness);
        harness.db
          .update(environments)
          .set({ environmentProviderInstanceKey: null })
          .where(eq(environments.id, environment.id))
          .run();
        recordEnvironmentRetention(harness.db, {
          environmentId: environment.id,
          projectId: environment.projectId,
          hostId: host.id,
          ownerThreadId: thread.id,
          providerId: PROVIDER_ID,
          originalPath: null,
          keptPath: null,
          state: "unresolved",
          message: "no answer",
        });

        await reconcileEnvironmentRetentions(harness.deps);

        expect(asked.map((context) => context.pathKey)).toEqual([
          environment.id,
        ]);
        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id),
        ).toEqual([]);
      });
    });

    it("does not ask about an intent that is still fresh", async () => {
      await withTestHarness(async (harness) => {
        const asked: unknown[] = [];
        registerProvider(bare, async (context) => {
          asked.push(context);
          return { absent: true, proof: "gone" };
        });
        const { host, thread, environment } = await destroyedThread(harness);
        recordEnvironmentRetention(harness.db, {
          environmentId: environment.id,
          projectId: environment.projectId,
          hostId: host.id,
          ownerThreadId: thread.id,
          providerId: PROVIDER_ID,
          originalPath: null,
          keptPath: null,
          state: "intent",
          message: "a create is in flight",
        });

        await reconcileEnvironmentRetentions(harness.deps);

        expect(asked).toEqual([]);
        expect(
          listOpenEnvironmentRetentionsForHost(harness.db, host.id),
        ).toHaveLength(1);
      });
    });
  });

  it("merges the path-less dispatch intent into the row that has a path when the create throws after claiming one", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(
        async (context) => {
          await context.experimental_claimPath(KEPT_PATH);
          throw new Error("connection lost");
        },
        async () => ({ absent: false, reason: "present" }),
      );
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);

      expect(
        listOpenEnvironmentRetentionsForHost(harness.db, host.id).map(
          (row) => [row.keptPath, row.state],
        ),
      ).toEqual([[KEPT_PATH, "unresolved"]]);
    });
  });
});
