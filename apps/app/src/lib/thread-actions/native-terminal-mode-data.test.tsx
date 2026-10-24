// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { NativeTerminalThread } from "@bb/server-contract";
import type { BbNavigate, PluginThreadActionTarget } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeTerminalThreadQueryKey } from "@/hooks/queries/query-keys";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import {
  nativeTerminalModeItem,
  useNativeTerminalModeData,
} from "./native-terminal-mode-action";

const { get, providerOf, switchMode, entries } = vi.hoisted(() => ({
  get: vi.fn<(args: { threadId: string }) => Promise<unknown>>(),
  switchMode: vi.fn(),
  providerOf: new Map<string, string>(),
  entries: new Map<string, { providerId: string; projectId: string }>(),
}));

vi.mock("@/lib/sdk", () => ({ sdk: { nativeTerminals: { get, switchMode } } }));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({
    data: [
      { id: "claude-code", capabilities: { supportsNativeTerminal: true } },
      { id: "codex", capabilities: { supportsNativeTerminal: true } },
      { id: "acp-elyra-codex", capabilities: {} },
    ],
  }),
}));
vi.mock("@/lib/sidebar-thread-entries", () => ({
  useSidebarThreadEntries: () => entries,
}));
vi.mock("@/lib/cached-thread", () => ({
  lookupCachedThread: (_client: unknown, threadId: string) => {
    const providerId = providerOf.get(threadId);
    return providerId === undefined ? null : { providerId };
  },
}));

function view(threadId: string, canReturnToChat: boolean) {
  return {
    threadId,
    providerId: "claude-code",
    nativeSessionId: "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
    canReturnToChat,
    terminal: null,
  } as unknown as NativeTerminalThread;
}

function target(id: string): PluginThreadActionTarget {
  return {
    id,
    projectId: "prj_a",
    parentThreadId: null,
    archivedAt: null,
    pinnedAt: null,
    sectionId: null,
    isUnread: false,
    status: "idle",
    environment: { id: "env_a", path: "/workspace" },
  };
}

afterEach(() => {
  cleanup();
  get.mockReset();
  providerOf.clear();
  entries.clear();
  switchMode.mockReset();
});

describe("thread menu mode for threads the app has not loaded", () => {
  it("clears a saved composer draft after switching a thread to native terminal", async () => {
    const threadId = "thr_convert";
    const projectId = "prj_convert";
    providerOf.set(threadId, "claude-code");
    entries.set(threadId, { providerId: "claude-code", projectId });
    get.mockResolvedValue(null);
    switchMode.mockResolvedValue(view(threadId, true));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useNativeTerminalModeData({ threadIds: [threadId] }),
      { wrapper },
    );
    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId,
      threadId,
    });
    draft.setDraft({
      text: "saved composer draft",
      mentions: [],
      attachments: [],
    });
    expect(window.localStorage.getItem(draft.storageKey)).not.toBeNull();

    await waitFor(() => expect(result.current.modeOf(threadId)).toBe("chat"));
    await result.current.switchMode(threadId, "terminal", projectId);

    expect(draft.getCurrent().text).toBe("");
    expect(window.localStorage.getItem(draft.storageKey)).toBeNull();
    expect(switchMode).toHaveBeenCalledWith({ threadId, mode: "terminal" });
  });

  it("reads each native thread's mode before offering a switch, and offers none until it knows", async () => {
    providerOf.set("thr_chat", "claude-code");
    providerOf.set("thr_terminal", "codex");
    providerOf.set("thr_born", "claude-code");
    providerOf.set("thr_failed", "claude-code");
    providerOf.set("thr_elyra", "acp-elyra-codex");
    const replies = new Map<string, (value: unknown) => void>();
    get.mockImplementation(
      ({ threadId }) =>
        new Promise((resolve, reject) => {
          if (threadId === "thr_failed") {
            reject(new Error("network"));
            return;
          }
          replies.set(threadId, resolve);
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const threadIds = [
      "thr_chat",
      "thr_terminal",
      "thr_born",
      "thr_failed",
      "thr_elyra",
      "thr_unknown",
    ];
    const { result } = renderHook(
      () => useNativeTerminalModeData({ threadIds }),
      { wrapper },
    );
    const labels = () =>
      Object.fromEntries(
        threadIds.map((id) => [
          id,
          nativeTerminalModeItem({
            thread: target(id),
            data: result.current,
            navigate: {} as BbNavigate,
            sdk: {} as never,
          })?.label ?? null,
        ]),
      );

    await waitFor(() => expect(replies.size).toBe(3));
    expect(get.mock.calls.map(([args]) => args.threadId).sort()).toEqual([
      "thr_born",
      "thr_chat",
      "thr_failed",
      "thr_terminal",
    ]);
    expect(Object.values(labels())).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);

    replies.get("thr_chat")!(null);
    replies.get("thr_terminal")!(view("thr_terminal", true));
    replies.get("thr_born")!(view("thr_born", false));
    await waitFor(() =>
      expect(labels()).toEqual({
        thr_chat: "Open in terminal",
        thr_terminal: "Back to chat",
        thr_born: null,
        thr_failed: null,
        thr_elyra: null,
        thr_unknown: null,
      }),
    );
  });

  it("offers no switch once a refetch of a known mode fails", async () => {
    providerOf.set("thr_terminal", "claude-code");
    let fail = false;
    get.mockImplementation(async ({ threadId }) => {
      if (fail) throw new Error("network");
      return view(threadId, true);
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useNativeTerminalModeData({ threadIds: ["thr_terminal"] }),
      { wrapper },
    );
    const label = () =>
      nativeTerminalModeItem({
        thread: target("thr_terminal"),
        data: result.current,
        navigate: {} as BbNavigate,
        sdk: {} as never,
      })?.label ?? null;
    await waitFor(() => expect(label()).toBe("Back to chat"));

    fail = true;
    await queryClient.refetchQueries({
      queryKey: nativeTerminalThreadQueryKey("thr_terminal"),
    });
    await waitFor(() => expect(label()).toBeNull());
    expect(
      queryClient.getQueryData(nativeTerminalThreadQueryKey("thr_terminal")),
    ).toMatchObject({ canReturnToChat: true });
  });
});
