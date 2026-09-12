// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { countPanes, findPaneByContent, listPanes } from "@/lib/split-layout";
import type { LayoutNode, PaneContent, SplitLayout } from "@/lib/split-layout";
import { usePaneContentSplitDrag } from "./usePaneContentSplitDrag";

const { navigateSpy, warnToastSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  warnToastSpy: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { warning: warnToastSpy },
}));

const NEW_THREAD_CONTENT: PaneContent = { kind: "new-thread" };

function pane(paneId: string, threadId: string): LayoutNode {
  return {
    type: "pane",
    paneId,
    content: { kind: "thread", projectId: "p1", threadId },
  };
}

function singlePane(): SplitLayout {
  return { root: pane("pane-1", "t1"), focusedPaneId: "pane-1" };
}

function eightPanes(): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: Array.from({ length: 8 }, () => 0.125),
      children: Array.from({ length: 8 }, (_, index) =>
        pane(`pane-${index + 1}`, `t${index + 1}`),
      ),
    },
    focusedPaneId: "pane-1",
  };
}

function renderNewThreadSplit(layout: SplitLayout) {
  const store = createStore();
  store.set(splitLayoutAtom, layout);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const { result } = renderHook(
    () =>
      usePaneContentSplitDrag({
        content: NEW_THREAD_CONTENT,
        enabled: true,
        label: "New thread",
      }),
    { wrapper },
  );
  return {
    store,
    openInSplit: (side?: "left" | "right" | "top" | "bottom") =>
      act(() => result.current.openInSplit(side)),
  };
}

describe("usePaneContentSplitDrag — the sidebar New thread control", () => {
  beforeEach(() => {
    navigateSpy.mockClear();
    warnToastSpy.mockClear();
  });

  it.each([
    ["top", "col", 0],
    ["bottom", "col", 1],
    ["right", "row", 1],
  ] as const)(
    "puts a real new-thread pane %s of the focused pane",
    (side, dir, index) => {
      const { store, openInSplit } = renderNewThreadSplit(singlePane());
      openInSplit(side);
      const layout = store.get(splitLayoutAtom);
      expect(countPanes(layout!.root)).toBe(2);
      const root = layout!.root;
      expect(root.type === "split" ? root.dir : null).toBe(dir);
      expect(
        root.type === "split" ? root.children[index] : null,
      ).toMatchObject({ content: NEW_THREAD_CONTENT });
      expect(findPaneByContent(root, NEW_THREAD_CONTENT)).not.toBeNull();
    },
  );

  it("refuses at the eight-pane cap instead of replacing the focused pane", () => {
    const seeded = eightPanes();
    const { store, openInSplit } = renderNewThreadSplit(seeded);
    openInSplit("right");
    expect(store.get(splitLayoutAtom)).toBe(seeded);
    expect(findPaneByContent(seeded.root, NEW_THREAD_CONTENT)).toBeNull();
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(warnToastSpy).toHaveBeenCalledTimes(1);
  });

  it("opens a SECOND new-thread pane instead of refocusing the first", () => {
    const layout: SplitLayout = {
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          pane("pane-1", "t1"),
          { type: "pane", paneId: "pane-2", content: NEW_THREAD_CONTENT },
        ],
      },
      focusedPaneId: "pane-1",
    };
    const { store, openInSplit } = renderNewThreadSplit(layout);
    openInSplit("bottom");
    const next = store.get(splitLayoutAtom);
    expect(countPanes(next!.root)).toBe(3);
    expect(
      listPanes(next!.root).filter(
        (candidate) => candidate.content.kind === "new-thread",
      ),
    ).toHaveLength(2);
  });
});
