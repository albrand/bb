// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(cleanup);

  beforeEach(() => {
    useThreadSpendSummary.mockReset();
    childSummary.mockReset();
    useThreadSpendSummary.mockReturnValue({
      data: {
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

  it("renders compact per-turn tokens and an expandable child agent summary", async () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ThreadTurnTokenSummary threadId="parent" turnId="da385f7e5d-t1" />
            <ThreadUsageAndAgents threadId="parent" />
          </MemoryRouter>
        </QueryClientProvider>
      </TooltipProvider>,
    );

    expect(container.querySelector("[data-thread-turn-tokens]")).toBeTruthy();
    expect(screen.getByText(/cached 2\.8M/)).toBeTruthy();
    expect(screen.getByText("Σ 2.8M")).toBeTruthy();
    expect(
      container.querySelector("[data-token-total-tight]")?.textContent,
    ).toBe("3M");
    expect(screen.queryByText(/Thread tokens/)).toBeNull();
    fireEvent.pointerMove(
      container.querySelector("[data-thread-turn-tokens]")!,
    );
    expect(
      (await screen.findAllByText("Cached (read + write)")).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Included in output").length).toBeGreaterThan(0);
    expect(await screen.findByText(/Ran 2 agents/)).toBeTruthy();
    expect(screen.getByText(/Σ 64.4M/)).toBeTruthy();

    fireEvent.click(screen.getByText("View ▸"));
    await waitFor(() =>
      expect(screen.getByText("Scout · active")).toBeTruthy(),
    );
    expect(screen.getByText("Writer · idle")).toBeTruthy();
  });

  it("shows reasoning in the footer only when a turn reports it", () => {
    useThreadSpendSummary.mockReturnValue({
      data: {
        historyComplete: true,
        total: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 100,
          reasoningOutputTokens: 10,
          totalTokens: 220,
        },
        turns: [
          {
            turnId: "reasoning-turn",
            inputTokens: 100,
            cachedInputTokens: 20,
            outputTokens: 100,
            reasoningOutputTokens: 10,
            totalTokens: 220,
          },
        ],
      },
    });
    const queryClient = new QueryClient();
    render(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <ThreadTurnTokenSummary threadId="parent" turnId="reasoning-turn" />
        </QueryClientProvider>
      </TooltipProvider>,
    );

    expect(screen.getByText("reason 10")).toBeTruthy();
    expect(screen.getByText("cached 20")).toBeTruthy();
    expect(screen.getByText("Σ 220")).toBeTruthy();
  });

  it("keeps a compact desktop summary while preserving the full details popup", async () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadUsageAndAgents compactSummary threadId="parent" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("2 agents · 1 working")).toBeTruthy();
    expect(
      container.querySelector(
        '[data-thread-agent-rollup][data-compact-summary="true"]',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("View ▸"));
    expect(await screen.findByText("Scout · active")).toBeTruthy();
    expect(screen.getByText("Writer · idle")).toBeTruthy();
    expect(screen.getByText(/2 agents · 1 working · 0 waiting · 1 idle/))
      .toBeTruthy();
  });

  it("closes the drawer when leaving compact mode", async () => {
    const queryClient = new QueryClient();
    const { rerender } = render(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ThreadUsageAndAgents compact threadId="parent" />
          </MemoryRouter>
        </QueryClientProvider>
      </TooltipProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "View 2 agents: 1 working" }),
    );
    await waitFor(() => expect(screen.getByText("Agent activity")).toBeTruthy());

    rerender(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ThreadUsageAndAgents compact={false} threadId="parent" />
          </MemoryRouter>
        </QueryClientProvider>
      </TooltipProvider>,
    );
    rerender(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ThreadUsageAndAgents compact threadId="parent" />
          </MemoryRouter>
        </QueryClientProvider>
      </TooltipProvider>,
    );

    await waitFor(() =>
      expect(
        document
          .querySelector("[data-persistent-drawer-backdrop]")
          ?.getAttribute("data-state"),
      ).toBe("closed"),
    );
  });

  it("keeps partial spend compact and marks missing reasoning in the tooltip", async () => {
    useThreadSpendSummary.mockReturnValue({
      data: {
        historyComplete: true,
        total: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 100,
          reasoningOutputTokens: null,
          totalTokens: 220,
        },
        turns: [
          {
            turnId: "partial-turn",
            inputTokens: 100,
            cachedInputTokens: 20,
            outputTokens: 100,
            reasoningOutputTokens: null,
            totalTokens: 220,
          },
        ],
      },
    });
    const queryClient = new QueryClient();
    const { container } = render(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <ThreadTurnTokenSummary threadId="parent" turnId="partial-turn" />
        </QueryClientProvider>
      </TooltipProvider>,
    );
    const tokenSummary = container.querySelector("[data-thread-turn-tokens]");

    expect(
      tokenSummary?.querySelector('[data-token-part="reasoning"]'),
    ).toBeNull();
    expect(tokenSummary?.textContent).toContain("cached 20");
    expect(tokenSummary?.textContent).toContain("Σ 220");
    fireEvent.pointerMove(tokenSummary!);
    expect((await screen.findAllByText("Not reported")).length).toBeGreaterThan(
      0,
    );
  });

  it("shows nothing for a turn without recorded spend", () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ThreadTurnTokenSummary threadId="parent" turnId="older-turn" />
      </QueryClientProvider>,
    );

    expect(container.querySelector("[data-thread-turn-tokens]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("keeps a cached value for the tight footer when the total is missing", () => {
    useThreadSpendSummary.mockReturnValue({
      data: {
        historyComplete: false,
        total: {
          inputTokens: null,
          cachedInputTokens: 686_719_425,
          outputTokens: null,
          reasoningOutputTokens: null,
          totalTokens: null,
        },
        turns: [
          {
            turnId: "missing-total",
            inputTokens: null,
            cachedInputTokens: 686_719_425,
            outputTokens: null,
            reasoningOutputTokens: null,
            totalTokens: null,
          },
        ],
      },
    });
    const queryClient = new QueryClient();
    const { container } = render(
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <ThreadTurnTokenSummary threadId="parent" turnId="missing-total" />
        </QueryClientProvider>
      </TooltipProvider>,
    );

    expect(container.querySelector("[data-token-total-full]")).toBeNull();
    expect(
      container.querySelector("[data-token-total-tight]")?.textContent,
    ).toBe("687M");
    expect(
      container.querySelector("[data-thread-turn-tokens]")?.textContent,
    ).toContain("cached 686.7M");
  });

  it("omits unavailable token totals from the child agent rollup", async () => {
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
    expect(screen.queryByText(/Σ unavailable/)).toBeNull();
  });

  it("keeps the compact agent chip short and opens the full breakdown in a drawer", async () => {
    childSummary.mockResolvedValue({
      nonDeletedChildCount: 2,
      unarchivedDescendantCount: 2,
      working: 1,
      waiting: 0,
      idle: 1,
      failed: 0,
      totalTokens: 64_400_000,
      children: [
        {
          id: "child-long",
          title: "A long child thread title that ends with complete",
          status: "idle",
        },
      ],
    });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadUsageAndAgents compact threadId="parent" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const chip = await screen.findByRole("button", {
      name: "View 2 agents: 1 working",
    });
    expect(chip.textContent).toContain("2 agents2");
    expect(chip.textContent).not.toContain("working");
    expect(chip.textContent).not.toContain("waiting");
    fireEvent.click(chip);

    const drawer = await screen.findByRole("dialog", {
      name: "Agent activity",
    });
    await waitFor(() =>
      expect(drawer.querySelector("p")?.textContent).toContain(
        "Ran 2 agents · 1 working · 0 waiting",
      ),
    );
    const child = await within(drawer).findByRole("link", {
      name: "A long child thread title that ends with complete · idle",
    });
    expect(drawer.contains(child)).toBe(true);
    expect(child.classList).toContain("whitespace-normal");
    expect(child.classList).toContain("break-words");
  });

  it("keeps only the per-agent rollup in the thread header row", async () => {
    useThreadSpendSummary.mockReturnValue({
      data: {
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

    expect(await screen.findByText("View ▸")).toBeTruthy();
    expect(screen.queryByText(/Thread tokens/)).toBeNull();
    expect(screen.queryByText(/Input \(uncached\) 70/)).toBeNull();
  });
});
