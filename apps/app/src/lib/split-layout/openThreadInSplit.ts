import { getThreadRoutePath } from "@/lib/route-paths";
import { splitLayoutAtom } from "./atoms";
import { isAtPaneLimit, type SplitOpenResult } from "./paneLimit";
import {
  findPaneByThread,
  setFocus,
  splitPane,
  type PaneContent,
  type SplitLayout,
  type SplitSide,
} from "./index";

interface SplitLayoutStore {
  get(atom: typeof splitLayoutAtom): SplitLayout | null;
  set(atom: typeof splitLayoutAtom, value: SplitLayout): void;
}

interface OpenThreadInSplitArgs {
  store: SplitLayoutStore;
  navigate: (route: string, options?: { replace?: boolean }) => void;
  projectId: string;
  threadId: string;
  isCompact: boolean;
  side?: SplitSide;
}

export function openThreadInSplit({
  store,
  navigate,
  projectId,
  threadId,
  isCompact,
  side = "right",
}: OpenThreadInSplitArgs): SplitOpenResult {
  const route = getThreadRoutePath({ projectId, threadId });
  const layout = store.get(splitLayoutAtom);
  if (isCompact || layout === null) {
    navigate(route);
    return "navigated";
  }
  const existing = findPaneByThread(layout.root, projectId, threadId);
  if (existing !== null) {
    const next = setFocus(layout, existing.paneId);
    if (next !== layout) {
      store.set(splitLayoutAtom, next);
    }
    navigate(route, { replace: true });
    return "focused-existing";
  }
  if (isAtPaneLimit(layout)) {
    return "at-pane-limit";
  }
  const content: PaneContent = { kind: "thread", projectId, threadId };
  const next = splitPane(layout, layout.focusedPaneId, side, content);
  if (next !== layout) {
    store.set(splitLayoutAtom, next);
  }
  navigate(route);
  return "opened";
}
