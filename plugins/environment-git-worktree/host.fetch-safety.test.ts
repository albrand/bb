import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearFetchMemo,
  findPreservationReasons,
  identifyWorktree,
  isWorktreePreservedError,
  nonInteractiveFetchEnvironment,
} from "./host/worktree-preservation.js";
import { removeWorktree } from "./host/worktree.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const servers: http.Server[] = [];
const inheritedSshCommand = process.env.GIT_SSH_COMMAND;

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

async function isRunning(pid: number): Promise<boolean> {
  const listing = await execFileAsync("ps", [
    "-o",
    "stat=",
    "-p",
    String(pid),
  ]).catch(() => ({ stdout: "" }));
  const state = listing.stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

afterEach(async () => {
  clearFetchMemo();
  if (inheritedSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
  else process.env.GIT_SSH_COMMAND = inheritedSshCommand;
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(remoteUrl: string) {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-fetch-"));
  roots.push(root);
  const sourcePath = join(root, "repo");
  await mkdir(sourcePath, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main");
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");
  const originPath = join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", originPath);
  await git(sourcePath, "remote", "add", "origin", originPath);
  await git(sourcePath, "push", "origin", "main");
  await git(sourcePath, "remote", "add", "backup", remoteUrl);
  const attemptRoot = join(root, "worktrees", "thr_fetch");
  const path = join(attemptRoot, "clean");
  await mkdir(attemptRoot, { recursive: true });
  await git(sourcePath, "worktree", "add", "--detach", path, "origin/main");
  return { root, sourcePath, attemptRoot, path };
}

async function addWorktree(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string,
) {
  const path = join(fixture.attemptRoot, name);
  await git(
    fixture.sourcePath,
    "worktree",
    "add",
    "--detach",
    path,
    "origin/main",
  );
  const identified = await identifyWorktree({
    path,
    rootPath: fixture.attemptRoot,
  });
  if (identified.status !== "identified")
    throw new Error("the extra worktree was not identified");
  return identified.identity;
}

async function writeScript(root: string, name: string, body: string) {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function identityOf(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const identified = await identifyWorktree({
    path: fixture.path,
    rootPath: fixture.attemptRoot,
  });
  if (identified.status !== "identified")
    throw new Error("the fixture's worktree was not identified");
  return identified.identity;
}

async function recordingSsh(root: string) {
  const log = join(root, "ssh.log");
  const script = await writeScript(
    root,
    "fake-ssh.sh",
    `{ echo "ARGV: $*"; echo "ENV GIT_ASKPASS=$GIT_ASKPASS SSH_ASKPASS=$SSH_ASKPASS SSH_ASKPASS_REQUIRE=$SSH_ASKPASS_REQUIRE GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT GCM_INTERACTIVE=$GCM_INTERACTIVE"; } >> ${JSON.stringify(log)}\nexit 255`,
  );
  return { log, script };
}

describe("the fetch that checks whether commits are published", () => {
  it("never prompts: batch mode is added to the user's own ssh command and nothing can ask for a password", async () => {
    const fixture = await createFixture("ssh://fetch.invalid/repo.git");
    const { log, script } = await recordingSsh(fixture.root);
    await git(
      fixture.sourcePath,
      "config",
      "core.sshCommand",
      `${script} --from-config`,
    );

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    const recorded = await readFile(log, "utf8");
    expect(recorded).toMatch(/ARGV: --from-config -o BatchMode=yes /u);
    expect(recorded).toContain("GIT_ASKPASS=true");
    expect(recorded).toContain("SSH_ASKPASS=true");
    expect(recorded).toContain("SSH_ASKPASS_REQUIRE=never");
    expect(recorded).toContain("GIT_TERMINAL_PROMPT=0");
    expect(recorded).toContain("GCM_INTERACTIVE=never");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("keeps the user's GIT_SSH_COMMAND, which wins over core.sshCommand, and appends batch mode to it", async () => {
    const fixture = await createFixture("ssh://fetch.invalid/repo.git");
    const { log, script } = await recordingSsh(fixture.root);
    await git(fixture.sourcePath, "config", "core.sshCommand", "false");
    process.env.GIT_SSH_COMMAND = `${script} --from-env`;

    await findPreservationReasons(await identityOf(fixture), undefined, {
      fetchTimeoutMs: 20_000,
    });

    expect(await readFile(log, "utf8")).toMatch(
      /ARGV: --from-env -o BatchMode=yes /u,
    );
  });

  it("builds the environment from the user's command, the configured one, GIT_SSH or plain ssh, in that order", () => {
    expect(
      nonInteractiveFetchEnvironment({}, { GIT_SSH_COMMAND: "env-ssh" }, "cfg")
        .GIT_SSH_COMMAND,
    ).toBe("env-ssh -o BatchMode=yes");
    expect(
      nonInteractiveFetchEnvironment({}, {}, "cfg -F x").GIT_SSH_COMMAND,
    ).toBe("cfg -F x -o BatchMode=yes");
    expect(
      nonInteractiveFetchEnvironment({}, { GIT_SSH: "/opt/my ssh" }, null)
        .GIT_SSH_COMMAND,
    ).toBe("'/opt/my ssh' -o BatchMode=yes");
    expect(nonInteractiveFetchEnvironment({}, {}, null).GIT_SSH_COMMAND).toBe(
      "ssh -o BatchMode=yes",
    );
  });

  it("does not run a credential helper, so a keychain cannot open a dialog", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    const fixture = await createFixture(`http://127.0.0.1:${port}/repo.git`);
    const marker = join(fixture.root, "helper-called");
    await git(
      fixture.sourcePath,
      "config",
      "credential.helper",
      `!f() { echo called >> ${marker}; }; f`,
    );
    await execFileAsync("git", ["fetch", "backup"], {
      cwd: fixture.sourcePath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).catch(() => undefined);
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(existsSync(marker)).toBe(false);
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("still fetches from a remote that works: a local remote and an ssh remote reached through the user's own wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-served-"));
    roots.push(root);
    const served = join(root, "served.git");
    await git(root, "init", "--bare", "--initial-branch=main", served);
    const seed = join(root, "seed");
    await mkdir(seed, { recursive: true });
    await git(seed, "init", "--initial-branch=main");
    await writeFile(join(seed, "a.txt"), "a\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "first");
    await git(seed, "push", served, "main");
    const log = join(root, "working-ssh.log");
    const wrapper = await writeScript(
      root,
      "working-ssh.sh",
      [
        `echo "ARGV: $*" >> ${JSON.stringify(log)}`,
        'for a in "$@"; do [ "$a" = "-G" ] && exit 0; done',
        'eval "last=\\${$#}"',
        'exec sh -c "$last"',
      ].join("\n"),
    );
    const fixture = await createFixture(`ssh://fetch.invalid${served}`);
    await git(
      fixture.sourcePath,
      "config",
      "core.sshCommand",
      `${wrapper} --from-config`,
    );
    await writeFile(join(seed, "b.txt"), "b\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "second");
    await git(seed, "push", served, "main");
    const published = (await git(seed, "rev-parse", "HEAD")).trim();

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(reasons.join("\n")).not.toContain("could not fetch");
    expect(
      (
        await git(fixture.sourcePath, "rev-parse", "refs/remotes/backup/main")
      ).trim(),
    ).toBe(published);
    expect(
      (
        await git(fixture.sourcePath, "rev-parse", "refs/remotes/origin/main")
      ).trim(),
    ).toMatch(/^[0-9a-f]{40}$/u);
    expect(await readFile(log, "utf8")).toMatch(
      /--from-config -o BatchMode=yes .*git-upload-pack/u,
    );
  });

  it("fetches once per source repository per pass, however many of its worktrees are checked", async () => {
    const fixture = await createFixture("ssh://fetch.invalid/repo.git");
    const { log, script } = await recordingSsh(fixture.root);
    await git(fixture.sourcePath, "config", "core.sshCommand", script);
    const first = await identityOf(fixture);
    const second = await addWorktree(fixture, "second");
    const third = await addWorktree(fixture, "third");
    const attempts = async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.includes("git-upload-pack")).length;

    const reasons = [
      await findPreservationReasons(first, undefined, {
        fetchTimeoutMs: 20_000,
      }),
      await findPreservationReasons(second, undefined, {
        fetchTimeoutMs: 20_000,
      }),
      await findPreservationReasons(third, undefined, {
        fetchTimeoutMs: 20_000,
      }),
    ];

    expect(await attempts()).toBe(1);
    for (const each of reasons)
      expect(each.join("\n")).toContain("could not fetch its remotes");
    clearFetchMemo();
    await findPreservationReasons(second, undefined, {
      fetchTimeoutMs: 20_000,
    });
    expect(await attempts()).toBe(2);
    await findPreservationReasons(third, undefined, {
      fetchTimeoutMs: 20_000,
      fetchMemoMs: 0,
    });
    expect(await attempts()).toBe(3);
  });

  it("fetches each of two source repositories once", async () => {
    const one = await createFixture("ssh://fetch.invalid/one.git");
    const two = await createFixture("ssh://fetch.invalid/two.git");
    const logOne = await recordingSsh(one.root);
    const logTwo = await recordingSsh(two.root);
    await git(one.sourcePath, "config", "core.sshCommand", logOne.script);
    await git(two.sourcePath, "config", "core.sshCommand", logTwo.script);

    await findPreservationReasons(await identityOf(one), undefined, {
      fetchTimeoutMs: 20_000,
    });
    await findPreservationReasons(await identityOf(two), undefined, {
      fetchTimeoutMs: 20_000,
    });

    for (const { log } of [logOne, logTwo])
      expect(
        (await readFile(log, "utf8"))
          .split("\n")
          .filter((line) => line.includes("git-upload-pack")),
      ).toHaveLength(1);
  });

  describe("when the remote never answers", () => {
    async function hangingFixture() {
      const fixture = await createFixture("ssh://fetch.invalid/repo.git");
      const pidFile = join(fixture.root, "ssh.pid");
      const script = await writeScript(
        fixture.root,
        "hanging-ssh.sh",
        `echo $$ >> ${JSON.stringify(pidFile)}\ntrap '' TERM\nwhile true; do sleep 1; done`,
      );
      await git(fixture.sourcePath, "config", "core.sshCommand", script);
      return { ...fixture, pidFile };
    }

    async function processGroupMembers(pgid: number): Promise<number> {
      const listing = await execFileAsync("ps", ["-eo", "pid=,pgid=,stat="]);
      return listing.stdout.split("\n").filter((line) => {
        const [, group, state] = line.trim().split(/\s+/u);
        return group === String(pgid) && !(state ?? "").startsWith("Z");
      }).length;
    }

    it("gives up within the bound, kills the git child and everything it started, and keeps the worktree with a reason", async () => {
      const fixture = await hangingFixture();
      const identity = await identityOf(fixture);

      const startedAt = Date.now();
      const reasons = await findPreservationReasons(identity, undefined, {
        fetchTimeoutMs: 1_500,
      });
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(9_000);
      expect(reasons.join("\n")).toMatch(
        /could not fetch its remotes to verify its commits are published \(.*timed out after 1500ms\)/u,
      );
      const pid = Number(
        (await readFile(fixture.pidFile, "utf8")).trim().split("\n")[0],
      );
      for (let wait = 0; wait < 30 && (await isRunning(pid)); wait += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await isRunning(pid)).toBe(false);
      expect(await processGroupMembers(pid)).toBe(0);
    }, 30_000);

    it("bounds a pass over several worktrees of one repository to one timeout, not one per worktree", async () => {
      const fixture = await hangingFixture();
      const identities = [
        await identityOf(fixture),
        await addWorktree(fixture, "second"),
        await addWorktree(fixture, "third"),
      ];

      const startedAt = Date.now();
      const outcomes: string[][] = [];
      for (const identity of identities)
        outcomes.push(
          await findPreservationReasons(identity, undefined, {
            fetchTimeoutMs: 1_500,
          }),
        );
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(6_000);
      for (const reasons of outcomes)
        expect(reasons.join("\n")).toContain("could not fetch its remotes");

      const again = await findPreservationReasons(identities[0]!, undefined, {
        fetchTimeoutMs: 1_500,
      });
      expect(
        (await readFile(fixture.pidFile, "utf8")).trim().split("\n"),
      ).toHaveLength(1);
      expect(again.join("\n")).toContain("could not fetch its remotes");
    }, 30_000);

    it("never removes the worktree: removal stops with the preserved error and the worktree is untouched", async () => {
      const fixture = await hangingFixture();

      const outcome = await removeWorktree({
        path: fixture.path,
        rootPath: fixture.attemptRoot,
        fetchTimeoutMs: 1_500,
      }).then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );

      expect(outcome.result).toBeNull();
      expect(isWorktreePreservedError(outcome.error)).toBe(true);
      expect((outcome.error as Error).message).toContain(
        "could not fetch its remotes",
      );
      expect(existsSync(join(fixture.path, "README.md"))).toBe(true);
      expect(
        await git(fixture.sourcePath, "worktree", "list", "--porcelain"),
      ).toContain(await realpath(fixture.path));
    }, 30_000);
  });
});
