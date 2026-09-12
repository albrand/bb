import { SPEND_PRUNE_SAFE_SEQUENCE } from "@bb/db";
import { describe, expect, it } from "vitest";
import { KEEP_RECENT_BY_MODE } from "../../src/services/system/event-pruning.js";

// Fork (albrand/bb): the spend rollup calls a thread's usage history complete
// when the pruner provably cannot have run on it. That proof rests on the
// pruner's own arithmetic, which lives in another package, so it is pinned here
// rather than restated in a comment.
describe("spend prune-safe window", () => {
  it("matches the smallest keep-recent window the pruner uses", () => {
    // `sequenceCutoff = Math.max(0, latestSequence - keepRecent)`, and every
    // prune step returns 0 when that cutoff is not positive. So a thread whose
    // latest sequence is at or below the SMALLEST window cannot have lost a
    // usage event in any pruning mode.
    expect(SPEND_PRUNE_SAFE_SEQUENCE).toBe(
      Math.min(...Object.values(KEEP_RECENT_BY_MODE)),
    );
  });
});
