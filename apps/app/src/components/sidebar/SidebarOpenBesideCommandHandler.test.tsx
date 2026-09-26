// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openThreadInSplit: vi.fn(),
  handlers: new Map<string, () => boolean>(),
}));

vi.mock("@/lib/split-layout/openThreadInSplit", () => ({
  openThreadInSplit: mocks.openThreadInSplit,
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandHandler: (command: string, handler: () => boolean) => {
    mocks.handlers.set(command, handler);
  },
  useAppCommandShortcut: () => undefined,
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({ renameThread: vi.fn() }),
}));

vi.mock("@/components/thread/ThreadActionsMenu", () => ({
  ThreadActionsMenu: () => null,
}));

import { SidebarOpenBesideCommandHandler } from "./SidebarOpenBesideCommandHandler";
import {
  EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS,
  SidebarThreadShortcutKeysContext,
  findFocusedSidebarThread,
} from "./sidebarThreadShortcuts";

const THREAD_ID = "thr_beside";
const PROJECT_ID = "proj_beside";

function renderSidebar() {
  const result = render(
    <MemoryRouter>
      <TooltipProvider>
        <SidebarThreadShortcutKeysContext.Provider
          value={EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS}
        >
          <a
            data-sidebar-project-id={PROJECT_ID}
            data-sidebar-thread-id={THREAD_ID}
            href="#thread"
          >
            Focusable thread row
          </a>
          <textarea data-testid="composer" />
          <SidebarOpenBesideCommandHandler />
        </SidebarThreadShortcutKeysContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  );
  const row = result.container.querySelector<HTMLAnchorElement>(
    "a[data-sidebar-thread-id]",
  );
  if (row === null) throw new Error("thread row anchor not rendered");
  return { row, result };
}

afterEach(() => {
  cleanup();
  mocks.openThreadInSplit.mockReset();
  mocks.handlers.clear();
});

describe("opening the focused sidebar thread beside the current one", () => {
  it("resolves both ids from a real focused thread row", () => {
    const { row } = renderSidebar();
    row.focus();

    expect(document.activeElement).toBe(row);
    expect(findFocusedSidebarThread(document.activeElement)).toEqual({
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
    });
  });

  it("opens the focused row beside the current pane", () => {
    const { row } = renderSidebar();
    row.focus();

    const handler = mocks.handlers.get("thread.openBeside");
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(true);
    expect(mocks.openThreadInSplit).toHaveBeenCalledTimes(1);
    expect(mocks.openThreadInSplit.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
    });
  });

  it("declines when focus is not on a thread row, so the key reaches the shell", () => {
    const { result } = renderSidebar();
    result.getByTestId("composer").focus();

    const handler = mocks.handlers.get("thread.openBeside");
    expect(handler?.()).toBe(false);
    expect(mocks.openThreadInSplit).not.toHaveBeenCalled();
  });
});
