import { findPane } from "./ops";
import type { SplitLayout } from "./types";

export function focusedPaneThread(
  layout: SplitLayout | null,
): { projectId: string; threadId: string } | null {
  if (layout === null) return null;
  const pane = findPane(layout.root, layout.focusedPaneId);
  if (pane === null || pane.content.kind !== "thread") return null;
  return { projectId: pane.content.projectId, threadId: pane.content.threadId };
}
