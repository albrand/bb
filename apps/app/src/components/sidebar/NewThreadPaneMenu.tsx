import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import {
  ActionMenuItem,
  ActionMenuNotice,
  ActionMenuSub,
} from "@/components/ui/action-menu-items";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import {
  isAtPaneLimit,
  PANE_LIMIT_DESCRIPTION,
  PANE_LIMIT_TITLE,
  type SplitSide,
} from "@/lib/split-layout";

interface NewThreadPaneContextMenuProps {
  children: ReactNode;
  enabled: boolean;
  onOpenInPane: (side: SplitSide) => void;
}

export function NewThreadPaneContextMenu({
  children,
  enabled,
  onOpenInPane,
}: NewThreadPaneContextMenuProps) {
  const splitLayout = useAtomValue(splitLayoutAtom);
  if (!enabled) {
    return <>{children}</>;
  }
  const paneLimitBlocksOpen = isAtPaneLimit(splitLayout);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {paneLimitBlocksOpen ? (
          <ActionMenuNotice surface="context">
            {PANE_LIMIT_TITLE}. {PANE_LIMIT_DESCRIPTION}
          </ActionMenuNotice>
        ) : (
          <>
            <ActionMenuItem
              surface="context"
              icon="Columns2"
              onSelect={() => {
                onOpenInPane("right");
              }}
            >
              New thread beside
            </ActionMenuItem>
            <ActionMenuSub
              surface="context"
              icon="Rows2"
              label="New thread above or below"
            >
              <ActionMenuItem
                surface="context"
                icon="ArrowUp"
                onSelect={() => {
                  onOpenInPane("top");
                }}
              >
                New thread above
              </ActionMenuItem>
              <ActionMenuItem
                surface="context"
                icon="ArrowDown"
                onSelect={() => {
                  onOpenInPane("bottom");
                }}
              >
                New thread below
              </ActionMenuItem>
            </ActionMenuSub>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
