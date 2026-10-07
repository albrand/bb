// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadTimelineScrollAnchorAtomFamily } from "@/lib/thread-timeline-scroll-anchor";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { useThreadUnreadDividerState } from "@/views/thread-detail/useThreadUnreadDividerState";
import { ThreadTimelinePane } from "@/views/thread-detail/ThreadTimelinePane";
import { ThreadProviderContext } from "../thread-provider-context";

const THREAD_ID = "thr_main";
vi.mock("@/components/thread/toc/ThreadTableOfContents", () => ({
  ThreadTableOfContents: () => null,
}));
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
  thread,
  hasUnseenTimelineEvents,
  isOpening = false,
  bootstrapUpdatedAt = 0,
  isThreadQueryError = false,
  isFocused = true,
}: {
  thread: { id: string; lastReadAt: number | null; latestAttentionAt: number } | undefined;
  hasUnseenTimelineEvents: boolean;
  isOpening?: boolean;
  bootstrapUpdatedAt?: number;
  isThreadQueryError?: boolean;
  isFocused?: boolean;
}) {
  const { placement, hasUnseenTimelineEvents: openAtLatest } =
    useThreadUnreadDividerState({
      routeThreadId: THREAD_ID,
      bootstrapQuery: {
        dataUpdatedAt: bootstrapUpdatedAt,
        isFetchedAfterMount: false,
        isSuccess: bootstrapUpdatedAt > 0,
      },
      threadQuery: {
        isFetchedAfterMount: !isOpening,
        isError: isThreadQueryError,
      },
      isFocused,
      hasUnseenTimelineEvents,
      thread,
    });
  return (
    <ThreadTimelinePane
      footer={<div>Composer</div>}
      canSpawnChild={false}
      hasOlderTimelineRows={false}
      isLoadingOlderTimelineRows={false}
      isStopping={false}
      onLoadOlderRows={() => undefined}
      resolveMentionLink={() => null}
      stoppingAnchorAt={0}
      activeThinking={null}
      contextBoundarySeq={null}
      hasUnseenTimelineEvents={openAtLatest}
      isThreadTimelinePending={false}
      timelineError={false}
      showOngoingIndicator={false}
      threadId={THREAD_ID}
      threadRuntimeDisplayStatus="idle"
      workspaceRootPath={undefined}
      timelineRows={rows}
      unreadDividerPlacement={placement}
    />
  );
}

function renderThread(
  lastReadAt: number | null = 150,
  hasUnseenTimelineEvents = false,
  isOpening = false,
  bootstrapUpdatedAt = 0,
  isFocused = true,
  initialLatestAttentionAt = 300,
  hasThreadMetadata = true,
) {
  const queryClient = new QueryClient();
  let currentLastReadAt: number | null | undefined = hasThreadMetadata
    ? lastReadAt
    : undefined;
  let currentLatestAttentionAt = initialLatestAttentionAt;
  const element = (
    unseen: boolean,
    latestAttentionAt = initialLatestAttentionAt,
    opening = isOpening,
    queryError = false,
    focused = isFocused,
  ) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ThreadProviderContext.Provider
          value={{ providerId: "echo-agent", pluginId: "echo-provider" }}
        >
          <OpenThread
            hasUnseenTimelineEvents={unseen}
            thread={
              currentLastReadAt === undefined
                ? undefined
                : {
                    id: THREAD_ID,
                    lastReadAt: currentLastReadAt,
                    latestAttentionAt,
                  }
            }
            isOpening={opening}
            bootstrapUpdatedAt={bootstrapUpdatedAt}
            isThreadQueryError={queryError}
            isFocused={focused}
          />
        </ThreadProviderContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { container, rerender } = render(
    element(hasUnseenTimelineEvents, initialLatestAttentionAt, isOpening, false, isFocused),
  );
  const rerenderTimeline = (
    unseen: boolean,
    latestAttentionAt = currentLatestAttentionAt,
    opening = isOpening,
    queryError = false,
    focused = isFocused,
  ) => {
    currentLatestAttentionAt = latestAttentionAt;
    rerender(element(unseen, latestAttentionAt, opening, queryError, focused));
  };
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
    catchUpAtCurrentAttention: () => rerenderTimeline(true),
    receiveAttention: () => rerenderTimeline(false, 400),
    receiveNewTimelineEvent: (latestAttentionAt = 400) =>
      rerenderTimeline(true, latestAttentionAt),
    finishOpeningWithAttention: () => rerenderTimeline(false, 400, false),
    receiveMetadata: (readAt: number | null, attentionAt: number) => {
      currentLastReadAt = readAt;
      rerenderTimeline(false, attentionAt);
    },
    changeOpening: (opening: boolean) => rerenderTimeline(false, initialLatestAttentionAt, opening),
    receiveOpeningAttention: () => rerenderTimeline(false, 400, true),
    receiveUnseenAttentionWhileHidden: () =>
      rerenderTimeline(false, 400, false, false, false),
    blurThread: () => rerenderTimeline(false, initialLatestAttentionAt, false, false, false),
    focusThread: () => rerenderTimeline(false, 400, false, false, true),
    focusWithoutNewAttention: () =>
      rerenderTimeline(false, currentLatestAttentionAt, false, false, true),
    failOpening: () => rerenderTimeline(false, initialLatestAttentionAt, true, true),
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

  it("repairs a virtualizer scroll correction while an unseen opening is pinned", () => {
    height = 400_000;
    const { area } = renderThread();
    resize();
    expect(area.scrollTop).toBe(399_200);
    area.scrollTop = 20_500;
    fireEvent.scroll(area);
    act(() => vi.advanceTimersByTime(25_000));
    expect(area.scrollTop).toBe(399_200);
  });

  it("respects browser scrolling to a timeline control reached by Tab", () => {
    const { area } = renderThread();
    resize();
    const control = document.createElement("button");
    area.append(control);
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    act(() => control.focus());
    area.scrollTop = 200;
    fireEvent.scroll(area);
    act(() => vi.advanceTimersByTime(25_000));
    expect(area.scrollTop).toBe(200);
  });

  it("opens an existing split at its latest update when it receives focus", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, blurThread, receiveUnseenAttentionWhileHidden, focusThread } =
      renderThread(350);
    resize();
    act(() => vi.advanceTimersByTime(1));
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
    blurThread();
    receiveUnseenAttentionWhileHidden();
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
    focusThread();
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(3300);
  });

  it.each(["wheel", "touch", "keyboard", "pointer"])(
    "leaves deliberate upward %s scrolling alone while unseen rows settle",
    (input) => {
      const { area } = renderThread();
      resize();
      if (input === "wheel") fireEvent.wheel(area, { deltaY: -500 });
      if (input === "touch") fireEvent.touchMove(area);
      if (input === "keyboard") fireEvent.keyDown(area, { key: "ArrowUp" });
      if (input === "pointer") fireEvent.pointerDown(area);
      area.scrollTop = 200;
      fireEvent.scroll(area);
      if (input === "pointer") fireEvent.pointerUp(window);
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

  it("keeps a read-at-open position when later metadata becomes unread", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, finishOpeningWithAttention } = renderThread(350, false, true);
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    resize();
    expect(area.scrollTop).toBe(200);
    finishOpeningWithAttention();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
  });

  it("never re-arms a settled opening when the bootstrap freshness signal changes", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, changeOpening, receiveOpeningAttention } = renderThread(
      350,
      false,
      true,
      Date.now(),
    );
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    resize();
    expect(area.scrollTop).toBe(200);
    act(() => vi.advanceTimersByTime(6000));
    changeOpening(true);
    receiveOpeningAttention();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
  });

  it("keeps the restored position when attention follows opening settlement", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, changeOpening, receiveAttention } = renderThread(
      350,
      false,
      true,
    );
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    resize();
    changeOpening(false);
    receiveAttention();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
  });

  it("settles an opening when a refetch errors with cached thread data", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, failOpening, receiveOpeningAttention } = renderThread(
      350,
      false,
      true,
    );
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    resize();
    failOpening();
    receiveOpeningAttention();
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

  it("keeps a restored read position when a new event arrives immediately", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, receiveNewTimelineEvent } = renderThread(350);
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    resize();
    expect(area.scrollTop).toBe(200);
    receiveNewTimelineEvent(400);
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
  });

  it("opens at newest when unseen-at-open catch-up arrives after the opening window", () => {
    const { area, catchUp } = renderThread(150);
    resize();
    act(() => vi.advanceTimersByTime(25_000));
    catchUp();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(3300);
  });

  it("follows a new event when already at the bottom", () => {
    const { area, receiveNewTimelineEvent } = renderThread(350);
    resize();
    area.scrollTop = 2700;
    fireEvent.scroll(area);
    receiveNewTimelineEvent(400);
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(3300);
  });

  it("keeps the newest position when metadata arrives unread before attention and catch-up", () => {
    const { area, catchUpAtCurrentAttention, receiveAttention, receiveMetadata } = renderThread(
      350,
      false,
      false,
      0,
      true,
      300,
      false,
    );
    receiveMetadata(150, 300);
    receiveAttention();
    catchUpAtCurrentAttention();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(3300);
  });

  it.each([
    { direction: "ahead", offset: 3_600_000 },
    { direction: "behind", offset: -3_600_000 },
  ])("keeps read-at-open position with server clock $direction", ({ offset }) => {
    const clientNow = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(clientNow);
    const serverBase = clientNow + offset;
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, receiveNewTimelineEvent } = renderThread(
      serverBase,
      false,
      false,
      0,
      true,
      serverBase - 100,
    );
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    resize();
    expect(area.scrollTop).toBe(200);
    receiveNewTimelineEvent(serverBase + 100);
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
  });

  it.each([
    { direction: "ahead", offset: 3_600_000 },
    { direction: "behind", offset: -3_600_000 },
  ])("opens unseen-at-open catch-up at newest with server clock $direction", ({ offset }) => {
    const clientNow = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(clientNow);
    const serverBase = clientNow + offset;
    const { area, catchUpAtCurrentAttention } = renderThread(
      serverBase - 100,
      false,
      false,
      0,
      true,
      serverBase,
    );
    resize();
    act(() => vi.advanceTimersByTime(25_000));
    catchUpAtCurrentAttention();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(3300);
  });

  it("opens an unread thread at newest when it becomes focused", () => {
    const { area, blurThread, focusThread, receiveUnseenAttentionWhileHidden } =
      renderThread(350);
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    blurThread();
    receiveUnseenAttentionWhileHidden();
    focusThread();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(3300);
  });

  it("keeps a read restored position when the same thread becomes focused", () => {
    getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), {
      rowId: "answer-100",
      offsetWithinRow: 0,
      atBottom: false,
    });
    const { area, blurThread, focusWithoutNewAttention } = renderThread(350);
    resize();
    act(() => vi.advanceTimersByTime(1));
    flushFrames();
    resize();
    expect(area.scrollTop).toBe(200);
    blurThread();
    focusWithoutNewAttention();
    height += 600;
    resize();
    flushFrames();
    expect(area.scrollTop).toBe(200);
  });
});
