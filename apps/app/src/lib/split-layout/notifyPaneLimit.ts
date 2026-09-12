import { appToast } from "@/components/ui/app-toast";
import {
  PANE_LIMIT_DESCRIPTION,
  PANE_LIMIT_TITLE,
  type SplitOpenResult,
} from "./paneLimit";

export function notifyPaneLimit(result: SplitOpenResult): SplitOpenResult {
  if (result === "at-pane-limit") {
    appToast.warning(PANE_LIMIT_TITLE, {
      description: PANE_LIMIT_DESCRIPTION,
      id: "split-layout-pane-limit",
    });
  }
  return result;
}
