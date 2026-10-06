import type { MouseEvent, ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent } from "@bb/shared-ui/dropdown-menu";

export function CompactLongPressMenuSurface({
  open,
  label,
  items,
  onOpenChange,
  onClearSuppressedClick,
  onClickCapture,
}: {
  open: boolean;
  label: string;
  items: ReactNode;
  onOpenChange: (open: boolean) => void;
  onClearSuppressedClick: () => void;
  onClickCapture: (
    event: MouseEvent<HTMLElement> | globalThis.MouseEvent,
  ) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuContent
        mobileTitle={label}
        aria-label={label}
        onPointerDownCapture={onClearSuppressedClick}
        onClickCapture={onClickCapture}
        onKeyDownCapture={onClearSuppressedClick}
      >
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
