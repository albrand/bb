import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useAtom } from "jotai";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  clampComposerEditorHeight,
  composerEditorHeightAtom,
  COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE,
  COMPOSER_RESIZE_KEYBOARD_STEP_PX,
  getComposerEditorMaxHeightPx,
  type ComposerEditorLayout,
} from "./composerHeightAtoms";

export function ComposerResizeHandle({
  scrollContainerRef,
  layout,
  floorPx,
}: {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  layout: ComposerEditorLayout;
  floorPx: number;
}) {
  const [userHeight, setUserHeight] = useAtom(composerEditorHeightAtom);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);

  const clamp = useCallback(
    (heightPx: number) =>
      clampComposerEditorHeight({
        heightPx,
        floorPx,
        layout,
        viewportHeightPx: window.innerHeight,
      }),
    [floorPx, layout],
  );

  const currentHeight = () =>
    scrollContainerRef.current?.getBoundingClientRect().height ?? floorPx;

  const previewHeight = (heightPx: number) => {
    scrollContainerRef.current?.style.setProperty(
      COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE,
      `${heightPx}px`,
    );
  };

  const clearPreview = () => {
    scrollContainerRef.current?.style.removeProperty(
      COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE,
    );
  };

  const commitHeight = (heightPx: number) => {
    clearPreview();
    setUserHeight(heightPx <= floorPx ? null : heightPx);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: currentHeight(),
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    previewHeight(clamp(drag.startHeight + (drag.startY - event.clientY)));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (commit) commitHeight(clamp(drag.startHeight + (drag.startY - event.clientY)));
    else clearPreview();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction =
      event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    commitHeight(clamp(currentHeight() + direction * COMPOSER_RESIZE_KEYBOARD_STEP_PX));
  };

  const maxPx = getComposerEditorMaxHeightPx(layout, typeof window === "undefined" ? 0 : window.innerHeight);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize composer"
      aria-valuemin={floorPx}
      aria-valuemax={Math.max(floorPx, maxPx)}
      aria-valuenow={Math.round(userHeight ?? floorPx)}
      data-promptbox-resize-handle=""
      data-promptbox-resize-dragging={dragging ? "" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event, true)}
      onPointerCancel={(event) => finishDrag(event, false)}
      onDoubleClick={() => commitHeight(floorPx)}
      onKeyDown={handleKeyDown}
      className={cn(
        "absolute inset-x-12 top-0 z-20 flex h-2 cursor-row-resize touch-none items-start justify-center outline-none",
        "before:mt-[3px] before:h-0.5 before:w-10 before:rounded-full before:bg-border before:opacity-0 before:transition-opacity before:duration-150 motion-reduce:before:transition-none",
        "group-hover/promptbox:before:opacity-100 group-focus-within/promptbox:before:opacity-100 hover:before:bg-ring/60 focus-visible:before:bg-ring focus-visible:before:opacity-100",
        dragging && "before:bg-ring before:opacity-100",
      )}
    />
  );
}
