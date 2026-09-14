import { describe, expect, it } from "vitest";
import { INHERITED_EVENT_TYPES } from "../../src/services/threads/thread-fork-history.js";

describe("fork history inheritance", () => {
  it("never inherits token usage events", () => {
    expect(INHERITED_EVENT_TYPES).not.toContain("thread/tokenUsage/updated");
  });
});
