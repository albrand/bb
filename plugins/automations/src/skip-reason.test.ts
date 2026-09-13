import { describe, expect, it } from "vitest";
import { describeSkipReason } from "./skip-reason.js";

describe("describeSkipReason", () => {
  it("turns the stored runner keys into a sentence a person can read", () => {
    expect(describeSkipReason("wakeAgent false")).toBe(
      "Skipped, the script reported nothing to do",
    );
    expect(describeSkipReason("empty output")).toBe(
      "Skipped, the script produced no output",
    );
  });

  it("never hides an unknown reason", () => {
    expect(describeSkipReason("host offline")).toBe("Skipped, host offline");
  });
});
