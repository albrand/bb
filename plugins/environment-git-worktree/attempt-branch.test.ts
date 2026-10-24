import { describe, expect, it } from "vitest";
import { attemptBranchName, branchBelongsToAttempt } from "./attempt-branch.js";

describe("attempt branch names", () => {
  it("keeps attempt 1 as suggested and appends a separator slugs cannot produce for later attempts", () => {
    expect(attemptBranchName("bb/fix-thr_a", "thr_a", 1)).toBe("bb/fix-thr_a");
    expect(attemptBranchName("bb/fix-thr_a", "thr_a", 2)).toBe(
      "bb/fix-thr_a.r2",
    );
    expect(attemptBranchName("bb/thr_a", "thr_a", 3)).toBe("bb/thr_a.r3");
  });

  it("refuses to name an attempt branch for a suggestion that does not end in the thread id", () => {
    expect(attemptBranchName("bb/other", "thr_a", 2)).toBeNull();
    expect(attemptBranchName("bb/xthr_a", "thr_a", 2)).toBeNull();
  });

  it.each([
    ["bb/player2-thr_a", 1, true],
    ["bb/fix-r2-thr_a", 1, true],
    ["bb/fix-r2-thr_a", 2, false],
    ["bb/fix-thr_a.r2", 2, true],
    ["bb/fix-thr_a.r2", 1, false],
    ["bb/fix-thr_a.r12", 2, false],
    ["bb/fix-thr_ab", 1, false],
    ["bb/fix-xthr_a", 1, false],
  ] as const)("matches %s for attempt %i: %s", (branch, attempt, expected) => {
    expect(branchBelongsToAttempt(branch, "thr_a", attempt)).toBe(expected);
  });
});
