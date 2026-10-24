import { execFile } from "node:child_process";
import { existsSync, statSync, utimesSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeHostEntry } from "./host.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const PATH_KEY = "thr_failed";
const FAILING_COMPLETION_LINK =
  "ln -s /nonexistent-bb-test/completed ../repo.completed";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

async function createFixture(options: {
  trackedFiles?: ReadonlyArray<{ name: string; content: string }>;
  hookLines: readonly string[];
  includedFiles: ReadonlyArray<{ name: string; content: string }>;
}) {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-failed-create-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main");
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await writeFile(join(sourcePath, ".gitignore"), "inc/\n");
  await writeFile(join(sourcePath, ".worktreeinclude"), "inc/\n");
  for (const file of options.trackedFiles ?? []) {
    await writeFile(join(sourcePath, file.name), file.content);
  }
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");
  await mkdir(join(sourcePath, "inc"));
  for (const file of options.includedFiles) {
    await writeFile(join(sourcePath, "inc", file.name), file.content);
  }
  await writeFile(
    join(sourcePath, ".git", "hooks", "post-checkout"),
    `#!/bin/sh\n${[FAILING_COMPLETION_LINK, ...options.hookLines].join("\n")}\n`,
    { mode: 0o755 },
  );
  const harness = experimental_createHostEntryHarness(
    createWorktreeHostEntry(),
    { experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") } },
  );
  const targetPath = join(dataDir, "worktrees", PATH_KEY, "repo");
  const create = () =>
    harness.experimental_call("create", {
      operationId: "create",
      sourcePath,
      pathKey: PATH_KEY,
      branchName: "bb/failed-create",
      baseBranch: { kind: "default" as const },
      branchMode: "reset" as const,
    });
  return { dataDir, harness, sourcePath, targetPath, create };
}

describe("a failed create keeps recoverable work in the worktree it just made", () => {
  it("keeps an untracked file that someone else put there", async () => {
    const fixture = await createFixture({
      hookLines: ['echo "work in progress" > extra.txt'],
      includedFiles: [],
    });
    const result = await fixture.create();
    const extra = join(fixture.targetPath, "extra.txt");
    expect(existsSync(extra), JSON.stringify(result)).toBe(true);
    expect(await readFile(extra, "utf8")).toBe("work in progress\n");
    expect(result.status).toBe("failed");
    await fixture.harness.experimental_dispose();
  });

  it("keeps an edit to a tracked file", async () => {
    const fixture = await createFixture({
      hookLines: ['echo "edited by someone" >> README.md'],
      includedFiles: [],
    });
    const result = await fixture.create();
    const readme = join(fixture.targetPath, "README.md");
    expect(existsSync(readme), JSON.stringify(result)).toBe(true);
    expect(await readFile(readme, "utf8")).toBe("hello\nedited by someone\n");
    expect(result.status).toBe("failed");
    await fixture.harness.experimental_dispose();
  });

  it("keeps the whole failed attempt in place, with the copies bb made, and says why", async () => {
    const fixture = await createFixture({
      hookLines: [],
      includedFiles: [
        { name: "a.env", content: "A=1\n" },
        { name: "b.env", content: "B=2\n" },
      ],
    });
    const result = await fixture.create();
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      kept: { kind: "kept", path: fixture.targetPath },
    });
    expect(JSON.stringify(result)).toContain("stays in place");
    expect(JSON.stringify(result)).toContain("ENOENT");
    expect(await readFile(join(fixture.targetPath, "inc", "a.env"), "utf8")).toBe(
      "A=1\n",
    );
    expect(await readFile(join(fixture.targetPath, "inc", "b.env"), "utf8")).toBe(
      "B=2\n",
    );
    expect(existsSync(join(fixture.dataDir, "retained"))).toBe(false);
    await fixture.harness.experimental_dispose();
  });

  it("keeps a foreign file in a directory bb also copied into", async () => {
    const fixture = await createFixture({
      hookLines: [
        "mkdir -p inc",
        'echo "not from the source" > inc/foreign.env',
      ],
      includedFiles: [{ name: "a.env", content: "A=1\n" }],
    });
    const result = await fixture.create();
    const foreign = join(fixture.targetPath, "inc", "foreign.env");
    expect(existsSync(foreign), JSON.stringify(result)).toBe(true);
    expect(await readFile(foreign, "utf8")).toBe("not from the source\n");
    expect(result.status).toBe("failed");
    await fixture.harness.experimental_dispose();
  });

  it("stops nothing and keeps everything when the worktree carries a committed .keep-worktree", async () => {
    const fixture = await createFixture({
      trackedFiles: [{ name: ".keep-worktree", content: "" }],
      hookLines: [
        "(sleep 300 > /dev/null 2>&1 & echo $! > ../hook-sleeper.pid)",
      ],
      includedFiles: [],
    });
    const result = await fixture.create();
    const pid = Number(
      (
        await readFile(
          join(fixture.targetPath, "..", "hook-sleeper.pid"),
          "utf8",
        )
      ).trim(),
    );
    try {
      expect(existsSync(join(fixture.targetPath, ".keep-worktree"))).toBe(true);
      expect(isAlive(pid)).toBe(true);
      expect(result.status).toBe("failed");
    } finally {
      process.kill(pid, "SIGKILL");
      await fixture.harness.experimental_dispose();
    }
  });

  it("pins how Git lists the files of an ignored directory, which the ownership check relies on", async () => {
    const fixture = await createFixture({ hookLines: [], includedFiles: [] });
    const repo = fixture.sourcePath;
    await mkdir(join(repo, "inc", "deep"), { recursive: true });
    await writeFile(join(repo, "inc", "a.env"), "A\n");
    await writeFile(join(repo, "inc", "deep", "b.env"), "B\n");
    const status = await git(
      repo,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=traditional",
    );
    expect(status.split("\0").filter(Boolean).sort()).toEqual([
      "!! inc/a.env",
      "!! inc/deep/b.env",
    ]);
    await fixture.harness.experimental_dispose();
  });

  describe.each([
    { label: "changed after it was copied", sameSizeAndMtime: false },
    {
      label: "edited to the same size with its modification time restored",
      sameSizeAndMtime: true,
    },
  ])("a copied file $label", ({ sameSizeAndMtime }) => {
    it("is kept", async () => {
      const copyCount = 1500;
      const fixture = await createFixture({
        hookLines: [],
        includedFiles: Array.from({ length: copyCount }, (_, index) => ({
          name: `f${String(index).padStart(5, "0")}.env`,
          content: `VALUE=${String(index).padStart(5, "0")}\n`,
        })),
      });
      const pending = fixture.create();
      const first = join(fixture.targetPath, "inc", "f00000.env");
      const last = join(
        fixture.targetPath,
        "inc",
        `f${String(copyCount - 1).padStart(5, "0")}.env`,
      );
      await expect
        .poll(() => existsSync(first), { interval: 2, timeout: 20_000 })
        .toBe(true);
      expect(
        existsSync(last),
        "fixture too fast: the copy finished before the edit could land",
      ).toBe(false);
      const copiedStat = statSync(first);
      const edited = sameSizeAndMtime ? "VALUE=X0000\n" : "VALUE=changed\n";
      await writeFile(first, edited);
      if (sameSizeAndMtime) {
        utimesSync(first, copiedStat.atime, copiedStat.mtime);
      }
      const result = await pending;
      expect(existsSync(first), JSON.stringify(result)).toBe(true);
      expect(await readFile(first, "utf8")).toBe(edited);
      expect(result.status).toBe("failed");
      await fixture.harness.experimental_dispose();
    }, 60_000);
  });
});
