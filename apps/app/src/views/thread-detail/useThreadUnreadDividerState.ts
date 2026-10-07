import { useEffect, useState } from "react";
import type { ThreadTimelineUnreadDividerPlacement } from "@/components/thread/timeline";
import { didThreadDetailBootstrapRefreshAfterMount } from "@/hooks/queries/thread-queries";

interface ThreadUnreadDividerThreadState {
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

interface ThreadUnreadDividerSnapshot {
  attentionAt: number;
  hasUnseenUpdatesOnOpen: boolean;
  isFocused: boolean;
  isOpening: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
  threadId: string;
}

interface ThreadUnreadDividerState {
  hasUnseenTimelineEvents: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
}

interface ShouldTrackThreadUnreadDividerArgs {
  routeThreadId: string | undefined;
  threadId: string | undefined;
}

interface IsThreadUnreadArgs {
  lastReadAt: number | null | undefined;
  latestAttentionAt: number | undefined;
}

interface UseThreadUnreadDividerStateArgs {
  bootstrapQuery: Parameters<
    typeof didThreadDetailBootstrapRefreshAfterMount
  >[0];
  threadQuery: { isFetchedAfterMount: boolean; isError: boolean };
  hasUnseenTimelineEvents: boolean;
  isFocused?: boolean;
  routeThreadId: string | undefined;
  thread: ThreadUnreadDividerThreadState | undefined;
}

const NO_UNREAD_DIVIDER_STATE: ThreadUnreadDividerState = {
  hasUnseenTimelineEvents: false,
  placement: null,
};

function shouldOpenThreadAtLatest({
  hasUnseenTimelineEvents,
  hasUnseenUpdatesOnOpen,
}: {
  hasUnseenTimelineEvents: boolean;
  hasUnseenUpdatesOnOpen: boolean;
}): boolean {
  return hasUnseenTimelineEvents || hasUnseenUpdatesOnOpen;
}

function shouldTrackThreadUnreadDivider({
  routeThreadId,
  threadId,
}: ShouldTrackThreadUnreadDividerArgs): boolean {
  if (threadId === undefined || routeThreadId !== threadId) {
    return false;
  }

  return true;
}

function isThreadUnread({
  lastReadAt,
  latestAttentionAt,
}: IsThreadUnreadArgs): boolean {
  if (lastReadAt === undefined || latestAttentionAt === undefined) {
    return false;
  }
  return lastReadAt === null || lastReadAt < latestAttentionAt;
}

function buildUnreadDividerPlacement(
  thread: ThreadUnreadDividerThreadState,
): ThreadTimelineUnreadDividerPlacement | null {
  if (thread.lastReadAt === null) {
    return { kind: "before-first" };
  }
  if (thread.lastReadAt < thread.latestAttentionAt) {
    return { kind: "after-cutoff", cutoffAt: thread.lastReadAt };
  }
  return null;
}

export function useThreadUnreadDividerState({
  bootstrapQuery,
  threadQuery,
  hasUnseenTimelineEvents,
  isFocused = true,
  routeThreadId,
  thread,
}: UseThreadUnreadDividerStateArgs): ThreadUnreadDividerState {
  const isOpening =
    !didThreadDetailBootstrapRefreshAfterMount(bootstrapQuery) &&
    !threadQuery.isFetchedAfterMount &&
    !threadQuery.isError;
  const [snapshot, setSnapshot] = useState<ThreadUnreadDividerSnapshot | null>(
    null,
  );
  const threadId = thread?.id;
  const threadLastReadAt = thread?.lastReadAt;
  const threadLatestAttentionAt = thread?.latestAttentionAt;

  useEffect(() => {
    if (
      threadId === undefined ||
      threadLastReadAt === undefined ||
      threadLatestAttentionAt === undefined ||
      !shouldTrackThreadUnreadDivider({
        routeThreadId,
        threadId,
      })
    ) {
      setSnapshot(null);
      return;
    }

    const threadState: ThreadUnreadDividerThreadState = {
      id: threadId,
      lastReadAt: threadLastReadAt,
      latestAttentionAt: threadLatestAttentionAt,
    };

    setSnapshot((currentSnapshot) => {
      const nextIsOpening =
        currentSnapshot?.threadId === threadId
          ? currentSnapshot.isOpening && isOpening
          : isOpening;
      if (
        currentSnapshot?.threadId === threadId &&
        currentSnapshot.attentionAt === threadLatestAttentionAt
      ) {
        const becameFocused = !currentSnapshot.isFocused && isFocused;
        const focusChanged = currentSnapshot.isFocused !== isFocused;
        if (threadLastReadAt === null) {
          return {
            attentionAt: threadLatestAttentionAt,
            hasUnseenUpdatesOnOpen:
              currentSnapshot.hasUnseenUpdatesOnOpen || becameFocused,
            isFocused,
            isOpening: nextIsOpening,
            placement: { kind: "before-first" },
            threadId,
          };
        }
        return currentSnapshot.isOpening === nextIsOpening && !focusChanged
          ? currentSnapshot
          : {
              ...currentSnapshot,
              hasUnseenUpdatesOnOpen:
                currentSnapshot.hasUnseenUpdatesOnOpen ||
                (becameFocused &&
                  buildUnreadDividerPlacement(threadState) !== null),
              isFocused,
              isOpening: nextIsOpening,
            };
      }

      const placement = buildUnreadDividerPlacement(threadState);
      const becameFocused =
        currentSnapshot?.threadId === threadId &&
        !currentSnapshot.isFocused &&
        isFocused;
      return {
        attentionAt: threadLatestAttentionAt,
        hasUnseenUpdatesOnOpen:
          currentSnapshot?.threadId === threadId
            ? currentSnapshot.hasUnseenUpdatesOnOpen ||
              ((currentSnapshot.isOpening || becameFocused) &&
                placement !== null)
            : placement !== null,
        isFocused,
        isOpening: nextIsOpening,
        placement,
        threadId,
      };
    });
  }, [
    isOpening,
    isFocused,
    routeThreadId,
    threadId,
    threadLastReadAt,
    threadLatestAttentionAt,
  ]);

  if (
    !shouldTrackThreadUnreadDivider({
      routeThreadId,
      threadId,
    }) ||
    (snapshot !== null &&
      snapshot.threadId === threadId &&
      snapshot.attentionAt !== threadLatestAttentionAt &&
      !isThreadUnread({
        lastReadAt: threadLastReadAt,
        latestAttentionAt: threadLatestAttentionAt,
      }))
  ) {
    return {
      ...NO_UNREAD_DIVIDER_STATE,
      hasUnseenTimelineEvents: isFocused && hasUnseenTimelineEvents,
    };
  }

  const hasUnseenUpdatesOnOpen =
    snapshot !== null && snapshot.threadId === threadId
      ? snapshot.hasUnseenUpdatesOnOpen ||
        ((snapshot.isOpening || (!snapshot.isFocused && isFocused)) &&
          isThreadUnread({
            lastReadAt: threadLastReadAt,
            latestAttentionAt: threadLatestAttentionAt,
          }))
      : isThreadUnread({
          lastReadAt: threadLastReadAt,
          latestAttentionAt: threadLatestAttentionAt,
        });
  return {
    hasUnseenTimelineEvents: shouldOpenThreadAtLatest({
      hasUnseenTimelineEvents: isFocused && hasUnseenTimelineEvents,
      hasUnseenUpdatesOnOpen: isFocused && hasUnseenUpdatesOnOpen,
    }),
    placement:
      snapshot !== null && snapshot.threadId === threadId
        ? snapshot.placement
        : thread === undefined
          ? null
          : buildUnreadDividerPlacement(thread),
  };
}
