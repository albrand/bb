import { describe, expect, it } from "vitest";
import {
  isVisibleTerminalSession,
  pickActiveTerminalId,
  shouldAutoCloseCleanTerminalSession,
  shouldAutoCloseCleanTerminalSessionsForPanel,
} from "./useThreadTerminalController";
import { shouldCloseUnretainedDisconnectedTerminalSession } from "@/lib/terminal-session-visibility";
import { makeTerminalSession as terminalSession } from "@/test/fixtures/terminal-sessions";

describe("terminal visibility", () => {
  it("does not replace an exact plugin tab with a sibling session", () => {
    const sibling = terminalSession({ id: "term_sibling" });

    expect(
      pickActiveTerminalId([sibling], "term_missing", "term_missing"),
    ).toBeNull();
    expect(
      pickActiveTerminalId([sibling], "term_sibling", "term_sibling"),
    ).toBe("term_sibling");
  });
  it("shows disconnected sessions only while retaining a mounted terminal view", () => {
    const disconnected = terminalSession({
      id: "term_disconnected",
      status: "disconnected",
    });

    expect(
      isVisibleTerminalSession({
        paneRetainedTerminalIds: new Set<string>(),
        session: disconnected,
      }),
    ).toBe(false);
    expect(
      isVisibleTerminalSession({
        paneRetainedTerminalIds: new Set(["term_disconnected"]),
        session: disconnected,
      }),
    ).toBe(true);
    expect(
      isVisibleTerminalSession({
        paneRetainedTerminalIds: new Set<string>(),
        session: terminalSession({ status: "running" }),
      }),
    ).toBe(true);
  });

  it("cleans up a disconnected session only when no pane still mounts it", () => {
    const disconnected = terminalSession({
      id: "term_disconnected",
      status: "disconnected",
    });

    expect(
      shouldCloseUnretainedDisconnectedTerminalSession({
        retainedTerminalIds: new Set<string>(),
        session: disconnected,
      }),
    ).toBe(true);
    expect(
      shouldCloseUnretainedDisconnectedTerminalSession({
        retainedTerminalIds: new Set(["term_other_pane", "term_disconnected"]),
        session: disconnected,
      }),
    ).toBe(false);
    expect(
      shouldCloseUnretainedDisconnectedTerminalSession({
        retainedTerminalIds: new Set<string>(),
        session: terminalSession({ status: "running" }),
      }),
    ).toBe(false);
  });

  it("auto-closes only clean UI-created terminal sessions", () => {
    const cleanUiCreated = terminalSession({ id: "term_ui" });
    const external = terminalSession({ id: "term_external" });
    const dirty = terminalSession({ id: "term_dirty" });
    const userInput = terminalSession({
      id: "term_user_input",
      lastUserInputAt: 2,
    });

    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(["term_dirty"]),
        session: cleanUiCreated,
        uiCreatedTerminalIds: new Set(["term_ui", "term_dirty"]),
      }),
    ).toBe(true);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(),
        session: external,
        uiCreatedTerminalIds: new Set(["term_ui"]),
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(["term_dirty"]),
        session: dirty,
        uiCreatedTerminalIds: new Set(["term_dirty"]),
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSession({
        dirtyTerminalIds: new Set(),
        session: userInput,
        uiCreatedTerminalIds: new Set(["term_user_input"]),
      }),
    ).toBe(false);
  });

  it("preserves clean terminals while a compact panel remains persisted", () => {
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: false,
        isPanelPersistedOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: true,
        isPanelPersistedOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen: false,
        isPanelPersistedOpen: false,
      }),
    ).toBe(true);
  });
});
