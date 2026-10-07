import { describe, expect, it } from "vitest";
import { childThreadModel } from "./child-thread-model.js";

describe("childThreadModel", () => {
  it("runs a child on the model its provider declares for children", () => {
    expect(
      childThreadModel({
        parentThreadId: "thr_parent",
        declaredChildModel: "child-model",
      }),
    ).toBe("child-model");
  });

  it("leaves top-level threads, where orchestrators run, alone", () => {
    for (const parentThreadId of [null, undefined, ""]) {
      expect(
        childThreadModel({ parentThreadId, declaredChildModel: "child-model" }),
      ).toBeNull();
    }
  });

  it("leaves children of a provider that declares no child model alone", () => {
    for (const declaredChildModel of [null, undefined]) {
      expect(
        childThreadModel({ parentThreadId: "thr_parent", declaredChildModel }),
      ).toBeNull();
    }
  });
});
