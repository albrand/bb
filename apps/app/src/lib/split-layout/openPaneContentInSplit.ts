import { splitLayoutAtom } from "./atoms";
import { isAtPaneLimit, type SplitOpenResult } from "./paneLimit";
import {
  findPaneByContent,
  findReusablePaneByContent,
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

export interface OpenPaneContentInSplitArgs {
  store: SplitLayoutStore;
  navigate: (
    route: string,
    options?: { replace?: boolean },
  ) => void | Promise<void>;
  content: PaneContent;
  route: string;
  enabled: boolean;
  side?: SplitSide;
}

export function openPaneContentInSplit({
  store,
  navigate,
  content,
  route,
  enabled,
  side = "right",
}: OpenPaneContentInSplitArgs): SplitOpenResult {
  const layout = store.get(splitLayoutAtom);
  if (!enabled || layout === null) {
    void navigate(route);
    return "navigated";
  }
  const existing = findReusablePaneByContent(layout.root, content);
  if (existing !== null) {
    const next = setFocus(layout, existing.paneId);
    if (next !== layout) store.set(splitLayoutAtom, next);
    void navigate(route, { replace: true });
    return "focused-existing";
  }
  if (isAtPaneLimit(layout)) {
    return "at-pane-limit";
  }
  const next = splitPane(layout, layout.focusedPaneId, side, content);
  if (next !== layout) store.set(splitLayoutAtom, next);
  void navigate(route);
  return "opened";
}

export function holdsPluginDetailPane(
  layout: SplitLayout | null,
  pluginId: string,
): boolean {
  if (layout === null) return false;
  return (
    findPaneByContent(layout.root, { kind: "plugin-detail", pluginId }) !== null
  );
}
