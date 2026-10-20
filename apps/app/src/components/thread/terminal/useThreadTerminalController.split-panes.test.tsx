// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  useThreadTerminalController,
  type ThreadTerminalControllerArgs,
} from "./useThreadTerminalController";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { clearTerminalCurrentCwd } from "./terminal-shell-state";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...actual,
    sdk: {
      ...actual.sdk,
      threads: {
        ...actual.sdk.threads,
        experimental_updateRowState: vi.fn(),
      },
      terminals: {
        ...actual.sdk.terminals,
        list: vi.fn(),
        close: vi.fn(),
        create: vi.fn(),
        rename: vi.fn(),
      },
    },
  };
});

function session(id: string, status: TerminalSession["status"]) {
  return makeTerminalSession({
    id,
    status,
    threadId: "thr_1",
    environmentId: "env_1",
    hostId: "host_1",
  });
}

function paneArgs(preferredTerminalId: string): ThreadTerminalControllerArgs {
  return {
    canCreateTerminal: true,
    isPanelOpen: true,
    isPanelPersistedOpen: true,
    preferredTerminalId,
    syncThreadId: null,
    target: { kind: "thread", threadId: "thr_1" },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  for (const terminalId of ["term_a", "term_b", "term_orphan", "term_new"]) {
    clearTerminalCurrentCwd(terminalId);
  }
});

describe("two split panes each holding a terminal", () => {
  it("writes terminal progress through the existing thread row-state contract", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("term_a", "running")],
    });
    vi.mocked(sdk.threads.experimental_updateRowState).mockResolvedValue({
      statuses: {},
      progress: { value: 0.75 },
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTerminalController(paneArgs("term_a")),
      { wrapper },
    );

    await waitFor(() => expect(result.current.activeSession?.id).toBe("term_a"));
    act(() => result.current.handleActiveTerminalProgressChange(0.75));

    await waitFor(() =>
      expect(sdk.threads.experimental_updateRowState).toHaveBeenCalledWith({
        threadId: "thr_1",
        action: "progress-set",
        progress: { value: 0.75 },
      }),
    );
    act(() => result.current.handleActiveTerminalProgressChange(null));
    await waitFor(() =>
      expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
        threadId: "thr_1",
        action: "progress-clear",
      }),
    );
  });

  it("accepts subsequent OSC process title changes", async () => {
    const current = session("term_a", "running");
    current.title = "vim";
    const renamed = { ...current, title: "bash" };
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [current] });
    vi.mocked(sdk.terminals.rename).mockResolvedValue(renamed);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTerminalController(paneArgs("term_a")),
      { wrapper },
    );

    await waitFor(() => expect(result.current.activeSession?.title).toBe("vim"));
    act(() => result.current.handleActiveTerminalTitleChange("bash"));

    await waitFor(() =>
      expect(sdk.terminals.rename).toHaveBeenCalledWith({
        terminalId: "term_a",
        title: "bash",
      }),
    );
  });

  it("does not close the other pane's terminal when both disconnect", async () => {
    const running = [
      session("term_a", "running"),
      session("term_b", "running"),
    ];
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: running });
    vi.mocked(sdk.terminals.close).mockImplementation(
      async ({ terminalId }: { terminalId: string }) =>
        session(terminalId, "exited"),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => ({
        paneA: useThreadTerminalController(paneArgs("term_a")),
        paneB: useThreadTerminalController(paneArgs("term_b")),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.paneA.activeSession?.id).toBe("term_a");
      expect(result.current.paneB.activeSession?.id).toBe("term_b");
    });

    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [
        session("term_a", "disconnected"),
        session("term_b", "disconnected"),
      ],
    });
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => {
      expect(result.current.paneA.activeSession?.status).toBe("disconnected");
      expect(result.current.paneB.activeSession?.status).toBe("disconnected");
    });

    const closedIds = [
      ...new Set(
        vi
          .mocked(sdk.terminals.close)
          .mock.calls.map(([request]) => request.terminalId),
      ),
    ].sort();
    expect(closedIds).toEqual([]);
  });

  it("keeps its own disconnected terminal when a single pane is open", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("term_a", "running")],
    });
    vi.mocked(sdk.terminals.close).mockImplementation(
      async ({ terminalId }: { terminalId: string }) =>
        session(terminalId, "exited"),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTerminalController(paneArgs("term_a")),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("term_a");
    });

    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("term_a", "disconnected")],
    });
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitFor(() => {
      expect(result.current.activeSession?.status).toBe("disconnected");
    });

    expect(vi.mocked(sdk.terminals.close)).not.toHaveBeenCalled();
    expect(result.current.shouldRetainActiveTerminalView).toBe(true);
  });

  it("still closes a disconnected session no pane is showing", async () => {
    const state = new Map<string, TerminalSession["status"]>([
      ["term_a", "running"],
      ["term_b", "running"],
      ["term_orphan", "disconnected"],
    ]);
    vi.mocked(sdk.terminals.list).mockImplementation(async () => ({
      sessions: [...state.entries()].map(([id, status]) => session(id, status)),
    }));
    vi.mocked(sdk.terminals.close).mockImplementation(
      async ({ terminalId }: { terminalId: string }) => {
        state.set(terminalId, "exited");
        return session(terminalId, "exited");
      },
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => ({
        paneA: useThreadTerminalController(paneArgs("term_a")),
        paneB: useThreadTerminalController(paneArgs("term_b")),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.paneA.activeSession?.id).toBe("term_a");
      expect(result.current.paneB.activeSession?.id).toBe("term_b");
    });
    await waitFor(() => {
      expect(state.get("term_orphan")).toBe("exited");
    });

    const closedIds = [
      ...new Set(
        vi
          .mocked(sdk.terminals.close)
          .mock.calls.map(([request]) => request.terminalId),
      ),
    ];
    expect(closedIds).toEqual(["term_orphan"]);
  });

  it.each(["/tmp/q?x", "/tmp/h#x", "/tmp/p%20x", "/tmp/s p", "/tmp/café"])(
    "opens a new terminal in the focused pane's cwd: %s",
    async (cwd) => {
      const source = session("term_a", "running");
      const created = session("term_new", "running");
      vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [source] });
      vi.mocked(sdk.terminals.create).mockResolvedValue(created);
      const { wrapper } = createQueryClientTestHarness();
      const { result } = renderHook(
        () => useThreadTerminalController(paneArgs("term_a")),
        { wrapper },
      );

      await waitFor(() =>
        expect(result.current.activeSession?.id).toBe("term_a"),
      );
      act(() => result.current.handleActiveTerminalCwdChange(cwd));
      act(() => result.current.handleCreateTerminal());

      await waitFor(() => expect(sdk.terminals.create).toHaveBeenCalled());
      expect(sdk.terminals.create).toHaveBeenCalledWith(
        expect.objectContaining({ cwd }),
      );
    },
  );
});
