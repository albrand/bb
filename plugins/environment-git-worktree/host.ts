import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { readdir } from "node:fs/promises";
import { createHostProgress } from "bb-environment-provider-host/progress";
import { worktreeHostContract, worktreeHostSignals } from "./contract.js";
import {
  readDefaultBranchRefs,
  WorkspaceError,
} from "bb-environment-provider-host/git";
import {
  resolveDefaultWorktreeBaseBranch,
  resolveWorktreeBaseBranch,
} from "./host/base-branch.js";
import {
  resolveWorktreeChildPath,
  resolveRetainedRoot,
  resolveWorktreesRoot,
  resolveWorktreeAttemptRoot,
  resolveWorktreeTargetPath,
} from "./host/paths.js";
import {
  createWorktree,
  inspectWorktreeRemoval,
  listAdoptableWorktrees,
  removeWorktree,
  resolveAdoptableWorktree,
} from "./host/worktree.js";
import { classifyCreateFailure } from "./host/create-failure.js";
import { proveRetentionAbsent } from "./host/retention-proof.js";
import { isWorktreePreservedError } from "./host/worktree-preservation.js";

function completionPathForWorktree(worktreePath: string): string {
  return `${worktreePath}.completed`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RemovalOutcome {
  removed: string[];
  kept: string[];
  unknown: string[];
  untouched: string[];
}

function describeRemovalOutcome(outcome: RemovalOutcome): string {
  const lines = ["Worktree removal stopped part-way."];
  if (outcome.removed.length > 0) {
    lines.push(`Removed: ${outcome.removed.join(", ")}.`);
  }
  if (outcome.kept.length > 0) {
    lines.push(...outcome.kept);
  }
  if (outcome.unknown.length > 0) {
    lines.push(`Unknown state after an error: ${outcome.unknown.join("; ")}.`);
  }
  if (outcome.untouched.length > 0) {
    lines.push(`Not attempted: ${outcome.untouched.join(", ")}.`);
  }
  return lines.join("\n");
}

async function removalTargets(
  dataDir: string,
  input: { pathKey: string; path: string | null },
): Promise<string[]> {
  return input.path === null
    ? await worktreePathsForPathKey({ dataDir, pathKey: input.pathKey })
    : [input.path];
}

async function findProtectedTargets(
  targets: readonly string[],
  attemptRoot: string,
  signal: AbortSignal,
): Promise<string[]> {
  const refusals: string[] = [];
  for (const target of targets) {
    const inspection = await inspectWorktreeRemoval({
      path: target,
      rootPath: attemptRoot,
      signal,
    });
    if (inspection.status === "protected") {
      refusals.push(inspection.message);
    }
  }
  return refusals;
}

async function worktreePathsForPathKey(args: {
  dataDir: string;
  pathKey: string;
}): Promise<string[]> {
  const root = resolveWorktreeAttemptRoot(args);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => (left.name < right.name ? -1 : 1))
      .map((entry) =>
        resolveWorktreeChildPath({
          dataDir: args.dataDir,
          pathKey: args.pathKey,
          childName: entry.name,
        }),
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function createWorktreeHostEntry() {
  return experimental_defineHostEntry({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
    handlers: {
      async defaultBaseBranch(input) {
        const refs = await readDefaultBranchRefs(input.sourcePath);
        return {
          branch: resolveDefaultWorktreeBaseBranch({
            defaultBranch: refs.defaultBranch ?? null,
            originDefaultBranch: refs.originDefaultBranch ?? null,
            defaultBranchRelation: refs.defaultBranchRelation ?? null,
          }),
        };
      },
      async listWorktrees(input, context) {
        const worktrees = await listAdoptableWorktrees({
          sourcePath: input.sourcePath,
          managedRoot: resolveWorktreesRoot(context.experimental_paths.dataDir),
        });
        return {
          worktrees: worktrees.map((entry) => ({
            path: entry.path,
            branch: entry.branch,
            locked: entry.locked,
            prunable: entry.prunable,
          })),
        };
      },
      async resolveExistingWorktree(input, context) {
        return resolveAdoptableWorktree({
          sourcePath: input.sourcePath,
          path: input.path,
          managedRoot: resolveWorktreesRoot(context.experimental_paths.dataDir),
        });
      },
      async create(input, context) {
        const targetPath = resolveWorktreeTargetPath({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
          sourcePath: input.sourcePath,
        });
        try {
          const baseBranch = await resolveWorktreeBaseBranch(
            input.sourcePath,
            input.baseBranch,
          );
          const created = await createWorktree({
            sourcePath: input.sourcePath,
            targetPath,
            completionPath: completionPathForWorktree(targetPath),
            ownWorktreesRoot: resolveWorktreesRoot(
              context.experimental_paths.dataDir,
            ),
            retainedRoot: resolveRetainedRoot(
              context.experimental_paths.dataDir,
            ),
            branchName: input.branchName,
            baseBranch,
            branchMode: input.branchMode,
            ...(input.previousAttempt !== undefined
              ? {
                  previousAttempt: {
                    ...input.previousAttempt,
                    pathsForAttempt: (attempt: number) =>
                      (attempt <= 1
                        ? [
                            input.previousAttempt!.threadId,
                            `${input.previousAttempt!.threadId}-1`,
                          ]
                        : [`${input.previousAttempt!.threadId}-${attempt}`]
                      ).map((pathKey) =>
                        resolveWorktreeTargetPath({
                          dataDir: context.experimental_paths.dataDir,
                          pathKey,
                          sourcePath: input.sourcePath,
                        }),
                      ),
                  },
                }
              : {}),
            onProgress: createHostProgress({
              operationId: input.operationId,
              emit: (payload) =>
                context.experimental_emitSignal("progress", payload),
            }),
            signal: context.signal,
          });
          return { status: "created", path: created.path, baseBranch } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
            kept: classifyCreateFailure(error, targetPath),
          } as const;
        }
      },

      async proveRetentionAbsent(input, context) {
        return proveRetentionAbsent({
          ...input,
          dataDir: context.experimental_paths.dataDir,
          signal: context.signal,
        });
      },

      async inspect(input, context) {
        try {
          const targets = await removalTargets(
            context.experimental_paths.dataDir,
            input,
          );
          const refusals = await findProtectedTargets(
            targets,
            resolveWorktreeAttemptRoot({
              dataDir: context.experimental_paths.dataDir,
              pathKey: input.pathKey,
            }),
            context.signal,
          );
          return refusals.length === 0
            ? ({ status: "removable" } as const)
            : ({ status: "retained", message: refusals.join("\n") } as const);
        } catch (error) {
          if (context.signal.aborted) throw error;
          return { status: "failed", message: describeError(error) } as const;
        }
      },

      async remove(input, context) {
        try {
          const dataDir = context.experimental_paths.dataDir;
          const attemptRoot = resolveWorktreeAttemptRoot({
            dataDir,
            pathKey: input.pathKey,
          });
          const targets = await removalTargets(dataDir, input);
          const refusals = await findProtectedTargets(
            targets,
            attemptRoot,
            context.signal,
          );
          if (refusals.length > 0) {
            return {
              status: "retained",
              message: refusals.join("\n"),
            } as const;
          }
          const outcome: RemovalOutcome = {
            removed: [],
            kept: [],
            unknown: [],
            untouched: [],
          };
          const onProgress = createHostProgress({
            operationId: input.operationId,
            emit: (payload) =>
              context.experimental_emitSignal("progress", payload),
          });
          for (const [index, target] of targets.entries()) {
            try {
              await removeWorktree({
                path: target,
                rootPath: attemptRoot,
                completionPath: completionPathForWorktree(target),
                onProgress,
                signal: context.signal,
              });
              outcome.removed.push(target);
            } catch (error) {
              if (context.signal.aborted) throw error;
              if (isWorktreePreservedError(error)) {
                outcome.kept.push(error.message);
                continue;
              }
              outcome.unknown.push(`${target} (${describeError(error)})`);
              outcome.untouched.push(...targets.slice(index + 1));
              break;
            }
          }
          if (outcome.kept.length === 0 && outcome.unknown.length === 0) {
            return { status: "removed" } as const;
          }
          return {
            status: "failed",
            message: describeRemovalOutcome(outcome),
          } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return { status: "failed", message: describeError(error) } as const;
        }
      },
    },
  });
}

export default createWorktreeHostEntry();
