import { useEffect, useRef } from "react";
import { useMutationState, useQueryClient } from "@tanstack/react-query";
import type { Thread } from "@bb/domain";
import { isThreadRead, type ThreadReadState } from "@bb/client-core";
import {
  getDocumentVisibilityRevision,
  isDocumentVisible,
  useDocumentVisibilityRevision,
} from "@/lib/document-visibility";
import { MARK_THREAD_UNREAD_MUTATION_KEY } from "./mutations/thread-state-mutations";

type ThreadReadTrackingState = ThreadReadState & Pick<Thread, "id">;

interface MarkThreadReadMutation {
  mutateAsync: (input: {
    signal?: AbortSignal;
    threadId: string;
  }) => Promise<ThreadReadState>;
}

interface UseThreadReadTrackingParams {
  isFocused?: boolean;
  markThreadRead: MarkThreadReadMutation;
  thread?: ThreadReadTrackingState;
}

interface ReadTrackingSnapshot {
  isVisible: boolean;
  isFocused: boolean;
  isRead: boolean | null;
  latestAttentionAt: number | null;
  threadId: string | null;
}

interface ManualUnreadRequest {
  mutationId: number;
  threadId: string | null;
}

function readMutationThreadId(variables: unknown): string | null {
  if (
    typeof variables === "object" &&
    variables !== null &&
    "threadId" in variables &&
    typeof variables.threadId === "string"
  ) {
    return variables.threadId;
  }
  return null;
}

function getLatestManualUnreadId(
  requests: readonly ManualUnreadRequest[],
  threadId: string | undefined,
): number | null {
  let latest: number | null = null;
  for (const request of requests) {
    if (request.threadId !== threadId) continue;
    if (latest === null || request.mutationId > latest) {
      latest = request.mutationId;
    }
  }
  return latest;
}

function getLatestMutationId(
  mutations: readonly { mutationId: number }[],
): number {
  let latest = 0;
  for (const mutation of mutations) {
    latest = Math.max(latest, mutation.mutationId);
  }
  return latest;
}

export function useThreadReadTracking({
  isFocused = true,
  markThreadRead,
  thread,
}: UseThreadReadTrackingParams) {
  const failedReadRevisionsRef = useRef<Map<string, number>>(new Map());
  const cancelledReadKeysRef = useRef<Set<string>>(new Set());
  const pendingReadControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const suppressedManualUnreadKeysRef = useRef<Set<string>>(new Set());
  const unreadIdAtReadStartRef = useRef<Map<string, number>>(new Map());
  const previousSnapshotRef = useRef<ReadTrackingSnapshot | null>(null);
  const visibilityRevision = useDocumentVisibilityRevision();
  const isVisible = isDocumentVisible();
  const queryClient = useQueryClient();
  const manualUnreadRequests = useMutationState({
    filters: { mutationKey: MARK_THREAD_UNREAD_MUTATION_KEY },
    select: (mutation): ManualUnreadRequest => ({
      mutationId: mutation.mutationId,
      threadId: readMutationThreadId(mutation.state.variables),
    }),
  });
  const latestManualUnreadId = getLatestManualUnreadId(
    manualUnreadRequests,
    thread?.id,
  );

  useEffect(() => {
    const controllers = pendingReadControllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
    };
  }, []);

  useEffect(() => {
    const previousSnapshot = previousSnapshotRef.current;
    const threadIsRead = thread ? isThreadRead(thread) : null;
    const currentSnapshot: ReadTrackingSnapshot = {
      isVisible,
      isFocused,
      isRead: threadIsRead,
      latestAttentionAt: thread?.latestAttentionAt ?? null,
      threadId: thread?.id ?? null,
    };
    previousSnapshotRef.current = currentSnapshot;

    if (previousSnapshot?.threadId !== currentSnapshot.threadId) {
      for (const controller of pendingReadControllersRef.current.values()) {
        controller.abort();
      }
    }

    if (!isVisible || !isFocused) {
      return;
    }
    if (!thread) {
      return;
    }

    const marker = `${thread.id}:${thread.latestAttentionAt}`;
    const isOpenedThread =
      previousSnapshot === null || previousSnapshot.threadId !== thread.id;
    const hasNewAttention =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.latestAttentionAt !== thread.latestAttentionAt;
    if (isOpenedThread || hasNewAttention) {
      suppressedManualUnreadKeysRef.current.clear();
      unreadIdAtReadStartRef.current.clear();
    }

    if (threadIsRead) {
      failedReadRevisionsRef.current.delete(marker);
      cancelledReadKeysRef.current.delete(marker);
      suppressedManualUnreadKeysRef.current.delete(marker);
      return;
    }

    const becameVisible =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.isVisible === false;
    const becameFocused =
      previousSnapshot?.threadId === thread.id &&
      previousSnapshot.isFocused === false;
    const failedReadRevision = failedReadRevisionsRef.current.get(marker);
    const wasCancelled = cancelledReadKeysRef.current.has(marker);
    const isRetry =
      wasCancelled ||
      (failedReadRevision !== undefined &&
        failedReadRevision !== visibilityRevision);
    const unreadIdAtReadStart = unreadIdAtReadStartRef.current.get(marker);
    const wasMarkedUnreadSinceRead =
      unreadIdAtReadStart !== undefined &&
      latestManualUnreadId !== null &&
      latestManualUnreadId > unreadIdAtReadStart;
    const becameManuallyUnread =
      wasMarkedUnreadSinceRead ||
      (previousSnapshot?.threadId === thread.id &&
        previousSnapshot.latestAttentionAt === thread.latestAttentionAt &&
        previousSnapshot.isVisible &&
        previousSnapshot.isRead === true &&
        !wasCancelled &&
        failedReadRevision === undefined);

    if (becameManuallyUnread) {
      suppressedManualUnreadKeysRef.current.add(marker);
    }
    if (
      suppressedManualUnreadKeysRef.current.has(marker) &&
      !isOpenedThread &&
      !hasNewAttention
    ) {
      return;
    }

    if (
      !isOpenedThread &&
      !hasNewAttention &&
      !becameVisible &&
      !becameFocused &&
      !isRetry
    ) {
      return;
    }
    if (pendingReadControllersRef.current.has(marker)) {
      return;
    }

    failedReadRevisionsRef.current.delete(marker);
    cancelledReadKeysRef.current.delete(marker);
    const controller = new AbortController();
    const requestVisibilityRevision = getDocumentVisibilityRevision();
    unreadIdAtReadStartRef.current.set(
      marker,
      getLatestMutationId(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: MARK_THREAD_UNREAD_MUTATION_KEY }),
      ),
    );
    pendingReadControllersRef.current.set(marker, controller);
    void markThreadRead
      .mutateAsync({ signal: controller.signal, threadId: thread.id })
      .catch(() => {
        if (controller.signal.aborted) {
          cancelledReadKeysRef.current.add(marker);
          return;
        }
        failedReadRevisionsRef.current.set(marker, requestVisibilityRevision);
      })
      .finally(() => {
        if (pendingReadControllersRef.current.get(marker) === controller) {
          pendingReadControllersRef.current.delete(marker);
        }
      });
  }, [
    isVisible,
    isFocused,
    latestManualUnreadId,
    markThreadRead,
    queryClient,
    thread,
    visibilityRevision,
  ]);
}
