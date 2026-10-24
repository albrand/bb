// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { NativeTerminalThread } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeThreadTerminalMain } from "./NativeThreadTerminalMain";

const hooks = vi.hoisted(() => ({
  listTerminals: vi.fn(),
  preloadTerminalPanel: vi.fn(),
  refetchNative: vi.fn(),
}));

vi.mock("@/components/secondary-panel/lazySecondaryPanelComponents", () => ({
  LazyThreadTerminalPanel: Object.assign(() => null, {
    preload: hooks.preloadTerminalPanel,
  }),
}));

vi.mock("@/hooks/queries/thread-terminal-queries", () => ({
  useThreadTerminals: hooks.listTerminals,
}));

vi.mock("@/hooks/queries/native-terminal-queries", () => ({
  useNativeTerminalThread: () => ({
    dataUpdatedAt: 0,
    refetch: hooks.refetchNative,
  }),
  useOpenNativeTerminal: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadPendingInteractions: () => ({ data: [] }),
}));

vi.mock("@/hooks/useNativeActivityUnconfirmed", () => ({
  useNativeActivityUnconfirmed: () => false,
}));

vi.mock("@bb/shared-ui/hooks/use-media-query", () => ({
  useMediaQuery: () => false,
}));

vi.mock("@/views/thread-detail/PaneContext", () => ({
  useOptionalPaneContext: () => null,
}));

const nativeView: NativeTerminalThread = {
  threadId: "thr_native",
  providerId: "claude-code",
  displayName: "Claude Code",
  nativeSessionId: "session-native",
  canReturnToChat: true,
  terminal: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NativeThreadTerminalMain", () => {
  it("shows loading while its terminal list is pending and no session is known", () => {
    hooks.listTerminals.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      isLoading: true,
    });
    hooks.refetchNative.mockResolvedValue(undefined);

    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={nativeView}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Loading terminals...");
    expect(screen.queryByText("Claude Code session ended")).toBeNull();
    expect(hooks.preloadTerminalPanel).toHaveBeenCalledOnce();
  });

  it("shows the ended state only after the empty terminal list is known", () => {
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [] },
      dataUpdatedAt: 1,
      isLoading: false,
    });
    hooks.refetchNative.mockResolvedValue(undefined);

    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={nativeView}
      />,
    );

    expect(screen.getByText("Claude Code session ended")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
