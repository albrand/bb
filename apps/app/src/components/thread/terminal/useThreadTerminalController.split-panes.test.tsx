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

vi.mock("@/lib/sdk", () => ({
  sdk: { terminals: { list: vi.fn(), close: vi.fn() } },
}));

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
});

describe("two split panes each holding a terminal", () => {
  it("does not close the other pane's terminal when both disconnect", async () => {
    const running = [session("term_a", "running"), session("term_b", "running")];
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
      expect(
        vi.mocked(sdk.terminals.list).mock.results.length,
      ).toBeGreaterThan(2);
    });
    const listed = await vi.mocked(sdk.terminals.list).mock.results.at(-1)!
      .value;
    expect(listed.sessions.map((s: TerminalSession) => s.status)).toEqual([
      "disconnected",
      "disconnected",
    ]);
    expect(result.current.paneA.activeSession?.status).toBe("disconnected");

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
});
