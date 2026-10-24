import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeHostEntry } from "./host.js";
import {
  beginCopy,
  fingerprintSource,
  recordCopy,
  type CreatedBy,
} from "./host/created-by.js";
import { copyWorktreeIncludeFiles } from "./host/worktree-include.js";
import { removeWorktree } from "./host/worktree.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bb",
      GIT_AUTHOR_EMAIL: "bb@example.com",
      GIT_COMMITTER_NAME: "bb",
      GIT_COMMITTER_EMAIL: "bb@example.com",
    },
  });
  return result.stdout;
}

async function createSourceRepository(repositoryName = "repo"): Promise<{
  root: string;
  sourcePath: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-plugin-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, repositoryName);
  const dataDir = join(root, "plugin-data");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main");
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");
  return { root, sourcePath, dataDir };
}

async function publishToBareRemote(
  root: string,
  sourcePath: string,
  remoteName = "origin",
): Promise<string> {
  const remotePath = join(root, `${remoteName}.git`);
  await git(root, "init", "--bare", "--initial-branch=main", remotePath);
  await git(sourcePath, "remote", "add", remoteName, remotePath);
  await git(sourcePath, "push", remoteName, "main");
  return remotePath;
}

async function createDetachedSingleBranchRepository(): Promise<{
  root: string;
  sourcePath: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-plugin-detached-"));
  temporaryRoots.push(root);
  const originPath = join(root, "origin");
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await mkdir(originPath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await git(originPath, "init", "--initial-branch=main");
  await writeFile(join(originPath, "README.md"), "hello\n");
  await git(originPath, "add", ".");
  await git(originPath, "commit", "-m", "initial");
  await git(originPath, "tag", "v1.0");
  await git(
    root,
    "clone",
    "--single-branch",
    "--branch",
    "v1.0",
    originPath,
    sourcePath,
  );
  return { root, sourcePath, dataDir };
}

function createHarness(dataDir: string) {
  return experimental_createHostEntryHarness(createWorktreeHostEntry(), {
    experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
  });
}

function createInput(args: {
  operationId: string;
  sourcePath: string;
  pathKey: string;
  branchName: string;
}) {
  return {
    ...args,
    baseBranch: { kind: "default" as const },
    branchMode: "reset" as const,
  };
}

function progressText(harness: ReturnType<typeof createHarness>): string {
  return harness
    .experimental_getSignals()
    .map((event) => event.payload.text)
    .join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("worktree host entry", () => {
  it.each([
    { existingBranch: false, branchMode: "reset" },
    { existingBranch: false, branchMode: "reuse-existing" },
    { existingBranch: true, branchMode: "reuse-existing" },
  ] as const)(
    "creates with a locked config (existing=$existingBranch, mode=$branchMode)",
    async ({ existingBranch, branchMode }) => {
      const { sourcePath, dataDir } = await createSourceRepository();
      await git(sourcePath, "remote", "add", "origin", sourcePath);
      await git(sourcePath, "fetch", "origin");
      await git(sourcePath, "config", "branch.autoSetupMerge", "always");
      await git(sourcePath, "config", "core.autocrlf", "true");
      const branchName = "bb/config-lock";
      if (existingBranch) {
        await git(
          sourcePath,
          "update-ref",
          "refs/remotes/origin/published",
          "HEAD",
        );
        await git(
          sourcePath,
          "branch",
          "--track",
          branchName,
          "origin/published",
        );
      }
      const configPath = join(sourcePath, ".git", "config");
      const originalConfig = await readFile(configPath, "utf8");
      const lockPath = `${configPath}.lock`;
      await writeFile(lockPath, "another Git writer\n");
      const harness = createHarness(dataDir);
      try {
        const result = await harness.experimental_call("create", {
          ...createInput({
            operationId: "config-lock",
            sourcePath,
            pathKey: "config-lock",
            branchName,
          }),
          branchMode,
          baseBranch: { kind: "named", name: "origin/main" },
        });
        expect(result.status).toBe("created");
        if (result.status !== "created") throw new Error(result.message);
        expect(
          (await readFile(join(result.path, "README.md"), "utf8")).replace(
            /\r\n/gu,
            "\n",
          ),
        ).toBe("hello\n");
        expect(await git(result.path, "rev-parse", "HEAD")).toBe(
          await git(sourcePath, "rev-parse", "origin/main"),
        );
        expect(
          (
            await git(
              result.path,
              "for-each-ref",
              "--format=%(upstream:short)",
              `refs/heads/${branchName}`,
            )
          ).trim(),
        ).toBe(existingBranch ? "origin/published" : "");
        expect(await readFile(lockPath, "utf8")).toBe("another Git writer\n");
        expect(await readFile(configPath, "utf8")).toBe(originalConfig);
      } finally {
        await harness.experimental_dispose();
      }
    },
  );

  it("refuses to reset an existing branch and leaves its commits alone", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const branchName = "bb/earlier-attempt";
    await git(sourcePath, "branch", branchName);
    await git(sourcePath, "checkout", branchName);
    const sha = await commitFile(sourcePath, "earlier.txt");
    await git(sourcePath, "checkout", "-");
    const harness = createHarness(dataDir);
    try {
      const result = await harness.experimental_call(
        "create",
        createInput({
          operationId: "reset-refused",
          sourcePath,
          pathKey: "reset-refused",
          branchName,
        }),
      );

      expect(result).toMatchObject({
        status: "failed",
        message: expect.stringContaining("already exists"),
      });
      expect(
        (await git(sourcePath, "rev-parse", `refs/heads/${branchName}`)).trim(),
      ).toBe(sha);
      expect(existsSync(join(dataDir, "worktrees", "reset-refused"))).toBe(
        false,
      );
    } finally {
      await harness.experimental_dispose();
    }
  });

  it("continues a retry from the earlier attempt's exact tip and leaves that workspace alone", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    try {
      const first = await harness.experimental_call(
        "create",
        createInput({
          operationId: "first",
          sourcePath,
          pathKey: "thr_ret-1",
          branchName: "bb/work-thr_ret",
        }),
      );
      if (first.status !== "created") throw new Error(first.message);
      const tip = await commitFile(first.path, "earlier.txt");
      await writeFile(join(first.path, "scratch.txt"), "uncommitted\n");

      const second = await harness.experimental_call("create", {
        ...createInput({
          operationId: "second",
          sourcePath,
          pathKey: "thr_ret-2",
          branchName: "bb/work-thr_ret.r2",
        }),
        previousAttempt: { threadId: "thr_ret", attempt: 2 },
      });

      expect(second.status).toBe("created");
      if (second.status !== "created") throw new Error(second.message);
      expect((await git(second.path, "rev-parse", "HEAD")).trim()).toBe(tip);
      expect(
        (await git(second.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
      ).toBe("bb/work-thr_ret.r2");
      expect(existsSync(join(second.path, "scratch.txt"))).toBe(false);
      expect(await readFile(join(first.path, "scratch.txt"), "utf8")).toBe(
        "uncommitted\n",
      );
      expect((await git(first.path, "rev-parse", "HEAD")).trim()).toBe(tip);
      expect(progressText(harness)).toContain("Continuing on bb/work-thr_ret.r2");
      expect(progressText(harness)).not.toContain("uncommitted\n");
    } finally {
      await harness.experimental_dispose();
    }
  });

  it.each([
    ["two branches could belong to the earlier attempt", ["bb/a-thr_amb", "bb/b-thr_amb"]],
  ] as const)("refuses a retry and creates nothing when %s", async (_label, branches) => {
    const { sourcePath, dataDir } = await createSourceRepository();
    for (const branch of branches) await git(sourcePath, "branch", branch);
    const harness = createHarness(dataDir);
    try {
      const result = await harness.experimental_call("create", {
        ...createInput({
          operationId: "retry",
          sourcePath,
          pathKey: "thr_amb-2",
          branchName: "bb/work-thr_amb.r2",
        }),
        previousAttempt: { threadId: "thr_amb", attempt: 2 },
      });

      expect(result).toMatchObject({
        status: "failed",
        message: expect.stringMatching(/Cannot continue from (the|an) earlier attempt/),
      });
      expect(
        (await git(sourcePath, "branch", "--list", "bb/work-thr_amb.r2")).trim(),
      ).toBe("");
      expect(existsSync(join(dataDir, "worktrees", "thr_amb-2"))).toBe(false);
    } finally {
      await harness.experimental_dispose();
    }
  });

  it("walks back to the latest earlier attempt branch that exists and does not mistake a slug ending in r2 for an attempt branch", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    try {
      const first = await harness.experimental_call(
        "create",
        createInput({
          operationId: "first",
          sourcePath,
          pathKey: "thr_wb-1",
          branchName: "bb/fix-r2-thr_wb",
        }),
      );
      if (first.status !== "created") throw new Error(first.message);
      const tip = await commitFile(first.path, "work.txt");

      const third = await harness.experimental_call("create", {
        ...createInput({
          operationId: "third",
          sourcePath,
          pathKey: "thr_wb-3",
          branchName: "bb/fix-r2-thr_wb.r3",
        }),
        previousAttempt: { threadId: "thr_wb", attempt: 3 },
      });

      expect(third.status).toBe("created");
      if (third.status !== "created") throw new Error(third.message);
      expect((await git(third.path, "rev-parse", "HEAD")).trim()).toBe(tip);
      expect(progressText(harness)).toContain(
        "from bb/fix-r2-thr_wb at",
      );
    } finally {
      await harness.experimental_dispose();
    }
  });

  it("refuses a retry when the earlier workspace is detached from its branch, naming it and leaving it alone", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    try {
      const first = await harness.experimental_call(
        "create",
        createInput({
          operationId: "first",
          sourcePath,
          pathKey: "thr_dt-1",
          branchName: "bb/work-thr_dt",
        }),
      );
      if (first.status !== "created") throw new Error(first.message);
      await commitFile(first.path, "work.txt");
      await git(first.path, "checkout", "--detach");
      const detachedWork = await commitFile(first.path, "later.txt");

      const second = await harness.experimental_call("create", {
        ...createInput({
          operationId: "second",
          sourcePath,
          pathKey: "thr_dt-2",
          branchName: "bb/work-thr_dt.r2",
        }),
        previousAttempt: { threadId: "thr_dt", attempt: 2 },
      });

      expect(second).toMatchObject({
        status: "failed",
        message: expect.stringContaining("detached"),
        kept: { kind: "kept", path: first.path },
      });
      expect(
        (await git(sourcePath, "branch", "--list", "bb/work-thr_dt.r2")).trim(),
      ).toBe("");
      expect((await git(first.path, "rev-parse", "HEAD")).trim()).toBe(
        detachedWork,
      );
    } finally {
      await harness.experimental_dispose();
    }
  });

  it("starts a retry from the base branch and says nothing could be lost when no earlier attempt left a branch or a workspace folder", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    try {
      const result = await harness.experimental_call("create", {
        ...createInput({
          operationId: "fresh-retry",
          sourcePath,
          pathKey: "thr_none-2",
          branchName: "bb/work-thr_none.r2",
        }),
        previousAttempt: { threadId: "thr_none", attempt: 2 },
      });

      expect(result.status).toBe("created");
      expect(progressText(harness)).toContain("nothing from an earlier attempt could be lost");
    } finally {
      await harness.experimental_dispose();
    }
  });

  it.each([
    [
      "a workspace folder without a branch",
      async (_sourcePath: string, dataDir: string) => {
        await mkdir(join(dataDir, "worktrees", "thr_left-1", "repo"), {
          recursive: true,
        });
        return "the workspace at";
      },
    ],
  ] as const)("refuses a branchless retry and names the blocker when %s remains", async (_label, leave) => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const blocker = await leave(sourcePath, dataDir);
    const harness = createHarness(dataDir);
    try {
      const result = await harness.experimental_call("create", {
        ...createInput({
          operationId: "blocked-retry",
          sourcePath,
          pathKey: "thr_left-2",
          branchName: "bb/work-thr_left.r2",
        }),
        previousAttempt: { threadId: "thr_left", attempt: 2 },
      });

      expect(result).toMatchObject({
        status: "failed",
        message: expect.stringContaining(blocker),
      });
      expect(
        (await git(sourcePath, "branch", "--list", "bb/work-thr_left.r2")).trim(),
      ).toBe("");
    } finally {
      await harness.experimental_dispose();
    }
  });

  describe("retention proof of absence", () => {
    it("proves a kept path absent only when it is gone, unregistered and no workspace holds a branch of the thread", async () => {
      const { sourcePath, dataDir } = await createSourceRepository();
      const harness = createHarness(dataDir);
      try {
        const gone = join(dataDir, "worktrees", "never-existed", "repo");
        const proof = await harness.experimental_call("proveRetentionAbsent", {
          path: gone,
          pathKey: null,
          branchName: null,
          sourcePath,
          threadId: "thr_proof",
        });
        expect(proof).toMatchObject({
          absent: true,
          proof: expect.stringContaining("lstat ENOENT"),
        });
      } finally {
        await harness.experimental_dispose();
      }
    });

    it("does not close while the path is still on disk", async () => {
      const { sourcePath, dataDir } = await createSourceRepository();
      const kept = join(dataDir, "worktrees", "kept", "repo");
      await mkdir(kept, { recursive: true });
      const harness = createHarness(dataDir);
      try {
        expect(
          await harness.experimental_call("proveRetentionAbsent", {
            path: kept,
            pathKey: null,
            branchName: null,
            sourcePath,
            threadId: null,
          }),
        ).toMatchObject({ absent: false, reason: expect.stringContaining("still exists") });
      } finally {
        await harness.experimental_dispose();
      }
    });

    it("does not close while a workspace is still registered at the path, even with its folder deleted", async () => {
      const { sourcePath, dataDir } = await createSourceRepository();
      const harness = createHarness(dataDir);
      try {
        const created = await harness.experimental_call(
          "create",
          createInput({
            operationId: "registered",
            sourcePath,
            pathKey: "registered",
            branchName: "bb/work-thr_reg",
          }),
        );
        if (created.status !== "created") throw new Error(created.message);
        await rm(created.path, { recursive: true, force: true });

        expect(
          await harness.experimental_call("proveRetentionAbsent", {
            path: created.path,
            pathKey: null,
            branchName: null,
            sourcePath,
            threadId: null,
          }),
        ).toMatchObject({
          absent: false,
          reason: expect.stringContaining("still registered"),
        });
      } finally {
        await harness.experimental_dispose();
      }
    });

    it("does not close while another workspace holds a branch of the thread", async () => {
      const { sourcePath, dataDir } = await createSourceRepository();
      const harness = createHarness(dataDir);
      try {
        const created = await harness.experimental_call(
          "create",
          createInput({
            operationId: "holder",
            sourcePath,
            pathKey: "holder",
            branchName: "bb/work-thr_hold",
          }),
        );
        if (created.status !== "created") throw new Error(created.message);

        expect(
          await harness.experimental_call("proveRetentionAbsent", {
            path: join(dataDir, "worktrees", "somewhere-else", "repo"),
            pathKey: null,
            branchName: null,
            sourcePath,
            threadId: "thr_hold",
          }),
        ).toMatchObject({
          absent: false,
          reason: expect.stringContaining("still holds branch"),
        });
      } finally {
        await harness.experimental_dispose();
      }
    });

    describe("for an attempt that never reported a path", () => {
      const pathless = (
        sourcePath: string | null,
        extra: { pathKey?: string | null; branchName?: string | null; threadId?: string | null } = {},
      ) => ({
        path: null,
        pathKey: extra.pathKey === undefined ? "thr_pl-2" : extra.pathKey,
        branchName: extra.branchName ?? null,
        sourcePath,
        threadId: extra.threadId ?? null,
      });

      it("proves absent when no workspace folder for the path key exists, nothing is registered under it, and no workspace holds the branch", async () => {
        const { sourcePath, dataDir } = await createSourceRepository();
        const harness = createHarness(dataDir);
        try {
          expect(
            await harness.experimental_call(
              "proveRetentionAbsent",
              pathless(sourcePath, { branchName: "bb/work-thr_pl.r2", threadId: "thr_pl" }),
            ),
          ).toMatchObject({ absent: true, proof: expect.stringContaining("lstat ENOENT") });
        } finally {
          await harness.experimental_dispose();
        }
      });

      it("does not close while a directory exists at the would-be path", async () => {
        const { sourcePath, dataDir } = await createSourceRepository();
        await mkdir(join(dataDir, "worktrees", "thr_pl-2", "repo"), { recursive: true });
        const harness = createHarness(dataDir);
        try {
          expect(
            await harness.experimental_call("proveRetentionAbsent", pathless(sourcePath)),
          ).toMatchObject({ absent: false, reason: expect.stringContaining("still exists") });
        } finally {
          await harness.experimental_dispose();
        }
      });

      it("does not close while a workspace is registered under the path key or holds the branch", async () => {
        const { sourcePath, dataDir } = await createSourceRepository();
        const harness = createHarness(dataDir);
        try {
          const created = await harness.experimental_call(
            "create",
            createInput({
              operationId: "pl",
              sourcePath,
              pathKey: "thr_pl-2",
              branchName: "bb/work-thr_pl.r2",
            }),
          );
          if (created.status !== "created") throw new Error(created.message);
          await rm(join(dataDir, "worktrees", "thr_pl-2"), { recursive: true, force: true });

          expect(
            await harness.experimental_call("proveRetentionAbsent", pathless(sourcePath)),
          ).toMatchObject({ absent: false, reason: expect.stringContaining("still registered") });
          expect(
            await harness.experimental_call(
              "proveRetentionAbsent",
              pathless(sourcePath, { pathKey: "thr_other-9", branchName: "bb/work-thr_pl.r2" }),
            ),
          ).toMatchObject({ absent: false, reason: expect.stringContaining("still holds branch") });
        } finally {
          await harness.experimental_dispose();
        }
      });

      it("does not close when neither a path nor a path key is known", async () => {
        const { sourcePath, dataDir } = await createSourceRepository();
        const harness = createHarness(dataDir);
        try {
          expect(
            await harness.experimental_call(
              "proveRetentionAbsent",
              pathless(sourcePath, { pathKey: null }),
            ),
          ).toMatchObject({ absent: false });
        } finally {
          await harness.experimental_dispose();
        }
      });
    });

    it("does not close when the repository's workspaces cannot be listed", async () => {
      const { dataDir } = await createSourceRepository();
      const harness = createHarness(dataDir);
      try {
        expect(
          await harness.experimental_call("proveRetentionAbsent", {
            path: join(dataDir, "worktrees", "x", "repo"),
            pathKey: null,
            branchName: null,
            sourcePath: join(dataDir, "not-a-repo"),
            threadId: null,
          }),
        ).toMatchObject({ absent: false });
      } finally {
        await harness.experimental_dispose();
      }
    });
  });

  it("refuses to replace a target path that already exists", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const target = join(dataDir, "worktrees", "occupied", basename(sourcePath));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "mine.txt"), "keep me\n");
    const harness = createHarness(dataDir);
    try {
      const result = await harness.experimental_call(
        "create",
        createInput({
          operationId: "occupied",
          sourcePath,
          pathKey: "occupied",
          branchName: "bb/occupied",
        }),
      );

      expect(result).toMatchObject({
        status: "failed",
        message: expect.stringContaining("left alone"),
        kept: { kind: "kept", path: target },
      });
      expect(await readFile(join(target, "mine.txt"), "utf8")).toBe(
        "keep me\n",
      );
    } finally {
      await harness.experimental_dispose();
    }
  });

  it("resolves adoption paths with trailing slashes and symlink aliases", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const worktreePath = join(root, "feature");
    await git(sourcePath, "worktree", "add", "-b", "feature", worktreePath);
    const canonicalPath = await realpath(worktreePath);
    const aliasPath = join(root, "feature-alias");
    await symlink(worktreePath, aliasPath, "junction");
    const harness = createHarness(dataDir);

    for (const path of [canonicalPath, `${canonicalPath}/`, aliasPath]) {
      expect(
        await harness.experimental_call("resolveExistingWorktree", {
          sourcePath,
          path,
        }),
      ).toEqual({ status: "resolved", path: canonicalPath, branch: "feature" });
    }
  });

  it("refuses adoption aliases of the main checkout and managed worktrees", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const worktreePath = join(dataDir, "worktrees", "managed");
    await git(sourcePath, "worktree", "add", "-b", "managed", worktreePath);
    const dataAlias = join(root, "data-alias");
    await symlink(dataDir, dataAlias, "junction");
    const harness = createHarness(dataAlias);

    expect(
      await harness.experimental_call("listWorktrees", { sourcePath }),
    ).toEqual({ worktrees: [] });
    for (const [index, target] of [sourcePath, worktreePath].entries()) {
      const aliasPath = join(root, `alias-${index}`);
      await symlink(target, aliasPath, "junction");
      expect(
        await harness.experimental_call("resolveExistingWorktree", {
          sourcePath,
          path: aliasPath,
        }),
      ).toMatchObject({ status: "failed" });
    }
  });

  it("preserves adoption failures for missing and prunable worktrees", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const worktreePath = join(root, "feature");
    await git(sourcePath, "worktree", "add", "-b", "feature", worktreePath);
    const canonicalPath = await realpath(worktreePath);
    await rm(worktreePath, { recursive: true });
    const harness = createHarness(dataDir);

    expect(
      await harness.experimental_call("resolveExistingWorktree", {
        sourcePath,
        path: `${canonicalPath}/`,
      }),
    ).toMatchObject({
      status: "failed",
      message: expect.stringContaining("prunable worktree"),
    });
    expect(
      await harness.experimental_call("resolveExistingWorktree", {
        sourcePath,
        path: join(root, "missing"),
      }),
    ).toMatchObject({
      status: "failed",
      message: expect.stringContaining("not a worktree"),
    });
  });

  it("resolves the default label from the same refs used for creation", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    expect(
      await harness.experimental_call("defaultBaseBranch", { sourcePath }),
    ).toEqual({ branch: "main" });
    await git(sourcePath, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(
      sourcePath,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    expect(
      await harness.experimental_call("defaultBaseBranch", { sourcePath }),
    ).toEqual({ branch: "origin/main" });
    await writeFile(join(sourcePath, "README.md"), "ahead");
    await git(sourcePath, "commit", "-am", "local ahead");
    expect(
      await harness.experimental_call("defaultBaseBranch", { sourcePath }),
    ).toEqual({ branch: "main" });
  });

  it.each([
    ["spaces", "Repo With Space", "Repo-With-Space-7373994537587106"],
    ["CJK", "資料庫", "repo-1b2c8c90d27707c4"],
    ["NFC", "café", "cafe-850f7dc43910ff89"],
    ["NFD", "cafe\u0301", "cafe-81ef060bcd98adc7"],
    ["punctuation only", "!!!", "repo-e84c538e7fe25073"],
  ])(
    "creates and discovers cleanup paths for repository names with %s",
    async (_label, repositoryName, expectedLeaf) => {
      const { root, sourcePath, dataDir } =
        await createSourceRepository(repositoryName);
      await publishToBareRemote(root, sourcePath);
      const harness = createHarness(dataDir);
      const pathKey = "special-name";
      const result = await harness.experimental_call(
        "create",
        createInput({
          operationId: "create-special",
          sourcePath,
          pathKey,
          branchName: "bb/special-name",
        }),
      );
      expect(result).toMatchObject({
        status: "created",
        path: join(dataDir, "worktrees", pathKey, expectedLeaf),
      });
      if (result.status !== "created") throw new Error(result.message);
      expect(existsSync(join(result.path, "README.md"))).toBe(true);
      expect(
        await harness.experimental_call("remove", {
          operationId: "remove-special",
          pathKey,
          path: null,
        }),
      ).toEqual({ status: "removed" });
      expect(existsSync(join(dataDir, "worktrees", pathKey))).toBe(false);
      await harness.experimental_dispose();
    },
  );

  it("creates a bounded worktree path for a long repository name", async ({
    skip,
  }) => {
    skip(
      process.platform === "win32",
      "Windows cannot start a process whose working directory is longer than MAX_PATH",
    );
    const repositoryName = "repository".repeat(24);
    const { sourcePath, dataDir } =
      await createSourceRepository(repositoryName);
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call(
      "create",
      createInput({
        operationId: "long-name",
        sourcePath,
        pathKey: "long-name",
        branchName: "bb/long-name",
      }),
    );
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error(result.message);
    expect(Buffer.byteLength(basename(result.path), "utf8")).toBe(200);
    expect(basename(result.path)).toMatch(/-[a-f0-9]{16}$/u);
    expect(existsSync(join(result.path, "README.md"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("provisions the same specially named repository concurrently", async () => {
    const { sourcePath, dataDir } =
      await createSourceRepository("Concurrent Repo");
    const harness = createHarness(dataDir);
    const [first, second] = await Promise.all([
      harness.experimental_call(
        "create",
        createInput({
          operationId: "concurrent-first",
          sourcePath,
          pathKey: "concurrent-1",
          branchName: "bb/concurrent-1",
        }),
      ),
      harness.experimental_call(
        "create",
        createInput({
          operationId: "concurrent-second",
          sourcePath,
          pathKey: "concurrent-2",
          branchName: "bb/concurrent-2",
        }),
      ),
    ]);
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    if (first.status !== "created") throw new Error(first.message);
    if (second.status !== "created") throw new Error(second.message);
    expect(first.path).not.toBe(second.path);
    expect(basename(first.path)).toBe(basename(second.path));
    expect(existsSync(join(first.path, "README.md"))).toBe(true);
    expect(existsSync(join(second.path, "README.md"))).toBe(true);
    await harness.experimental_dispose();
  });

  it.skipIf(process.platform === "win32")(
    "settles a cancelled create promptly when Git's children are still running",
    async () => {
      const { root, sourcePath, dataDir } = await createSourceRepository();
      const hookPidPath = join(root, "hook.pid");
      const hookPath = join(sourcePath, ".git", "hooks", "post-checkout");
      await writeFile(
        hookPath,
        `#!/bin/sh\necho $$ > "${hookPidPath}"\nexec sleep 30\n`,
        { mode: 0o755 },
      );
      const harness = createHarness(dataDir);
      const controller = new AbortController();
      const created = harness
        .experimental_call(
          "create",
          createInput({
            operationId: "cancelled-create",
            sourcePath,
            pathKey: "cancelled",
            branchName: "bb/cancelled",
          }),
          { signal: controller.signal },
        )
        .catch((error: unknown) => error);
      await expect
        .poll(() => existsSync(hookPidPath), { timeout: 10_000 })
        .toBe(true);
      const hookPid = Number((await readFile(hookPidPath, "utf8")).trim());
      const abortedAt = performance.now();
      controller.abort();
      expect(await created).toBeInstanceOf(Error);
      expect(performance.now() - abortedAt).toBeLessThan(3_000);
      await expect.poll(() => isPidAlive(hookPid)).toBe(false);
      await harness.experimental_dispose();
    },
  );

  it("creates a worktree on a named base under the path-key directory", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    await git(sourcePath, "branch", "release");
    await git(sourcePath, "checkout", "release");
    await writeFile(join(sourcePath, "release.txt"), "release\n");
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "release only");
    await git(sourcePath, "checkout", "main");
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("create", {
      operationId: "named",
      sourcePath,
      pathKey: "thr_1",
      branchName: "bb/named-thr_1",
      baseBranch: { kind: "named", name: "release" },
      branchMode: "reset",
    });
    expect(result).toMatchObject({
      status: "created",
      path: join(dataDir, "worktrees", "thr_1", "repo"),
      baseBranch: "release",
    });
    if (result.status !== "created") throw new Error(result.message);
    expect(existsSync(join(result.path, "release.txt"))).toBe(true);
    expect(
      (await git(result.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
    ).toBe("bb/named-thr_1");
    await harness.experimental_dispose();
  });

  it("creates on an explicit base from a detached single-branch checkout", async () => {
    const { sourcePath, dataDir } =
      await createDetachedSingleBranchRepository();
    const harness = createHarness(dataDir);
    const result = await harness.experimental_call("create", {
      operationId: "detached",
      sourcePath,
      pathKey: "thr_detached",
      branchName: "bb/detached-thr",
      baseBranch: { kind: "named", name: "v1.0" },
      branchMode: "reset",
    });
    expect(result).toMatchObject({
      status: "created",
      path: join(dataDir, "worktrees", "thr_detached", "repo"),
      baseBranch: "v1.0",
    });
    if (result.status !== "created") throw new Error(result.message);
    expect(existsSync(join(result.path, "README.md"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("re-runs create with the same path key without replacing a valid worktree", async () => {
    const { sourcePath, dataDir } =
      await createSourceRepository("Restartable Repo");
    const input = createInput({
      operationId: "first",
      sourcePath,
      pathKey: "same-path-key",
      branchName: "bb/restart",
    });
    const firstHarness = createHarness(dataDir);
    const first = await firstHarness.experimental_call("create", input);
    if (first.status !== "created") throw new Error(first.message);
    await writeFile(join(first.path, "survives.txt"), "kept\n");
    await firstHarness.experimental_dispose();

    const restartedHarness = createHarness(dataDir);
    const resumed = await restartedHarness.experimental_call("create", {
      ...input,
      operationId: "resumed",
    });
    expect(resumed).toEqual(first);
    expect(existsSync(join(first.path, "survives.txt"))).toBe(true);
    await restartedHarness.experimental_dispose();
  });

  it("completes a recovered worktree without running core setup", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    const setupMarker = join(root, "setup.marker");
    await writeFile(
      join(sourcePath, ".bb-env-setup.sh"),
      `#!/usr/bin/env bash\necho resumed > ${setupMarker}\n`,
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add setup script");
    const pathKey = "interrupted";
    const branchName = "bb/interrupted";
    const targetPath = join(dataDir, "worktrees", pathKey, "repo");
    await mkdir(join(dataDir, "worktrees", pathKey), { recursive: true });
    await git(
      sourcePath,
      "worktree",
      "add",
      "-B",
      branchName,
      targetPath,
      "main",
    );

    const harness = createHarness(dataDir);
    const resumed = await harness.experimental_call(
      "create",
      createInput({
        operationId: "resume-interrupted",
        sourcePath,
        pathKey,
        branchName,
      }),
    );

    expect(resumed).toMatchObject({ status: "created", path: targetPath });
    expect(existsSync(setupMarker)).toBe(false);
    expect(progressText(harness)).not.toContain("Running .bb-env-setup.sh");
    await harness.experimental_dispose();
  });

  it("refuses to replace a target that is on another branch and leaves it as it was", async () => {
    const { root, sourcePath, dataDir } = await createSourceRepository();
    await publishToBareRemote(root, sourcePath);
    const harness = createHarness(dataDir);
    const input = createInput({
      operationId: "first",
      sourcePath,
      pathKey: "replace",
      branchName: "bb/expected",
    });
    const first = await harness.experimental_call("create", input);
    if (first.status !== "created") throw new Error(first.message);
    await git(first.path, "checkout", "-b", "wrong-branch");
    const retried = await harness.experimental_call("create", {
      ...input,
      operationId: "retry",
    });
    expect(retried).toMatchObject({
      status: "failed",
      message: expect.stringContaining("left alone"),
      kept: { kind: "kept", path: first.path },
    });
    expect(
      (await git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
    ).toBe("wrong-branch");
    await harness.experimental_dispose();
  });

  it("leaves setup execution to core", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    await writeFile(
      join(sourcePath, ".bb-env-setup.sh"),
      "#!/usr/bin/env bash\necho setup-line-one\necho setup-line-two\n",
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add setup script");
    const harness = createHarness(dataDir);
    expect(
      await harness.experimental_call(
        "create",
        createInput({
          operationId: "setup",
          sourcePath,
          pathKey: "thr_3",
          branchName: "bb/setup-thr_3",
        }),
      ),
    ).toMatchObject({ status: "created" });
    expect(progressText(harness)).not.toContain("Running .bb-env-setup.sh");
    expect(progressText(harness)).not.toContain("setup-line-one");
    expect(progressText(harness)).not.toContain("setup-line-two");
    expect(
      harness
        .experimental_getSignals()
        .every((event) => event.payload.operationId === "setup"),
    ).toBe(true);
    await harness.experimental_dispose();
  });

  it("leaves a dirty earlier attempt alone when it holds the branch", async () => {
    const { sourcePath, dataDir } = await createSourceRepository();
    const harness = createHarness(dataDir);
    const first = await harness.experimental_call(
      "create",
      createInput({
        operationId: "first",
        sourcePath,
        pathKey: "thr_7",
        branchName: "bb/dirty-thr_7",
      }),
    );
    if (first.status !== "created") throw new Error(first.message);
    await writeFile(join(first.path, "notes.txt"), "work in progress\n");
    const retry = await harness.experimental_call(
      "create",
      createInput({
        operationId: "retry",
        sourcePath,
        pathKey: "thr_7-2",
        branchName: "bb/dirty-thr_7",
      }),
    );
    expect(retry).toMatchObject({
      status: "failed",
      message: expect.stringContaining("still checked out"),
    });
    expect(existsSync(join(first.path, "notes.txt"))).toBe(true);
    await harness.experimental_dispose();
  });

  it("leaves teardown to core, defers while a program runs in the workspace without signalling it, and prunes the path-key parent", async ({
    skip,
  }) => {
    skip(
      process.platform === "win32",
      "the holder scan cannot inspect processes on Windows, so the removal always retains",
    );
    const { root, sourcePath, dataDir } = await createSourceRepository();
    await writeFile(
      join(sourcePath, ".bb-env-teardown.sh"),
      `#!/usr/bin/env bash\necho teardown-ran > ${join(root, "teardown.marker")}\necho tearing-down\n`,
    );
    await git(sourcePath, "add", ".");
    await git(sourcePath, "commit", "-m", "add teardown script");
    await publishToBareRemote(root, sourcePath);
    const harness = createHarness(dataDir);
    const created = await harness.experimental_call(
      "create",
      createInput({
        operationId: "create",
        sourcePath,
        pathKey: "thr_6",
        branchName: "bb/teardown-thr_6",
      }),
    );
    if (created.status !== "created") throw new Error(created.message);
    const lingering = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 300_000)"],
      {
        cwd: created.path,
        detached: true,
        stdio: "ignore",
      },
    );
    lingering.unref();
    const deferred = await harness.experimental_call("remove", {
      operationId: "remove-deferred",
      pathKey: "thr_6",
      path: created.path,
    });
    const stillRunning = isPidAlive(lingering.pid ?? 0);
    lingering.kill("SIGKILL");
    await expect
      .poll(() => isPidAlive(lingering.pid ?? 0), { timeout: 10_000 })
      .toBe(false);
    const removed = await harness.experimental_call("remove", {
      operationId: "remove",
      pathKey: "thr_6",
      path: created.path,
    });
    expect(deferred).toMatchObject({
      status: "retained",
      message: expect.stringContaining("in use by"),
    });
    expect(stillRunning).toBe(true);
    expect(removed).toEqual({ status: "removed" });
    expect(progressText(harness)).not.toContain("tearing-down");
    expect(existsSync(join(root, "teardown.marker"))).toBe(false);
    expect(existsSync(created.path)).toBe(false);
    expect(await readdir(join(dataDir, "worktrees"))).toEqual([]);
    await harness.experimental_dispose();
  });
});

const lingeringProcesses: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of lingeringProcesses.splice(0)) {
    child.kill("SIGKILL");
  }
});

function spawnLingeringProcess(cwd: string) {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 300_000)"],
    {
      cwd,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  lingeringProcesses.push(child);
  return child;
}

interface ManagedWorktree {
  root: string;
  sourcePath: string;
  dataDir: string;
  harness: ReturnType<typeof createHarness>;
  pathKey: string;
  branchName: string;
  path: string;
  completionPath: string;
  lingering: ReturnType<typeof spawn>;
}

async function createManagedWorktree(
  options: {
    publish?: boolean;
    pathKey?: string;
    branchName?: string;
    prepareSource?: (sourcePath: string) => Promise<void>;
    afterPublish?: (sourcePath: string) => Promise<void>;
  } = {},
): Promise<ManagedWorktree> {
  const { root, sourcePath, dataDir } = await createSourceRepository();
  await options.prepareSource?.(sourcePath);
  if (options.publish !== false) {
    await publishToBareRemote(root, sourcePath);
  }
  await options.afterPublish?.(sourcePath);
  const harness = createHarness(dataDir);
  const pathKey = options.pathKey ?? "thr_keep";
  const branchName = options.branchName ?? `bb/${pathKey}`;
  const created = await harness.experimental_call(
    "create",
    createInput({ operationId: "create", sourcePath, pathKey, branchName }),
  );
  if (created.status !== "created") throw new Error(created.message);
  return {
    root,
    sourcePath,
    dataDir,
    harness,
    pathKey,
    branchName,
    path: created.path,
    completionPath: `${created.path}.completed`,
    lingering: spawnLingeringProcess(created.path),
  };
}

async function stopLingering(worktree: ManagedWorktree): Promise<void> {
  worktree.lingering.kill("SIGKILL");
  await expect
    .poll(() => isPidAlive(worktree.lingering.pid ?? 0), { timeout: 10_000 })
    .toBe(false);
}

async function commitFile(cwd: string, name: string): Promise<string> {
  await writeFile(join(cwd, name), `${name}\n`);
  await git(cwd, "add", name);
  await git(cwd, "commit", "-m", `add ${name}`);
  return (await git(cwd, "rev-parse", "HEAD")).trim();
}

async function registeredWorktrees(sourcePath: string): Promise<string[]> {
  const listing = await git(sourcePath, "worktree", "list", "--porcelain");
  return Promise.all(
    listing
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpath(line.slice("worktree ".length))),
  );
}

async function expectWorktreeIntact(worktree: ManagedWorktree): Promise<void> {
  expect(existsSync(worktree.path)).toBe(true);
  expect(existsSync(worktree.completionPath)).toBe(true);
  expect(await registeredWorktrees(worktree.sourcePath)).toContain(
    await realpath(worktree.path),
  );
  expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(true);
}

async function expectWorktreeRemoved(worktree: ManagedWorktree): Promise<void> {
  expect(existsSync(worktree.path)).toBe(false);
  expect(existsSync(worktree.completionPath)).toBe(false);
  expect(
    existsSync(join(worktree.dataDir, "worktrees", worktree.pathKey)),
  ).toBe(false);
  expect(await registeredWorktrees(worktree.sourcePath)).not.toContain(
    join(
      await realpath(worktree.dataDir),
      "worktrees",
      worktree.pathKey,
      basename(worktree.path),
    ),
  );
  expect(
    await git(
      worktree.sourcePath,
      "show-ref",
      "--verify",
      `refs/heads/${worktree.branchName}`,
    ),
  ).not.toBe("");
  expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(false);
}

function removeFrom(
  worktree: ManagedWorktree,
  path: string | null = worktree.path,
) {
  return worktree.harness.experimental_call("remove", {
    operationId: "remove",
    pathKey: worktree.pathKey,
    path,
  });
}

describe.skipIf(process.platform === "win32")(
  "worktree removal preservation",
  () => {
    interface PreservationCase {
      name: string;
      reason: string;
      options?: Parameters<typeof createManagedWorktree>[0];
      prepare: (worktree: ManagedWorktree) => Promise<() => Promise<void>>;
    }

    const preservationCases: PreservationCase[] = [
      {
        name: "a modified tracked file",
        reason: "uncommitted changes",
        prepare: async (worktree) => {
          await writeFile(join(worktree.path, "README.md"), "edited\n");
          return async () => {
            expect(
              await readFile(join(worktree.path, "README.md"), "utf8"),
            ).toBe("edited\n");
          };
        },
      },
      {
        name: "an untracked file",
        reason: "uncommitted changes",
        prepare: async (worktree) => {
          await writeFile(join(worktree.path, "notes.txt"), "draft\n");
          return async () => {
            expect(
              await readFile(join(worktree.path, "notes.txt"), "utf8"),
            ).toBe("draft\n");
          };
        },
      },
      {
        name: "a commit that was never pushed",
        reason: "not reachable from any remote-tracking branch",
        prepare: async (worktree) => {
          const sha = await commitFile(worktree.path, "work.txt");
          return async () => {
            expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(
              sha,
            );
            expect(
              (
                await git(worktree.sourcePath, "rev-parse", worktree.branchName)
              ).trim(),
            ).toBe(sha);
          };
        },
      },
      {
        name: "a repository with no remote at all",
        reason: "not reachable from any remote-tracking branch",
        options: { publish: false },
        prepare: async (worktree) => async () => {
          expect(existsSync(join(worktree.path, "README.md"))).toBe(true);
        },
      },
      {
        name: "a detached HEAD on a unique commit",
        reason: "not reachable from any remote-tracking branch",
        prepare: async (worktree) => {
          await git(worktree.path, "checkout", "--detach");
          const sha = await commitFile(worktree.path, "detached.txt");
          return async () => {
            expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(
              sha,
            );
            expect(existsSync(join(worktree.path, "detached.txt"))).toBe(true);
          };
        },
      },
      {
        name: "the .keep-worktree marker on an otherwise clean published worktree",
        reason: ".keep-worktree",
        prepare: async (worktree) => {
          const commonDir = (
            await git(worktree.path, "rev-parse", "--git-common-dir")
          ).trim();
          await appendFile(
            join(resolve(worktree.path, commonDir), "info", "exclude"),
            ".keep-worktree\n",
          );
          await writeFile(join(worktree.path, ".keep-worktree"), "");
          expect(await git(worktree.path, "status", "--porcelain")).toBe("");
          return async () => {
            expect(existsSync(join(worktree.path, ".keep-worktree"))).toBe(
              true,
            );
          };
        },
      },
      {
        name: "a locked worktree",
        reason: "locked",
        prepare: async (worktree) => {
          await git(worktree.sourcePath, "worktree", "lock", worktree.path);
          return async () => {
            expect(
              await git(worktree.sourcePath, "worktree", "list", "--porcelain"),
            ).toContain("locked");
          };
        },
      },
      ...["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].map(
        (name): PreservationCase => ({
          name: `an in-progress ${name}`,
          reason: name,
          prepare: async (worktree) => {
            const gitDir = (
              await git(worktree.path, "rev-parse", "--absolute-git-dir")
            ).trim();
            const head = (await git(worktree.path, "rev-parse", "HEAD")).trim();
            await writeFile(join(gitDir, name), `${head}\n`);
            return async () => {
              expect(existsSync(join(gitDir, name))).toBe(true);
            };
          },
        }),
      ),
      {
        name: "an in-progress rebase",
        reason: "rebase-merge",
        prepare: async (worktree) => {
          const gitDir = (
            await git(worktree.path, "rev-parse", "--absolute-git-dir")
          ).trim();
          await mkdir(join(gitDir, "rebase-merge"));
          return async () => {
            expect(existsSync(join(gitDir, "rebase-merge"))).toBe(true);
          };
        },
      },
      {
        name: "a staged new file",
        reason: "uncommitted changes",
        prepare: async (worktree) => {
          await writeFile(join(worktree.path, "staged.txt"), "staged\n");
          await git(worktree.path, "add", "staged.txt");
          return async () => {
            expect(
              await git(worktree.path, "diff", "--cached", "--name-only"),
            ).toContain("staged.txt");
          };
        },
      },
      {
        name: "a stash made on its branch",
        reason: "stashed change",
        prepare: async (worktree) => {
          await writeFile(join(worktree.path, "README.md"), "stashed\n");
          await git(worktree.path, "stash", "push");
          expect(await git(worktree.path, "status", "--porcelain")).toBe("");
          return async () => {
            expect(await git(worktree.path, "stash", "list")).toContain(
              worktree.branchName,
            );
          };
        },
      },
      {
        name: "a commit on a branch that is ahead of its upstream",
        reason: "not reachable from any remote-tracking branch",
        prepare: async (worktree) => {
          await git(worktree.path, "push", "--set-upstream", "origin", "HEAD");
          const sha = await commitFile(worktree.path, "ahead.txt");
          return async () => {
            expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(
              sha,
            );
          };
        },
      },
    ];

    it.each(preservationCases)(
      "keeps the worktree, its marker and its processes alive for $name",
      async ({ reason, options, prepare }) => {
        const worktree = await createManagedWorktree(options);
        try {
          const verifySurvived = await prepare(worktree);
          const result = await removeFrom(worktree);
          expect(result).toMatchObject({
            status: "retained",
            message: expect.stringContaining(worktree.path),
          });
          expect(result.status === "retained" ? result.message : "").toContain(
            reason,
          );
          await verifySurvived();
          await expectWorktreeIntact(worktree);
        } finally {
          await worktree.harness.experimental_dispose();
        }
      },
    );

    it("says the branch has no upstream when it keeps unpublished commits on it", async () => {
      const worktree = await createManagedWorktree();
      try {
        await commitFile(worktree.path, "local.txt");
        await stopLingering(worktree);
        const result = await removeFrom(worktree);
        expect(result.status === "retained" ? result.message : "").toContain(
          `${worktree.branchName} has no upstream`,
        );
        expect(existsSync(worktree.path)).toBe(true);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("does not blame a missing upstream when the branch has one", async () => {
      const worktree = await createManagedWorktree();
      try {
        await git(worktree.path, "push", "--set-upstream", "origin", "HEAD");
        await commitFile(worktree.path, "ahead.txt");
        await stopLingering(worktree);
        const result = await removeFrom(worktree);
        const message = result.status === "retained" ? result.message : "";
        expect(message).toContain("not reachable from any remote-tracking");
        expect(message).not.toContain("no upstream");
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("removes a clean zero-commit worktree whose base commit is published", async () => {
      const worktree = await createManagedWorktree();
      try {
        const base = (await git(worktree.path, "rev-parse", "HEAD")).trim();
        expect(
          (await git(worktree.path, "branch", "-r", "--contains", base)).trim(),
        ).not.toBe("");
        expect(
          (
            await git(worktree.path, "rev-list", "--count", `${base}..HEAD`)
          ).trim(),
        ).toBe("0");
        await stopLingering(worktree);
        expect(await removeFrom(worktree)).toEqual({ status: "removed" });
        await expectWorktreeRemoved(worktree);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("keeps a clean zero-commit worktree whose base commit exists only locally, and names the base", async () => {
      let localBase = "";
      const worktree = await createManagedWorktree({
        afterPublish: async (sourcePath) => {
          await commitFile(sourcePath, "local-only-base.txt");
          localBase = (await git(sourcePath, "rev-parse", "HEAD")).trim();
        },
      });
      try {
        expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(
          localBase,
        );
        expect(
          await git(worktree.path, "branch", "-r", "--contains", localBase),
        ).toBe("");
        expect(await git(worktree.path, "status", "--porcelain")).toBe("");
        await stopLingering(worktree);
        const result = await removeFrom(worktree);
        const message = result.status === "retained" ? result.message : "";
        expect(result.status).toBe("retained");
        expect(message).toContain(`base commit ${localBase}`);
        expect(message).toContain("not reachable from any remote-tracking");
        expect(existsSync(worktree.path)).toBe(true);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("removes a worktree whose commits were published from elsewhere, once it has fetched", async () => {
      const worktree = await createManagedWorktree();
      try {
        const sha = await commitFile(worktree.path, "elsewhere.txt");
        const remoteUrl = (
          await git(worktree.path, "remote", "get-url", "origin")
        ).trim();
        await git(
          worktree.path,
          "push",
          remoteUrl,
          "HEAD:refs/heads/published-elsewhere",
        );
        expect(
          await git(worktree.path, "branch", "-r", "--contains", sha),
        ).toBe("");
        await stopLingering(worktree);
        expect(await removeFrom(worktree)).toEqual({ status: "removed" });
        await expectWorktreeRemoved(worktree);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("keeps a worktree it could not fetch to check", async () => {
      const worktree = await createManagedWorktree();
      try {
        await git(
          worktree.path,
          "remote",
          "set-url",
          "origin",
          join(worktree.root, "no-such-remote.git"),
        );
        await stopLingering(worktree);
        const result = await removeFrom(worktree);
        expect(result.status === "retained" ? result.message : "").toContain(
          "could not fetch its remotes",
        );
        expect(existsSync(worktree.path)).toBe(true);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("removes a worktree whose stash belongs to another branch", async () => {
      const worktree = await createManagedWorktree();
      try {
        await writeFile(join(worktree.sourcePath, "README.md"), "other\n");
        await git(worktree.sourcePath, "stash", "push");
        await stopLingering(worktree);
        expect(await removeFrom(worktree)).toEqual({ status: "removed" });
        await expectWorktreeRemoved(worktree);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("removes a clean published worktree with ignored dependency files", async () => {
      const worktree = await createManagedWorktree({
        prepareSource: async (sourcePath) => {
          await writeFile(join(sourcePath, ".gitignore"), "node_modules/\n");
          await git(sourcePath, "add", ".");
          await git(sourcePath, "commit", "-m", "ignore dependencies");
        },
      });
      try {
        await mkdir(join(worktree.path, "node_modules", "pkg"), {
          recursive: true,
        });
        await writeFile(join(worktree.path, "node_modules", "pkg", "i.js"), "");
        await stopLingering(worktree);
        expect(await removeFrom(worktree)).toEqual({ status: "removed" });
        await expectWorktreeRemoved(worktree);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("removes a worktree with no upstream whose HEAD is reachable from another remote branch", async () => {
      const worktree = await createManagedWorktree();
      try {
        await commitFile(worktree.path, "shared.txt");
        await git(worktree.path, "push", "origin", "HEAD:refs/heads/other");
        expect(
          (
            await git(
              worktree.sourcePath,
              "for-each-ref",
              "--format=%(upstream)",
              `refs/heads/${worktree.branchName}`,
            )
          ).trim(),
        ).toBe("");
        await stopLingering(worktree);
        expect(await removeFrom(worktree)).toEqual({ status: "removed" });
        await expectWorktreeRemoved(worktree);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("removes a worktree detached at a published commit", async () => {
      const worktree = await createManagedWorktree();
      try {
        await git(worktree.path, "checkout", "--detach", "origin/main");
        await stopLingering(worktree);
        expect(await removeFrom(worktree)).toEqual({ status: "removed" });
        await expectWorktreeRemoved(worktree);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("keeps a symlinked path and the worktree it points at", async () => {
      const target = await createManagedWorktree({ pathKey: "thr_target" });
      try {
        const linkPath = join(target.dataDir, "worktrees", "thr_link", "repo");
        await mkdir(join(target.dataDir, "worktrees", "thr_link"), {
          recursive: true,
        });
        await symlink(target.path, linkPath);
        const result = await target.harness.experimental_call("remove", {
          operationId: "remove-link",
          pathKey: "thr_link",
          path: linkPath,
        });
        expect(result).toMatchObject({
          status: "retained",
          message: expect.stringContaining("symbolic link"),
        });
        expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
        await expectWorktreeIntact(target);
      } finally {
        await target.harness.experimental_dispose();
      }
    });

    it("keeps a directory outside the managed worktree root", async () => {
      const { root, dataDir } = await createSourceRepository();
      const harness = createHarness(dataDir);
      const outside = join(root, "outside");
      await mkdir(outside);
      await mkdir(join(dataDir, "worktrees", "thr_outside"), {
        recursive: true,
      });
      await writeFile(join(outside, "precious.txt"), "keep\n");
      const result = await harness.experimental_call("remove", {
        operationId: "remove-outside",
        pathKey: "thr_outside",
        path: outside,
      });
      expect(result).toMatchObject({
        status: "retained",
        message: expect.stringContaining(
          "outside the managed worktree directory",
        ),
      });
      expect(await readFile(join(outside, "precious.txt"), "utf8")).toBe(
        "keep\n",
      );
      await harness.experimental_dispose();
    });

    it("keeps a stray non-git directory under the path key inside a wrapping repository", async () => {
      const worktree = await createManagedWorktree();
      try {
        await git(worktree.dataDir, "init", "--initial-branch=main");
        const stray = join(
          worktree.dataDir,
          "worktrees",
          worktree.pathKey,
          "stray",
        );
        await mkdir(stray);
        await writeFile(join(stray, "data.txt"), "keep\n");
        const result = await removeFrom(worktree, null);
        expect(result).toMatchObject({
          status: "retained",
          message: expect.stringContaining(stray),
        });
        expect(await readFile(join(stray, "data.txt"), "utf8")).toBe("keep\n");
        await expectWorktreeIntact(worktree);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("keeps a worktree whose Git administrative directory is gone", async () => {
      const worktree = await createManagedWorktree();
      try {
        await writeFile(join(worktree.path, "orphaned.txt"), "keep\n");
        await rm(join(worktree.sourcePath, ".git", "worktrees"), {
          recursive: true,
          force: true,
        });
        const result = await removeFrom(worktree);
        expect(result).toMatchObject({
          status: "retained",
          message: expect.stringContaining(worktree.path),
        });
        expect(
          await readFile(join(worktree.path, "orphaned.txt"), "utf8"),
        ).toBe("keep\n");
        expect(existsSync(worktree.completionPath)).toBe(true);
        expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(true);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("keeps the completion marker so a retried create resumes the preserved worktree", async () => {
      const worktree = await createManagedWorktree();
      try {
        await commitFile(worktree.path, "work.txt");
        expect(await removeFrom(worktree)).toMatchObject({
          status: "retained",
        });
        expect(existsSync(worktree.completionPath)).toBe(true);
        const retried = await worktree.harness.experimental_call(
          "create",
          createInput({
            operationId: "retry",
            sourcePath: worktree.sourcePath,
            pathKey: worktree.pathKey,
            branchName: worktree.branchName,
          }),
        );
        expect(retried).toMatchObject({
          status: "created",
          path: worktree.path,
        });
        expect(existsSync(join(worktree.path, "work.txt"))).toBe(true);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    async function addSiblingWorktree(
      worktree: ManagedWorktree,
      name: string,
    ): Promise<{ path: string; completionPath: string }> {
      const siblingPath = join(
        worktree.dataDir,
        "worktrees",
        worktree.pathKey,
        name,
      );
      await git(
        worktree.sourcePath,
        "worktree",
        "add",
        "--detach",
        siblingPath,
        "origin/main",
      );
      await writeFile(`${siblingPath}.completed`, `${name}\n`);
      return { path: siblingPath, completionPath: `${siblingPath}.completed` };
    }

    it("retains every target untouched when any one of several is protected", async () => {
      const worktree = await createManagedWorktree({ pathKey: "thr_two" });
      try {
        const sibling = await addSiblingWorktree(worktree, "protected");
        await writeFile(join(sibling.path, "notes.txt"), "draft\n");
        const result = await removeFrom(worktree, null);
        expect(result).toMatchObject({
          status: "retained",
          message: expect.stringContaining(sibling.path),
        });
        await expectWorktreeIntact(worktree);
        expect(existsSync(sibling.path)).toBe(true);
        expect(existsSync(sibling.completionPath)).toBe(true);
        expect(await readFile(join(sibling.path, "notes.txt"), "utf8")).toBe(
          "draft\n",
        );
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("defers a path-key removal and signals nothing while a program still runs in a sibling worktree", async () => {
      const worktree = await createManagedWorktree({ pathKey: "thr_race" });
      try {
        const sibling = await addSiblingWorktree(worktree, "late-writer");
        const writer = spawn(
          process.execPath,
          [
            "-e",
            `const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync("late.txt", "written while stopping\\n");
  process.exit(0);
});
setTimeout(() => {}, 300_000);`,
          ],
          { cwd: sibling.path, detached: true, stdio: "ignore" },
        );
        writer.unref();
        lingeringProcesses.push(writer);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await stopLingering(worktree);

        const result = await removeFrom(worktree, null);

        expect(result.status).toBe("retained");
        const message = result.status === "retained" ? result.message : "";
        expect(message).toContain(sibling.path);
        expect(message).toContain("in use by");
        expect(isPidAlive(writer.pid ?? 0)).toBe(true);
        expect(existsSync(join(sibling.path, "late.txt"))).toBe(false);
        expect(existsSync(worktree.path)).toBe(true);
        expect(existsSync(sibling.completionPath)).toBe(true);
        expect(await registeredWorktrees(worktree.sourcePath)).toContain(
          await realpath(sibling.path),
        );
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("inspects without side effects", async () => {
      const worktree = await createManagedWorktree({ pathKey: "thr_inspect" });
      try {
        const inspect = () =>
          worktree.harness.experimental_call("inspect", {
            pathKey: worktree.pathKey,
            path: worktree.path,
          });
        expect(await inspect()).toMatchObject({
          status: "retained",
          message: expect.stringContaining("in use by"),
        });
        expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(true);
        await stopLingering(worktree);
        expect(await inspect()).toEqual({ status: "removable" });
        expect(existsSync(worktree.path)).toBe(true);
        await writeFile(join(worktree.path, "notes.txt"), "draft\n");
        expect(await inspect()).toMatchObject({
          status: "retained",
          message: expect.stringContaining("uncommitted changes"),
        });
        expect(existsSync(join(worktree.path, "README.md"))).toBe(true);
        expect(existsSync(join(worktree.path, "notes.txt"))).toBe(true);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    it("reports a Git refusal as a failure, with the worktree and marker intact", async () => {
      const worktree = await createManagedWorktree({
        pathKey: "thr_submodule",
        prepareSource: async (sourcePath) => {
          const submodule = join(dirname(sourcePath), "sub");
          await mkdir(submodule);
          await git(submodule, "init", "--initial-branch=main");
          await writeFile(join(submodule, "s.txt"), "s\n");
          await git(submodule, "add", ".");
          await git(submodule, "commit", "-m", "sub");
          await git(
            sourcePath,
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            submodule,
            "libs/sub",
          );
          await git(sourcePath, "commit", "-m", "add submodule");
        },
      });
      try {
        await git(
          worktree.path,
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "update",
          "--init",
        );
        expect(await git(worktree.path, "status", "--porcelain")).toBe("");
        await stopLingering(worktree);

        const result = await removeFrom(worktree);

        expect(result.status).toBe("failed");
        const message = result.status === "failed" ? result.message : "";
        expect(message).toContain(`Kept ${worktree.path}`);
        expect(message).toContain("Git declined to remove it");
        expect(message).toContain("submodules");
        expect(existsSync(join(worktree.path, "README.md"))).toBe(true);
        expect(existsSync(worktree.completionPath)).toBe(true);
        expect(await registeredWorktrees(worktree.sourcePath)).toContain(
          await realpath(worktree.path),
        );
        expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(false);
      } finally {
        await worktree.harness.experimental_dispose();
      }
    });

    describe("create-side cleanup", () => {
      it("keeps a wrong-branch target that holds a unique commit instead of replacing it", async () => {
        const worktree = await createManagedWorktree({ pathKey: "replace" });
        try {
          await git(worktree.path, "checkout", "-b", "wrong-branch");
          const sha = await commitFile(worktree.path, "unique.txt");
          const retried = await worktree.harness.experimental_call(
            "create",
            createInput({
              operationId: "retry",
              sourcePath: worktree.sourcePath,
              pathKey: worktree.pathKey,
              branchName: worktree.branchName,
            }),
          );
          expect(retried).toMatchObject({
            status: "failed",
            message: expect.stringContaining("left alone"),
          });
          expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(
            sha,
          );
          expect(existsSync(join(worktree.path, "unique.txt"))).toBe(true);
        } finally {
          await worktree.harness.experimental_dispose();
        }
      });

      it("keeps an abandoned earlier attempt whether or not it is published, leaving its removal to its owner", async () => {
        const worktree = await createManagedWorktree({
          pathKey: "thr_7",
          branchName: "bb/abandoned",
        });
        try {
          const sha = await commitFile(worktree.path, "unpushed.txt");
          const retry = createInput({
            operationId: "retry",
            sourcePath: worktree.sourcePath,
            pathKey: "thr_7-2",
            branchName: "bb/abandoned",
          });
          expect(
            await worktree.harness.experimental_call("create", retry),
          ).toMatchObject({
            status: "failed",
            message: expect.stringContaining(worktree.path),
          });
          expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(
            sha,
          );

          await git(
            worktree.path,
            "push",
            "origin",
            "HEAD:refs/heads/abandoned",
          );
          const second = await worktree.harness.experimental_call(
            "create",
            retry,
          );
          expect(second).toMatchObject({
            status: "failed",
            message: expect.stringContaining("left alone"),
          });
          expect(existsSync(worktree.path)).toBe(true);
          expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(
            sha,
          );
        } finally {
          await worktree.harness.experimental_dispose();
        }
      });

      it("keeps a just-created target whose setup failed in place until a retention record exists", async () => {
        const { sourcePath, dataDir } = await createSourceRepository();
        const hookPath = join(sourcePath, ".git", "hooks", "post-checkout");
        await writeFile(
          hookPath,
          "#!/bin/sh\nln -s /nonexistent-bb-test/completed ../repo.completed\n",
          { mode: 0o755 },
        );
        const harness = createHarness(dataDir);
        const result = await harness.experimental_call(
          "create",
          createInput({
            operationId: "create-fail",
            sourcePath,
            pathKey: "thr_fail",
            branchName: "bb/fail",
          }),
        );
        expect(result.status).toBe("failed");
        expect(existsSync(join(dataDir, "worktrees", "thr_fail"))).toBe(true);
        expect(JSON.stringify(result)).toContain("stays in place");
        await harness.experimental_dispose();
      });

      it("refuses a fresh-create removal when HEAD moved since the attempt created the worktree, before stopping anything", async () => {
        const worktree = await createManagedWorktree({ publish: false });
        try {
          const createdHead = (
            await git(worktree.path, "rev-parse", "HEAD")
          ).trim();
          await commitFile(worktree.path, "after-create.txt");
          await expect(
            removeWorktree({
              path: worktree.path,
              rootPath: join(worktree.dataDir, "worktrees"),
              createdBy: { head: createdHead, copies: new Map() },
            }),
          ).rejects.toMatchObject({ code: "worktree_preserved" });
          expect(existsSync(join(worktree.path, "after-create.txt"))).toBe(
            true,
          );
          expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(true);
        } finally {
          await worktree.harness.experimental_dispose();
        }
      });

      it("never treats an edit made right after the copy as bb's own", async () => {
        const worktree = await createManagedWorktree({ publish: false });
        try {
          await writeFile(
            join(worktree.sourcePath, ".worktreeinclude"),
            "inc/\n",
          );
          await mkdir(join(worktree.sourcePath, "inc"));
          await writeFile(join(worktree.sourcePath, "inc", "a.env"), "A=1\n");
          const createdBy: CreatedBy = {
            head: (await git(worktree.path, "rev-parse", "HEAD")).trim(),
            copies: new Map(),
          };
          const copied = join(worktree.path, "inc", "a.env");

          await copyWorktreeIncludeFiles({
            sourcePath: worktree.sourcePath,
            targetPath: worktree.path,
            ledger: {
              expect: fingerprintSource,
              begin: (relativePath) => {
                beginCopy(createdBy, relativePath);
                writeFileSync(copied, "A=2\n");
              },
              record: (relativePath, file, expected) =>
                recordCopy(createdBy, relativePath, file, expected),
            },
          });
          await expect(
            removeWorktree({
              path: worktree.path,
              rootPath: join(worktree.dataDir, "worktrees"),
              createdBy,
            }),
          ).rejects.toMatchObject({ code: "worktree_preserved" });
          expect(await readFile(copied, "utf8")).toBe("A=2\n");
          expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(true);
        } finally {
          await worktree.harness.experimental_dispose();
        }
      });

      it("never deletes through a recorded copy whose folder now links outside the worktree", async () => {
        const worktree = await createManagedWorktree({ publish: false });
        try {
          const createdHead = (
            await git(worktree.path, "rev-parse", "HEAD")
          ).trim();
          const outside = join(worktree.root, "outside");
          await mkdir(outside);
          await writeFile(join(outside, "a.env"), "A=outside\n");
          await symlink(outside, join(worktree.path, "inc"));
          const print = createHash("sha256")
            .update("A=outside\n")
            .digest("hex");
          await expect(
            removeWorktree({
              path: worktree.path,
              rootPath: join(worktree.dataDir, "worktrees"),
              createdBy: {
                head: createdHead,
                copies: new Map([
                  [
                    "inc/a.env",
                    {
                      state: "recorded",
                      sha256: print,
                      size: 10,
                      mode: 0o100644,
                    },
                  ],
                ]),
              },
            }),
          ).rejects.toMatchObject({ code: "worktree_preserved" });
          expect(await readFile(join(outside, "a.env"), "utf8")).toBe(
            "A=outside\n",
          );
          expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(true);
        } finally {
          await worktree.harness.experimental_dispose();
        }
      });

      it("refuses a fresh-create removal while a copy has no recorded contents, before stopping anything", async () => {
        const worktree = await createManagedWorktree({ publish: false });
        try {
          const createdHead = (
            await git(worktree.path, "rev-parse", "HEAD")
          ).trim();
          await expect(
            removeWorktree({
              path: worktree.path,
              rootPath: join(worktree.dataDir, "worktrees"),
              createdBy: {
                head: createdHead,
                copies: new Map([["README.md", { state: "pending" }]]),
              },
            }),
          ).rejects.toMatchObject({
            code: "worktree_preserved",
            message: expect.stringContaining("stays in place"),
          });
          expect(existsSync(join(worktree.path, "README.md"))).toBe(true);
          expect(isPidAlive(worktree.lingering.pid ?? 0)).toBe(true);
        } finally {
          await worktree.harness.experimental_dispose();
        }
      });
    });
  },
);
