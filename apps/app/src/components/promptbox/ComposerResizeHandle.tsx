import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useAtom, useAtomValue } from "jotai";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  applyContentMeasure,
  applyContentMeasureWidth,
  clampComposerContentWidth,
  composerContentWidthAtom,
  CONTENT_MEASURE_WIDTH_PX,
  resetComposerContentWidth,
  resolveContentMeasureWidth,
  setComposerContentWidth,
  useContentMeasure,
} from "@/lib/content-measure";
import {
  clampComposerEditorHeight,
  composerEditorHeightAtom,
  COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE,
  COMPOSER_RESIZE_KEYBOARD_STEP_PX,
  getComposerEditorMaxHeightPx,
  type ComposerEditorLayout,
} from "./composerHeightAtoms";

type ResizeAxis = "height" | "width";

const DRAG_AXIS_LOCK_THRESHOLD_PX = 4;

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
  const contentMeasure = useContentMeasure();
  const customContentWidth = useAtomValue(composerContentWidthAtom);
  const [dragging, setDragging] = useState(false);
  const [dragAxis, setDragAxis] = useState<ResizeAxis | null>(null);
  const instructionsId = useId();
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startHeight: number;
    startWidth: number;
    axis: ResizeAxis | null;
  } | null>(null);

  const baseContentWidth = CONTENT_MEASURE_WIDTH_PX[contentMeasure];
  const currentContentWidth = resolveContentMeasureWidth({
    measure: contentMeasure,
    customWidthPx: customContentWidth,
  });

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

  const clearPreview = useCallback(() => {
    scrollContainerRef.current?.style.removeProperty(
      COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE,
    );
  }, [scrollContainerRef]);

  const commitHeight = (heightPx: number) => {
    clearPreview();
    setUserHeight(heightPx <= floorPx ? null : heightPx);
  };

  const clampWidth = useCallback(
    (widthPx: number) =>
      clampComposerContentWidth({
        widthPx,
        baseWidthPx: baseContentWidth,
        viewportWidthPx: window.innerWidth,
      }),
    [baseContentWidth],
  );

  const previewWidth = (widthPx: number) => {
    applyContentMeasureWidth(widthPx);
  };

  const commitWidth = (widthPx: number) => {
    const clampedWidth = clampWidth(widthPx);
    setComposerContentWidth(
      clampedWidth <= baseContentWidth ? null : clampedWidth,
    );
  };

  const resolveDragAxis = (
    drag: NonNullable<typeof dragRef.current>,
    clientX: number,
    clientY: number,
  ): ResizeAxis | null => {
    if (drag.axis !== null) return drag.axis;
    const deltaX = clientX - drag.startX;
    const deltaY = drag.startY - clientY;
    if (
      Math.max(Math.abs(deltaX), Math.abs(deltaY)) <
      DRAG_AXIS_LOCK_THRESHOLD_PX
    ) {
      return null;
    }
    const axis = Math.abs(deltaX) > Math.abs(deltaY) ? "width" : "height";
    drag.axis = axis;
    setDragAxis(axis);
    return axis;
  };

  useEffect(() => {
    const handleViewportResize = () => {
      dragRef.current = null;
      setDragging(false);
      setDragAxis(null);
      clearPreview();
      resetComposerContentWidth();
    };
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, [clearPreview]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startHeight: currentHeight(),
      startWidth: currentContentWidth,
      axis: null,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const axis = resolveDragAxis(drag, event.clientX, event.clientY);
    if (axis === "height") {
      previewHeight(clamp(drag.startHeight + (drag.startY - event.clientY)));
    }
    if (axis === "width") {
      previewWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)));
    }
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const axis = commit
      ? resolveDragAxis(drag, event.clientX, event.clientY)
      : null;
    dragRef.current = null;
    setDragging(false);
    setDragAxis(null);
    if (commit) {
      if (axis === "height") {
        commitHeight(clamp(drag.startHeight + (drag.startY - event.clientY)));
      }
      if (axis === "width") {
        commitWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)));
      }
    } else {
      clearPreview();
      applyContentMeasure();
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const heightDirection =
      event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    const widthDirection =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (heightDirection === 0 && widthDirection === 0) return;
    event.preventDefault();
    if (heightDirection !== 0) {
      commitHeight(
        clamp(currentHeight() + heightDirection * COMPOSER_RESIZE_KEYBOARD_STEP_PX),
      );
    }
    if (widthDirection !== 0) {
      commitWidth(
        currentContentWidth + widthDirection * COMPOSER_RESIZE_KEYBOARD_STEP_PX,
      );
    }
  };

  const maxPx = getComposerEditorMaxHeightPx(layout, typeof window === "undefined" ? 0 : window.innerHeight);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize composer and chat width"
      aria-describedby={instructionsId}
      aria-valuemin={floorPx}
      aria-valuemax={Math.max(floorPx, maxPx)}
      aria-valuenow={Math.round(userHeight ?? floorPx)}
      aria-valuetext={`Composer height ${Math.round(userHeight ?? floorPx)} pixels. Chat width ${Math.round(currentContentWidth)} pixels.`}
      data-promptbox-resize-handle=""
      data-promptbox-resize-dragging={dragging ? "" : undefined}
      data-promptbox-resize-axis={dragAxis ?? undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event, true)}
      onPointerCancel={(event) => finishDrag(event, false)}
      onDoubleClick={() => {
        commitHeight(floorPx);
        resetComposerContentWidth();
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        "absolute inset-x-12 top-0 z-20 flex h-2 touch-none items-start justify-center outline-none",
        dragAxis === "height" ? "cursor-row-resize" : dragAxis === "width" ? "cursor-col-resize" : "cursor-nesw-resize",
        "before:mt-[3px] before:h-0.5 before:w-10 before:rounded-full before:bg-border before:opacity-0 before:transition-opacity before:duration-150 motion-reduce:before:transition-none",
        "group-hover/promptbox:before:opacity-100 group-focus-within/promptbox:before:opacity-100 hover:before:bg-ring/60 focus-visible:before:bg-ring focus-visible:before:opacity-100",
        dragging && "before:bg-ring before:opacity-100",
      )}
    >
      <span id={instructionsId} className="sr-only">
        Drag up to make the composer taller, or drag right to make the chat
        wider. Each drag changes one direction only.
        Use Arrow Up and Arrow Down for composer height, Arrow Right and Arrow
        Left for chat width, or double-click to reset both.
      </span>
    </div>
  );
}
