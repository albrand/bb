import { describe, expect, it } from "vitest";
import { focusedPaneThread } from "./focusedPaneThread";
import type { SplitLayout } from "./types";

function layoutWith(content: SplitLayout["root"]): SplitLayout {
  return { root: content, focusedPaneId: "pane-2" };
}

const threadPane = {
  type: "pane" as const,
  paneId: "pane-2",
  content: {
    kind: "thread" as const,
    projectId: "proj_1",
    threadId: "thr_1",
  },
};

describe("focusedPaneThread", () => {
  it("finds the thread in the focused pane", () => {
    expect(focusedPaneThread(layoutWith(threadPane))).toEqual({
      projectId: "proj_1",
      threadId: "thr_1",
    });
  });

  it("ignores a focused pane that is not a thread", () => {
    expect(
      focusedPaneThread(
        layoutWith({
          type: "pane",
          paneId: "pane-2",
          content: { kind: "new-thread" },
        }),
      ),
    ).toBeNull();
  });

  it("returns null without a layout", () => {
    expect(focusedPaneThread(null)).toBeNull();
  });
});
