import { useEffect, useState } from "react";
import type { ThreadTimelineUnreadDividerPlacement } from "@/components/thread/timeline";
import { didThreadDetailBootstrapRefreshAfterMount } from "@/hooks/queries/thread-queries";

interface ThreadUnreadDividerThreadState {
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

interface ThreadUnreadDividerSnapshot {
  attentionAt: number | null;
  hasObservedMetadata: boolean;
  hasUnseenTimelineEventsOnOpen: boolean;
  hasUnseenUpdatesOnOpen: boolean;
  isFocused: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
  threadId: string | undefined;
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
  return threadId !== undefined && routeThreadId === threadId;
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

function samePlacement(
  current: ThreadTimelineUnreadDividerPlacement | null,
  next: ThreadTimelineUnreadDividerPlacement | null,
): boolean {
  if (current === null || next === null) return current === next;
  if (current.kind !== next.kind) return false;
  return (
    current.kind === "before-first" ||
    (next.kind === "after-cutoff" && current.cutoffAt === next.cutoffAt)
  );
}

function createSnapshot({
  hasMetadata,
  hasUnseenTimelineEvents,
  isFocused,
  routeThreadId,
  thread,
}: {
  hasMetadata: boolean;
  hasUnseenTimelineEvents: boolean;
  isFocused: boolean;
  routeThreadId: string | undefined;
  thread: ThreadUnreadDividerThreadState | undefined;
}): ThreadUnreadDividerSnapshot {
  const matchingThread =
    thread !== undefined &&
    shouldTrackThreadUnreadDivider({ routeThreadId, threadId: thread.id });
  const availableThread = matchingThread ? thread : undefined;
  const observedThread = hasMetadata ? availableThread : undefined;
  return {
    attentionAt: availableThread?.latestAttentionAt ?? null,
    hasObservedMetadata: observedThread !== undefined,
    hasUnseenTimelineEventsOnOpen: hasUnseenTimelineEvents,
    hasUnseenUpdatesOnOpen:
      routeThreadId === undefined
        ? false
        : availableThread === undefined
          ? true
          : isThreadUnread(availableThread),
    isFocused,
    placement:
      availableThread === undefined
        ? null
        : buildUnreadDividerPlacement(availableThread),
    threadId: routeThreadId,
  };
}

export function useThreadUnreadDividerState({
  hasUnseenTimelineEvents,
  isFocused = true,
  routeThreadId,
  thread,
}: UseThreadUnreadDividerStateArgs): ThreadUnreadDividerState {
  const hasMetadata =
    thread !== undefined &&
    thread.lastReadAt !== undefined &&
    thread.latestAttentionAt !== undefined;
  const [snapshot, setSnapshot] = useState(() =>
    createSnapshot({
      hasMetadata,
      hasUnseenTimelineEvents,
      isFocused,
      routeThreadId,
      thread,
    }),
  );
  if (snapshot.threadId !== routeThreadId) {
    setSnapshot(
      createSnapshot({
        hasMetadata,
        hasUnseenTimelineEvents,
        isFocused,
        routeThreadId,
        thread,
      }),
    );
  }

  const threadId = thread?.id;
  const threadState =
    threadId !== undefined &&
    thread?.lastReadAt !== undefined &&
    thread.latestAttentionAt !== undefined
      ? thread
      : undefined;

  useEffect(() => {
    setSnapshot((currentSnapshot) => {
      if (currentSnapshot.threadId !== routeThreadId) {
        return createSnapshot({
          hasMetadata,
          hasUnseenTimelineEvents,
          isFocused,
          routeThreadId,
          thread: threadState,
        });
      }

      const matchingThread =
        threadState !== undefined &&
        shouldTrackThreadUnreadDivider({
          routeThreadId,
          threadId: threadState.id,
        });
      const observedThread =
        hasMetadata && matchingThread ? threadState : undefined;
      const firstMetadataArrived =
        !currentSnapshot.hasObservedMetadata && observedThread !== undefined;
      const becameFocused = !currentSnapshot.isFocused && isFocused;
      const hasUnseenUpdatesOnOpen = firstMetadataArrived
        ? isThreadUnread(observedThread)
        : currentSnapshot.hasUnseenUpdatesOnOpen ||
          (becameFocused &&
            observedThread !== undefined &&
            isThreadUnread(observedThread));
      const nextAttentionAt = firstMetadataArrived
        ? observedThread.latestAttentionAt
        : currentSnapshot.attentionAt;
      const nextPlacement =
        observedThread === undefined
          ? currentSnapshot.placement
          : buildUnreadDividerPlacement(observedThread);
      const hasChanged =
        firstMetadataArrived ||
        currentSnapshot.isFocused !== isFocused ||
        !samePlacement(currentSnapshot.placement, nextPlacement) ||
        currentSnapshot.hasUnseenUpdatesOnOpen !== hasUnseenUpdatesOnOpen;
      if (!hasChanged) return currentSnapshot;
      return {
        ...currentSnapshot,
        attentionAt: nextAttentionAt,
        hasObservedMetadata:
          currentSnapshot.hasObservedMetadata || firstMetadataArrived,
        hasUnseenUpdatesOnOpen,
        isFocused,
        placement: nextPlacement,
      };
    });
  }, [
    hasMetadata,
    hasUnseenTimelineEvents,
    isFocused,
    routeThreadId,
    threadState,
  ]);

  const snapshotForRoute =
    snapshot.threadId === routeThreadId
      ? snapshot
      : createSnapshot({
          hasMetadata,
          hasUnseenTimelineEvents,
          isFocused,
          routeThreadId,
          thread: threadState,
        });
  const hasUnseenTimelineEventsToOpenLatest =
    hasUnseenTimelineEvents &&
    (snapshotForRoute.hasUnseenTimelineEventsOnOpen ||
      snapshotForRoute.attentionAt === threadState?.latestAttentionAt);

  if (routeThreadId === undefined) return NO_UNREAD_DIVIDER_STATE;

  const shouldOpenForUnseenTimelineEvents =
    isFocused && hasUnseenTimelineEventsToOpenLatest;
  return {
    hasUnseenTimelineEvents: shouldOpenThreadAtLatest({
      hasUnseenTimelineEvents: shouldOpenForUnseenTimelineEvents,
      hasUnseenUpdatesOnOpen:
        isFocused && snapshotForRoute.hasUnseenUpdatesOnOpen,
    }),
    placement: snapshotForRoute.placement,
  };
}
