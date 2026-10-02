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
        total: {
          inputTokens: 900,
          cachedInputTokens: null,
          outputTokens: 120,
          reasoningOutputTokens: 30,
          totalTokens: 1050,
        },
        turns: [
          {
            turnId: "turn-1",
            inputTokens: 300,
            cachedInputTokens: 20,
            outputTokens: 80,
            reasoningOutputTokens: 10,
            totalTokens: 390,
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
          <ThreadTurnTokenSummary threadId="parent" turnId="turn-1" />
          <ThreadUsageAndAgents threadId="parent" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(/In 300 · Out 80 · Reasoning 10 · Cached 20/),
    ).toBeTruthy();
    expect(await screen.findByText(/Ran 2 agents/)).toBeTruthy();
    expect(screen.getByText(/Σ 64.4M/)).toBeTruthy();

    fireEvent.click(screen.getByText("View ▸"));
    await waitFor(() =>
      expect(screen.getByText("Scout · active")).toBeTruthy(),
    );
    expect(screen.getByText("Writer · idle")).toBeTruthy();
  });
});
