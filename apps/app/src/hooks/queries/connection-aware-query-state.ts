import { useEffect, useMemo, useState } from "react";
import type { WebSocketConnectionState } from "@/lib/ws";
import { useServerConnectionState } from "../useServerConnectionState";

const CONNECTION_GRACE_PERIOD_MS = 10_000;
export const RECOVERABLE_LOADING_RETRY_BASE_DELAY_MS = 1_000;
const RECOVERABLE_LOADING_RETRY_SLOW_DELAY_MS = 30_000;
const RECOVERABLE_LOADING_RETRY_MAX_DELAY_MS = 300_000;
const RECOVERABLE_LOADING_RETRY_FAST_ATTEMPTS = Math.ceil(
  Math.log2(
    RECOVERABLE_LOADING_RETRY_SLOW_DELAY_MS /
      RECOVERABLE_LOADING_RETRY_BASE_DELAY_MS,
  ),
);

export type ConnectionAwareQueryStatus = "loading" | "ready" | "unavailable";

interface ConnectionAwareQuerySnapshot {
  hasResolvedData: boolean;
  isFetching: boolean;
  isLoadingError: boolean;
  isRecoverableLoadingError?: boolean;
}

interface UseConnectionAwareQueryStateArgs extends ConnectionAwareQuerySnapshot {
  enabled: boolean;
  refetch: () => unknown;
  retryKey: string;
}

export interface ConnectionAwareQueryStateArgs extends ConnectionAwareQuerySnapshot {
  serverConnectionState: WebSocketConnectionState;
  connectionGracePeriodElapsed: boolean;
}

interface ConnectionAwareQueryState {
  status: ConnectionAwareQueryStatus;
}

export function getConnectionAwareQueryState({
  hasResolvedData,
  isFetching,
  isLoadingError,
  isRecoverableLoadingError = false,
  serverConnectionState,
  connectionGracePeriodElapsed,
}: ConnectionAwareQueryStateArgs): ConnectionAwareQueryState {
  if (!hasResolvedData && isFetching) {
    return { status: "loading" };
  }

  if (
    !hasResolvedData &&
    isLoadingError &&
    serverConnectionState !== "connected" &&
    !connectionGracePeriodElapsed
  ) {
    return { status: "loading" };
  }

  if (
    !hasResolvedData &&
    isLoadingError &&
    isRecoverableLoadingError &&
    (serverConnectionState === "connected" || !connectionGracePeriodElapsed)
  ) {
    return { status: "loading" };
  }

  if (!hasResolvedData && isLoadingError) {
    return { status: "unavailable" };
  }

  return { status: "ready" };
}

function useServerConnectionGracePeriodElapsed(): boolean {
  const connectionState = useServerConnectionState();
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (connectionState === "connected") {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(
      () => setElapsed(true),
      CONNECTION_GRACE_PERIOD_MS,
    );
    return () => clearTimeout(timer);
  }, [connectionState]);

  return elapsed;
}

function getRecoverableLoadingRetryDelayMs(attempt: number): number {
  if (attempt < RECOVERABLE_LOADING_RETRY_FAST_ATTEMPTS) {
    return RECOVERABLE_LOADING_RETRY_BASE_DELAY_MS * 2 ** attempt;
  }
  return Math.min(
    RECOVERABLE_LOADING_RETRY_SLOW_DELAY_MS *
      2 ** (attempt - RECOVERABLE_LOADING_RETRY_FAST_ATTEMPTS),
    RECOVERABLE_LOADING_RETRY_MAX_DELAY_MS,
  );
}

function useRecoverableLoadingRetry({
  enabled,
  hasResolvedData,
  isFetching,
  isLoadingError,
  isRecoverableLoadingError,
  refetch,
  retryKey,
  serverConnectionState,
}: UseConnectionAwareQueryStateArgs & {
  serverConnectionState: WebSocketConnectionState;
}): void {
  const [retry, setRetry] = useState({ attempt: 0, key: retryKey });
  if (retry.key !== retryKey || (hasResolvedData && retry.attempt !== 0)) {
    setRetry({ attempt: 0, key: retryKey });
  }
  const isAwaitingRetry =
    enabled &&
    !hasResolvedData &&
    !isFetching &&
    isLoadingError &&
    isRecoverableLoadingError === true &&
    serverConnectionState === "connected";

  useEffect(() => {
    if (!isAwaitingRetry) {
      return;
    }
    const timer = setTimeout(
      () => {
        setRetry((current) => ({ ...current, attempt: current.attempt + 1 }));
        void refetch();
      },
      getRecoverableLoadingRetryDelayMs(retry.attempt),
    );
    return () => clearTimeout(timer);
  }, [isAwaitingRetry, refetch, retry.attempt, retryKey]);
}

export function useConnectionAwareQueryState({
  enabled,
  hasResolvedData,
  isFetching,
  isLoadingError,
  isRecoverableLoadingError,
  refetch,
  retryKey,
}: UseConnectionAwareQueryStateArgs): ConnectionAwareQueryState {
  const serverConnectionState = useServerConnectionState();
  const connectionGracePeriodElapsed = useServerConnectionGracePeriodElapsed();
  useRecoverableLoadingRetry({
    enabled,
    hasResolvedData,
    isFetching,
    isLoadingError,
    isRecoverableLoadingError,
    refetch,
    retryKey,
    serverConnectionState,
  });

  return useMemo(
    () =>
      getConnectionAwareQueryState({
        hasResolvedData,
        isFetching,
        isLoadingError,
        isRecoverableLoadingError,
        serverConnectionState,
        connectionGracePeriodElapsed,
      }),
    [
      hasResolvedData,
      isFetching,
      isLoadingError,
      isRecoverableLoadingError,
      serverConnectionState,
      connectionGracePeriodElapsed,
    ],
  );
}
