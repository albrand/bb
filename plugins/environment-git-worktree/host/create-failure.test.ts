import { WorkspaceError } from "bb-environment-provider-host/git";
import { describe, expect, it } from "vitest";
import { classifyCreateFailure, markCreateFailure } from "./create-failure.js";
import { WORKTREE_PRESERVED_CODE } from "./worktree-preservation.js";

describe("classifyCreateFailure", () => {
  it("reports a preserved workspace at the target and a named kept path", () => {
    expect(
      classifyCreateFailure(
        new WorkspaceError(WORKTREE_PRESERVED_CODE, "kept"),
        "/data/worktrees/a/repo",
      ),
    ).toEqual({ kind: "kept", path: "/data/worktrees/a/repo" });
    expect(
      classifyCreateFailure(
        new WorkspaceError("target_exists_preserved", "x", {
          keptPath: "/elsewhere",
        }),
        "/data/worktrees/a/repo",
      ),
    ).toEqual({ kind: "kept", path: "/elsewhere" });
  });

  it("says nothing was kept only for a marked cleanup success or a failure that happens before anything is created", () => {
    expect(
      classifyCreateFailure(markCreateFailure(new Error("hook"), "nothing"), "/t"),
    ).toEqual({ kind: "nothing" });
    expect(
      classifyCreateFailure(new WorkspaceError("not_git_repo", "x"), "/t"),
    ).toEqual({ kind: "nothing" });
  });

  it("is unknown when cleanup itself failed, for an unmarked error and for an abort", () => {
    expect(
      classifyCreateFailure(markCreateFailure(new Error("rm failed"), "unknown"), "/t"),
    ).toEqual({ kind: "unknown" });
    expect(classifyCreateFailure(new Error("boom"), "/t")).toEqual({
      kind: "unknown",
    });
    expect(classifyCreateFailure("a string", "/t")).toEqual({ kind: "unknown" });
  });
});
