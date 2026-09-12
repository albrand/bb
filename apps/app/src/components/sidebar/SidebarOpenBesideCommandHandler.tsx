import { useStore } from "jotai";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { notifyPaneLimit } from "@/lib/split-layout/notifyPaneLimit";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import { findFocusedSidebarThread } from "./sidebarThreadShortcuts";

export function SidebarOpenBesideCommandHandler() {
  const store = useStore();
  const navigate = useRouteNavigate();
  const isCompact = useIsCompactViewport();

  useAppCommandHandler("thread.openBeside", () => {
    if (isCompact) return false;
    const focused = findFocusedSidebarThread(document.activeElement);
    if (focused === null) return false;
    notifyPaneLimit(
      openThreadInSplit({
        store,
        navigate,
        projectId: focused.projectId,
        threadId: focused.threadId,
        isCompact,
      }),
    );
    return true;
  });

  return null;
}
