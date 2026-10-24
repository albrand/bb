import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeHostEntry } from "./host.js";
import { descendantsOnly } from "./host/descendants-only.js";
import {
  hostProc,
  useProcReaderForTests,
  type ProcReader,
} from "./host/holders.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const lingering: ReturnType<typeof spawn>[] = [];
const NON_DUMPABLE = [
  "import ctypes, os, sys, time",
  "libc = ctypes.CDLL(None)",
  "libc.prctl(4, 0, 0, 0, 0)",
  "libc.prctl(15, b'unlisted-agent', 0, 0, 0)",
  "sys.stdout.write(str(os.getpid()) + chr(10))",
  "sys.stdout.flush()",
  "time.sleep(300)",
].join("\n");
const realUnreadableApplies =
  process.platform === "linux" && process.getuid?.() !== 0;

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
  useProcReaderForTests(descendantsOnly(hostProc, process.pid));
  for (const child of lingering.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-unreadable-"));
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
    { experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") } },
  );
  const path = join(dataDir, "worktrees", "thr_unreadable", "clean");
  await mkdir(join(dataDir, "worktrees", "thr_unreadable"), {
    recursive: true,
  });
  await git(sourcePath, "worktree", "add", "--detach", path, "origin/main");
  await writeFile(`${path}.completed`, "clean\n");
  return { sourcePath, dataDir, harness, path };
}

function startOrdinaryProcess(cwd: string): ReturnType<typeof spawn> {
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
  lingering.push(child);
  return child;
}

function unreadableAfterStart(reader: ProcReader, pid: number): ProcReader {
  const denied = (path: string) =>
    new RegExp(`^/proc/${pid}/(ns|root|exe|cwd|fd|task|maps)(/|$)`, "u").test(
      path,
    );
  const refuse = (): never => {
    throw Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
  };
  return {
    ...reader,
    readlink: (path) => (denied(path) ? refuse() : reader.readlink(path)),
    readdir: (path) => (denied(path) ? refuse() : reader.readdir(path)),
    lstatId: (path) => (denied(path) ? refuse() : reader.lstatId(path)),
    statId: (path) => (denied(path) ? refuse() : reader.statId(path)),
    readFile: (path) => (denied(path) ? refuse() : reader.readFile(path)),
  };
}

async function expectKept(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  holderPid: number,
) {
  const input = {
    operationId: "remove",
    pathKey: "thr_unreadable",
    path: fixture.path,
  };
  const removed = await fixture.harness.experimental_call("remove", input);
  expect(removed).toMatchObject({
    status: "retained",
    message: expect.stringContaining(`process ${holderPid}`),
  });
  expect(existsSync(join(fixture.path, "README.md"))).toBe(true);
  expect(existsSync(`${fixture.path}.completed`)).toBe(true);
  expect(
    await git(fixture.sourcePath, "worktree", "list", "--porcelain"),
  ).toContain(await realpath(fixture.path));
  const inspected = await fixture.harness.experimental_call("inspect", {
    pathKey: input.pathKey,
    path: input.path,
  });
  expect(inspected).toMatchObject({
    status: "retained",
    message: expect.stringContaining(
      "could not check which programs are using it",
    ),
  });
  expect(isPidAlive(holderPid)).toBe(true);
}

describe("a program whose /proc entries cannot be read", () => {
  it("keeps a clean, published worktree and deletes nothing, with a readable reason, when a same-user program is unreadable (any user)", async () => {
    const fixture = await createFixture();
    const holder = startOrdinaryProcess(fixture.dataDir);
    const pid = holder.pid ?? 0;
    useProcReaderForTests(
      unreadableAfterStart(descendantsOnly(hostProc, process.pid), pid),
    );

    await expectKept(fixture, pid);
    await fixture.harness.experimental_dispose();
  });

  it.skipIf(!realUnreadableApplies)(
    "keeps it when the program is a real non-dumpable process with an unlisted name",
    async () => {
      const fixture = await createFixture();
      const holder = spawn("python3", ["-c", NON_DUMPABLE], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      lingering.push(holder);
      const pid = await new Promise<number>((resolve) =>
        holder.stdout?.once("data", (chunk: Buffer) =>
          resolve(Number(String(chunk).trim())),
        ),
      );

      await expectKept(fixture, pid);
      await fixture.harness.experimental_dispose();
    },
  );

  it("removes the same worktree when nothing is unreadable, so only the unreadable program is what keeps it", async () => {
    const fixture = await createFixture();
    startOrdinaryProcess(fixture.dataDir);

    const removed = await fixture.harness.experimental_call("remove", {
      operationId: "remove",
      pathKey: "thr_unreadable",
      path: fixture.path,
    });

    expect(removed).toMatchObject({ status: "removed" });
    expect(existsSync(fixture.path)).toBe(false);
    await fixture.harness.experimental_dispose();
  });
});
