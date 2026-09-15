// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  SidebarSplitContainer,
  type SidebarSplitTabDescriptor,
} from "./SidebarSplitContainer";
import { createTerminalFixedPanelTab } from "@/lib/fixed-panel-tabs-state";

const PANEL_STATE_ID = "sidebar-split-new-terminal-test";
const FIRST_TAB: SidebarSplitTabDescriptor = {
  id: "tab-a",
  label: "A",
  restoresPlacementAfterRemoval: false,
};
const NEW_TERMINAL_ID = "term_new";
const NEW_TERMINAL_TAB_ID = createTerminalFixedPanelTab({
  terminalId: NEW_TERMINAL_ID,
}).id;

function paneTabGroups(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-tabs]"),
    (pane) => pane.dataset.paneTabs ?? "",
  );
}

function Harness({ createTerminal }: { createTerminal: () => void }) {
  const [tabs, setTabs] = useState<readonly SidebarSplitTabDescriptor[]>([
    FIRST_TAB,
  ]);
  return (
    <SidebarProvider>
      <TooltipProvider>
        <SidebarSplitContainer
          activeTabId={FIRST_TAB.id}
          isFullScreen={false}
          onActivateTab={vi.fn()}
          onCreateTerminalInNewPane={async () => {
            createTerminal();
            setTabs((current) => [
              ...current,
              {
                id: NEW_TERMINAL_TAB_ID,
                label: "Terminal",
                restoresPlacementAfterRemoval: false,
              },
            ]);
            return NEW_TERMINAL_ID;
          }}
          onGlobalTabReorder={vi.fn()}
          onToggleFullScreen={vi.fn()}
          panelStateId={PANEL_STATE_ID}
          tabs={tabs}
          renderPane={(pane) => (
            <div
              data-testid={`pane-${pane.paneId}`}
              data-pane-tabs={pane.group.tabIds.join(",")}
            >
              {pane.onSplitWithNewTerminal ? (
                <button
                  type="button"
                  onClick={() => pane.onSplitWithNewTerminal?.("right")}
                >
                  New terminal right
                </button>
              ) : (
                <span>no split action</span>
              )}
            </div>
          )}
        />
      </TooltipProvider>
    </SidebarProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("splitting a single terminal pane into a new terminal", () => {
  it("offers the action with one pane holding one tab, and lands the new terminal in its own pane", async () => {
    const createTerminal = vi.fn();
    const { getByText } = render(<Harness createTerminal={createTerminal} />);

    expect(paneTabGroups()).toEqual(["tab-a"]);
    const action = getByText("New terminal right");

    fireEvent.click(action);

    await waitFor(() => {
      expect(createTerminal).toHaveBeenCalledTimes(1);
      expect(paneTabGroups()).toEqual(["tab-a", NEW_TERMINAL_TAB_ID]);
    });
  });
});
