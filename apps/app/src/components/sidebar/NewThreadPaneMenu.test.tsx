// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { LayoutNode, SplitLayout } from "@/lib/split-layout";
import { ProjectListNewThreadAction } from "./ProjectList";

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandRunner: () => ({
    dispatch: vi.fn(),
    isCommandAvailable: () => true,
  }),
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));

afterEach(cleanup);

function pane(paneId: string, threadId: string): LayoutNode {
  return {
    type: "pane",
    paneId,
    content: { kind: "thread", projectId: "p1", threadId },
  };
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

function renderNewThreadAction(
  layout: SplitLayout | null,
  { splitDraggable = true }: { splitDraggable?: boolean } = {},
) {
  const openInSplit = vi.fn();
  const onNewChat = vi.fn();
  const store = createStore();
  store.set(splitLayoutAtom, layout);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  render(
    <ProjectListNewThreadAction
      splitEnabled
      newThreadSplit={{
        openInSplit,
        ...(splitDraggable ? { onPointerDown: vi.fn() } : {}),
      }}
      onNewChat={onNewChat}
    />,
    { wrapper },
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: /New thread/ }));
  return { openInSplit, onNewChat };
}

describe("New thread pane affordances", () => {
  it("opens a new-thread pane beside from the context menu", () => {
    const { openInSplit } = renderNewThreadAction(null);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "New thread beside" }),
    );
    expect(openInSplit).toHaveBeenCalledWith("right");
  });

  it.each([
    ["New thread above", "top"],
    ["New thread below", "bottom"],
  ])("opens %s from the submenu", (label, side) => {
    const { openInSplit } = renderNewThreadAction(null);
    fireEvent.click(
      screen.getByRole("menuitem", { name: /New thread above or below/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(openInSplit).toHaveBeenCalledWith(side);
  });

  it("explains the pane limit rather than offering a silent replace", () => {
    renderNewThreadAction(eightPanes());
    expect(
      screen.queryByRole("menuitem", { name: "New thread beside" }),
    ).toBeNull();
    expect(screen.getByText(/8 of 8 open/)).not.toBeNull();
    expect(screen.getByText(/Close a pane/)).not.toBeNull();
  });

  it("offers no pane actions on a surface that cannot split", () => {
    renderNewThreadAction(null, { splitDraggable: false });
    expect(
      screen.queryByRole("menuitem", { name: "New thread beside" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /New thread above or below/ }),
    ).toBeNull();
  });
});
