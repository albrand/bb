import fs from "node:fs/promises";
import path from "node:path";
import { runGit, WorkspaceError } from "bb-environment-provider-host/git";
import { describeHolderScan, scanWorktreeHolders } from "./holders.js";
import { parseWorktreeListPorcelain } from "./worktree-list.js";

export const KEEP_WORKTREE_MARKER = ".keep-worktree";
export const WORKTREE_PRESERVED_CODE = "worktree_preserved";

const IN_PROGRESS_OPERATION_PATHS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];

export interface WorktreeIdentity {
  path: string;
  gitDir: string;
  commonDir: string;
  locked: boolean;
}

export type WorktreeIdentityResult =
  | { status: "missing" }
  | { status: "identified"; identity: WorktreeIdentity }
  | { status: "preserve"; reasons: string[] };

export function worktreePreservedError(
  worktreePath: string,
  reasons: readonly string[],
): WorkspaceError {
  return new WorkspaceError(
    WORKTREE_PRESERVED_CODE,
    `Kept ${worktreePath}: ${reasons.join("; ")}. Commit and push the work, or remove the worktree yourself; bb retries the removal automatically.`,
  );
}

export function isWorktreePreservedError(
  error: unknown,
): error is WorkspaceError {
  return (
    error instanceof WorkspaceError && error.code === WORKTREE_PRESERVED_CODE
  );
}

function errorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function signalOptions(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
} {
  return signal !== undefined ? { signal } : {};
}

function isStrictlyInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function entryExists(target: string): Promise<boolean | null> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT" ? false : null;
  }
}

export function gitEnvironment(worktreePath: string): NodeJS.ProcessEnv {
  return { GIT_CEILING_DIRECTORIES: path.dirname(worktreePath) };
}

export async function identifyWorktree(args: {
  path: string;
  rootPath: string;
  signal?: AbortSignal | undefined;
}): Promise<WorktreeIdentityResult> {
  const target = path.resolve(args.path);
  let info;
  try {
    info = await fs.lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "preserve",
      reasons: [`could not be inspected (${describeError(error)})`],
    };
  }
  if (info.isSymbolicLink()) {
    return { status: "preserve", reasons: ["is a symbolic link"] };
  }
  if (!info.isDirectory()) {
    return { status: "preserve", reasons: ["is not a directory"] };
  }

  let real: string;
  let rootReal: string;
  try {
    real = await fs.realpath(target);
    rootReal = await fs.realpath(args.rootPath);
  } catch (error) {
    return {
      status: "preserve",
      reasons: [`could not be resolved (${describeError(error)})`],
    };
  }
  if (!isStrictlyInside(rootReal, real)) {
    return {
      status: "preserve",
      reasons: [`is outside the managed worktree directory ${rootReal}`],
    };
  }

  const revParse = await runGit(
    [
      "--no-optional-locks",
      "rev-parse",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ],
    {
      cwd: real,
      env: gitEnvironment(real),
      allowFailure: true,
      ...signalOptions(args.signal),
    },
  );
  const [toplevel, gitDir, commonDir, ...extra] = revParse.stdout
    .trimEnd()
    .split("\n");
  if (
    revParse.exitCode !== 0 ||
    !toplevel ||
    !gitDir ||
    !commonDir ||
    extra.length > 0
  ) {
    return {
      status: "preserve",
      reasons: [
        `is not a Git worktree root${revParse.stderr.trim() ? ` (${revParse.stderr.trim()})` : ""}`,
      ],
    };
  }

  let toplevelReal: string;
  let gitDirReal: string;
  let commonDirReal: string;
  try {
    toplevelReal = await fs.realpath(path.resolve(real, toplevel));
    gitDirReal = await fs.realpath(path.resolve(real, gitDir));
    commonDirReal = await fs.realpath(path.resolve(real, commonDir));
  } catch (error) {
    return {
      status: "preserve",
      reasons: [`has unresolvable Git metadata (${describeError(error)})`],
    };
  }
  if (toplevelReal !== real) {
    return {
      status: "preserve",
      reasons: [`is not the root of its Git checkout (${toplevelReal})`],
    };
  }
  if (gitDirReal === commonDirReal) {
    return {
      status: "preserve",
      reasons: ["is a main checkout, not a linked worktree"],
    };
  }

  const list = await runGit(
    ["--git-dir", commonDirReal, "worktree", "list", "--porcelain", "-z"],
    {
      cwd: real,
      env: gitEnvironment(real),
      allowFailure: true,
      ...signalOptions(args.signal),
    },
  );
  if (list.exitCode !== 0) {
    return {
      status: "preserve",
      reasons: [
        `could not be matched to its repository's worktree list${list.stderr.trim() ? ` (${list.stderr.trim()})` : ""}`,
      ],
    };
  }
  for (const entry of parseWorktreeListPorcelain(list.stdout)) {
    let entryReal: string;
    try {
      entryReal = await fs.realpath(entry.path);
    } catch {
      continue;
    }
    if (entryReal !== real) continue;
    if (entry.isMain || entry.isBare) {
      return {
        status: "preserve",
        reasons: ["is the repository's main checkout"],
      };
    }
    return {
      status: "identified",
      identity: {
        path: real,
        gitDir: gitDirReal,
        commonDir: commonDirReal,
        locked: entry.locked,
      },
    };
  }
  return {
    status: "preserve",
    reasons: [`is not registered in the worktree list of ${commonDirReal}`],
  };
}

export async function findStructuralReasons(
  identity: WorktreeIdentity,
): Promise<string[]> {
  const reasons: string[] = [];
  if (identity.locked) {
    reasons.push("is locked (git worktree lock)");
  }

  const marker = await entryExists(
    path.join(identity.path, KEEP_WORKTREE_MARKER),
  );
  if (marker === true) {
    reasons.push(`contains ${KEEP_WORKTREE_MARKER}`);
  } else if (marker === null) {
    reasons.push(`could not check for ${KEEP_WORKTREE_MARKER}`);
  }

  for (const name of IN_PROGRESS_OPERATION_PATHS) {
    const present = await entryExists(path.join(identity.gitDir, name));
    if (present === true) {
      reasons.push(`has a Git operation in progress (${name})`);
    } else if (present === null) {
      reasons.push(`could not check for a Git operation in progress (${name})`);
    }
  }
  return reasons;
}

const FETCH_TIMEOUT_MS = 60_000;
const FETCH_MEMO_MS = 30_000;
const fetchMemo = new Map<
  string,
  { settledAt: number | null; outcome: Promise<string | null> }
>();

export function clearFetchMemo(): void {
  fetchMemo.clear();
}

function fetchRemotesOncePerRepository(
  commonDir: string,
  memoMs: number,
  run: () => Promise<string | null>,
): Promise<string | null> {
  const known = fetchMemo.get(commonDir);
  if (
    known !== undefined &&
    (known.settledAt === null || Date.now() - known.settledAt < memoMs)
  )
    return known.outcome;
  const entry = {
    settledAt: null as number | null,
    outcome: run().finally(() => {
      entry.settledAt = Date.now();
    }),
  };
  fetchMemo.set(commonDir, entry);
  return entry.outcome;
}
const BATCH_MODE_OPTION = "-o BatchMode=yes";
const NON_INTERACTIVE_FETCH_ENVIRONMENT: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  SSH_ASKPASS_REQUIRE: "never",
  GCM_INTERACTIVE: "never",
};

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function nonInteractiveFetchEnvironment(
  environment: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv,
  configuredSshCommand: string | null,
): NodeJS.ProcessEnv {
  const sshCommand =
    inherited.GIT_SSH_COMMAND ??
    configuredSshCommand ??
    (inherited.GIT_SSH !== undefined && inherited.GIT_SSH !== ""
      ? shellQuote(inherited.GIT_SSH)
      : "ssh");
  return {
    ...environment,
    ...NON_INTERACTIVE_FETCH_ENVIRONMENT,
    GIT_SSH_COMMAND: `${sshCommand} ${BATCH_MODE_OPTION}`,
  };
}
const STASH_SUBJECT = /^(?:WIP on|On) ([^:]+): /;

function stashBranch(subject: string): string | null {
  return STASH_SUBJECT.exec(subject)?.[1] ?? null;
}

const BRANCH_CREATED = "branch: Created from";

async function findZeroCommitBase(
  branchName: string,
  gitOptions: Parameters<typeof runGit>[1],
): Promise<string | null> {
  const head = await runGit(
    ["--no-optional-locks", "rev-parse", "HEAD"],
    gitOptions,
  );
  if (head.exitCode !== 0) return null;
  const reflog = await runGit(
    [
      "--no-optional-locks",
      "reflog",
      "show",
      "--format=%H%x09%gs",
      `refs/heads/${branchName}`,
    ],
    gitOptions,
  );
  if (reflog.exitCode !== 0) return null;
  const entries = reflog.stdout.split("\n").filter((line) => line !== "");
  const oldest = entries[entries.length - 1];
  if (oldest === undefined) return null;
  const [sha, subject] = oldest.split("\t");
  if (sha === undefined || subject === undefined) return null;
  if (!subject.startsWith(BRANCH_CREATED)) return null;
  return sha === head.stdout.trim() ? sha : null;
}

export async function findPreservationReasons(
  identity: WorktreeIdentity,
  signal: AbortSignal | undefined,
  options: {
    fetchRemotes?: boolean;
    fetchTimeoutMs?: number;
    fetchMemoMs?: number;
  } = {},
): Promise<string[]> {
  const reasons = await findStructuralReasons(identity);
  const gitOptions = {
    cwd: identity.path,
    env: gitEnvironment(identity.path),
    allowFailure: true,
    ...signalOptions(signal),
  };

  const status = await runGit(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    gitOptions,
  );
  if (status.exitCode !== 0) {
    reasons.push(
      `could not read its Git status${status.stderr.trim() ? ` (${status.stderr.trim()})` : ""}`,
    );
  } else if (status.stdout !== "") {
    reasons.push("has uncommitted changes or untracked files");
  }

  const head = await runGit(
    ["--no-optional-locks", "symbolic-ref", "--short", "-q", "HEAD"],
    gitOptions,
  );
  const branchName = head.exitCode === 0 ? head.stdout.trim() : null;
  const stashes = await runGit(
    ["--no-optional-locks", "stash", "list", "--format=%gs"],
    gitOptions,
  );
  if (stashes.exitCode !== 0) {
    reasons.push(
      `could not list its stashes${stashes.stderr.trim() ? ` (${stashes.stderr.trim()})` : ""}`,
    );
  } else {
    const own = stashes.stdout
      .split("\n")
      .filter(
        (subject) => stashBranch(subject) === (branchName ?? "(no branch)"),
      );
    if (own.length > 0) {
      reasons.push(
        `has ${own.length} stashed change${own.length === 1 ? "" : "s"} (git stash)`,
      );
    }
  }

  if (options.fetchRemotes !== false) {
    const fetchReason = await fetchRemotesOncePerRepository(
      identity.commonDir,
      options.fetchMemoMs ?? FETCH_MEMO_MS,
      async () => {
        try {
          const configured = await runGit(
            ["--no-optional-locks", "config", "--get", "core.sshCommand"],
            gitOptions,
          );
          const fetched = await runGit(
            [
              "-c",
              "credential.helper=",
              "fetch",
              "--all",
              "--quiet",
              "--no-tags",
            ],
            {
              ...gitOptions,
              env: nonInteractiveFetchEnvironment(
                gitOptions.env,
                process.env,
                configured.exitCode === 0 && configured.stdout.trim() !== ""
                  ? configured.stdout.trim()
                  : null,
              ),
              timeoutMs: options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
            },
          );
          return fetched.exitCode === 0
            ? null
            : `could not fetch its remotes to verify its commits are published${fetched.stderr.trim() ? ` (${fetched.stderr.trim()})` : ""}`;
        } catch (error) {
          return `could not fetch its remotes to verify its commits are published (${describeError(error)})`;
        }
      },
    );
    if (fetchReason !== null) reasons.push(fetchReason);
  }

  const zeroCommitBase =
    branchName === null
      ? null
      : await findZeroCommitBase(branchName, gitOptions);
  if (zeroCommitBase !== null) {
    const baseUnpublished = await runGit(
      [
        "--no-optional-locks",
        "rev-list",
        "--max-count=1",
        zeroCommitBase,
        "--not",
        "--remotes",
      ],
      gitOptions,
    );
    if (baseUnpublished.exitCode !== 0) {
      reasons.push(
        `could not verify its base commit ${zeroCommitBase} is published${baseUnpublished.stderr.trim() ? ` (${baseUnpublished.stderr.trim()})` : ""}`,
      );
    } else if (baseUnpublished.stdout.trim() !== "") {
      reasons.push(
        `its base commit ${zeroCommitBase} is not reachable from any remote-tracking branch, so the branch holds no commit of its own but starts from work that was never published`,
      );
    }
  } else {
    const unpublished = await runGit(
      [
        "--no-optional-locks",
        "rev-list",
        "--max-count=1",
        "HEAD",
        "--not",
        "--remotes",
      ],
      gitOptions,
    );
    if (unpublished.exitCode !== 0) {
      reasons.push(
        `could not verify its commits are published${unpublished.stderr.trim() ? ` (${unpublished.stderr.trim()})` : ""}`,
      );
    } else if (unpublished.stdout.trim() !== "") {
      const upstream =
        branchName === null
          ? null
          : await runGit(
              [
                "--no-optional-locks",
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                `${branchName}@{upstream}`,
              ],
              gitOptions,
            );
      reasons.push(
        branchName !== null && upstream !== null && upstream.exitCode !== 0
          ? `its branch ${branchName} has no upstream and has commits that are not reachable from any remote-tracking branch`
          : "has commits that are not reachable from any remote-tracking branch",
      );
    }
  }
  const holderReason = describeHolderScan(
    await scanWorktreeHolders(identity.path),
  );
  if (holderReason !== null) reasons.push(holderReason);
  return reasons;
}
