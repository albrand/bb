// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddedThreadChat } from "@/components/thread/embedded-chat";
import { threadTimelineScrollAnchorAtomFamily } from "@/lib/thread-timeline-scroll-anchor";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { useThreadUnreadDividerState } from "@/views/thread-detail/useThreadUnreadDividerState";
import { ThreadProviderContext } from "../thread-provider-context";

const THREAD_ID = "thr_main";
const rows = [100, 200, 300].map((seq) =>
  conversationRow({
    id: `answer-${seq}`,
    seq,
    role: "assistant",
    text: `Answer ${seq}`,
    createdAt: seq,
    startedAt: seq,
    turnId: `turn-${seq}`,
  }),
);

class ResizeObserverMock implements ResizeObserver {
  static instances: ResizeObserverMock[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve() {}
  disconnect() {}
  trigger() {
    if (
      [...this.targets].some((target) =>
        target.hasAttribute("data-page-scroll-viewport"),
      )
    ) {
      this.callback([], this);
    }
  }
}

let height = 3500;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  height = 3500;
  frames = new Map();
  let nextHandle = 0;
  vi.useFakeTimers();
  ResizeObserverMock.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = ++nextHandle;
    frames.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    frames.delete(handle),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const area = this.closest<HTMLElement>("[data-page-scroll-viewport]");
      if (this === area) return new DOMRect(0, 0, 390, 800);
      const offset =
        this.dataset.testid === "thread-unread-divider"
          ? 900
          : this.dataset.timelineRowId === "answer-300"
            ? height - 500
            : 200;
      return new DOMRect(0, offset - (area?.scrollTop ?? 0), 390, 400);
    },
  );
});

afterEach(() => {
  cleanup();
  getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function OpenThread({
  lastReadAt,
  hasUnseenTimelineEvents,
  latestAttentionAt = 300,
}: {
  lastReadAt: number;
  hasUnseenTimelineEvents: boolean;
  latestAttentionAt?: number;
}) {
  const { placement, hasUnseenUpdatesOnOpen } = useThreadUnreadDividerState({
    routeThreadId: THREAD_ID,
    thread: { id: THREAD_ID, lastReadAt, latestAttentionAt },
  });
  return (
    <EmbeddedThreadChat
      variant="hosted-footer"
      footer={<div>Composer</div>}
      surface={{
        activeThinking: null,
        contextBoundarySeq: null,
        hasUnseenTimelineEvents:
          hasUnseenTimelineEvents || hasUnseenUpdatesOnOpen,
        isThreadTimelinePending: false,
        timelineError: false,
        showOngoingIndicator: false,
        threadId: THREAD_ID,
        threadRuntimeDisplayStatus: "idle",
        workspaceRootPath: undefined,
        timelineRows: rows,
        unreadDividerPlacement: placement,
      }}
    />
  );
}

function renderThread(lastReadAt = 150, hasUnseenTimelineEvents = false) {
  const queryClient = new QueryClient();
  const element = (unseen: boolean, latestAttentionAt = 300) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ThreadProviderContext.Provider
          value={{ providerId: "echo-agent", pluginId: "echo-provider" }}
        >
          <OpenThread
            lastReadAt={lastReadAt}
            hasUnseenTimelineEvents={unseen}
            latestAttentionAt={latestAttentionAt}
          />
        </ThreadProviderContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { container, rerender } = render(element(hasUnseenTimelineEvents));
  const area = container.querySelector<HTMLElement>(
    "[data-page-scroll-viewport]",
  );
  if (!area) throw new Error("Missing scroll viewport");
  Object.defineProperty(area, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
  Object.defineProperty(area, "clientHeight", {
    configurable: true,
    value: 800,
  });
  return {
    area,
    catchUp: () => rerender(element(true)),
    receiveAttention: () => rerender(element(false, 400)),
  };
}

function resize() {
  act(() => {
    for (const observer of ResizeObserverMock.instances) observer.trigger();
  });
}

function flushFrames() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(performance.now());
  });
}

describe("opening an unseen timeline", () => {
  it("keeps the newest answer visible after the unread divider and late layout settle", () => {
    const { area } = renderThread();
    resize();
    expect(area.scrollTop).toBe(2700);
    act(() => vi.advanceTimersByTime(1));
    expect(area.scrollTop).toBe(2700);
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(3300);
  });

  it.each(["wheel", "touch", "keyboard"])(
    "leaves deliberate upward %s scrolling alone while unseen rows settle",
    (input) => {
      const { area } = renderThread();
      resize();
      if (input === "wheel") fireEvent.wheel(area, { deltaY: -500 });
      if (input === "touch") fireEvent.touchMove(area);
      if (input === "keyboard") fireEvent.keyDown(area, { key: "ArrowUp" });
      area.scrollTop = 200;
      fireEvent.scroll(area);
      act(() => vi.advanceTimersByTime(1));
      height += 600;
      resize();
      flushFrames();
      expect(area.scrollTop).toBe(200);
    },
  );

  it("opens at the latest answer even with an anchor saved on an older visit", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area } = renderThread();
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    expect(area.scrollTop).toBe(2700);
  });

  it("preserves the saved reading position when the thread has no unseen updates", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area } = renderThread(350);
    resize();
    act(() => vi.advanceTimersByTime(1));
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
  });

  it("ignores a saved anchor for unseen streaming events without a new attention marker", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area } = renderThread(350, true);
    resize();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(3300);
  });

  it("preserves a seen thread's reading position when new attention arrives after opening", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, receiveAttention } = renderThread(350);
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    resize();
    expect(area.scrollTop).toBe(200);
    receiveAttention();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
  });

  it.each([false, true])(
    "handles late unseen data while respecting user input=%s",
    (userScrolled) => {
      getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
        rowId: "answer-100",
        offsetWithinRow: 0,
        atBottom: false,
      });
      const { area, catchUp } = renderThread(350);
      resize();
      act(() => vi.advanceTimersByTime(1));
      flushFrames();
      resize();
      expect(area.scrollTop).toBe(200);
      if (userScrolled) {
        fireEvent.wheel(area, { deltaY: -100 });
        area.scrollTop = 100;
        fireEvent.scroll(area);
      }
      catchUp();
      height += 600;
      resize();
      flushFrames();
      expect(area.scrollTop).toBe(userScrolled ? 100 : 3300);
    },
  );
});
