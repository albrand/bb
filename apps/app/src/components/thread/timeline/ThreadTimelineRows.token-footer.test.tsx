// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import liveCapture from "@/test/fixtures/thread-token-footer-live-capture.json";
import {
  commandRow,
  conversationRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

const useThreadSpendSummary = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/queries/thread-queries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/queries/thread-queries")>();
  return {
    ...actual,
    useThreadSpendSummary,
  };
});

describe("ThreadTimelineRows token footer", () => {
  beforeEach(() => {
    useThreadSpendSummary.mockReset();
    useThreadSpendSummary.mockReturnValue({
      data: liveCapture.sample.spendSummary,
    });
  });

  it("joins captured spend to an assistant response in a flat live timeline", () => {
    const row = liveCapture.sample.timelineRow;
    const assistant = conversationRow({
      id: row.id,
      threadId: row.threadId,
      turnId: row.turnId,
      role: "assistant",
      text: row.text,
      sourceSeqStart: row.sourceSeqStart,
      sourceSeqEnd: row.sourceSeqEnd,
      startedAt: row.startedAt,
      createdAt: row.createdAt,
    });

    const { container } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={row.threadId}
          timelineRows={[assistant]}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );

    expect(
      container
        .querySelector('[data-token-part="input"]')
        ?.getAttribute("aria-label"),
    ).toBe("Input 4 tokens");
    expect(
      container
        .querySelector('[data-token-part="output"]')
        ?.getAttribute("aria-label"),
    ).toBe("Output 435 tokens");
    expect(
      container
        .querySelector('[data-token-part="cached"]')
        ?.getAttribute("aria-label"),
    ).toBe("Cached 466,193 tokens");
    expect(screen.getByText("Σ 466.6K")).toBeTruthy();
    expect(
      container.querySelector("[data-token-total-tight]")?.textContent,
    ).toBe("467K");
  });

  it("keeps the footer on the last assistant message and hides the active turn", () => {
    const row = liveCapture.sample.timelineRow;
    const earlierAssistant = conversationRow({
      id: "earlier-assistant-in-live-turn",
      threadId: row.threadId,
      turnId: row.turnId,
      role: "assistant",
      text: "earlier response block",
      sourceSeqStart: row.sourceSeqStart - 1,
      sourceSeqEnd: row.sourceSeqEnd - 1,
    });
    const latestAssistant = conversationRow({
      id: row.id,
      threadId: row.threadId,
      turnId: row.turnId,
      role: "assistant",
      text: row.text,
      sourceSeqStart: row.sourceSeqStart,
      sourceSeqEnd: row.sourceSeqEnd,
      startedAt: row.startedAt,
      createdAt: row.createdAt,
    });

    const { rerender, container } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={row.threadId}
          timelineRows={[earlierAssistant, latestAssistant]}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );

    expect(
      container.querySelectorAll("[data-thread-turn-tokens]"),
    ).toHaveLength(1);
    expect(
      container
        .querySelector("[data-thread-turn-tokens]")
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe(row.id);

    rerender(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={row.threadId}
          timelineRows={[earlierAssistant, latestAssistant]}
          threadRuntimeDisplayStatus="active"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector("[data-thread-turn-tokens]")).toBeNull();
  });

  it("keeps completed token summaries when an active flat row has no turn ID", () => {
    const row = liveCapture.sample.timelineRow;
    const completedAssistant = conversationRow({
      id: row.id,
      threadId: row.threadId,
      turnId: row.turnId,
      role: "assistant",
      text: row.text,
      sourceSeqStart: row.sourceSeqStart,
      sourceSeqEnd: row.sourceSeqEnd,
      startedAt: row.startedAt,
      createdAt: row.createdAt,
    });
    const streamingAssistant = conversationRow({
      id: "streaming-assistant-without-turn-id",
      threadId: row.threadId,
      turnId: null,
      role: "assistant",
      text: "Streaming response with an unscoped row.",
      sourceSeqStart: row.sourceSeqEnd + 1,
      sourceSeqEnd: row.sourceSeqEnd + 1,
    });

    const { container } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={row.threadId}
          timelineRows={[completedAssistant, streamingAssistant]}
          threadRuntimeDisplayStatus="active"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );

    expect(
      container
        .querySelector("[data-thread-turn-tokens]")
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe(row.id);
  });

  it("hides an active turn with spend while paused in a tool call", () => {
    const firstTurn = liveCapture.sample.timelineRow;
    const activeTurn = liveCapture.sample.secondTimelineRow;
    const completedAssistant = conversationRow({
      id: firstTurn.id,
      threadId: firstTurn.threadId,
      turnId: firstTurn.turnId,
      role: "assistant",
      text: firstTurn.text,
      sourceSeqStart: firstTurn.sourceSeqStart,
      sourceSeqEnd: firstTurn.sourceSeqEnd,
    });
    const activeAssistant = conversationRow({
      id: activeTurn.id,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      role: "assistant",
      text: activeTurn.text,
      sourceSeqStart: activeTurn.sourceSeqStart,
      sourceSeqEnd: activeTurn.sourceSeqEnd,
    });
    const pendingToolCall = commandRow({
      id: "active-tool-call",
      command: "node scripts/check.js",
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      status: "pending",
      seq: activeTurn.sourceSeqEnd + 1,
    });

    const { container, rerender } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={firstTurn.threadId}
          timelineRows={[completedAssistant, activeAssistant, pendingToolCall]}
          threadRuntimeDisplayStatus="active"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );

    const summaries = container.querySelectorAll("[data-thread-turn-tokens]");
    expect(summaries).toHaveLength(1);
    expect(
      summaries[0]
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe(firstTurn.id);

    rerender(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={firstTurn.threadId}
          timelineRows={[completedAssistant, activeAssistant, pendingToolCall]}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );

    expect(
      container.querySelectorAll("[data-thread-turn-tokens]"),
    ).toHaveLength(2);
  });

  it("joins each captured response to its own turn when history is incomplete", () => {
    const sample = liveCapture.sample;
    const firstTurn = sample.timelineRow;
    const secondTurn = sample.secondTimelineRow;
    const assistantRows = [firstTurn, secondTurn].map((row) =>
      conversationRow({
        id: row.id,
        threadId: row.threadId,
        turnId: row.turnId,
        role: "assistant",
        text: row.text,
        sourceSeqStart: row.sourceSeqStart,
        sourceSeqEnd: row.sourceSeqEnd,
        startedAt: row.startedAt,
        createdAt: row.createdAt,
      }),
    );

    const { container } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={firstTurn.threadId}
          timelineRows={assistantRows}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );

    expect(sample.spendSummary.historyComplete).toBe(false);
    expect(useThreadSpendSummary).toHaveBeenCalledWith(firstTurn.threadId);
    const summaries = container.querySelectorAll("[data-thread-turn-tokens]");
    expect(summaries).toHaveLength(2);
    expect(
      summaries[0]
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe(firstTurn.id);
    expect(
      summaries[0]?.querySelector(
        '[data-token-part="output"] [data-token-value]',
      )?.textContent,
    ).toBe("435");
    expect(
      summaries[1]
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe(secondTurn.id);
    expect(
      summaries[1]?.querySelector(
        '[data-token-part="output"] [data-token-value]',
      )?.textContent,
    ).toBe("3.2K");
    expect(useThreadSpendSummary.mock.calls).toEqual([
      [firstTurn.threadId],
      [firstTurn.threadId],
    ]);
  });
});
