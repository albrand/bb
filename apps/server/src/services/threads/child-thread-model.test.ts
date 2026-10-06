import { describe, expect, it } from "vitest";
import { childThreadModel } from "./child-thread-model.js";

describe("childThreadModel", () => {
  it("runs a Claude child on Sonnet 5.5", () => {
    expect(
      childThreadModel({
        parentThreadId: "thr_parent",
        providerId: "claude-code",
      }),
    ).toBe("claude-sonnet-5-5");
  });

  it("leaves top-level threads, where orchestrators run, alone", () => {
    for (const parentThreadId of [null, undefined, ""]) {
      expect(
        childThreadModel({ parentThreadId, providerId: "claude-code" }),
      ).toBeNull();
    }
  });

  it("leaves children of other providers alone", () => {
    expect(
      childThreadModel({ parentThreadId: "thr_parent", providerId: "codex" }),
    ).toBeNull();
  });
});
