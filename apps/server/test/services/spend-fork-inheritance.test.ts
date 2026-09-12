import { describe, expect, it } from "vitest";
import { INHERITED_EVENT_TYPES } from "../../src/services/threads/thread-fork-history.js";

// Fork (albrand/bb): a forked thread must not inherit its source's usage events.
//
// The fork copies history by inserting rows directly, not through the daemon
// append path, so the spend hook never sees them - but the BACKFILL scans stored
// events, so a copied usage event would be counted a second time under the
// fork's id and the same tokens would appear twice in a fleet total.
//
// Verified on a live database as well as here: no usage event on a forked thread
// is byte-identical to one on its source, and every one of them carries a
// non-null provider_thread_id while the copy path forces that field to null -
// so they were spent by the fork, not inherited. This pins the list, because
// adding the type to it would make the double count silent.
describe("fork history inheritance", () => {
  it("never inherits token usage events", () => {
    expect(INHERITED_EVENT_TYPES).not.toContain("thread/tokenUsage/updated");
  });
});
