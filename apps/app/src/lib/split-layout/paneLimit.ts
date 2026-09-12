import { countPanes, MAX_PANES } from "./ops";
import type { SplitLayout } from "./types";

export type SplitOpenResult =
  | "opened"
  | "focused-existing"
  | "navigated"
  | "at-pane-limit";

export const PANE_LIMIT_TITLE = `Pane limit reached — ${MAX_PANES} of ${MAX_PANES} open`;
export const PANE_LIMIT_DESCRIPTION = "Close a pane to open another one.";

export function isAtPaneLimit(layout: SplitLayout | null): boolean {
  return layout !== null && countPanes(layout.root) >= MAX_PANES;
}
