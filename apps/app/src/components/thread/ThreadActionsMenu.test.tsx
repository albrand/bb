// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import type { ReactNode } from "react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sidebarHiddenGroupsAtom,
  sidebarManualSectionOrderAtom,
  sidebarOrganizationModeAtom,
} from "@/components/sidebar/sidebarCollapsedAtoms";
import { makeThreadListEntry } from "../../../.ladle/story-fixtures";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { LayoutNode, SplitLayout } from "@/lib/split-layout";
import {
  ThreadActionsContextMenu,
  ThreadActionsMenu,
} from "./ThreadActionsMenu";
import {
  AppThreadSectionMoveProvider,
  ThreadSectionMoveProvider,
} from "./ThreadSectionMoveProvider";
import { useSidebarRename } from "../sidebar/SidebarInlineRename";

const moveThreadToSection = vi.hoisted(() => vi.fn());
const copyToClipboardWithToast = vi.hoisted(() => vi.fn());
const threadActions = vi.hoisted(() => ({
  archiveThreadAndChildren: vi.fn(),
  requestDelete: vi.fn(),
  requestRename: vi.fn(),
  togglePin: vi.fn(),
  toggleRead: vi.fn(),
  unarchiveThread: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast,
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({
  useMoveThreadToSection: () => moveThreadToSection,
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandShortcut: () => ({ label: "\u21e7\u2318B" }),
}));

vi.mock("./ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    ...threadActions,
    renameThread: vi.fn(),
  }),
}));

const destinations = [
  { label: "Planning", sectionId: "sec_planning" },
  { label: "Building", sectionId: "sec_building" },
  { label: "Threads", sectionId: null },
] as const;
const thread = makeThreadListEntry({
  id: "thread-1",
  pinnedAt: null,
  sectionId: "sec_planning",
  title: "Move me",
});

function renderWide(children: ReactNode, withMoveProvider = true) {
  const content = withMoveProvider ? (
    <ThreadSectionMoveProvider destinations={destinations}>
      {children}
    </ThreadSectionMoveProvider>
  ) : (
    children
  );
  return render(
    <CompactViewportOverrideProvider isCompactViewport={false}>
      {content}
    </CompactViewportOverrideProvider>,
  );
}

function renderCompact(children: ReactNode) {
  return render(
    <CompactViewportOverrideProvider isCompactViewport>
      <ThreadSectionMoveProvider destinations={destinations}>
        {children}
      </ThreadSectionMoveProvider>
    </CompactViewportOverrideProvider>,
  );
}

function InlineRenameMenuHarness({ context = false }: { context?: boolean }) {
  const rename = useSidebarRename({
    kind: "thread",
    id: thread.id,
    name: thread.title ?? "Thread",
    label: "Thread name",
    onSave: async () => {},
  });
  const row = (
    <div data-sidebar-rename-row="" data-testid="thread-row">
      <button type="button" data-sidebar-rename-anchor="">
        Open thread
      </button>
      {rename.editor ?? <span>{thread.title}</span>}
      {!context && (
        <ThreadActionsMenu
          thread={thread}
          onRename={rename.startEditingFromMenu}
          onCloseAutoFocus={rename.onCloseAutoFocus}
        />
      )}
    </div>
  );
  return context ? (
    <ThreadActionsContextMenu
      thread={thread}
      onRename={rename.startEditingFromMenu}
      onCloseAutoFocus={rename.onCloseAutoFocus}
      disabled={rename.isEditing}
    >
      {row}
    </ThreadActionsContextMenu>
  ) : (
    row
  );
}

async function openMoveSubmenu() {
  const trigger = await screen.findByRole("menuitem", {
    name: "Move to section",
  });
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  return screen.findByRole("menuitem", { name: "Building" });
}

afterEach(() => {
  cleanup();
  moveThreadToSection.mockReset();
  copyToClipboardWithToast.mockReset();
  for (const action of Object.values(threadActions)) {
    action.mockReset();
  }
});

describe("ThreadActionsMenu", () => {
  it("keeps the existing rename dialog for callers without an inline override", async () => {
    renderWide(<ThreadActionsMenu thread={thread} />);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    await waitFor(() => {
      expect(threadActions.requestRename).toHaveBeenCalledWith(thread);
    });
  });

  it.each([
    { compact: false, context: false },
    { compact: false, context: true },
    { compact: true, context: false },
    { compact: true, context: true },
  ])(
    "hands focus to inline rename ($compact, $context)",
    async ({ compact, context }) => {
      (compact ? renderCompact : renderWide)(
        <InlineRenameMenuHarness context={context} />,
      );
      if (context) {
        fireEvent.contextMenu(screen.getByTestId("thread-row"));
      } else {
        const trigger = screen.getByRole("button", { name: "Thread actions" });
        if (compact) fireEvent.click(trigger);
        else fireEvent.pointerDown(trigger, { button: 0 });
      }
      const item = await screen.findByRole("menuitem", { name: "Rename" });
      if (compact) fireEvent.click(item);
      else fireEvent.keyDown(item, { key: "Enter" });
      const input = await screen.findByRole("textbox", { name: "Thread name" });
      await waitFor(() => expect(document.activeElement).toBe(input));
      expect(input).toHaveProperty("value", "Move me");
      expect(threadActions.requestRename).not.toHaveBeenCalled();
    },
  );

  it("copies the canonical thread URL from every menu instance", () => {
    renderWide(<ThreadActionsMenu thread={thread} />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy thread link" }));

    expect(copyToClipboardWithToast).toHaveBeenCalledWith(
      `${window.location.origin}/projects/${thread.projectId}/threads/${thread.id}`,
      {
        successMessage: "Thread link copied",
        errorMessage: "Failed to copy thread link",
      },
    );
  });

  it("offers Open beside with its shortcut, and only when a split is available", () => {
    const onOpenInSplit = vi.fn();
    render(
      <ThreadActionsMenu thread={thread} onOpenInSplit={onOpenInSplit} />,
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
    render(<ThreadActionsMenu thread={thread} />);

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
      content: { kind: "thread", projectId: thread.projectId, threadId },
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
      <ThreadActionsMenu thread={thread} onOpenInSplit={onOpenInSplit} />,
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
        pane(`pane-${index + 1}`, index === 4 ? thread.id : `other${index}`),
      ),
    };
    renderMenu(layout, onOpenInSplit);

    expect(
      screen.queryByRole("menuitem", { name: /Open beside/ }),
    ).not.toBeNull();
  });

  it("reaches the directions through the right-click context menu surface", () => {
    const onOpenInSplit = vi.fn();
    const store = createStore();
    store.set(splitLayoutAtom, null);
    render(
      <Provider store={store}>
        <ThreadActionsContextMenu
          thread={thread}
          onOpenInSplit={onOpenInSplit}
        >
          <button type="button">Row</button>
        </ThreadActionsContextMenu>
      </Provider>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Row" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Open beside/ }));
    expect(onOpenInSplit).toHaveBeenCalledWith("right");

    fireEvent.contextMenu(screen.getByRole("button", { name: "Row" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Open above or below/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Open below" }));
    expect(onOpenInSplit).toHaveBeenCalledWith("bottom");
  });
});

describe("ThreadActionsMenu section moves", () => {
  it("keeps hidden sections selectable without restoring them to the list", async () => {
    const store = createStore();
    const hidden = ["section:sec_planning", "section:sec_building"];
    const order = [
      "section:sec_building",
      "pinned",
      "threads",
      "section:sec_planning",
    ];
    store.set(sidebarOrganizationModeAtom, "chronological");
    store.set(sidebarHiddenGroupsAtom, hidden);
    store.set(sidebarManualSectionOrderAtom, order);
    const unfiledThread = makeThreadListEntry({
      ...thread,
      parentThreadId: null,
      sectionId: null,
    });
    renderWide(
      <Provider store={store}>
        <AppThreadSectionMoveProvider
          sections={[
            { id: "sec_planning", name: "Planning" },
            { id: "sec_building", name: "Building" },
          ]}
        >
          <ThreadActionsMenu thread={unfiledThread} />
        </AppThreadSectionMoveProvider>
      </Provider>,
      false,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    const building = await openMoveSubmenu();
    expect(screen.getByRole("menuitem", { name: "Planning" })).not.toBeNull();
    fireEvent.click(building);

    expect(moveThreadToSection).toHaveBeenCalledWith({
      thread: unfiledThread,
      sectionId: "sec_building",
    });
    expect(store.get(sidebarHiddenGroupsAtom)).toEqual(hidden);
    expect(store.get(sidebarManualSectionOrderAtom)).toEqual(order);
  });

  it("moves from the overflow menu and indicates the current section", async () => {
    renderWide(<ThreadActionsMenu thread={thread} />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    const building = await openMoveSubmenu();
    const current = screen.getByRole("menuitem", { name: "Planning" });
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(building);
    expect(moveThreadToSection).toHaveBeenCalledWith({
      thread,
      sectionId: "sec_building",
    });
  });

  it("offers the same destinations from the thread context menu", async () => {
    renderWide(
      <ThreadActionsContextMenu thread={thread}>
        <div data-testid="thread-row">Move me</div>
      </ThreadActionsContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("thread-row"));
    const building = await openMoveSubmenu();
    fireEvent.click(building);

    expect(moveThreadToSection).toHaveBeenCalledWith({
      thread,
      sectionId: "sec_building",
    });
  });

  it("does not add section controls outside Manual organization", async () => {
    renderWide(<ThreadActionsMenu thread={thread} />, false);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    expect(
      screen.queryByRole("menuitem", { name: "Move to section" }),
    ).toBeNull();
  });

  it("does not offer section moves for nested child threads", async () => {
    const childThread = makeThreadListEntry({
      ...thread,
      id: "thread-child",
      parentThreadId: thread.id,
    });
    renderWide(<ThreadActionsMenu thread={childThread} />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    expect(
      screen.queryByRole("menuitem", { name: "Move to section" }),
    ).toBeNull();
  });

  it("supports Back and resets the compact overflow menu after a move", async () => {
    renderCompact(<ThreadActionsMenu thread={thread} />);

    const trigger = screen.getByRole("button", { name: "Thread actions" });
    fireEvent.click(trigger);
    const moveToSection = await screen.findByRole("menuitem", {
      name: "Move to section",
    });
    expect(
      moveToSection.querySelector('[data-icon="SectionMove"]'),
    ).not.toBeNull();
    fireEvent.click(moveToSection);

    expect(await screen.findByText("Move to section")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Building" })).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Back" }));
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).not.toBeNull();

    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Move to section" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Building" }));

    fireEvent.click(trigger);
    expect(
      await screen.findByRole("menuitem", { name: "Move to section" }),
    ).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();
  });

  it("reopens the compact long-press menu at the root after moving a thread", async () => {
    renderCompact(
      <ThreadActionsContextMenu thread={thread}>
        <div data-testid="thread-row">Move me</div>
      </ThreadActionsContextMenu>,
    );

    const row = screen.getByTestId("thread-row");
    fireEvent.contextMenu(row);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Move to section" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Building" }));

    fireEvent.contextMenu(row);
    expect(
      await screen.findByRole("menuitem", { name: "Move to section" }),
    ).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();
  });
});
