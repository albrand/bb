// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ThreadTurnTokenSummary,
  ThreadUsageAndAgents,
} from "./ThreadUsageSummary";

const useThreadSpendSummary = vi.hoisted(() => vi.fn());
const childSummary = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadSpendSummary,
}));
vi.mock("@/lib/sdk", () => ({ sdk: { threads: { childSummary } } }));

describe("thread usage summary", () => {
  beforeEach(() => {
    useThreadSpendSummary.mockReset();
    childSummary.mockReset();
    useThreadSpendSummary.mockReturnValue({
      data: {
        providerId: "claude-code",
        historyComplete: false,
        total: {
          inputTokens: 6_442,
          cachedInputTokens: 686_719_425,
          outputTokens: 1_809_971,
          reasoningOutputTokens: 0,
          totalTokens: 688_535_838,
        },
        turns: [
          {
            turnId: "da385f7e5d-t1",
            inputTokens: 30,
            cachedInputTokens: 2_843_776,
            outputTokens: 6_149,
            reasoningOutputTokens: null,
            totalTokens: 2_849_955,
          },
          {
            turnId: "da385f7e5d-t2",
            inputTokens: 8,
            cachedInputTokens: 788_012,
            outputTokens: 831,
            reasoningOutputTokens: null,
            totalTokens: 788_851,
          },
        ],
      },
    });
    childSummary.mockResolvedValue({
      nonDeletedChildCount: 2,
      unarchivedDescendantCount: 2,
      working: 1,
      waiting: 0,
      idle: 1,
      failed: 0,
      totalTokens: 64_400_000,
      children: [
        { id: "child-1", title: "Scout", status: "active" },
        { id: "child-2", title: "Writer", status: "idle" },
      ],
    });
  });

  it("renders a turn breakdown and an expandable child agent summary", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadTurnTokenSummary threadId="parent" turnId="da385f7e5d-t1" />
          <ThreadUsageAndAgents threadId="parent" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(
        /Input \(uncached\) 30 · Out 6\.1K · Reasoning included in output · Cached \(read \+ write\) 2\.8M/,
      ),
    ).toBeTruthy();
    expect(await screen.findByText(/Ran 2 agents/)).toBeTruthy();
    expect(screen.getByText(/Σ 64.4M/)).toBeTruthy();
    expect(
      screen.getByText(
        /Input \(uncached\) ≥ 6\.4K \(partial history\) · Out ≥ 1\.8M \(partial history\) · Reasoning included in output · Cached \(read \+ write\) ≥ 686\.7M \(partial history\)/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Σ ≥ 688\.5M \(partial history\)/)).toBeTruthy();

    fireEvent.click(screen.getByText("View ▸"));
    await waitFor(() =>
      expect(screen.getByText("Scout · active")).toBeTruthy(),
    );
    expect(screen.getByText("Writer · idle")).toBeTruthy();
  });

  it("renders unavailable when child token totals are missing", async () => {
    childSummary.mockResolvedValue({
      nonDeletedChildCount: 1,
      unarchivedDescendantCount: 1,
      working: 0,
      waiting: 0,
      idle: 1,
      failed: 0,
      totalTokens: null,
      children: [{ id: "child-1", title: "Scout", status: "idle" }],
    });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadUsageAndAgents threadId="parent" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Ran 1 agent/)).toBeTruthy();
    expect(screen.getByText(/Σ unavailable/)).toBeTruthy();
  });

  it("labels Codex cached and reasoning tokens without overstating the sum", () => {
    useThreadSpendSummary.mockReturnValue({
      data: {
        providerId: "codex",
        historyComplete: true,
        total: {
          inputTokens: 70,
          cachedInputTokens: 30,
          outputTokens: 20,
          reasoningOutputTokens: 10,
          totalTokens: 120,
        },
        turns: [],
      },
    });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadUsageAndAgents threadId="codex-thread" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(
        /Input \(uncached\) 70 · Out 20 · Reasoning \(within output\) 10 · Cached 30/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Σ 120/)).toBeTruthy();
  });
});
