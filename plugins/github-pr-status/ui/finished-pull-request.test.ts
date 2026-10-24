import { describe, expect, it } from "vitest";
import { isFinishedPullRequest } from "./finished-pull-request";

describe("isFinishedPullRequest", () => {
  it("treats closed and merged as finished", () => {
    expect(isFinishedPullRequest({ state: "closed" })).toBe(true);
    expect(isFinishedPullRequest({ state: "merged" })).toBe(true);
  });

  it("leaves open and draft alone", () => {
    expect(isFinishedPullRequest({ state: "open" })).toBe(false);
    expect(isFinishedPullRequest({ state: "draft" })).toBe(false);
  });
});
