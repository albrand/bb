import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import { completeClaudeInference } from "./claude-complete.js";
import {
  type ClaudeExecutableCheckDeps,
  trustedClaudeExecutable,
} from "./claude-executable.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.chmod(dir, 0o700).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-claude-exec-")),
  );
  tempDirs.push(dir);
  return dir;
}

async function cli(dir: string, mode = 0o755): Promise<string> {
  const file = path.join(dir, "claude");
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n");
  await fs.chmod(file, mode);
  return file;
}

function deps(
  overrides: Partial<ClaudeExecutableCheckDeps>,
): ClaudeExecutableCheckDeps {
  return {
    env: {},
    platform: "linux",
    uid: process.getuid?.() ?? null,
    defaultExecutable: async () => "claude",
    resolve: async () => null,
    listAcl: async (entry) =>
      `drwxr-xr-x  2 owner  staff  64 Oct 23 12:00 ${entry}\n`,
    linkOwner: async (link) => (await fs.lstat(link)).uid,
    ...overrides,
  };
}

function hostContext(): ExperimentalHostRpcContext {
  const unused = (): never => {
    throw new Error("not used by this handler");
  };
  return {
    signal: new AbortController().signal,
    lifecycle: { signal: new AbortController().signal },
    experimental_paths: { dataDir: os.tmpdir(), tempDir: os.tmpdir() },
    experimental_emitSignal: unused,
    experimental_watch: unused,
    experimental_retainWorker: unused,
  };
}

const posix = process.platform === "win32" ? describe.skip : describe;

posix("the Claude CLI that writing assistance trusts", () => {
  it("runs the resolved real file when only its owner or root can change it and every directory above it", async () => {
    const dir = await scratch();
    const file = await cli(dir);
    await expect(
      trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).resolves.toEqual({ ok: true, path: file });
    await expect(
      trustedClaudeExecutable(
        deps({ env: { BB_CLAUDE_CODE_EXECUTABLE: `  ${file}  ` } }),
      ),
    ).resolves.toEqual({ ok: true, path: file });
  });

  it("refuses a CLI file that any account can change", async () => {
    const file = await cli(await scratch(), 0o777);
    const result = await trustedClaudeExecutable(
      deps({ env: { BB_CLAUDE_CODE_EXECUTABLE: file } }),
    );
    expect(result).toEqual({
      ok: false,
      message: `Writing assistance will not run ${file}: any account can change ${file}`,
    });
  });

  it("refuses a CLI in a directory any account can change, unless the directory is sticky", async () => {
    const dir = await scratch();
    const file = await cli(dir);
    await fs.chmod(dir, 0o777);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).toEqual({
      ok: false,
      message: `Writing assistance will not run ${file}: any account can change ${dir}`,
    });
    await fs.chmod(dir, 0o1777);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).toEqual({ ok: true, path: file });
  });

  it("refuses a CLI file or directory that other accounts in its group can change, unless the directory is sticky", async () => {
    const dir = await scratch();
    const file = await cli(dir, 0o775);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).toEqual({
      ok: false,
      message: `Writing assistance will not run ${file}: other accounts in its group can change ${file}`,
    });
    await fs.chmod(file, 0o755);
    await fs.chmod(dir, 0o775);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).toEqual({
      ok: false,
      message: `Writing assistance will not run ${file}: other accounts in its group can change ${dir}`,
    });
    await fs.chmod(dir, 0o1775);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).toEqual({ ok: true, path: file });
  });

  it("on macOS refuses a CLI whose file or directory has an access control list allowing writes, and ignores deny entries", async () => {
    const dir = await scratch();
    const file = await cli(dir);
    const acl =
      (allowed: string, rule: string) =>
      async (entry: string): Promise<string> =>
        `-rwxr-xr-x+ 1 owner  staff  17 Oct 23 12:00 ${entry}\n` +
        (entry === allowed
          ? ` 0: ${rule}\n`
          : " 0: group:everyone deny delete\n");
    expect(
      await trustedClaudeExecutable(
        deps({
          platform: "darwin",
          resolve: async () => file,
          listAcl: acl(dir, "group:staff allow add_file,delete_child"),
        }),
      ),
    ).toEqual({
      ok: false,
      message: `Writing assistance will not run ${file}: an access control list lets other accounts change ${dir}`,
    });
    expect(
      await trustedClaudeExecutable(
        deps({
          platform: "darwin",
          resolve: async () => file,
          listAcl: acl(file, "user:someone allow write,append"),
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await trustedClaudeExecutable(
        deps({
          platform: "darwin",
          resolve: async () => file,
          listAcl: acl(file, "group:everyone deny write"),
        }),
      ),
    ).toEqual({ ok: true, path: file });
  });

  (process.platform === "darwin" ? it : it.skip)(
    "on macOS reads a real access control list that lets everyone write the CLI",
    async () => {
      const file = await cli(await scratch());
      const saved = process.env.BB_CLAUDE_CODE_EXECUTABLE;
      process.env.BB_CLAUDE_CODE_EXECUTABLE = file;
      try {
        await expect(trustedClaudeExecutable()).resolves.toEqual({
          ok: true,
          path: file,
        });
        await execFileAsync("/bin/chmod", ["+a", "everyone allow write", file]);
        await expect(trustedClaudeExecutable()).resolves.toEqual({
          ok: false,
          message: `Writing assistance will not run ${file}: an access control list lets other accounts change ${file}`,
        });
      } finally {
        await execFileAsync("/bin/chmod", ["-N", file]);
        if (saved === undefined) delete process.env.BB_CLAUDE_CODE_EXECUTABLE;
        else process.env.BB_CLAUDE_CODE_EXECUTABLE = saved;
      }
    },
  );

  it("refuses a link whose target sits where any account can change it", async () => {
    const good = await scratch();
    const bad = await scratch();
    const target = await cli(bad);
    await fs.chmod(bad, 0o777);
    const link = path.join(good, "claude");
    await fs.symlink(target, link);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => link })),
    ).toEqual({
      ok: false,
      message: `Writing assistance will not run ${link}: any account can change ${bad}`,
    });
  });

  it("refuses a link owned by another account, even when its target and every directory are trusted", async () => {
    const dir = await scratch();
    const target = await cli(dir);
    const first = path.join(dir, "claude-current");
    const link = path.join(dir, "claude-link");
    await fs.symlink(target, first);
    await fs.symlink(first, link);
    const uid = process.getuid?.() ?? 0;
    for (const foreign of [link, first]) {
      expect(
        await trustedClaudeExecutable(
          deps({
            resolve: async () => link,
            linkOwner: async (entry) =>
              entry === foreign ? uid + 1 : (await fs.lstat(entry)).uid,
          }),
        ),
      ).toEqual({
        ok: false,
        message: `Writing assistance will not run ${link}: ${foreign} belongs to another account`,
      });
    }
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => link })),
    ).toEqual({ ok: true, path: target });
  });

  it("runs the real CLI behind a directory link it trusts", async () => {
    const dir = await scratch();
    await fs.mkdir(path.join(dir, "real"), { mode: 0o755 });
    const target = await cli(path.join(dir, "real"));
    await fs.symlink(path.join(dir, "real"), path.join(dir, "linked"));
    const candidate = path.join(dir, "linked", "claude");
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => candidate })),
    ).toEqual({ ok: true, path: target });
  });

  it("refuses a directory link owned by another account, even when the directory it points to is trusted", async () => {
    const dir = await scratch();
    await fs.mkdir(path.join(dir, "real"), { mode: 0o755 });
    await cli(path.join(dir, "real"));
    const linked = path.join(dir, "linked");
    await fs.symlink(path.join(dir, "real"), linked);
    const candidate = path.join(linked, "claude");
    const uid = process.getuid?.() ?? 0;
    expect(
      await trustedClaudeExecutable(
        deps({
          resolve: async () => candidate,
          linkOwner: async (entry) =>
            entry === linked ? uid + 1 : (await fs.lstat(entry)).uid,
        }),
      ),
    ).toEqual({
      ok: false,
      message: `Writing assistance will not run ${candidate}: ${linked} belongs to another account`,
    });
  });

  it("runs the CLI it checked when a directory link on the way is retargeted while the check runs, so another CLI never receives the prompt", async () => {
    const dir = await scratch();
    const markers = await scratch();
    for (const name of ["trusted", "other"]) {
      await fs.mkdir(path.join(dir, name), { mode: 0o755 });
      const file = await cli(path.join(dir, name));
      await fs.writeFile(
        file,
        `#!/bin/sh\ncat > ${path.join(markers, name)}\nexit 0\n`,
      );
    }
    const linked = path.join(dir, "linked");
    await fs.symlink(path.join(dir, "trusted"), linked);
    const candidate = path.join(linked, "claude");
    let retargeted = false;
    const result = await trustedClaudeExecutable(
      deps({
        platform: "darwin",
        resolve: async () => candidate,
        listAcl: async (entry) => {
          if (!retargeted) {
            retargeted = true;
            await fs.rm(linked);
            await fs.symlink(path.join(dir, "other"), linked);
          }
          return `drwxr-xr-x  2 owner  staff  64 Oct 23 12:00 ${entry}\n`;
        },
      }),
    );
    expect(retargeted).toBe(true);
    expect(result).toEqual({
      ok: true,
      path: path.join(dir, "trusted", "claude"),
    });
    if (!result.ok) return;
    await completeClaudeInference(
      { model: "haiku", prompt: "Fix this.", timeoutMs: 5_000 },
      new AbortController().signal,
      { executable: result.path, env: {} },
    );
    await expect(
      fs.readFile(path.join(markers, "trusted"), "utf8"),
    ).resolves.toBe("Fix this.");
    await expect(fs.access(path.join(markers, "other"))).rejects.toThrow();
  });

  it("refuses a CLI owned by another account", async () => {
    const file = await cli(await scratch());
    const uid = process.getuid?.() ?? 0;
    const result = await trustedClaudeExecutable(
      deps({ uid: uid + 1, resolve: async () => file }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toContain(
      "belongs to another account",
    );
  });

  it("refuses a relative BB_CLAUDE_CODE_EXECUTABLE and a missing CLI without running anything", async () => {
    expect(
      await trustedClaudeExecutable(
        deps({ env: { BB_CLAUDE_CODE_EXECUTABLE: "bin/claude" } }),
      ),
    ).toEqual({
      ok: false,
      message:
        "BB_CLAUDE_CODE_EXECUTABLE must be an absolute path for writing assistance, not bin/claude",
    });
    expect(await trustedClaudeExecutable(deps({}))).toEqual({
      ok: false,
      message: "Install Claude Code on the primary machine",
    });
    const missing = path.join(await scratch(), "claude");
    expect(
      await trustedClaudeExecutable(
        deps({ env: { BB_CLAUDE_CODE_EXECUTABLE: missing } }),
      ),
    ).toEqual({
      ok: false,
      message: `Writing assistance cannot read ${missing}. Install Claude Code on the primary machine`,
    });
  });

  it("does not check file ownership on Windows, where POSIX modes do not apply", async () => {
    const file = await cli(await scratch(), 0o777);
    expect(
      await trustedClaudeExecutable(
        deps({ platform: "win32", env: { BB_CLAUDE_CODE_EXECUTABLE: file } }),
      ),
    ).toEqual({ ok: true, path: file });
  });

  it("makes the writing service report not ready and refuse a request, without running the CLI, when the CLI is not trusted", async () => {
    const dir = await scratch();
    const file = await cli(dir);
    const ran = path.join(dir, "ran");
    await fs.writeFile(file, `#!/bin/sh\ntouch ${ran}\n`);
    await fs.chmod(file, 0o777);
    const previous = process.env.BB_CLAUDE_CODE_EXECUTABLE;
    try {
      process.env.BB_CLAUDE_CODE_EXECUTABLE = file;
      const message = `Writing assistance will not run ${file}: any account can change ${file}`;
      await expect(
        hostEntry.handlers["claude.ai.status"]({}, hostContext()),
      ).resolves.toEqual({ ready: false, message });
      await expect(
        hostEntry.handlers["claude.ai.complete"](
          { model: "haiku", prompt: "Fix this.", timeoutMs: 1_000 },
          hostContext(),
        ),
      ).resolves.toEqual({ ok: false, code: "request_failed", message });
      await expect(fs.access(ran)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.BB_CLAUDE_CODE_EXECUTABLE;
      else process.env.BB_CLAUDE_CODE_EXECUTABLE = previous;
    }
  });
});
