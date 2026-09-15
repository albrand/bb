import { useRef } from "react";

interface UseRetainedThreadSnapshotArgs<TSnapshot> {
  snapshot: TSnapshot | undefined;
  threadId: string;
}

/**
 * A cache owner may briefly remove a query while replacing it after reconnect.
 * Keep the last snapshot for that exact thread visible until the replacement
 * arrives, but never carry it into a different thread route.
 */
export function useRetainedThreadSnapshot<TSnapshot>({
  snapshot,
  threadId,
}: UseRetainedThreadSnapshotArgs<TSnapshot>): TSnapshot | undefined {
  const retainedSnapshotRef = useRef<{
    snapshot: TSnapshot | undefined;
    threadId: string;
  }>({ snapshot, threadId });

  if (retainedSnapshotRef.current.threadId !== threadId) {
    retainedSnapshotRef.current = { snapshot, threadId };
  } else if (snapshot !== undefined) {
    retainedSnapshotRef.current.snapshot = snapshot;
  }

  return snapshot ?? retainedSnapshotRef.current.snapshot;
}
