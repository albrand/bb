import { useEffect, useState } from "react";
import type { ThreadTimelineUnreadDividerPlacement } from "@/components/thread/timeline";

interface ThreadUnreadDividerThreadState {
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

interface ThreadUnreadDividerSnapshot {
  attentionAt: number;
  hasUnseenUpdatesOnOpen: boolean;
  isOpening: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
  threadId: string;
}

interface ThreadUnreadDividerState {
  hasUnseenUpdatesOnOpen: boolean;
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
  isOpening: boolean;
  routeThreadId: string | undefined;
  thread: ThreadUnreadDividerThreadState | undefined;
}

const NO_UNREAD_DIVIDER_STATE: ThreadUnreadDividerState = {
  hasUnseenUpdatesOnOpen: false,
  placement: null,
};

export function shouldOpenThreadAtLatest({
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
  isOpening,
  routeThreadId,
  thread,
}: UseThreadUnreadDividerStateArgs): ThreadUnreadDividerState {
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
      if (
        currentSnapshot?.threadId === threadId &&
        currentSnapshot.attentionAt === threadLatestAttentionAt
      ) {
        if (threadLastReadAt === null) {
          return {
            attentionAt: threadLatestAttentionAt,
            hasUnseenUpdatesOnOpen: currentSnapshot.hasUnseenUpdatesOnOpen,
            isOpening,
            placement: { kind: "before-first" },
            threadId,
          };
        }
        return currentSnapshot.isOpening === isOpening
          ? currentSnapshot
          : { ...currentSnapshot, isOpening };
      }

      const placement = buildUnreadDividerPlacement(threadState);
      return {
        attentionAt: threadLatestAttentionAt,
        hasUnseenUpdatesOnOpen:
          currentSnapshot?.threadId === threadId
            ? currentSnapshot.hasUnseenUpdatesOnOpen ||
              (currentSnapshot.isOpening && placement !== null)
            : placement !== null,
        isOpening,
        placement,
        threadId,
      };
    });
  }, [
    isOpening,
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
    return NO_UNREAD_DIVIDER_STATE;
  }

  return {
    hasUnseenUpdatesOnOpen:
      snapshot !== null && snapshot.threadId === threadId
        ? snapshot.hasUnseenUpdatesOnOpen ||
          (snapshot.isOpening &&
            isThreadUnread({
              lastReadAt: threadLastReadAt,
              latestAttentionAt: threadLatestAttentionAt,
            }))
        : isThreadUnread({
            lastReadAt: threadLastReadAt,
            latestAttentionAt: threadLatestAttentionAt,
          }),
    placement:
      snapshot !== null && snapshot.threadId === threadId
        ? snapshot.placement
        : thread === undefined
          ? null
          : buildUnreadDividerPlacement(thread),
  };
}
