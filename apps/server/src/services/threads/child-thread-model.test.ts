import { describe, expect, it } from "vitest";
import { childThreadDefaultModel } from "./child-thread-model.js";

describe("childThreadDefaultModel", () => {
  it("gives a Claude child with no requested model Sonnet 5.5", () => {
    expect(
      childThreadDefaultModel({
        parentThreadId: "thr_parent",
        providerId: "claude-code",
        requestedModel: null,
      }),
    ).toBe("claude-sonnet-5-5");
  });

  it("keeps an explicitly requested model", () => {
    expect(
      childThreadDefaultModel({
        parentThreadId: "thr_parent",
        providerId: "claude-code",
        requestedModel: "claude-opus-5-5",
      }),
    ).toBeNull();
  });

  it("leaves top-level threads on the project or catalog default", () => {
    expect(
      childThreadDefaultModel({
        parentThreadId: undefined,
        providerId: "claude-code",
        requestedModel: null,
      }),
    ).toBeNull();
  });

  it("leaves children of other providers alone", () => {
    expect(
      childThreadDefaultModel({
        parentThreadId: "thr_parent",
        providerId: "codex",
        requestedModel: null,
      }),
    ).toBeNull();
  });
});
