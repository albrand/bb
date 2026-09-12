// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeThread } from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { LayoutNode, SplitLayout } from "@/lib/split-layout";
import { ThreadActionsMenu } from "./ThreadActionsMenu";

const mocks = vi.hoisted(() => ({
  copyToClipboardWithToast: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: mocks.copyToClipboardWithToast,
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandShortcut: () => ({ label: "\u21e7\u2318B" }),
}));

vi.mock("./ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    archiveThreadAndChildren: vi.fn(),
    requestRename: vi.fn(),
    requestDelete: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
    unarchiveThread: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  mocks.copyToClipboardWithToast.mockReset();
});

describe("ThreadActionsMenu", () => {
  it("copies the canonical thread URL from every menu instance", () => {
    render(<ThreadActionsMenu thread={makeThread()} />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy thread link" }));

    expect(mocks.copyToClipboardWithToast).toHaveBeenCalledWith(
      `${window.location.origin}/projects/proj_test/threads/thr_test`,
      {
        successMessage: "Thread link copied",
        errorMessage: "Failed to copy thread link",
      },
    );
  });

  it("offers Open beside with its shortcut, and only when a split is available", () => {
    const onOpenInSplit = vi.fn();
    render(
      <ThreadActionsMenu thread={makeThread()} onOpenInSplit={onOpenInSplit} />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    const item = screen.getByRole("menuitem", { name: /Open beside/ });
    expect(item.textContent).toContain("\u21e7\u2318B");

    fireEvent.click(item);
    expect(onOpenInSplit).toHaveBeenCalledTimes(1);
  });

  it("hides Open beside when the surface cannot split", () => {
    render(<ThreadActionsMenu thread={makeThread()} />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );

    expect(screen.queryByRole("menuitem", { name: /Open beside/ })).toBeNull();
  });

  function pane(paneId: string, threadId: string): LayoutNode {
    return {
      type: "pane",
      paneId,
      content: { kind: "thread", projectId: "proj_test", threadId },
    };
  }

  function eightPanes(occupantPrefix: string): SplitLayout {
    return {
      root: {
        type: "split",
        dir: "row",
        sizes: Array.from({ length: 8 }, () => 0.125),
        children: Array.from({ length: 8 }, (_, index) =>
          pane(`pane-${index + 1}`, `${occupantPrefix}${index + 1}`),
        ),
      },
      focusedPaneId: "pane-1",
    };
  }

  function renderMenu(layout: SplitLayout | null, onOpenInSplit: () => void) {
    const store = createStore();
    store.set(splitLayoutAtom, layout);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    render(
      <ThreadActionsMenu thread={makeThread()} onOpenInSplit={onOpenInSplit} />,
      { wrapper },
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
  }

  it("asks for a right split from Open beside", () => {
    const onOpenInSplit = vi.fn();
    renderMenu(null, onOpenInSplit);
    fireEvent.click(screen.getByRole("menuitem", { name: /Open beside/ }));
    expect(onOpenInSplit).toHaveBeenCalledWith("right");
  });

  it.each([
    ["Open above", "top"],
    ["Open below", "bottom"],
  ])("asks for a %s split from the submenu", (label, side) => {
    const onOpenInSplit = vi.fn();
    renderMenu(null, onOpenInSplit);
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Open above or below/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(onOpenInSplit).toHaveBeenCalledWith(side);
  });

  it("explains the pane limit instead of offering an open that would replace a pane", () => {
    const onOpenInSplit = vi.fn();
    renderMenu(eightPanes("other"), onOpenInSplit);

    expect(screen.queryByRole("menuitem", { name: /Open beside/ })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Open above or below/ }),
    ).toBeNull();
    expect(screen.getByText(/8 of 8 open/)).not.toBeNull();
    expect(screen.getByText(/Close a pane/)).not.toBeNull();
  });

  it("keeps the open actions at the pane limit when the thread is already in a pane", () => {
    const onOpenInSplit = vi.fn();
    const layout = eightPanes("other");
    layout.root = {
      type: "split",
      dir: "row",
      sizes: Array.from({ length: 8 }, () => 0.125),
      children: Array.from({ length: 8 }, (_, index) =>
        pane(`pane-${index + 1}`, index === 4 ? "thr_test" : `other${index}`),
      ),
    };
    renderMenu(layout, onOpenInSplit);

    expect(
      screen.queryByRole("menuitem", { name: /Open beside/ }),
    ).not.toBeNull();
  });
});
