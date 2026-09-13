import { useStore } from "jotai";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { notifyPaneLimit } from "@/lib/split-layout/notifyPaneLimit";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { focusedPaneThread } from "@/lib/split-layout/focusedPaneThread";
import { findFocusedSidebarThread } from "./sidebarThreadShortcuts";

export function SidebarOpenBesideCommandHandler() {
  const store = useStore();
  const navigate = useRouteNavigate();
  const isCompact = useIsCompactViewport();

  useAppCommandHandler("thread.openBeside", () => {
    if (isCompact) return false;
    const target =
      findFocusedSidebarThread(document.activeElement) ??
      focusedPaneThread(store.get(splitLayoutAtom));
    if (target === null) return false;
    notifyPaneLimit(
      openThreadInSplit({
        store,
        navigate,
        projectId: target.projectId,
        threadId: target.threadId,
        isCompact,
      }),
    );
    return true;
  });

  return null;
}
