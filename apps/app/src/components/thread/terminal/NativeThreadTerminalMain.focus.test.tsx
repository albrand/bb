// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NativeTerminalThread } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeThreadTerminalMain } from "./NativeThreadTerminalMain";

const pane = vi.hoisted(() => ({ isFocused: true }));

vi.mock("@/views/thread-detail/PaneContext", () => ({
  useOptionalPaneContext: () => ({ isFocused: pane.isFocused }),
}));
vi.mock("@bb/shared-ui/hooks/use-media-query", () => ({
  useMediaQuery: () => false,
}));
vi.mock("@/hooks/useNativeActivityUnconfirmed", () => ({
  useNativeActivityUnconfirmed: () => false,
}));
vi.mock("@/hooks/queries/native-terminal-queries", () => ({
  useNativeTerminalThread: () => ({ dataUpdatedAt: 1, refetch: vi.fn() }),
  useOpenNativeTerminal: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadPendingInteractions: () => ({ data: [] }),
}));
vi.mock("@/hooks/queries/thread-terminal-queries", () => ({
  useThreadTerminals: () => ({ data: undefined, dataUpdatedAt: 0 }),
}));
vi.mock("@/components/secondary-panel/lazySecondaryPanelComponents", () => ({
  LazyThreadTerminalPanel: ({ autoFocus }: { autoFocus?: boolean }) => (
    <div data-testid="terminal" data-autofocus={String(autoFocus)} />
  ),
}));
vi.mock("./NativeTerminalPromptBar", () => ({
  NativeTerminalPromptBar: () => (
    <form data-native-terminal-prompt="">
      <textarea aria-label="Message" />
    </form>
  ),
}));
vi.mock("./NativeTerminalWaitingBanner", () => ({
  NativeTerminalWaitingBanner: () => null,
  nativeTerminalWaitingPrompts: () => [],
}));

afterEach(() => {
  cleanup();
  pane.isFocused = true;
});

const view = {
  providerId: "codex",
  displayName: "Codex",
  terminal: { id: "term_1", status: "running", exitCode: null },
} as unknown as NativeTerminalThread;

function renderMain() {
  return render(
    <NativeThreadTerminalMain
      projectId="proj_1"
      threadId="thr_1"
      threadIsProvisioning={false}
      view={view}
      runtime={{ displayStatus: "idle" }}
    />,
  );
}

const terminalAutoFocus = () =>
  screen.getByTestId("terminal").getAttribute("data-autofocus");

describe("NativeThreadTerminalMain focus", () => {
  it("auto-focuses the terminal on desktop until the user focuses the composer", () => {
    renderMain();
    expect(terminalAutoFocus()).toBe("true");
    fireEvent.focus(screen.getByLabelText("Message"));
    expect(terminalAutoFocus()).toBe("false");
  });

  it("keeps the terminal from taking focus back after the composer blurs, until the pane loses focus", () => {
    const view_ = renderMain();
    const composer = screen.getByLabelText("Message");
    fireEvent.focus(composer);
    fireEvent.blur(composer);
    expect(terminalAutoFocus()).toBe("false");
    pane.isFocused = false;
    view_.rerender(
      <NativeThreadTerminalMain
        projectId="proj_1"
        threadId="thr_1"
        threadIsProvisioning={false}
        view={view}
        runtime={{ displayStatus: "idle" }}
      />,
    );
    pane.isFocused = true;
    view_.rerender(
      <NativeThreadTerminalMain
        projectId="proj_1"
        threadId="thr_1"
        threadIsProvisioning={false}
        view={view}
        runtime={{ displayStatus: "idle" }}
      />,
    );
    expect(terminalAutoFocus()).toBe("true");
  });
});
