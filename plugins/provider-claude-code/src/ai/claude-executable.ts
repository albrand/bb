import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { experimental_resolveExecutablePath as resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import { claudeExecutable } from "../bridge/provider-maintenance.js";

const OTHERS_WRITE = 0o002;
const GROUP_WRITE = 0o020;
const STICKY = 0o1000;
const MAX_LINK_HOPS = 40;
const execFileAsync = promisify(execFile);

export type ClaudeExecutableCheck =
  | { ok: true; path: string }
  | { ok: false; message: string };

export interface ClaudeExecutableCheckDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number | null;
  defaultExecutable: () => Promise<string>;
  resolve: (command: string) => Promise<string | null>;
  listAcl: (entry: string) => Promise<string>;
  linkOwner: (link: string) => Promise<number>;
}

const ACL_WRITE =
  /\ballow\b.*\b(write|append|add_file|add_subdirectory|delete|delete_child|writeattr|writeextattr|writesecurity|chown)\b/u;

async function linkOwner(link: string): Promise<number> {
  return (await fs.lstat(link)).uid;
}

async function listAcl(entry: string): Promise<string> {
  const { stdout } = await execFileAsync("/bin/ls", ["-lde", entry]);
  return stdout;
}

function defaultDeps(): ClaudeExecutableCheckDeps {
  return {
    env: process.env,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    defaultExecutable: claudeExecutable,
    resolve: resolveExecutablePath,
    listAcl,
    linkOwner,
  };
}

function withParents(dir: string, into: Set<string>): void {
  for (let current = dir; ; current = path.dirname(current)) {
    into.add(current);
    if (path.dirname(current) === current) return;
  }
}

async function untrustedReason(
  file: string,
  real: string,
  deps: ClaudeExecutableCheckDeps,
): Promise<string | null> {
  const checked = new Set<string>();
  let current = file;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    withParents(path.dirname(current), checked);
    withParents(await fs.realpath(path.dirname(current)), checked);
    const link = await fs.lstat(current);
    if (!link.isSymbolicLink()) break;
    const owner = await deps.linkOwner(current);
    if (deps.uid !== null && owner !== deps.uid && owner !== 0) {
      return `${current} belongs to another account`;
    }
    current = path.resolve(path.dirname(current), await fs.readlink(current));
  }
  checked.add(real);
  withParents(path.dirname(real), checked);
  const links = new Set<string>();
  for (const entry of checked) {
    const stat = await fs.lstat(entry);
    const owner = stat.isSymbolicLink()
      ? await deps.linkOwner(entry)
      : stat.uid;
    if (deps.uid !== null && owner !== deps.uid && owner !== 0) {
      return `${entry} belongs to another account`;
    }
    if (stat.isSymbolicLink()) {
      links.add(entry);
      continue;
    }
    const sticky = stat.isDirectory() && (stat.mode & STICKY) !== 0;
    if (sticky) continue;
    if ((stat.mode & OTHERS_WRITE) !== 0) {
      return `any account can change ${entry}`;
    }
    if ((stat.mode & GROUP_WRITE) !== 0) {
      return `other accounts in its group can change ${entry}`;
    }
  }
  if (deps.platform === "darwin") {
    for (const entry of checked) {
      if (links.has(entry)) continue;
      const listing = (await deps.listAcl(entry)).split("\n").slice(1);
      if (listing.some((line) => ACL_WRITE.test(line))) {
        return `an access control list lets other accounts change ${entry}`;
      }
    }
  }
  if (!(await fs.lstat(real)).isFile()) return `${real} is not a file`;
  return null;
}

export async function trustedClaudeExecutable(
  deps: ClaudeExecutableCheckDeps = defaultDeps(),
): Promise<ClaudeExecutableCheck> {
  const override = deps.env.BB_CLAUDE_CODE_EXECUTABLE?.trim();
  let candidate: string;
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        ok: false,
        message: `BB_CLAUDE_CODE_EXECUTABLE must be an absolute path for writing assistance, not ${override}`,
      };
    }
    candidate = override;
  } else {
    const chosen = await deps.defaultExecutable();
    const resolved = path.isAbsolute(chosen)
      ? chosen
      : await deps.resolve(chosen);
    if (resolved === null) {
      return {
        ok: false,
        message: "Install Claude Code on the primary machine",
      };
    }
    candidate = resolved;
  }
  if (deps.platform === "win32") return { ok: true, path: candidate };
  try {
    const real = await fs.realpath(candidate);
    const reason = await untrustedReason(candidate, real, deps);
    if (reason !== null) {
      return {
        ok: false,
        message: `Writing assistance will not run ${candidate}: ${reason}`,
      };
    }
    return { ok: true, path: real };
  } catch {
    return {
      ok: false,
      message: `Writing assistance cannot read ${candidate}. Install Claude Code on the primary machine`,
    };
  }
}
