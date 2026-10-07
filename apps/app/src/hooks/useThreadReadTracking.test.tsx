// @vitest-environment jsdom

import {
  act,
  cleanup,
  renderHook,
  type RenderHookOptions,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadReadTracking } from "./useThreadReadTracking";

function renderTrackingHook<Result, Props>(
  callback: (props: Props) => Result,
  options?: RenderHookOptions<Props>,
) {
  return renderHook(callback, {
    ...options,
    wrapper: createQueryClientTestHarness().wrapper,
  });
}

type MarkThreadReadMutation = Parameters<
  typeof useThreadReadTracking
>[0]["markThreadRead"];

function makeMarkThreadRead() {
  return {
    mutateAsync: vi.fn<MarkThreadReadMutation["mutateAsync"]>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true },
          );
        }),
    ),
  } satisfies MarkThreadReadMutation;
}

function setDocumentVisibilityState(
  visibilityState: DocumentVisibilityState,
): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visibilityState,
  });
}

describe("useThreadReadTracking", () => {
  afterEach(() => {
    cleanup();
    setDocumentVisibilityState("visible");
  });

  it("does not mark read without a visible thread", () => {
    const markThreadRead = makeMarkThreadRead();

    renderTrackingHook(() =>
      useThreadReadTracking({
        markThreadRead,
        thread: undefined,
      }),
    );

    expect(markThreadRead.mutateAsync).not.toHaveBeenCalled();
  });

  it("marks an unread thread read after a mobile pageshow restore", () => {
    setDocumentVisibilityState("hidden");
    const markThreadRead = makeMarkThreadRead();

    renderTrackingHook(() =>
      useThreadReadTracking({
        markThreadRead,
        thread: {
          id: "thr_mobile_restore",
          lastReadAt: 10,
          latestAttentionAt: 20,
        },
      }),
    );

    expect(markThreadRead.mutateAsync).not.toHaveBeenCalled();

    act(() => {
      setDocumentVisibilityState("visible");
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(1);
    expect(markThreadRead.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thr_mobile_restore" }),
    );
  });

  it("marks an unread thread once per attention timestamp", () => {
    const markThreadRead = makeMarkThreadRead();
    const { rerender } = renderTrackingHook(
      ({ latestAttentionAt }: { latestAttentionAt: number }) =>
        useThreadReadTracking({
          markThreadRead,
          thread: {
            id: "thr_side_chat",
            lastReadAt: 10,
            latestAttentionAt,
          },
        }),
      { initialProps: { latestAttentionAt: 20 } },
    );

    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(1);
    expect(markThreadRead.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thr_side_chat" }),
    );

    rerender({ latestAttentionAt: 20 });
    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(1);

    rerender({ latestAttentionAt: 30 });
    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(2);
  });

  it("waits until an unread split pane receives focus before marking it read", () => {
    const markThreadRead = makeMarkThreadRead();
    const { rerender } = renderTrackingHook(
      ({ isFocused }: { isFocused: boolean }) =>
        useThreadReadTracking({
          isFocused,
          markThreadRead,
          thread: {
            id: "thr_unfocused_split",
            lastReadAt: 10,
            latestAttentionAt: 20,
          },
        }),
      { initialProps: { isFocused: false } },
    );

    expect(markThreadRead.mutateAsync).not.toHaveBeenCalled();

    rerender({ isFocused: true });

    expect(markThreadRead.mutateAsync).toHaveBeenCalledOnce();
    expect(markThreadRead.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "thr_unfocused_split" }),
    );
  });

  it("retries a failed read after pageshow while already visible", async () => {
    const markThreadRead = makeMarkThreadRead();
    markThreadRead.mutateAsync.mockRejectedValueOnce(new Error("Failed"));
    renderTrackingHook(() =>
      useThreadReadTracking({
        markThreadRead,
        thread: {
          id: "thr_side_chat",
          lastReadAt: 10,
          latestAttentionAt: 20,
        },
      }),
    );
    await act(async () => {});
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(2);
  });

  it("retries a read that fails after the page was shown again during the request", async () => {
    const markThreadRead = makeMarkThreadRead();
    let failFirstRead: (error: Error) => void = () => undefined;
    markThreadRead.mutateAsync.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirstRead = reject;
        }),
    );
    const thread = {
      id: "thr_side_chat",
      lastReadAt: 10,
      latestAttentionAt: 20,
    };
    const { rerender } = renderTrackingHook(
      ({ mutation }: { mutation: MarkThreadReadMutation }) =>
        useThreadReadTracking({ markThreadRead: mutation, thread }),
      { initialProps: { mutation: markThreadRead } },
    );
    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      failFirstRead(new Error("Failed"));
    });
    rerender({ mutation: { mutateAsync: markThreadRead.mutateAsync } });

    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(2);
  });

  it("does not undo marking the visible thread unread after tab refocus", () => {
    const markThreadRead = makeMarkThreadRead();
    type VisibleThreadProps = { lastReadAt: number | null };
    const initialProps: VisibleThreadProps = { lastReadAt: 20 };
    const { rerender } = renderTrackingHook(
      ({ lastReadAt }: VisibleThreadProps) =>
        useThreadReadTracking({
          markThreadRead,
          thread: {
            id: "thr_side_chat",
            lastReadAt,
            latestAttentionAt: 20,
          },
        }),
      { initialProps },
    );

    rerender({ lastReadAt: null });
    expect(markThreadRead.mutateAsync).not.toHaveBeenCalled();

    act(() => {
      setDocumentVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      setDocumentVisibilityState("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(markThreadRead.mutateAsync).not.toHaveBeenCalled();
  });

  it("marks a previously auto-read thread read when reopened after manual unread", async () => {
    const markThreadRead = makeMarkThreadRead();
    type ReopenThreadProps = {
      lastReadAt: number | null;
      visible: boolean;
    };
    const initialProps: ReopenThreadProps = {
      lastReadAt: 10,
      visible: true,
    };
    const { rerender } = renderTrackingHook(
      ({ lastReadAt, visible }: ReopenThreadProps) =>
        useThreadReadTracking({
          markThreadRead,
          thread: visible
            ? {
                id: "thr_side_chat",
                lastReadAt,
                latestAttentionAt: 20,
              }
            : undefined,
        }),
      { initialProps },
    );

    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(1);

    rerender({ lastReadAt: 20, visible: true });
    rerender({ lastReadAt: null, visible: true });
    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(1);

    rerender({ lastReadAt: null, visible: false });
    await act(async () => {});
    rerender({ lastReadAt: null, visible: true });

    expect(markThreadRead.mutateAsync).toHaveBeenCalledTimes(2);
  });
});
