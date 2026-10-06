import { useEffect, useRef } from "react";
import { useMutationState } from "@tanstack/react-query";
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
  markThreadRead: MarkThreadReadMutation;
  thread?: ThreadReadTrackingState;
}

interface ReadTrackingSnapshot {
  isVisible: boolean;
  isRead: boolean | null;
  latestAttentionAt: number | null;
  threadId: string | null;
}

interface ManualUnreadRequest {
  submittedAt: number;
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

function getLatestManualUnreadAt(
  requests: readonly ManualUnreadRequest[],
  threadId: string | undefined,
): number | null {
  let latest: number | null = null;
  for (const request of requests) {
    if (request.threadId !== threadId) continue;
    if (latest === null || request.submittedAt > latest) {
      latest = request.submittedAt;
    }
  }
  return latest;
}

export function useThreadReadTracking({
  markThreadRead,
  thread,
}: UseThreadReadTrackingParams) {
  const failedReadRevisionsRef = useRef<Map<string, number>>(new Map());
  const cancelledReadKeysRef = useRef<Set<string>>(new Set());
  const pendingReadControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const suppressedManualUnreadKeysRef = useRef<Set<string>>(new Set());
  const readStartedAtRef = useRef<Map<string, number>>(new Map());
  const previousSnapshotRef = useRef<ReadTrackingSnapshot | null>(null);
  const visibilityRevision = useDocumentVisibilityRevision();
  const isVisible = isDocumentVisible();
  const manualUnreadRequests = useMutationState({
    filters: { mutationKey: MARK_THREAD_UNREAD_MUTATION_KEY },
    select: (mutation): ManualUnreadRequest => ({
      submittedAt: mutation.state.submittedAt,
      threadId: readMutationThreadId(mutation.state.variables),
    }),
  });
  const latestManualUnreadAt = getLatestManualUnreadAt(
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

    if (!isVisible) {
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
      readStartedAtRef.current.clear();
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
    const failedReadRevision = failedReadRevisionsRef.current.get(marker);
    const wasCancelled = cancelledReadKeysRef.current.has(marker);
    const isRetry =
      wasCancelled ||
      (failedReadRevision !== undefined &&
        failedReadRevision !== visibilityRevision);
    const readStartedAt = readStartedAtRef.current.get(marker);
    const wasMarkedUnreadSinceRead =
      readStartedAt !== undefined &&
      latestManualUnreadAt !== null &&
      latestManualUnreadAt >= readStartedAt;
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

    if (!isOpenedThread && !hasNewAttention && !becameVisible && !isRetry) {
      return;
    }
    if (pendingReadControllersRef.current.has(marker)) {
      return;
    }

    failedReadRevisionsRef.current.delete(marker);
    cancelledReadKeysRef.current.delete(marker);
    const controller = new AbortController();
    const requestVisibilityRevision = getDocumentVisibilityRevision();
    readStartedAtRef.current.set(marker, Date.now());
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
    latestManualUnreadAt,
    markThreadRead,
    thread,
    visibilityRevision,
  ]);
}
