import { WorkspaceError } from "bb-environment-provider-host/git";
import { isWorktreePreservedError } from "./worktree-preservation.js";

export type CreateFailureKept =
  | { kind: "kept"; path: string }
  | { kind: "nothing" }
  | { kind: "unknown" };

const marks = new WeakMap<object, "nothing" | "unknown">();

const NOTHING_CODES = new Set([
  "not_git_repo",
  "unborn_head",
  "missing_default_branch",
  "branch_exists_preserved",
  "previous_attempt_unresolved",
  "previous_attempt_changed",
  "invalid_path_key",
  "invalid_source_path",
]);

export function markCreateFailure<T>(error: T, kind: "nothing" | "unknown"): T {
  if (typeof error === "object" && error !== null) marks.set(error, kind);
  return error;
}

export function classifyCreateFailure(
  error: unknown,
  targetPath: string,
): CreateFailureKept {
  if (isWorktreePreservedError(error)) return { kind: "kept", path: targetPath };
  if (error instanceof WorkspaceError && error.keptPath !== null)
    return { kind: "kept", path: error.keptPath };
  if (typeof error === "object" && error !== null) {
    const marked = marks.get(error);
    if (marked !== undefined) return { kind: marked };
  }
  if (error instanceof WorkspaceError && NOTHING_CODES.has(error.code))
    return { kind: "nothing" };
  return { kind: "unknown" };
}
