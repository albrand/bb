// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

const renderedMessageTexts = vi.hoisted(() => [] as string[]);

vi.mock("./ConversationMessageContent.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./ConversationMessageContent.js")>();
  const Actual = actual.ConversationMessageContent;
  return {
    ...actual,
    ConversationMessageContent: (props: ComponentProps<typeof Actual>) => {
      renderedMessageTexts.push(props.text);
      return createElement(Actual, props);
    },
  };
});

function assistantRow(
  index: number,
  text = `Assistant answer number ${index}.`,
  turnId: string | null = null,
) {
  return conversationRow({
    id: `assistant_message_${index}`,
    role: "assistant",
    text,
    sourceSeqStart: 10 + index,
    sourceSeqEnd: 10 + index,
    threadId: "thr_main",
    turnId,
  });
}

afterEach(() => {
  cleanup();
  renderedMessageTexts.length = 0;
});

describe("ThreadTimelineRows row isolation", () => {
  it("re-renders only the rows whose mobile action display flips when a message is appended", () => {
    const queryClient = new QueryClient();
    const rows = Array.from({ length: 12 }, (_, index) => assistantRow(index));
    const renderTimeline = (timelineRows: typeof rows) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={timelineRows}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );
    const view = render(renderTimeline(rows));
    expect(renderedMessageTexts).toHaveLength(12);
    renderedMessageTexts.length = 0;

    view.rerender(renderTimeline([...rows, assistantRow(12)]));
    expect([...renderedMessageTexts].sort()).toEqual([
      "Assistant answer number 11.",
      "Assistant answer number 12.",
    ]);
  });

  it("keeps earlier flat rows memoized when a streaming assistant row is appended", () => {
    const queryClient = new QueryClient();
    const rows = Array.from({ length: 12 }, (_, index) =>
      assistantRow(index, `Assistant answer number ${index}.`, `turn_${index}`),
    );
    const streamingRow = assistantRow(
      12,
      "Assistant response, token one.",
      "turn_stream",
    );
    const renderTimeline = (timelineRows: typeof rows) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={timelineRows}
            threadRuntimeDisplayStatus="active"
            workspaceRootPath={undefined}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );
    const view = render(renderTimeline(rows));
    expect(renderedMessageTexts).toHaveLength(12);
    renderedMessageTexts.length = 0;

    view.rerender(renderTimeline([...rows, streamingRow]));
    expect([...renderedMessageTexts].sort()).toEqual([
      "Assistant answer number 11.",
      "Assistant response, token one.",
    ]);
  });
});
