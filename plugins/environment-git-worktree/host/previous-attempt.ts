import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { runGit, WorkspaceError } from "bb-environment-provider-host/git";
import { branchBelongsToAttempt } from "../attempt-branch.js";
import { parseWorktreeListPorcelain } from "./worktree-list.js";

export interface PreviousAttemptRequest {
  threadId: string;
  attempt: number;
  pathsForAttempt: (attempt: number) => string[];
}

export interface PinnedPreviousAttempt {
  branch: string;
  sha: string;
  worktreePath: string | null;
  workingState: string;
}

async function describeWorkingState(
  worktreePath: string | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (worktreePath === null) return "no workspace of it is registered any more";
  const status = await runGit(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=traditional",
    ],
    {
      cwd: worktreePath,
      allowFailure: true,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  if (status.exitCode !== 0) return "its uncommitted state could not be inspected";
  const entries = status.stdout.split("\0").filter((entry) => entry !== "");
  return entries.length === 0
    ? "had no uncommitted, staged, untracked or ignored files when checked"
    : `has ${entries.length} uncommitted, staged, untracked or ignored entries that were not copied`;
}

async function findLeftovers(args: {
  request: PreviousAttemptRequest;
  registered: readonly { path: string }[];
}): Promise<{ path: string; text: string }[]> {
  const leftovers: { path: string; text: string }[] = [];
  for (let attempt = 1; attempt < args.request.attempt; attempt += 1) {
    for (const earlierPath of args.request.pathsForAttempt(attempt)) {
      const exists = await fs
        .lstat(earlierPath)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => error.code !== "ENOENT");
      const earlierReal = await fs
        .realpath(earlierPath)
        .catch(() => earlierPath);
      let registered = false;
      for (const entry of args.registered) {
        const entryReal = await fs.realpath(entry.path).catch(() => entry.path);
        if (entryReal === earlierReal) registered = true;
      }
      if (exists || registered)
        leftovers.push({
          path: earlierPath,
          text: `the workspace at ${earlierPath}`,
        });
    }
  }
  return leftovers;
}

export async function pinPreviousAttempt(args: {
  sourcePath: string;
  request: PreviousAttemptRequest;
  signal: AbortSignal | undefined;
}): Promise<PinnedPreviousAttempt | null> {
  const options = {
    cwd: args.sourcePath,
    allowFailure: true,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
  const refs = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    options,
  );
  if (refs.exitCode !== 0) {
    throw new WorkspaceError(
      "previous_attempt_unresolved",
      "Cannot continue from the earlier attempt because its branches could not be listed; nothing was created.",
    );
  }
  const branches = refs.stdout.split("\n").filter((branch) => branch !== "");
  let branch: string | null = null;
  let found = 0;
  for (
    let attempt = args.request.attempt - 1;
    attempt >= 1 && branch === null;
    attempt -= 1
  ) {
    const candidates = branches.filter((candidate) =>
      branchBelongsToAttempt(candidate, args.request.threadId, attempt),
    );
    if (candidates.length > 1) {
      throw new WorkspaceError(
        "previous_attempt_unresolved",
        `Cannot continue from the earlier attempt: ${candidates.length} branches could belong to attempt ${attempt}. Nothing was created, and the earlier work was left alone.`,
      );
    }
    if (candidates.length === 1) {
      branch = candidates[0]!;
      found = attempt;
    }
  }
  if (branch === null) {
    const listing = await runGit(
      ["worktree", "list", "--porcelain", "-z"],
      options,
    );
    const leftovers =
      listing.exitCode === 0
        ? await findLeftovers({
            request: args.request,
            registered: parseWorktreeListPorcelain(listing.stdout),
          })
        : [
            {
              path: "",
              text: "a workspace that could not be ruled out because the registered workspaces could not be listed",
            },
          ];
    if (leftovers.length > 0) {
      throw new WorkspaceError(
        "previous_attempt_unresolved",
        `Cannot start this retry: no branch of this thread's earlier attempts exists, but ${leftovers.map((leftover) => leftover.text).join(", ")} remains, so work could be lost. Nothing was created, and it was left alone. Release or recover it yourself, then retry.`,
        leftovers[0]!.path === ""
          ? undefined
          : { keptPath: leftovers[0]!.path },
      );
    }
    return null;
  }
  const resolved = await runGit(
    ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
    options,
  );
  const sha = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || sha === "") {
    throw new WorkspaceError(
      "previous_attempt_unresolved",
      `Cannot continue from the earlier attempt: the tip of ${branch} could not be read. Nothing was created.`,
    );
  }
  const listing = await runGit(
    ["worktree", "list", "--porcelain", "-z"],
    options,
  );
  if (listing.exitCode !== 0) {
    throw new WorkspaceError(
      "previous_attempt_unresolved",
      `Cannot continue from ${branch}: the registered workspaces could not be listed, so an earlier workspace that is not on this branch could not be ruled out. Nothing was created.`,
    );
  }
  const entries = parseWorktreeListPorcelain(listing.stdout);
  for (let attempt = args.request.attempt - 1; attempt >= found; attempt -= 1) {
    for (const earlierPath of args.request.pathsForAttempt(attempt)) {
      const earlierReal = await fs
        .realpath(earlierPath)
        .catch(() => earlierPath);
      for (const entry of entries) {
        const entryReal = await fs.realpath(entry.path).catch(() => entry.path);
        if (entryReal === earlierReal && entry.branch !== branch) {
          throw new WorkspaceError(
            "previous_attempt_unresolved",
            `Cannot continue from ${branch}: the earlier workspace at ${earlierPath} is ${entry.branch === null ? "detached" : `on ${entry.branch}`}, not on that branch, so its latest work is not at the branch tip. Nothing was created, and that workspace was left alone.`,
            { keptPath: earlierPath },
          );
        }
      }
    }
  }
  const holder = entries.find((entry) => entry.branch === branch);
  const worktreePath = holder?.path ?? null;
  return {
    branch,
    sha,
    worktreePath,
    workingState: await describeWorkingState(worktreePath, args.signal),
  };
}

function runRefTransaction(
  cwd: string,
  input: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["update-ref", "--stdin"], {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => resolve({ code: null, stderr: error.message }));
    child.once("close", (code) => resolve({ code, stderr }));
    child.stdin.end(input);
  });
}

export async function createBranchAtPinnedTip(args: {
  sourcePath: string;
  pinned: PinnedPreviousAttempt;
  newBranch: string;
}): Promise<void> {
  const result = await runRefTransaction(
    args.sourcePath,
    [
      "start",
      `verify refs/heads/${args.pinned.branch} ${args.pinned.sha}`,
      `create refs/heads/${args.newBranch} ${args.pinned.sha}`,
      "commit",
      "",
    ].join("\n"),
  );
  if (result.code !== 0) {
    throw new WorkspaceError(
      "previous_attempt_changed",
      `Cannot continue from ${args.pinned.branch}: it moved while the new branch was being prepared, or ${args.newBranch} already exists. Nothing was created, and the earlier work was left alone. ${result.stderr.trim().split("\n")[0] ?? ""}`.trim(),
    );
  }
}

export async function deleteCreatedBranch(args: {
  sourcePath: string;
  newBranch: string;
  sha: string;
}): Promise<void> {
  await runGit(
    ["update-ref", "-d", `refs/heads/${args.newBranch}`, args.sha],
    { cwd: args.sourcePath, allowFailure: true },
  );
}

export async function describeContinuity(args: {
  sourcePath: string;
  pinned: PinnedPreviousAttempt;
  newBranch: string;
}): Promise<string> {
  const current = await runGit(
    ["rev-parse", "--verify", `refs/heads/${args.pinned.branch}^{commit}`],
    { cwd: args.sourcePath, allowFailure: true },
  );
  const tip = current.stdout.trim();
  const moved =
    current.exitCode !== 0 || tip !== args.pinned.sha
      ? ` The earlier branch is no longer at that commit${tip === "" ? "" : ` (it is at ${tip.slice(0, 12)})`}; this attempt keeps the commit it pinned, which is not necessarily the latest work.`
      : "";
  return `Continuing on ${args.newBranch} from ${args.pinned.branch} at ${args.pinned.sha.slice(0, 12)}. The earlier workspace${args.pinned.worktreePath === null ? "" : ` at ${args.pinned.worktreePath}`} was kept and ${args.pinned.workingState}.${moved}`;
}
