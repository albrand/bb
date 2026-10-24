import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeHostEntry } from "./host.js";

const lockBehavior: {
  unresolvable: string | null;
  failing: string | null;
} = { unresolvable: null, failing: null };

vi.mock("bb-environment-provider-host/locks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("bb-environment-provider-host/locks")>();
  return {
    ...actual,
    tryWithCheckoutMutationLock: (
      checkoutPath: string,
      ...rest: Parameters<typeof actual.tryWithCheckoutMutationLock> extends [
        string,
        ...infer Tail,
      ]
        ? Tail
        : never
    ) => {
      if (
        lockBehavior.unresolvable !== null &&
        checkoutPath.includes(lockBehavior.unresolvable)
      )
        return Promise.resolve(null);
      if (
        lockBehavior.failing !== null &&
        checkoutPath.includes(lockBehavior.failing)
      )
        return Promise.reject(new Error("disk exploded"));
      return actual.tryWithCheckoutMutationLock(checkoutPath, ...rest);
    },
  };
});

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const lingering: ReturnType<typeof spawn>[] = [];

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

afterEach(async () => {
  lockBehavior.unresolvable = null;
  lockBehavior.failing = null;
  for (const child of lingering.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createPublishedFixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-failures-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main");
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");
  const remotePath = join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", remotePath);
  await git(sourcePath, "remote", "add", "origin", remotePath);
  await git(sourcePath, "push", "origin", "main");
  const harness = experimental_createHostEntryHarness(
    createWorktreeHostEntry(),
    {
      experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
    },
  );
  return { sourcePath, dataDir, harness };
}

async function addWorktree(
  fixture: Awaited<ReturnType<typeof createPublishedFixture>>,
  name: string,
) {
  const path = join(fixture.dataDir, "worktrees", "thr_fail", name);
  await mkdir(join(fixture.dataDir, "worktrees", "thr_fail"), {
    recursive: true,
  });
  await git(
    fixture.sourcePath,
    "worktree",
    "add",
    "--detach",
    path,
    "origin/main",
  );
  await writeFile(`${path}.completed`, `${name}\n`);
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 300_000)"],
    {
      cwd: fixture.dataDir,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  lingering.push(child);
  return { path, completionPath: `${path}.completed`, process: child };
}

describe("worktree removal when its machinery fails", () => {
  it("refuses before stopping anything when the checkout lock cannot be resolved", async () => {
    const fixture = await createPublishedFixture();
    const target = await addWorktree(fixture, "locked-out");
    lockBehavior.unresolvable = "locked-out";

    const result = await fixture.harness.experimental_call("remove", {
      operationId: "remove",
      pathKey: "thr_fail",
      path: target.path,
    });

    expect(result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("checkout lock could not be resolved"),
    });
    expect(existsSync(join(target.path, "README.md"))).toBe(true);
    expect(existsSync(target.completionPath)).toBe(true);
    expect(isPidAlive(target.process.pid ?? 0)).toBe(true);
    expect(
      await git(fixture.sourcePath, "worktree", "list", "--porcelain"),
    ).toContain(await realpath(target.path));
    await fixture.harness.experimental_dispose();
  });

  it("stops at an unknown error and reports removed, unknown and not-attempted targets accurately", async () => {
    const fixture = await createPublishedFixture();
    const first = await addWorktree(fixture, "a-first");
    const second = await addWorktree(fixture, "b-second");
    const third = await addWorktree(fixture, "c-third");
    lockBehavior.failing = "b-second";

    const result = await fixture.harness.experimental_call("remove", {
      operationId: "remove",
      pathKey: "thr_fail",
      path: null,
    });

    expect(result.status).toBe("failed");
    const lines = result.status === "failed" ? result.message.split("\n") : [];
    expect(lines).toEqual([
      "Worktree removal stopped part-way.",
      `Removed: ${first.path}.`,
      `Unknown state after an error: ${second.path} (disk exploded).`,
      `Not attempted: ${third.path}.`,
    ]);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(first.completionPath)).toBe(false);
    expect(await readFile(join(second.path, "README.md"), "utf8")).toBe(
      "hello\n",
    );
    expect(existsSync(second.completionPath)).toBe(true);
    expect(existsSync(third.path)).toBe(true);
    expect(existsSync(third.completionPath)).toBe(true);
    expect(isPidAlive(third.process.pid ?? 0)).toBe(true);
    await fixture.harness.experimental_dispose();
  });
});
