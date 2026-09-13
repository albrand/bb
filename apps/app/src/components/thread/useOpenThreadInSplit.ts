import { useCallback } from "react";
import { useStore } from "jotai";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import { notifyPaneLimit } from "@/lib/split-layout/notifyPaneLimit";
import { openThreadInSplit } from "@/lib/split-layout/openThreadInSplit";
import type { SplitSide } from "@/lib/split-layout";

export function useOpenThreadInSplit(args: {
  projectId: string;
  threadId: string;
}): ((side?: SplitSide) => void) | undefined {
  const store = useStore();
  const navigate = useRouteNavigate();
  const isCompact = useIsCompactViewport();
  const { projectId, threadId } = args;
  const openInSplit = useCallback(
    (side?: SplitSide) => {
      notifyPaneLimit(
        openThreadInSplit({
          store,
          navigate,
          projectId,
          threadId,
          isCompact,
          ...(side === undefined ? {} : { side }),
        }),
      );
    },
    [isCompact, navigate, projectId, store, threadId],
  );
  return isCompact ? undefined : openInSplit;
}
