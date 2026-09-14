import { SPEND_PRUNE_SAFE_SEQUENCE } from "@bb/db";
import { describe, expect, it } from "vitest";
import { KEEP_RECENT_BY_MODE } from "../../src/services/system/event-pruning.js";

describe("spend prune-safe window", () => {
  it("matches the smallest keep-recent window the pruner uses", () => {
    expect(SPEND_PRUNE_SAFE_SEQUENCE).toBe(
      Math.min(...Object.values(KEEP_RECENT_BY_MODE)),
    );
  });
});
