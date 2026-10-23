// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { NativeTerminalThread } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNativeTerminalThread } from "./native-terminal-queries";

const { preloadPanel, preloadModules } = vi.hoisted(() => ({
  preloadPanel: vi.fn(() => Promise.resolve()),
  preloadModules: vi.fn(),
}));

vi.mock("@/components/secondary-panel/lazySecondaryPanelComponents", () => ({
  LazyThreadTerminalPanel: { preload: preloadPanel },
}));

vi.mock("@/components/thread/terminal/terminal-modules", () => ({
  preloadTerminalModules: preloadModules,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    nativeTerminals: { get: vi.fn(), open: vi.fn() },
    threads: { send: vi.fn() },
  },
}));

const NATIVE_VIEW = {
  threadId: "thread-1",
  providerId: "codex",
  displayName: "Codex",
  nativeSessionId: null,
  canReturnToChat: false,
  terminal: null,
} satisfies NativeTerminalThread;

describe("useNativeTerminalThread terminal preload", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts panel and xterm preloads as soon as native metadata resolves, before a terminal view mounts", async () => {
    const { wrapper } = createQueryClientTestHarness();
    let resolveMetadata: ((view: NativeTerminalThread) => void) | undefined;
    vi.mocked(sdk.nativeTerminals.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
    );

    const { result } = renderHook(() => useNativeTerminalThread("thread-1"), {
      wrapper,
    });
    await waitFor(() => expect(sdk.nativeTerminals.get).toHaveBeenCalledOnce());
    expect(preloadPanel).not.toHaveBeenCalled();
    expect(preloadModules).not.toHaveBeenCalled();

    await act(async () => {
      resolveMetadata?.(NATIVE_VIEW);
    });

    await waitFor(() => expect(result.current.data).toEqual(NATIVE_VIEW));
    expect(preloadPanel).toHaveBeenCalledOnce();
    expect(preloadModules).toHaveBeenCalledOnce();
  });
});
