// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketConnectionState } from "@/lib/ws";
import {
  getConnectionAwareQueryState,
  useConnectionAwareQueryState,
  type ConnectionAwareQueryStateArgs,
} from "./connection-aware-query-state";

const connection = vi.hoisted(() => ({
  state: "connected" as WebSocketConnectionState,
}));

vi.mock("../useServerConnectionState", () => ({
  useServerConnectionState: () => connection.state,
}));

const baseArgs: ConnectionAwareQueryStateArgs = {
  hasResolvedData: false,
  isFetching: false,
  isLoadingError: false,
  serverConnectionState: "connecting",
  connectionGracePeriodElapsed: false,
};

describe("getConnectionAwareQueryState", () => {
  it("resolves loading, unavailable, and ready states from fetch and connection state", () => {
    const cases: ReadonlyArray<{
      args: ConnectionAwareQueryStateArgs;
      status: "loading" | "unavailable" | "ready";
    }> = [
      {
        args: { ...baseArgs, isFetching: true },
        status: "loading",
      },
      {
        args: {
          ...baseArgs,
          isLoadingError: true,
          serverConnectionState: "connecting",
          connectionGracePeriodElapsed: false,
        },
        status: "loading",
      },
      {
        args: {
          ...baseArgs,
          isLoadingError: true,
          serverConnectionState: "connecting",
          connectionGracePeriodElapsed: true,
        },
        status: "unavailable",
      },
      {
        args: {
          ...baseArgs,
          isLoadingError: true,
          serverConnectionState: "connected",
          connectionGracePeriodElapsed: false,
        },
        status: "unavailable",
      },
      {
        args: {
          ...baseArgs,
          isLoadingError: true,
          isRecoverableLoadingError: true,
          serverConnectionState: "connected",
          connectionGracePeriodElapsed: false,
        },
        status: "loading",
      },
      {
        args: {
          ...baseArgs,
          isLoadingError: true,
          isRecoverableLoadingError: true,
          serverConnectionState: "reconnecting",
          connectionGracePeriodElapsed: true,
        },
        status: "unavailable",
      },
      {
        args: {
          ...baseArgs,
          hasResolvedData: true,
          serverConnectionState: "connected",
        },
        status: "ready",
      },
    ];

    for (const testCase of cases) {
      expect(getConnectionAwareQueryState(testCase.args).status).toBe(
        testCase.status,
      );
    }
  });
});

describe("useConnectionAwareQueryState retry", () => {
  type RetryProps = Omit<
    Parameters<typeof useConnectionAwareQueryState>[0],
    "refetch"
  >;
  const awaitingRetry: RetryProps = {
    enabled: true,
    hasResolvedData: false,
    isFetching: false,
    isLoadingError: true,
    isRecoverableLoadingError: true,
    retryKey: "thread-a",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    connection.state = "connected";
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderRetry(initialProps: RetryProps) {
    const refetch = vi.fn();
    const hook = renderHook(
      (props: RetryProps) => useConnectionAwareQueryState({ ...props, refetch }),
      { initialProps },
    );
    return { ...hook, refetch };
  }

  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  function expectNextRetryAfter(
    refetch: ReturnType<typeof vi.fn>,
    delayMs: number,
  ): void {
    const calls = refetch.mock.calls.length;
    advance(delayMs - 1);
    expect(refetch).toHaveBeenCalledTimes(calls);
    advance(1);
    expect(refetch).toHaveBeenCalledTimes(calls + 1);
  }

  it("backs off from one second, then from thirty seconds to a five minute cap while the error persists", () => {
    const { refetch, result } = renderRetry(awaitingRetry);

    expect(result.current.status).toBe("loading");
    for (const delayMs of [
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 120_000, 240_000,
      300_000, 300_000,
    ]) {
      expectNextRetryAfter(refetch, delayMs);
    }
  });

  it("does not retry a disabled, fetching, non-recoverable or disconnected query", () => {
    const cases: RetryProps[] = [
      { ...awaitingRetry, enabled: false },
      { ...awaitingRetry, isFetching: true },
      { ...awaitingRetry, isRecoverableLoadingError: false },
      { ...awaitingRetry, hasResolvedData: true },
    ];
    for (const props of cases) {
      const { refetch, unmount } = renderRetry(props);
      advance(60_000);
      expect(refetch).not.toHaveBeenCalled();
      unmount();
    }

    connection.state = "reconnecting";
    const { refetch } = renderRetry(awaitingRetry);
    advance(60_000);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("stops retrying when the query is disabled mid-backoff", () => {
    const { refetch, rerender } = renderRetry(awaitingRetry);
    expectNextRetryAfter(refetch, 1_000);

    rerender({ ...awaitingRetry, enabled: false });
    advance(60_000);

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("restarts the backoff for a different query key", () => {
    const { refetch, rerender } = renderRetry(awaitingRetry);
    for (const delayMs of [1_000, 2_000, 4_000]) {
      expectNextRetryAfter(refetch, delayMs);
    }

    rerender({ ...awaitingRetry, retryKey: "thread-b" });

    expectNextRetryAfter(refetch, 1_000);
  });

  it("restarts the backoff after data arrives", () => {
    const { refetch, rerender } = renderRetry(awaitingRetry);
    for (const delayMs of [1_000, 2_000, 4_000]) {
      expectNextRetryAfter(refetch, delayMs);
    }

    rerender({ ...awaitingRetry, hasResolvedData: true, isLoadingError: false });
    rerender(awaitingRetry);

    expectNextRetryAfter(refetch, 1_000);
  });

  it("does not retry after unmount", () => {
    const { refetch, unmount } = renderRetry(awaitingRetry);
    advance(500);
    unmount();
    advance(60_000);

    expect(refetch).not.toHaveBeenCalled();
  });
});
