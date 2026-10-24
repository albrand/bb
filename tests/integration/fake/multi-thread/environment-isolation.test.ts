import { eq } from "drizzle-orm";
import { environmentReleaseConsents, environments } from "@bb/db";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveThread,
  deleteThread,
  getEnvironment,
  getThreadOutput,
  restoreThreadEnvironment,
  runEnvironmentAction,
  sendTextMessage,
  unarchiveThread,
} from "../../helpers/api.js";
import {
  waitForEnvironmentStatus,
  waitForPathRemoval,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import {
  createProjectFixture,
  createReadyHostThread,
  createReadyReuseThread,
} from "../../helpers/fixtures.js";
import { withHarness } from "../../helpers/harness.js";
import {
  createTestFile,
  createTestGitRepo,
  publishTestGitRepo,
  runGit,
} from "../../helpers/seed.js";
import { scaleTimeoutMs } from "../../helpers/time.js";
import {
  CONCURRENT_DELAY_TEXT,
  DEFAULT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

const REBUILD_TIMEOUT_MS = scaleTimeoutMs(30_000);
const REBUILD_TEST_TIMEOUT_MS = scaleTimeoutMs(120_000);

async function waitForTeardownRemoved(
  harness: {
    api: Parameters<typeof getEnvironment>[0];
    server: { sweepEnvironments(): Promise<void> };
  },
  environmentId: string,
): Promise<void> {
  const deadline = Date.now() + REBUILD_TIMEOUT_MS;
  let lifecycle = (await getEnvironment(harness.api, environmentId)).lifecycle;
  while (lifecycle.teardown?.status !== "removed") {
    if (Date.now() > deadline) {
      throw new Error(
        `Expected the teardown of environment ${environmentId} to be removed within ${REBUILD_TIMEOUT_MS} ms. phase=${lifecycle.phase} teardown=${JSON.stringify(lifecycle.teardown)} message=${JSON.stringify(lifecycle.message ?? null)}`,
      );
    }
    await harness.server.sweepEnvironments();
    lifecycle = (await getEnvironment(harness.api, environmentId)).lifecycle;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.sequential("fake provider environment-isolation multi-thread integration", () => {
  it(
    "refuses sends to a destroyed worktree until the thread restores it",
    () =>
      withHarness(
        { builtinPlugins: ["environment-git-worktree"] },
        async (harness) => {
          const teardownMarker = path.join(
            path.dirname(harness.repoDir),
            "teardown-ran-published.marker",
          );
          await createTestFile({
            filePath: path.join(harness.repoDir, ".bb-env-teardown.sh"),
            content: `#!/usr/bin/env bash\ntouch ${teardownMarker}\n`,
          });
          await runGit({ cwd: harness.repoDir, args: ["add", "."] });
          await runGit({
            cwd: harness.repoDir,
            args: ["commit", "-m", "Add teardown hook"],
          });
          await publishTestGitRepo({ repoDir: harness.repoDir });
          const project = await createProjectFixture(harness, {
            name: "Rebuild Managed Worktree",
          });
          const worktreeThread = await createReadyHostThread(harness, {
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            workspace: { type: "managed-worktree" },
          });
          const siblingThread = await createReadyReuseThread(harness, {
            environmentId: worktreeThread.environment.id,
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const unrelatedThread = await createReadyHostThread(harness, {
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            workspace: { type: "unmanaged", path: harness.repoDir },
          });
          const originalWorkspacePath = worktreeThread.environment.path;
          if (!originalWorkspacePath) {
            throw new Error("Managed worktree path was not assigned");
          }

          await archiveThread(harness.api, worktreeThread.thread.id);
          await deleteThread(harness.api, siblingThread.thread.id);
          await expect
            .poll(
              async () =>
                (
                  await getEnvironment(
                    harness.api,
                    worktreeThread.environment.id,
                  )
                ).lifecycle.phase,
              { timeout: DEFAULT_TIMEOUT_MS },
            )
            .toBe("retiring");
          await fs.access(originalWorkspacePath);
          await expect(fs.access(teardownMarker)).rejects.toThrow();
          harness.db
            .update(environments)
            .set({ retireAt: Date.now() - 1 })
            .where(eq(environments.id, worktreeThread.environment.id))
            .run();
          await waitForTeardownRemoved(harness, worktreeThread.environment.id);
          await waitForPathRemoval(originalWorkspacePath, DEFAULT_TIMEOUT_MS);
          await fs.access(teardownMarker);
          await deleteThread(harness.api, unrelatedThread.thread.id);
          await waitForEnvironmentStatus(
            harness.api,
            worktreeThread.environment.id,
            "destroyed",
            DEFAULT_TIMEOUT_MS,
          );

          await unarchiveThread(harness.api, worktreeThread.thread.id);
          const refused = await harness.api.threads[":id"].send.$post({
            param: { id: worktreeThread.thread.id },
            json: {
              input: [{ type: "text", text: "too early", mentions: [] }],
              mode: "auto",
            },
          });
          expect(refused.status).toBe(409);
          expect(await refused.json()).toMatchObject({
            code: "thread_environment_unavailable",
          });

          await restoreThreadEnvironment(harness.api, worktreeThread.thread.id);
          await waitForThreadStatus(
            harness.api,
            worktreeThread.thread.id,
            "idle",
            REBUILD_TIMEOUT_MS,
          );
          await sendTextMessage(harness.api, worktreeThread.thread.id, {
            text: "rebuild after archive",
          });
          const rebuiltThread = await waitForThreadStatus(
            harness.api,
            worktreeThread.thread.id,
            "idle",
            REBUILD_TIMEOUT_MS,
          );

          const rebuiltEnvironmentId = rebuiltThread.environmentId;
          expect(rebuiltEnvironmentId).toBeTruthy();
          expect(rebuiltEnvironmentId).not.toBe(worktreeThread.environment.id);
          if (!rebuiltEnvironmentId) {
            throw new Error("Rebuilt thread has no environment");
          }
          const rebuiltEnvironment = await getEnvironment(
            harness.api,
            rebuiltEnvironmentId,
          );
          expect(rebuiltEnvironment.status).toBe("ready");
          expect(rebuiltEnvironment.environmentProviderId).toBe("git-worktree");
          expect(rebuiltEnvironment.path).toBeTruthy();
          expect(rebuiltEnvironment.path).not.toBe(originalWorkspacePath);
          await fs.access(rebuiltEnvironment.path ?? "");
          expect(
            await getThreadOutput(harness.api, worktreeThread.thread.id),
          ).toContain("rebuild after archive");
        },
      ),
    REBUILD_TEST_TIMEOUT_MS,
  );

  it(
    "keeps an unpublished managed worktree and its commit when its environment retires, and lets the thread keep using it",
    () =>
      withHarness(
        { builtinPlugins: ["environment-git-worktree"] },
        async (harness) => {
          const teardownMarker = path.join(
            path.dirname(harness.repoDir),
            "teardown-ran.marker",
          );
          await createTestFile({
            filePath: path.join(harness.repoDir, ".bb-env-teardown.sh"),
            content: `#!/usr/bin/env bash\ntouch ${teardownMarker}\n`,
          });
          await runGit({ cwd: harness.repoDir, args: ["add", "."] });
          await runGit({
            cwd: harness.repoDir,
            args: ["commit", "-m", "Add teardown hook"],
          });
          const project = await createProjectFixture(harness, {
            name: "Keep Unpublished Worktree",
          });
          const worktreeThread = await createReadyHostThread(harness, {
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            workspace: { type: "managed-worktree" },
          });
          const worktreePath = worktreeThread.environment.path;
          if (!worktreePath) {
            throw new Error("Managed worktree path was not assigned");
          }
          await createTestFile({
            filePath: path.join(worktreePath, "recoverable.txt"),
            content: "work that exists nowhere else\n",
          });
          await runGit({ cwd: worktreePath, args: ["add", "."] });
          await runGit({
            cwd: worktreePath,
            args: ["commit", "-m", "Recoverable work"],
          });
          const recoverableHead = (
            await runGit({ cwd: worktreePath, args: ["rev-parse", "HEAD"] })
          ).trim();

          await archiveThread(harness.api, worktreeThread.thread.id);
          await expect
            .poll(
              async () =>
                (
                  await getEnvironment(
                    harness.api,
                    worktreeThread.environment.id,
                  )
                ).lifecycle.phase,
              { timeout: DEFAULT_TIMEOUT_MS },
            )
            .toBe("retiring");
          harness.db
            .update(environments)
            .set({ retireAt: Date.now() - 1 })
            .where(eq(environments.id, worktreeThread.environment.id))
            .run();
          await expect
            .poll(
              async () => {
                await harness.server.sweepEnvironments();
                return (
                  (
                    await getEnvironment(
                      harness.api,
                      worktreeThread.environment.id,
                    )
                  ).lifecycle.message ?? ""
                );
              },
              { timeout: REBUILD_TIMEOUT_MS },
            )
            .toContain("not reachable from any remote-tracking branch");

          const kept = await getEnvironment(
            harness.api,
            worktreeThread.environment.id,
          );
          expect(kept.status).toBe("ready");
          expect(kept.lifecycle.teardown).toBeNull();
          expect(kept.lifecycle.message).toContain(worktreePath);
          expect(kept.path).toBe(worktreePath);
          await fs.access(path.join(worktreePath, "recoverable.txt"));
          expect(
            (
              await runGit({ cwd: worktreePath, args: ["rev-parse", "HEAD"] })
            ).trim(),
          ).toBe(recoverableHead);
          await expect(fs.access(teardownMarker)).rejects.toThrow();

          await unarchiveThread(harness.api, worktreeThread.thread.id);
          await sendTextMessage(harness.api, worktreeThread.thread.id, {
            text: "still here after the kept retirement",
          });
          const resumed = await waitForThreadStatus(
            harness.api,
            worktreeThread.thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          );
          expect(resumed.environmentId).toBe(worktreeThread.environment.id);
          expect(
            await getThreadOutput(harness.api, worktreeThread.thread.id),
          ).toContain("still here after the kept retirement");
        },
      ),
    REBUILD_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a clean published worktree whose thread was archived without a recorded release, until an archive through bb records one",
    () =>
      withHarness(
        { builtinPlugins: ["environment-git-worktree"] },
        async (harness) => {
          await publishTestGitRepo({ repoDir: harness.repoDir });
          const project = await createProjectFixture(harness, {
            name: "Unreleased Worktree",
          });
          const worktreeThread = await createReadyHostThread(harness, {
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            workspace: { type: "managed-worktree" },
          });
          const worktreePath = worktreeThread.environment.path;
          if (!worktreePath) {
            throw new Error("Managed worktree path was not assigned");
          }
          await archiveThread(harness.api, worktreeThread.thread.id);
          harness.db
            .delete(environmentReleaseConsents)
            .where(
              eq(environmentReleaseConsents.threadId, worktreeThread.thread.id),
            )
            .run();
          harness.db
            .update(environments)
            .set({ retireAt: Date.now() - 1 })
            .where(eq(environments.id, worktreeThread.environment.id))
            .run();
          await expect
            .poll(
              async () => {
                await harness.server.sweepEnvironments();
                return (
                  (
                    await getEnvironment(
                      harness.api,
                      worktreeThread.environment.id,
                    )
                  ).lifecycle.message ?? ""
                );
              },
              { timeout: REBUILD_TIMEOUT_MS },
            )
            .toContain("no archive or delete through bb");
          await fs.access(worktreePath);

          await archiveThread(harness.api, worktreeThread.thread.id);
          harness.db
            .update(environments)
            .set({ retireAt: Date.now() - 1 })
            .where(eq(environments.id, worktreeThread.environment.id))
            .run();
          await waitForTeardownRemoved(harness, worktreeThread.environment.id);
          await waitForPathRemoval(worktreePath, DEFAULT_TIMEOUT_MS);
        },
      ),
    REBUILD_TEST_TIMEOUT_MS,
  );

  it("isolates concurrent work across separate environments", () =>
    withHarness(async (harness) => {
      const secondRepoDir = await createTestGitRepo({
        repoDir: path.join(path.dirname(harness.repoDir), "second-project"),
      });
      const projectA = await createProjectFixture(harness, {
        name: "Environment Isolation A",
      });
      const projectB = await createProjectFixture(harness, {
        name: "Environment Isolation B",
        path: secondRepoDir,
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: projectA.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyHostThread(harness, {
        projectId: projectB.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: secondRepoDir,
        },
      });

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} env-a`,
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} env-b`,
        }),
      ]);
      await Promise.all([
        waitForThreadStatus(
          harness.api,
          threadA.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
        waitForThreadStatus(
          harness.api,
          threadB.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
      ]);

      await createTestFile({
        content: "environment a only\n",
        filePath: path.join(harness.repoDir, "env-a-only.txt"),
      });
      await createTestFile({
        content: "environment b only\n",
        filePath: path.join(secondRepoDir, "env-b-only.txt"),
      });

      await Promise.all([
        runEnvironmentAction(harness.api, threadA.environment.id, {
          action: "commit",
        }),
        runEnvironmentAction(harness.api, threadB.environment.id, {
          action: "commit",
        }),
      ]);

      expect(
        (
          await runGit({
            args: ["log", "-1", "--format=%s"],
            cwd: harness.repoDir,
          })
        ).trim(),
      ).toBe("bb: automated commit");
      expect(
        (
          await runGit({
            args: ["log", "-1", "--format=%s"],
            cwd: secondRepoDir,
          })
        ).trim(),
      ).toBe("bb: automated commit");
    }));
});
