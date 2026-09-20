import { useRef } from "react";

interface UseRetainedThreadSnapshotArgs<TSnapshot> {
  snapshot: TSnapshot | undefined;
  threadId: string;
}

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
