// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import liveCapture from "@/test/fixtures/thread-token-footer-live-capture.json";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
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

    expect(screen.getByText("in 4")).toBeTruthy();
    expect(screen.getByText("out 435")).toBeTruthy();
    expect(
      container.querySelector('[data-token-part="cached"]')?.textContent,
    ).toBe("cached 466.2K");
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
});
