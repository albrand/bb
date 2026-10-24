import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "bb-environment-provider-host/git";
import { branchBelongsToThread } from "../attempt-branch.js";
import { resolveWorktreeAttemptRoot } from "./paths.js";
import { parseWorktreeListPorcelain } from "./worktree-list.js";

export type RetentionProof =
  | { absent: true; proof: string }
  | { absent: false; reason: string };

function isUnderOrEqual(candidate: string, directory: string): boolean {
  return (
    candidate === directory || candidate.startsWith(`${directory}${path.sep}`)
  );
}

async function realOrSelf(target: string): Promise<string> {
  return fs.realpath(target).catch(() => path.resolve(target));
}

async function lstatAbsent(target: string): Promise<string | null> {
  try {
    await fs.lstat(target);
    return `${target} still exists on this machine`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? null
      : `${target} could not be checked (${code ?? "error"})`;
  }
}

export async function proveRetentionAbsent(args: {
  path: string | null;
  pathKey: string | null;
  branchName: string | null;
  sourcePath: string | null;
  threadId: string | null;
  dataDir: string;
  signal: AbortSignal | undefined;
}): Promise<RetentionProof> {
  const watched: string[] = [];
  if (args.path !== null) watched.push(path.resolve(args.path));
  if (args.path === null) {
    if (args.pathKey === null) {
      return {
        absent: false,
        reason:
          "neither a path nor a path key was recorded, so where the attempt would have put its workspace is unknown",
      };
    }
    let attemptRoot: string;
    try {
      attemptRoot = resolveWorktreeAttemptRoot({
        dataDir: args.dataDir,
        pathKey: args.pathKey,
      });
    } catch {
      return {
        absent: false,
        reason: `the path key ${args.pathKey} does not name a workspace folder`,
      };
    }
    watched.push(attemptRoot);
  }
  for (const target of watched) {
    const present = await lstatAbsent(target);
    if (present !== null) return { absent: false, reason: present };
  }
  if (args.sourcePath === null) {
    return {
      absent: false,
      reason:
        "the project's checkout on this machine is unknown, so the registered workspaces could not be checked",
    };
  }
  const listing = await runGit(["worktree", "list", "--porcelain", "-z"], {
    cwd: args.sourcePath,
    allowFailure: true,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  if (listing.exitCode !== 0) {
    return {
      absent: false,
      reason: "the registered workspaces of the repository could not be listed",
    };
  }
  const entries = parseWorktreeListPorcelain(listing.stdout);
  for (const entry of entries) {
    const entryPaths = [path.resolve(entry.path), await realOrSelf(entry.path)];
    for (const target of watched) {
      if (
        entryPaths.some(
          (entryPath) =>
            isUnderOrEqual(entryPath, target) ||
            isUnderOrEqual(target, entryPath),
        )
      ) {
        return {
          absent: false,
          reason: `a workspace at ${entry.path} is still registered at or around ${target}`,
        };
      }
    }
    if (entry.branch !== null) {
      if (args.branchName !== null && entry.branch === args.branchName) {
        return {
          absent: false,
          reason: `the workspace at ${entry.path} still holds branch ${entry.branch}`,
        };
      }
      if (
        args.threadId !== null &&
        branchBelongsToThread(entry.branch, args.threadId)
      ) {
        return {
          absent: false,
          reason: `the workspace at ${entry.path} still holds branch ${entry.branch} of this thread`,
        };
      }
    }
  }
  return {
    absent: true,
    proof: `lstat ENOENT on ${watched.join(", ")}; no registered workspace at or around it; no workspace holds a branch of ${args.threadId ?? "this thread"}${args.branchName === null ? "" : ` or ${args.branchName}`}`,
  };
}
