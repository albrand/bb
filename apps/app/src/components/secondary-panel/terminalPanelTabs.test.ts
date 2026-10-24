import { openSecondaryPanelTabInState } from "@bb/client-core";
import { describe, expect, it } from "vitest";
import {
  createEmptyFixedPanelTabsState,
  createHostFilePreviewFixedPanelTab,
  createTerminalFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import {
  buildTerminalSyncedSecondaryFileTabs,
  pruneTerminalTabsForSessions,
  syncTerminalTabsInFixedPanelState,
} from "./terminalPanelTabs";
import { makeTerminalSession as terminalSession } from "@/test/fixtures/terminal-sessions";

const NO_PENDING_TERMINALS = {
  closing: new Set<string>(),
  starting: new Set<string>(),
};

interface TabIdentity {
  id: string;
}

function tabIds(tabs: readonly TabIdentity[]): string[] {
  return tabs.map((tab) => tab.id);
}

describe("terminalPanelTabs", () => {
  it("prunes vanished and closing terminal tabs while keeping fork-retained exited sessions", () => {
    const infoTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/file.ts",
      },
      threadId: "thr_1",
    });
    const disconnectedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_disconnected",
    });
    const exitedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_exited",
    });
    const missingTerminal = createTerminalFixedPanelTab({
      terminalId: "term_missing",
    });
    const runningTerminal = createTerminalFixedPanelTab({
      terminalId: "term_running",
    });
    const startingTerminal = createTerminalFixedPanelTab({
      terminalId: "term_starting",
    });
    const closingTerminal = createTerminalFixedPanelTab({
      terminalId: "term_closing",
    });

    expect(
      pruneTerminalTabsForSessions({
        pendingTerminalIds: {
          closing: new Set(["term_closing"]),
          starting: new Set(["term_starting"]),
        },
        retainedTerminalIds: new Set(["term_disconnected"]),
        tabs: [
          infoTab,
          disconnectedTerminal,
          exitedTerminal,
          missingTerminal,
          runningTerminal,
          startingTerminal,
          closingTerminal,
        ],
        terminalSessions: [
          terminalSession({
            id: "term_disconnected",
            status: "disconnected",
          }),
          terminalSession({ id: "term_exited", status: "exited" }),
          terminalSession({ id: "term_running" }),
          terminalSession({ id: "term_closing" }),
        ],
      }),
    ).toEqual([
      infoTab,
      disconnectedTerminal,
      exitedTerminal,
      runningTerminal,
      startingTerminal,
    ]);
  });

  it("keeps retained disconnected and all exited terminal tabs", () => {
    const retained = createTerminalFixedPanelTab({ terminalId: "term_retained" });
    const disconnected = createTerminalFixedPanelTab({ terminalId: "term_disconnected" });
    const exited = createTerminalFixedPanelTab({ terminalId: "term_exited" });
    const running = createTerminalFixedPanelTab({ terminalId: "term_running" });

    expect(
      pruneTerminalTabsForSessions({
        pendingTerminalIds: NO_PENDING_TERMINALS,
        retainedTerminalIds: new Set(["term_retained"]),
        tabs: [retained, disconnected, exited, running],
        terminalSessions: [
          terminalSession({ id: "term_retained", status: "disconnected" }),
          terminalSession({ id: "term_disconnected", status: "disconnected" }),
          terminalSession({ id: "term_exited", status: "exited" }),
          terminalSession({ id: "term_running" }),
        ],
      }),
    ).toEqual([retained, exited, running]);
  });

  it("adds server terminal sessions missing from local tabs", () => {
    const tabs = buildTerminalSyncedSecondaryFileTabs({
      orderedTabs: [],
      pendingTerminalIds: NO_PENDING_TERMINALS,
      terminalSessions: [
        terminalSession({ id: "term_1" }),
        terminalSession({ id: "term_2" }),
      ],
    });

    expect(tabIds(tabs)).toEqual([
      "terminal:term_1:none",
      "terminal:term_2:none",
    ]);
  });

  it("does not add tabs for sessions this client is closing", () => {
    const tabs = buildTerminalSyncedSecondaryFileTabs({
      orderedTabs: [],
      pendingTerminalIds: {
        closing: new Set(["term_closing"]),
        starting: new Set<string>(),
      },
      terminalSessions: [
        terminalSession({ id: "term_closing" }),
        terminalSession({ id: "term_open" }),
      ],
    });

    expect(tabIds(tabs)).toEqual(["terminal:term_open:none"]);
  });

  it("preserves local terminal tab order when sessions still exist", () => {
    const localTerminal2 = createTerminalFixedPanelTab({
      terminalId: "term_2",
    });
    const localFile = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/file.ts",
      },
      threadId: "thr_1",
    });
    const localTerminal1 = createTerminalFixedPanelTab({
      terminalId: "term_1",
    });
    const tabs = buildTerminalSyncedSecondaryFileTabs({
      orderedTabs: [localTerminal2, localFile, localTerminal1],
      pendingTerminalIds: NO_PENDING_TERMINALS,
      terminalSessions: [
        terminalSession({ id: "term_1" }),
        terminalSession({ id: "term_2" }),
        terminalSession({ id: "term_3" }),
      ],
    });

    expect(tabIds(tabs)).toEqual([
      "terminal:term_2:none",
      "host-file-preview:%2Fworkspace%2Ffile.ts:thread%3Athr_1%3Aenvironment%3Aenv_1",
      "terminal:term_1:none",
      "terminal:term_3:none",
    ]);
  });

  it("drops stale local terminal tabs when sessions disappear elsewhere", () => {
    const tabs = buildTerminalSyncedSecondaryFileTabs({
      orderedTabs: [
        createTerminalFixedPanelTab({ terminalId: "term_stale" }),
        createTerminalFixedPanelTab({ terminalId: "term_1" }),
      ],
      pendingTerminalIds: NO_PENDING_TERMINALS,
      terminalSessions: [terminalSession({ id: "term_1" })],
    });

    expect(tabIds(tabs)).toEqual(["terminal:term_1:none"]);
  });

  it("keeps disconnected terminal tabs", () => {
    const disconnectedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_disconnected",
    });
    const runningTerminal = createTerminalFixedPanelTab({
      terminalId: "term_running",
    });
    const sessions = [
      terminalSession({
        id: "term_disconnected",
        status: "disconnected",
      }),
      terminalSession({ id: "term_running" }),
    ];

    expect(
      tabIds(
        buildTerminalSyncedSecondaryFileTabs({
          orderedTabs: [disconnectedTerminal, runningTerminal],
          pendingTerminalIds: NO_PENDING_TERMINALS,
          retainedTerminalIds: new Set(["term_disconnected"]),
          terminalSessions: sessions,
        }),
      ),
    ).toEqual([
      "terminal:term_disconnected:none",
      "terminal:term_running:none",
    ]);
  });

  describe("a daemon-disconnect record superseded by a newer running terminal of the thread", () => {
    const superseded = terminalSession({
      closeReason: "daemon-disconnect",
      createdAt: 1,
      exitCode: 0,
      id: "term_old",
      status: "exited",
      threadId: "thr_1",
    });
    const current = terminalSession({
      createdAt: 2,
      id: "term_new",
      status: "running",
      threadId: "thr_1",
    });

    it("loses its tab when terminal tabs are pruned, and the newer terminal keeps its tab", () => {
      const tabs = pruneTerminalTabsForSessions({
        pendingTerminalIds: NO_PENDING_TERMINALS,
        tabs: [
          createTerminalFixedPanelTab({ terminalId: "term_old" }),
          createTerminalFixedPanelTab({ terminalId: "term_new" }),
        ],
        terminalSessions: [superseded, current],
      });

      expect(tabIds(tabs)).toEqual(["terminal:term_new:none"]);
    });

    it("gets no tab when sessions are synced, and the newer terminal gets one", () => {
      const tabs = buildTerminalSyncedSecondaryFileTabs({
        orderedTabs: [],
        pendingTerminalIds: NO_PENDING_TERMINALS,
        terminalSessions: [superseded, current],
      });

      expect(tabIds(tabs)).toEqual(["terminal:term_new:none"]);
    });
  });

  it("syncs missing server terminal sessions into fixed panel state", () => {
    const fileTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/file.ts",
      },
      threadId: "thr_1",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: fileTab.id,
        isOpen: true,
        tabs: [fileTab],
      },
    });
    const nextState = syncTerminalTabsInFixedPanelState({
      state,
      pendingTerminalIds: NO_PENDING_TERMINALS,
      terminalSessions: [
        terminalSession({ id: "term_1" }),
        terminalSession({ id: "term_2" }),
      ],
    });

    expect(tabIds(nextState.secondary.tabs)).toEqual([
      "host-file-preview:%2Fworkspace%2Ffile.ts:thread%3Athr_1%3Aenvironment%3Aenv_1",
      "terminal:term_1:none",
      "terminal:term_2:none",
    ]);
    expect(nextState.secondary.activeTabId).toBe(fileTab.id);
  });

  it("removes stale fixed terminal tabs and selects the remaining neighbor", () => {
    const staleTerminalTab = createTerminalFixedPanelTab({
      terminalId: "term_stale",
    });
    const currentTerminalTab = createTerminalFixedPanelTab({
      terminalId: "term_1",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: staleTerminalTab.id,
        isOpen: true,
        tabs: [staleTerminalTab, currentTerminalTab],
      },
    });
    const nextState = syncTerminalTabsInFixedPanelState({
      state,
      pendingTerminalIds: NO_PENDING_TERMINALS,
      terminalSessions: [terminalSession({ id: "term_1" })],
    });

    expect(tabIds(nextState.secondary.tabs)).toEqual(["terminal:term_1:none"]);
    expect(nextState.secondary.activeTabId).toBe(currentTerminalTab.id);
  });

  it("keeps an exited terminal without disturbing the active file tab", () => {
    const terminalTab = createTerminalFixedPanelTab({
      terminalId: "term_exited",
    });
    const activeFileTab = createHostFilePreviewFixedPanelTab({
      environmentId: "env_1",
      tab: {
        lineRange: null,
        path: "/workspace/proposal.md",
      },
      threadId: "thr_1",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: activeFileTab.id,
        isOpen: true,
        tabs: [terminalTab, activeFileTab],
      },
    });

    const nextState = syncTerminalTabsInFixedPanelState({
      state,
      pendingTerminalIds: NO_PENDING_TERMINALS,
      retainedTerminalIds: new Set([
        "term_disconnected",
        "term_other_disconnected",
      ]),
      terminalSessions: [
        terminalSession({
          id: "term_exited",
          status: "exited",
          title: "zsh",
        }),
      ],
    });

    expect(nextState.secondary.tabs).toEqual([terminalTab, activeFileTab]);
    expect(nextState.secondary.activeTabId).toBe(activeFileTab.id);
  });

  it("keeps fixed panel state identity when terminal tabs already match", () => {
    const terminalTab = createTerminalFixedPanelTab({ terminalId: "term_1" });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: terminalTab.id,
        isOpen: true,
        tabs: [terminalTab],
      },
    });

    expect(
      syncTerminalTabsInFixedPanelState({
        state,
        pendingTerminalIds: NO_PENDING_TERMINALS,
        terminalSessions: [terminalSession({ id: "term_1" })],
      }),
    ).toBe(state);
  });

  it("keeps disconnected terminals in fixed panel state", () => {
    const disconnectedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_disconnected",
    });
    const otherDisconnectedTerminal = createTerminalFixedPanelTab({
      terminalId: "term_other_disconnected",
    });
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        activeTabId: disconnectedTerminal.id,
        isOpen: true,
        tabs: [disconnectedTerminal, otherDisconnectedTerminal],
      },
    });
    const nextState = syncTerminalTabsInFixedPanelState({
      state,
      pendingTerminalIds: NO_PENDING_TERMINALS,
      retainedTerminalIds: new Set([
        "term_disconnected",
        "term_other_disconnected",
      ]),
      terminalSessions: [
        terminalSession({
          id: "term_disconnected",
          status: "disconnected",
        }),
        terminalSession({
          id: "term_other_disconnected",
          status: "disconnected",
        }),
      ],
    });

    expect(tabIds(nextState.secondary.tabs)).toEqual([
      "terminal:term_disconnected:none",
      "terminal:term_other_disconnected:none",
    ]);
    expect(nextState.secondary.activeTabId).toBe(disconnectedTerminal.id);
  });
});

it("returns to the source if session synchronization removes an active terminal before its close callback", () => {
  const source = createHostFilePreviewFixedPanelTab({
    environmentId: "env_1",
    threadId: "thr_1",
    tab: { path: "/source.txt", lineRange: null },
  });
  const neighbor = createHostFilePreviewFixedPanelTab({
    environmentId: "env_1",
    threadId: "thr_1",
    tab: { path: "/neighbor.txt", lineRange: null },
  });
  const terminal = createTerminalFixedPanelTab({ terminalId: "closing" });
  const state = openSecondaryPanelTabInState({
    state: createEmptyFixedPanelTabsState({
      secondary: {
        tabs: [source, neighbor],
        activeTabId: source.id,
        isOpen: true,
      },
    }),
    tab: terminal,
  });
  const next = syncTerminalTabsInFixedPanelState({
    state,
    pendingTerminalIds: NO_PENDING_TERMINALS,
    terminalSessions: [],
  });
  expect(next.secondary.activeTabId).toBe(source.id);
});
