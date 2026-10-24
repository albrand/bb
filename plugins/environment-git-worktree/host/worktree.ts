import {
  createBranchAtPinnedTip,
  deleteCreatedBranch,
  describeContinuity,
  pinPreviousAttempt,
  type PinnedPreviousAttempt,
  type PreviousAttemptRequest,
} from "./previous-attempt.js";
import {
  findWorktreeEntry,
  parseWorktreeListPorcelain,
  selectAdoptableWorktrees,
  type GitWorktreeEntry,
} from "./worktree-list.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  beginCopy,
  fingerprintSource,
  inspectCreatedBy,
  describeRetainedCopies,
  recordCopy,
  retainCreatedCopies,
  type CreatedBy,
  type RetainedCopies,
  type SourceFingerprint,
} from "./created-by.js";
import {
  WORKTREE_PRESERVED_CODE,
  findPreservationReasons,
  identifyWorktree,
  isWorktreePreservedError,
  worktreePreservedError,
  type WorktreeIdentity,
} from "./worktree-preservation.js";
import { markCreateFailure } from "./create-failure.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  findWorktreeForBranch,
  getCurrentBranch,
  getGitCommonDir,
  hasRef,
  readDefaultBranch,
  readGitRepositoryState,
  runGit,
  WorkspaceError,
  type GitProcessOptions,
} from "bb-environment-provider-host/git";
import {
  ProcessLocalQueuedLockTimeoutError,
  runGitWithWorktreeMetadataLock,
  tryWithCheckoutMutationLock,
  withGitRefMutationLock,
  withWorktreeMetadataLock,
} from "bb-environment-provider-host/locks";
import {
  createProvisionCancelledError,
  emitCwd,
  emitGitOutput,
  emitOutput,
  emitStep,
  isProvisionAbortError,
  throwIfProvisionAborted,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";
import {
  copyWorktreeIncludeFiles,
  WORKTREE_INCLUDE_FILE_NAME,
  type CopyWorktreeIncludeFilesResult,
} from "./worktree-include.js";

export type BranchMode = "reset" | "reuse-existing";

interface CreateWorktreeArgs {
  sourcePath: string;
  targetPath: string;
  completionPath: string;
  ownWorktreesRoot: string;
  retainedRoot: string;
  branchName: string;
  previousAttempt?: PreviousAttemptRequest | undefined;
  baseBranch: string | null;
  branchMode: BranchMode;
  onProgress?: ProgressCallback | undefined;
  signal?: AbortSignal | undefined;
}

interface RemoveWorktreeArgs {
  path: string;
  rootPath: string;
  completionPath?: string | undefined;
  createdBy?: CreatedBy | undefined;
  branchName?: string | undefined;
  retainedRoot?: string | undefined;
  retention?: RetentionState | undefined;
  onProgress?: ProgressCallback | undefined;
  signal?: AbortSignal | undefined;
  fetchTimeoutMs?: number | undefined;
}

interface RetentionState {
  retained: RetainedCopies | null;
}

function appendToError(error: unknown, text: string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const combined = `${message}. ${text}`;
  if (!(error instanceof Error)) return new Error(combined, { cause: error });
  try {
    Object.defineProperty(error, "message", {
      value: combined,
      configurable: true,
      writable: true,
    });
    return error;
  } catch {
    return new Error(combined, { cause: error });
  }
}

function annotateRetained(
  error: unknown,
  retained: RetainedCopies | null,
): unknown {
  if (retained === null) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(retained.directory)) return error;
  return appendToError(error, describeRetainedCopies(retained));
}

export interface RemoveWorktreeResult {
  retained: RetainedCopies | null;
}

const REMOTE_BASE_FETCH_TIMEOUT_MS = 60_000;
const REMOTE_REF_LOCK_RETRY_INTERVAL_MS = 200;
const REMOTE_REF_LOCK_RETRY_TIMEOUT_MS = 2_000;
const WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT = 20;

type ConcurrentRemoteRefUpdateErrorKind = "stale-value" | "lock-file-exists";

function signalOptions(
  signal: AbortSignal | undefined,
): GitProcessOptions & { signal?: AbortSignal } {
  return signal !== undefined ? { signal } : {};
}

function classifyConcurrentRemoteRefUpdateError(
  error: unknown,
  remoteRef: string,
): ConcurrentRemoteRefUpdateErrorKind | null {
  if (
    !(error instanceof WorkspaceError) ||
    error.code !== "git_command_failed"
  ) {
    return null;
  }

  if (
    error.message.endsWith(
      `error: fetching ref ${remoteRef} failed: reference already exists`,
    )
  ) {
    return "lock-file-exists";
  }

  const lockFailurePrefix = `cannot lock ref '${remoteRef}': `;
  const lockFailureDetail = error.message.split(lockFailurePrefix)[1];
  if (lockFailureDetail === undefined) {
    return null;
  }

  if (
    /^is at [0-9a-f]+ but expected [0-9a-f]+(?:\n|$)/u.test(lockFailureDetail)
  ) {
    return "stale-value";
  }
  if (
    /^Unable to create '.+\.lock': File exists\.(?:\n|$)/u.test(
      lockFailureDetail,
    )
  ) {
    return "lock-file-exists";
  }
  return null;
}

async function ensureExistingWorkspaceMatches(
  targetPath: string,
  branchName: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await fs.access(targetPath);
  } catch {
    return false;
  }

  try {
    const currentBranch = await getCurrentBranch(targetPath);
    throwIfProvisionAborted(signal);
    return currentBranch === branchName;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

async function realpathOrResolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function isPathInside(root: string, target: string): Promise<boolean> {
  const relative = path.relative(
    await realpathOrResolved(root),
    await realpathOrResolved(target),
  );
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

async function refuseAbandonedAttemptWorktree(args: {
  sourcePath: string;
  ownWorktreesRoot: string;
  branchName: string;
}): Promise<void> {
  const holder = await findWorktreeForBranch(args.sourcePath, args.branchName);
  if (holder === null || !(await isPathInside(args.ownWorktreesRoot, holder))) {
    return;
  }
  throw new WorkspaceError(
    "abandoned_worktree_preserved",
    `Branch ${args.branchName} is still checked out at ${holder} by an earlier workspace, so it was left alone. bb removes a workspace only through its owner's cleanup; finish or remove ${holder} yourself, then retry.`,
    { keptPath: holder },
  );
}

async function ensureWorkspaceParentDirectory(
  targetPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

async function waitForProvisionRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await delay(
      delayMs,
      undefined,
      signal !== undefined ? { signal } : undefined,
    );
  } catch (error) {
    if (signal?.aborted) {
      throw createProvisionCancelledError(error);
    }
    throw error;
  }
}

async function resolveRemoteBaseBranch(
  sourcePath: string,
  baseBranch: string,
  signal: AbortSignal | undefined,
): Promise<{ remote: string; branch: string } | null> {
  if (!baseBranch.includes("/")) {
    return null;
  }

  const remotes = (
    await runGit(["remote"], {
      cwd: sourcePath,
      ...(signal !== undefined ? { signal } : {}),
    })
  ).stdout
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
  const matchingRemotes = remotes
    .filter(
      (remote) =>
        baseBranch.startsWith(`${remote}/`) &&
        baseBranch.length > remote.length + 1,
    )
    .sort((left, right) => right.length - left.length);
  const remote = matchingRemotes[0];
  if (!remote) {
    return null;
  }

  return {
    remote,
    branch: baseBranch.slice(remote.length + 1),
  };
}

export async function fetchRemoteBaseBranch(args: {
  sourcePath: string;
  baseBranch: string;
  onProgress: ProgressCallback | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const remoteBase = await resolveRemoteBaseBranch(
    args.sourcePath,
    args.baseBranch,
    args.signal,
  );
  if (!remoteBase) {
    return;
  }

  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "git-fetch-started",
    text: `Fetching ${args.baseBranch}`,
    status: "started",
    startedAt,
  });

  const remoteRef = `refs/remotes/${remoteBase.remote}/${remoteBase.branch}`;
  const refspec = `+refs/heads/${remoteBase.branch}:${remoteRef}`;
  const gitProcessOptions = signalOptions(args.signal);
  try {
    throwIfProvisionAborted(args.signal);
    const commonDir = await getGitCommonDir(args.sourcePath, gitProcessOptions);
    const fetchBaseBranch = async (): Promise<void> => {
      try {
        await withGitRefMutationLock(
          commonDir,
          () =>
            runGit(["fetch", "--quiet", remoteBase.remote, refspec], {
              cwd: args.sourcePath,
              ...gitProcessOptions,
              env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
              timeoutMs: REMOTE_BASE_FETCH_TIMEOUT_MS,
            }),
          args.signal !== undefined ? { signal: args.signal } : {},
        );
      } catch (error) {
        if (args.signal?.aborted && !isProvisionAbortError(error)) {
          throw createProvisionCancelledError(error);
        }
        if (error instanceof ProcessLocalQueuedLockTimeoutError) {
          throw new WorkspaceError(
            "git_command_timeout",
            `Timed out waiting to fetch ${args.baseBranch} because another Git ref update is still running`,
            { cause: error },
          );
        }
        throw error;
      }
    };
    let staleValueRetried = false;
    let lockFileRetryDeadline: number | undefined;
    while (true) {
      try {
        await fetchBaseBranch();
        break;
      } catch (error) {
        const errorKind = classifyConcurrentRemoteRefUpdateError(
          error,
          remoteRef,
        );
        if (errorKind === null) {
          throw error;
        }
        if (errorKind === "stale-value") {
          if (staleValueRetried) {
            throw error;
          }
          staleValueRetried = true;
          throwIfProvisionAborted(args.signal);
          continue;
        }

        lockFileRetryDeadline ??= Date.now() + REMOTE_REF_LOCK_RETRY_TIMEOUT_MS;
        const remainingRetryMs = lockFileRetryDeadline - Date.now();
        if (remainingRetryMs <= 0) {
          throw error;
        }
        throwIfProvisionAborted(args.signal);
        await waitForProvisionRetry(
          Math.min(REMOTE_REF_LOCK_RETRY_INTERVAL_MS, remainingRetryMs),
          args.signal,
        );
      }
    }
    emitStep({
      onProgress: args.onProgress,
      key: "git-fetch-completed",
      text: `Fetched ${args.baseBranch}`,
      status: "completed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
  } catch (error) {
    emitStep({
      onProgress: args.onProgress,
      key: "git-fetch-failed",
      text: `Failed to fetch ${args.baseBranch}`,
      status: "failed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
    throw error;
  }
}

function summarizePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT);
  const hiddenCount = paths.length - shown.length;
  const suffix = hiddenCount > 0 ? `, and ${hiddenCount} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

async function copyIncludedFiles(args: {
  sourcePath: string;
  targetPath: string;
  createdBy: CreatedBy | undefined;
  onProgress: ProgressCallback | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  throwIfProvisionAborted(args.signal);
  const startedAt = Date.now();
  let result: CopyWorktreeIncludeFilesResult;
  try {
    result = await copyWorktreeIncludeFiles({
      sourcePath: args.sourcePath,
      targetPath: args.targetPath,
      signal: args.signal,
      ...(args.createdBy !== undefined
        ? {
            ledger: {
              expect: fingerprintSource,
              begin: (relativePath: string) =>
                beginCopy(args.createdBy!, relativePath),
              record: (
                relativePath: string,
                file: string,
                expected: SourceFingerprint | null,
              ) => recordCopy(args.createdBy!, relativePath, file, expected),
            },
          }
        : {}),
    });
  } catch (error) {
    if (isProvisionAbortError(error)) {
      throw error;
    }
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Skipped ${WORKTREE_INCLUDE_FILE_NAME}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (!result.ran) {
    return;
  }

  for (const skipped of result.skipped.slice(
    0,
    WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT,
  )) {
    emitOutput(args.onProgress, "worktree-include", `Skipped ${skipped}`);
  }
  const hiddenSkipCount =
    result.skipped.length - WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT;
  if (hiddenSkipCount > 0) {
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Skipped ${hiddenSkipCount} more file(s)`,
    );
  }
  if (result.copied.length > 0) {
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Copied ${result.copied.length} file(s): ${summarizePaths(result.copied)}`,
    );
  }
  emitStep({
    onProgress: args.onProgress,
    key: "worktree-include-completed",
    text: `Copied ${result.copied.length} file(s) from ${WORKTREE_INCLUDE_FILE_NAME}`,
    status: "completed",
    startedAt,
    metadata: { durationMs: Date.now() - startedAt },
  });
}

async function readCompletedBranch(
  completionPath: string,
): Promise<string | null> {
  try {
    return (await fs.readFile(completionPath, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function finishWorktreeSetup(
  args: CreateWorktreeArgs,
  createdBy?: CreatedBy,
): Promise<void> {
  emitCwd({
    onProgress: args.onProgress,
    keySuffix: "target",
    cwd: args.targetPath,
  });
  await copyIncludedFiles({
    sourcePath: args.sourcePath,
    targetPath: args.targetPath,
    createdBy,
    onProgress: args.onProgress,
    signal: args.signal,
  });
  await fs.writeFile(args.completionPath, `${args.branchName}\n`, "utf8");
}

async function readCreatedBy(
  args: CreateWorktreeArgs,
): Promise<CreatedBy | undefined> {
  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: args.targetPath,
    allowFailure: true,
    ...signalOptions(args.signal),
  });
  const sha = head.stdout.trim();
  return head.exitCode === 0 && sha !== ""
    ? { head: sha, copies: new Map() }
    : undefined;
}

async function removeCreateTarget(
  args: CreateWorktreeArgs,
  retention: RetentionState = { retained: null },
  createdBy?: CreatedBy,
): Promise<RemoveWorktreeResult> {
  return await removeWorktree({
    path: args.targetPath,
    rootPath: args.ownWorktreesRoot,
    completionPath: args.completionPath,
    createdBy,
    branchName: args.branchName,
    retainedRoot: args.retainedRoot,
    retention,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
}

async function refuseExistingCreateTarget(
  args: CreateWorktreeArgs,
): Promise<void> {
  try {
    await fs.lstat(args.targetPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      await fs.rm(args.completionPath, { force: true });
      return;
    }
    throw error;
  }
  throw new WorkspaceError(
    "target_exists_preserved",
    `${args.targetPath} already exists and is not a workspace on branch ${args.branchName} that this create can reuse, so it was left alone. bb does not replace an existing workspace; finish or remove it yourself, then retry.`,
    { keptPath: args.targetPath },
  );
}

async function removeCreateTargetAfterFailure(
  args: CreateWorktreeArgs,
  failure: unknown,
  createdBy?: CreatedBy,
): Promise<never> {
  const retention: RetentionState = { retained: null };
  try {
    await removeCreateTarget(args, retention, createdBy);
  } catch (cleanupError) {
    if (
      retention.retained !== null &&
      !isWorktreePreservedError(cleanupError)
    ) {
      throw markCreateFailure(
        appendToError(
          cleanupError,
          `Create failed earlier: ${failure instanceof Error ? failure.message : String(failure)}`,
        ),
        "unknown",
      );
    }
    if (isWorktreePreservedError(cleanupError)) {
      throw new WorkspaceError(
        WORKTREE_PRESERVED_CODE,
        `${failure instanceof Error ? failure.message : String(failure)}. ${cleanupError.message}`,
        { cause: failure },
      );
    }
    throw markCreateFailure(cleanupError, "unknown");
  }
  if (retention.retained !== null) {
    throw new WorkspaceError(
      WORKTREE_PRESERVED_CODE,
      `${failure instanceof Error ? failure.message : String(failure)}. ${describeRetainedCopies(retention.retained)}`,
      { cause: failure },
    );
  }
  throw markCreateFailure(failure, "nothing");
}

export async function createWorktree(
  args: CreateWorktreeArgs,
): Promise<{ path: string }> {
  throwIfProvisionAborted(args.signal);
  const existingWorkspaceMatches = await ensureExistingWorkspaceMatches(
    args.targetPath,
    args.branchName,
    args.signal,
  );
  if (existingWorkspaceMatches) {
    if ((await readCompletedBranch(args.completionPath)) === args.branchName) {
      return { path: args.targetPath };
    }
    await finishWorktreeSetup(args);
    return { path: args.targetPath };
  }

  await refuseExistingCreateTarget(args);

  throwIfProvisionAborted(args.signal);
  switch (
    await readGitRepositoryState(args.sourcePath, signalOptions(args.signal))
  ) {
    case "not_git":
      throw new WorkspaceError(
        "not_git_repo",
        `Cannot create a worktree because the source is not a Git repository: ${args.sourcePath}. Initialize it and create at least one commit, then try again.`,
      );
    case "no_commits":
      throw new WorkspaceError(
        "unborn_head",
        `Cannot create a worktree because the repository has no commits: ${args.sourcePath}. Create an initial commit, then try again.`,
      );
    case "has_commits":
      break;
  }

  throwIfProvisionAborted(args.signal);
  await refuseAbandonedAttemptWorktree({
    sourcePath: args.sourcePath,
    ownWorktreesRoot: args.ownWorktreesRoot,
    branchName: args.branchName,
  });

  throwIfProvisionAborted(args.signal);
  const reuseExistingBranch =
    args.branchMode === "reuse-existing" &&
    (await hasRef(args.sourcePath, `refs/heads/${args.branchName}`));

  let gitArgs: string[];
  let pinned: PinnedPreviousAttempt | null = null;
  if (!reuseExistingBranch && args.previousAttempt !== undefined) {
    pinned = await pinPreviousAttempt({
      sourcePath: args.sourcePath,
      request: args.previousAttempt,
      signal: args.signal,
    });
  }
  if (reuseExistingBranch) {
    gitArgs = ["worktree", "add", args.targetPath, args.branchName];
  } else if (pinned !== null) {
    throwIfProvisionAborted(args.signal);
    await createBranchAtPinnedTip({
      sourcePath: args.sourcePath,
      pinned,
      newBranch: args.branchName,
    });
    gitArgs = ["worktree", "add", args.targetPath, args.branchName];
  } else {
    if (args.previousAttempt !== undefined) {
      emitOutput(
        args.onProgress,
        "worktree-continuity",
        "No earlier attempt of this thread left a branch or a workspace folder, so this attempt starts from the base branch; nothing from an earlier attempt could be lost.",
      );
    }
    if (await hasRef(args.sourcePath, `refs/heads/${args.branchName}`)) {
      throw new WorkspaceError(
        "branch_exists_preserved",
        `Branch ${args.branchName} already exists, so it was not reset to the base branch and its work is kept. Remove or rename that branch yourself, or retry so the create continues on its own attempt branch.`,
      );
    }
    const baseBranch =
      args.baseBranch ?? (await readDefaultBranch(args.sourcePath));
    if (!baseBranch) {
      throw new WorkspaceError(
        "missing_default_branch",
        `Cannot resolve default branch for source: ${args.sourcePath}`,
      );
    }
    throwIfProvisionAborted(args.signal);
    await fetchRemoteBaseBranch({
      sourcePath: args.sourcePath,
      baseBranch,
      onProgress: args.onProgress,
      signal: args.signal,
    });
    gitArgs = [
      "worktree",
      "add",
      "--no-track",
      "-b",
      args.branchName,
      args.targetPath,
      baseBranch,
    ];
  }

  const worktreeStartedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "git-worktree-started",
    text: "Creating worktree",
    status: "started",
    startedAt: worktreeStartedAt,
  });
  let worktreeCreated = false;
  let createdBy: CreatedBy | undefined;
  try {
    throwIfProvisionAborted(args.signal);
    await ensureWorkspaceParentDirectory(args.targetPath);
    const result = await runGitWithWorktreeMetadataLock(gitArgs, {
      cwd: args.sourcePath,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    emitGitOutput(args.onProgress, "git-worktree", result);
    emitStep({
      onProgress: args.onProgress,
      key: "git-worktree-completed",
      text: "Created worktree",
      status: "completed",
      startedAt: worktreeStartedAt,
      metadata: { durationMs: Date.now() - worktreeStartedAt },
    });
    worktreeCreated = true;
    if (pinned !== null) {
      emitOutput(
        args.onProgress,
        "worktree-continuity",
        await describeContinuity({
          sourcePath: args.sourcePath,
          pinned,
          newBranch: args.branchName,
        }),
      );
    }
    createdBy = await readCreatedBy(args);
    await finishWorktreeSetup(args, createdBy);
    return { path: args.targetPath };
  } catch (error) {
    if (!worktreeCreated && pinned !== null) {
      await deleteCreatedBranch({
        sourcePath: args.sourcePath,
        newBranch: args.branchName,
        sha: pinned.sha,
      });
    }
    if (!worktreeCreated) {
      emitStep({
        onProgress: args.onProgress,
        key: "git-worktree-failed",
        text: "Worktree setup failed",
        status: "failed",
        startedAt: worktreeStartedAt,
        metadata: { durationMs: Date.now() - worktreeStartedAt },
      });
    }
    return await removeCreateTargetAfterFailure(args, error, createdBy);
  }
}

async function removeDirectoryIfEmpty(pathToRemove: string): Promise<void> {
  try {
    await fs.rmdir(pathToRemove);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)
    ) {
      return;
    }

    throw error;
  }
}

async function assertWorktreeRemovable(
  identity: WorktreeIdentity,
  args: RemoveWorktreeArgs,
  options: { fetchRemotes?: boolean; fetchTimeoutMs?: number } = {},
): Promise<void> {
  const reasons =
    args.createdBy !== undefined
      ? (await inspectCreatedBy(identity, args.createdBy, args.signal)).reasons
      : await findPreservationReasons(identity, args.signal, options);
  if (reasons.length > 0) {
    throw worktreePreservedError(identity.path, reasons);
  }
}

async function removeRegisteredWorktree(
  identity: WorktreeIdentity,
  args: RemoveWorktreeArgs,
  retention: RetentionState,
): Promise<RemoveWorktreeResult> {
  if (args.createdBy !== undefined) {
    const kept = await retainCreatedCopies(
      identity,
      args.createdBy,
      args.retainedRoot,
    );
    retention.retained = kept.retained;
    const retained = retention.retained;
    if (kept.reasons.length > 0) {
      throw worktreePreservedError(identity.path, [
        ...kept.reasons,
        ...(retained !== null ? [describeRetainedCopies(retained)] : []),
      ]);
    }
    if (retained !== null) {
      try {
        await assertWorktreeRemovable(identity, args);
      } catch (error) {
        throw isWorktreePreservedError(error)
          ? new WorkspaceError(
              WORKTREE_PRESERVED_CODE,
              `${error.message} ${describeRetainedCopies(retained)}`,
              { cause: error },
            )
          : error;
      }
    }
  }
  const parentPath = path.dirname(identity.path);
  const removal = await withWorktreeMetadataLock(identity.commonDir, () =>
    runGit(
      ["--git-dir", identity.commonDir, "worktree", "remove", identity.path],
      {
        cwd: parentPath,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
        allowFailure: true,
      },
    ),
  );
  const retained = retention.retained;
  const keptNote = retained !== null ? [describeRetainedCopies(retained)] : [];
  if (removal.exitCode !== 0) {
    throw worktreePreservedError(identity.path, [
      `Git declined to remove it${removal.stderr.trim() ? ` (${removal.stderr.trim()})` : ""}`,
      ...keptNote,
    ]);
  }
  await removeDirectoryIfEmpty(identity.path);
  try {
    await fs.lstat(identity.path);
  } catch {
    return { retained };
  }
  throw worktreePreservedError(identity.path, [
    "still has files after Git removed the worktree",
    ...keptNote,
  ]);
}

export async function inspectWorktreeRemoval(args: {
  path: string;
  rootPath: string;
  signal?: AbortSignal | undefined;
}): Promise<
  { status: "removable" } | { status: "protected"; message: string }
> {
  const workspacePath = path.resolve(args.path);
  const identified = await identifyWorktree({
    path: workspacePath,
    rootPath: args.rootPath,
    signal: args.signal,
  });
  if (identified.status === "missing") {
    return { status: "removable" };
  }
  const reasons =
    identified.status === "preserve"
      ? identified.reasons
      : await findPreservationReasons(identified.identity, args.signal);
  return reasons.length === 0
    ? { status: "removable" }
    : {
        status: "protected",
        message: worktreePreservedError(workspacePath, reasons).message,
      };
}

export async function removeWorktree(
  args: RemoveWorktreeArgs,
): Promise<RemoveWorktreeResult> {
  const retention = args.retention ?? { retained: null };
  try {
    throwIfProvisionAborted(args.signal);
    const workspacePath = path.resolve(args.path);
    const parentPath = path.dirname(workspacePath);
    const identified = await identifyWorktree({
      path: workspacePath,
      rootPath: args.rootPath,
      signal: args.signal,
    });
    if (identified.status === "preserve") {
      throw worktreePreservedError(workspacePath, identified.reasons);
    }
    if (identified.status === "identified" && args.createdBy !== undefined) {
      throw worktreePreservedError(workspacePath, [
        `a failed create's workspace stays in place until its owner releases it and a durable retention record exists, and neither is available yet. ${args.branchName === undefined ? "Its branch is" : `Branch ${args.branchName} is`} left behind with it. Retrying this same create reuses the workspace where it is when it is still on that branch; bb does not start a second workspace or delete this one in the meantime`,
      ]);
    }
    if (identified.status === "identified") {
      const { identity } = identified;
      const removed = await tryWithCheckoutMutationLock(
        identity.path,
        async () => {
          await assertWorktreeRemovable(
            identity,
            args,
            args.fetchTimeoutMs === undefined
              ? {}
              : { fetchTimeoutMs: args.fetchTimeoutMs },
          );
          throwIfProvisionAborted(args.signal);
          throwIfProvisionAborted(args.signal);
          await assertWorktreeRemovable(identity, args, {
            fetchRemotes: false,
          });
          await removeRegisteredWorktree(identity, args, retention);
          return true;
        },
        args.signal,
        signalOptions(args.signal),
      );
      if (removed === null) {
        throw worktreePreservedError(workspacePath, [
          "its checkout lock could not be resolved",
        ]);
      }
    }
    if (args.completionPath !== undefined) {
      await fs.rm(args.completionPath, { force: true });
    }
    await removeDirectoryIfEmpty(parentPath);
    return { retained: retention.retained };
  } catch (error) {
    throw annotateRetained(error, retention.retained);
  }
}

export async function listGitWorktrees(args: {
  sourcePath: string;
  signal?: AbortSignal;
}): Promise<GitWorktreeEntry[]> {
  const result = await runGit(["worktree", "list", "--porcelain", "-z"], {
    cwd: args.sourcePath,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  return parseWorktreeListPorcelain(result.stdout);
}

export async function listAdoptableWorktrees(args: {
  sourcePath: string;
  managedRoot: string;
  signal?: AbortSignal;
}): Promise<GitWorktreeEntry[]> {
  const entries = await listGitWorktrees(args);
  return selectAdoptableWorktrees({
    entries,
    managedRoot: await realpathOrResolved(args.managedRoot),
  });
}

export async function resolveAdoptableWorktree(args: {
  sourcePath: string;
  path: string;
  managedRoot: string;
  signal?: AbortSignal;
}): Promise<
  | { status: "resolved"; path: string; branch: string | null }
  | { status: "failed"; message: string }
> {
  const adoptable = await listAdoptableWorktrees(args);
  const entry = findWorktreeEntry(
    adoptable,
    await realpathOrResolved(args.path),
  );
  if (entry === null) {
    return {
      status: "failed",
      message: `${args.path} is not a worktree of this repository that bb can adopt.`,
    };
  }
  if (entry.prunable) {
    return {
      status: "failed",
      message: `${args.path} is a prunable worktree; run \`git worktree prune\` or repair it first.`,
    };
  }
  return { status: "resolved", path: entry.path, branch: entry.branch };
}
