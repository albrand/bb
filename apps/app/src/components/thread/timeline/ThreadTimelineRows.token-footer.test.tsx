// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import liveCapture from "@/test/fixtures/thread-token-footer-live-capture.json";
import {
  commandRow,
  conversationRow,
  turnRow,
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

function flatRowsWithCapturedTurns(toolStatus: "completed" | "pending") {
  const firstTurn = liveCapture.sample.timelineRow;
  const activeTurn = liveCapture.sample.secondTimelineRow;
  const assistants = [firstTurn, activeTurn].map((row) =>
    conversationRow({
      id: row.id,
      threadId: row.threadId,
      turnId: row.turnId,
      role: "assistant",
      text: row.text,
      sourceSeqStart: row.sourceSeqStart,
      sourceSeqEnd: row.sourceSeqEnd,
    }),
  );
  return {
    firstTurn,
    activeTurn,
    rows: [
      ...assistants,
      commandRow({
        id: `tool-call-${toolStatus}`,
        command: "node scripts/check.js",
        threadId: activeTurn.threadId,
        turnId: null,
        status: toolStatus,
        seq: activeTurn.sourceSeqEnd + 1,
      }),
    ],
  };
}

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
      container.querySelector('[data-token-part="input"]')?.textContent,
    ).toContain("in 4");
    expect(
      container.querySelector('[data-token-part="output"]')?.textContent,
    ).toContain("out 435");
    expect(
      container.querySelector('[data-token-part="cached"]')?.textContent,
    ).toContain("cached 466.2K");
    expect(screen.getByText("Σ 466.6K")).toBeTruthy();
    expect(
      container.querySelector("[data-token-total-tight]")?.textContent,
    ).toBe("467K");
    const breakdown = container.querySelector("[data-thread-turn-tokens]");
    expect(breakdown?.getAttribute("class")).toContain("flex-wrap");
    expect(breakdown?.getAttribute("class")).toContain("whitespace-normal");
    const trailingGroup = container.querySelector("[data-token-trailing-group]");
    expect(
      trailingGroup?.querySelector('[data-token-part="cached"]'),
    ).toBeTruthy();
    expect(
      trailingGroup?.querySelector('[data-token-part="total"]'),
    ).toBeTruthy();
  });

  it("keeps token parts visible and allows them to wrap in narrow action rows", () => {
    const actionBarStyles = readFileSync(
      join(
        process.cwd(),
        "src/components/thread/timeline/message-action-bar.css",
      ),
      "utf8",
    );
    expect(actionBarStyles).not.toMatch(
      /\[data-thread-turn-tokens\]\s*\[data-token-part="(?:reasoning|output|input|cached)"\]\s*\{\s*display:\s*none\s*;/,
    );
    expect(actionBarStyles).toContain("flex-wrap: wrap");
  });

  it("renders captured reasoning tokens on a wide flat Claude response", () => {
    const row = liveCapture.sample.timelineRow;
    useThreadSpendSummary.mockReturnValueOnce({
      data: {
        ...liveCapture.sample.spendSummary,
        total: {
          ...liveCapture.sample.spendSummary.total,
          reasoningOutputTokens: 37,
        },
        turns: liveCapture.sample.spendSummary.turns.map((turn) =>
          turn.turnId === row.turnId
            ? { ...turn, reasoningOutputTokens: 37 }
            : turn,
        ),
      },
    });
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
        <div style={{ width: 720 }}>
          <ThreadTimelineRows
            threadId={row.threadId}
            timelineRows={[assistant]}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </div>
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("[data-thread-turn-tokens]")).toHaveLength(
      1,
    );
    expect(
      container.querySelector('[data-token-part="reasoning"]')?.textContent,
    ).toBe("reason 37");
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

  it("hides the newest flat turn while active when the streaming row lacks an ID", () => {
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

    expect(container.querySelector("[data-thread-turn-tokens]")).toBeNull();
  });

  it("excludes an active flat turn after a completed response and pending command", () => {
    const { firstTurn, rows } = flatRowsWithCapturedTurns("pending");
    const { container } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={firstTurn.threadId}
          timelineRows={rows}
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
  });

  it("excludes the active flat turn between steps with no pending work", () => {
    const { firstTurn, rows } = flatRowsWithCapturedTurns("completed");
    const { container } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={firstTurn.threadId}
          timelineRows={rows}
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
  });

  it("restores all flat turn footers when the thread returns to idle", () => {
    const { firstTurn, rows } = flatRowsWithCapturedTurns("completed");
    const { container, rerender } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={firstTurn.threadId}
          timelineRows={rows}
          threadRuntimeDisplayStatus="active"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );

    expect(
      container.querySelectorAll("[data-thread-turn-tokens]"),
    ).toHaveLength(1);

    rerender(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={firstTurn.threadId}
          timelineRows={rows}
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
      summaries[0]?.querySelector('[data-token-part="output"]')?.textContent,
    ).toContain("out 435");
    expect(
      summaries[1]
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe(secondTurn.id);
    expect(
      summaries[1]?.querySelector('[data-token-part="output"]')?.textContent,
    ).toContain("out 3.2K");
    expect(useThreadSpendSummary.mock.calls).toEqual([
      [firstTurn.threadId],
      [firstTurn.threadId],
    ]);
  });

  it("shows every completed grouped response while excluding the active turn", () => {
    const sample = liveCapture.sample;
    const first = sample.timelineRow;
    const second = sample.secondTimelineRow;
    const firstAssistant = conversationRow({
      id: first.id,
      threadId: first.threadId,
      turnId: first.turnId,
      role: "assistant",
      text: first.text,
      sourceSeqStart: first.sourceSeqStart,
      sourceSeqEnd: first.sourceSeqEnd,
    });
    const secondAssistant = conversationRow({
      id: second.id,
      threadId: second.threadId,
      turnId: second.turnId,
      role: "assistant",
      text: second.text,
      sourceSeqStart: second.sourceSeqStart,
      sourceSeqEnd: second.sourceSeqEnd,
    });
    const activeRows = [
      turnRow({
        id: `turn-${first.turnId}`,
        threadId: first.threadId,
        turnId: first.turnId,
        sourceSeqStart: first.sourceSeqStart,
        sourceSeqEnd: first.sourceSeqEnd,
        status: "completed",
      }),
      firstAssistant,
      turnRow({
        id: `turn-${second.turnId}`,
        threadId: second.threadId,
        turnId: second.turnId,
        sourceSeqStart: second.sourceSeqStart,
        sourceSeqEnd: second.sourceSeqEnd,
        status: "pending",
      }),
      secondAssistant,
    ];

    const { container, rerender } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={first.threadId}
          timelineRows={activeRows}
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
    ).toBe(first.id);
    expect(
      summaries[0]?.querySelector('[data-token-part="output"]')?.textContent,
    ).toContain("out 435");
    expect(useThreadSpendSummary).toHaveBeenCalledWith(first.threadId);

    const idleRows = [...activeRows];
    idleRows[2] = turnRow({
      id: `turn-${second.turnId}`,
      threadId: second.threadId,
      turnId: second.turnId,
      sourceSeqStart: second.sourceSeqStart,
      sourceSeqEnd: second.sourceSeqEnd,
      status: "completed",
    });
    rerender(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={first.threadId}
          timelineRows={idleRows}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </MemoryRouter>,
    );
    expect(
      container.querySelectorAll("[data-thread-turn-tokens]"),
    ).toHaveLength(2);
    const idleSummaries = container.querySelectorAll(
      "[data-thread-turn-tokens]",
    );
    expect(
      idleSummaries[0]
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe(first.id);
    expect(
      idleSummaries[1]
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe(second.id);
    expect(
      idleSummaries[1]?.querySelector('[data-token-part="output"]')
        ?.textContent,
    ).toContain("out 3.2K");
  });

  it("keeps partial active-turn spend hidden while waiting for its host", () => {
    const { firstTurn, rows } = flatRowsWithCapturedTurns("pending");
    const { container } = render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId={firstTurn.threadId}
          threadIsActive={true}
          timelineRows={rows}
          threadRuntimeDisplayStatus="waiting-for-host"
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
  });
});
