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
type WidthHandleSide = "left" | "right";

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
  const [dragWidthHandleSide, setDragWidthHandleSide] =
    useState<WidthHandleSide | null>(null);
  const heightInstructionsId = useId();
  const widthInstructionsId = useId();
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startHeight: number;
    startWidth: number;
    axis: ResizeAxis;
    widthHandleSide: WidthHandleSide | null;
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

  useEffect(() => {
    const handleViewportResize = () => {
      dragRef.current = null;
      setDragging(false);
      setDragAxis(null);
      setDragWidthHandleSide(null);
      clearPreview();
      resetComposerContentWidth();
    };
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, [clearPreview]);

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    axis: ResizeAxis,
    widthHandleSide: WidthHandleSide | null = null,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startHeight: currentHeight(),
      startWidth: currentContentWidth,
      axis,
      widthHandleSide,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDragAxis(axis);
    setDragWidthHandleSide(widthHandleSide);
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (drag.axis === "height") {
      previewHeight(clamp(drag.startHeight + (drag.startY - event.clientY)));
    }
    if (drag.axis === "width") {
      const direction = drag.widthHandleSide === "left" ? -1 : 1;
      previewWidth(
        clampWidth(drag.startWidth + direction * (event.clientX - drag.startX)),
      );
    }
  };

  const finishDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setDragAxis(null);
    setDragWidthHandleSide(null);
    if (commit) {
      if (drag.axis === "height") {
        commitHeight(clamp(drag.startHeight + (drag.startY - event.clientY)));
      }
      if (drag.axis === "width") {
        const direction = drag.widthHandleSide === "left" ? -1 : 1;
        commitWidth(
          clampWidth(
            drag.startWidth + direction * (event.clientX - drag.startX),
          ),
        );
      }
    } else {
      clearPreview();
      applyContentMeasure();
    }
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    axis: ResizeAxis,
    widthHandleSide: WidthHandleSide | null = null,
  ) => {
    const direction =
      axis === "height"
        ? event.key === "ArrowUp"
          ? 1
          : event.key === "ArrowDown"
            ? -1
            : 0
        : widthHandleSide === "left"
          ? event.key === "ArrowLeft"
            ? 1
            : event.key === "ArrowRight"
              ? -1
              : 0
          : event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowLeft"
              ? -1
              : 0;
    if (direction === 0) return;
    event.preventDefault();
    if (axis === "height") {
      commitHeight(
        clamp(currentHeight() + direction * COMPOSER_RESIZE_KEYBOARD_STEP_PX),
      );
    }
    if (axis === "width") {
      commitWidth(
        currentContentWidth + direction * COMPOSER_RESIZE_KEYBOARD_STEP_PX,
      );
    }
  };

  const maxPx = getComposerEditorMaxHeightPx(
    layout,
    typeof window === "undefined" ? 0 : window.innerHeight,
  );

  return (
    <>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="Resize composer height"
        aria-describedby={heightInstructionsId}
        aria-valuemin={floorPx}
        aria-valuemax={Math.max(floorPx, maxPx)}
        aria-valuenow={Math.round(userHeight ?? floorPx)}
        aria-valuetext={`Composer height ${Math.round(userHeight ?? floorPx)} pixels.`}
        data-promptbox-resize-handle=""
        data-promptbox-height-resize-handle=""
        data-promptbox-resize-dragging={
          dragging && dragAxis === "height" ? "" : undefined
        }
        onPointerDown={(event) => handlePointerDown(event, "height")}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishDrag(event, true)}
        onPointerCancel={(event) => finishDrag(event, false)}
        onDoubleClick={() => commitHeight(floorPx)}
        onKeyDown={(event) => handleKeyDown(event, "height")}
        className={cn(
          "absolute inset-x-12 top-0 z-20 flex h-2 cursor-row-resize touch-none items-start justify-center outline-none",
          "before:mt-[3px] before:h-0.5 before:w-10 before:rounded-full before:bg-border before:opacity-0 before:transition-opacity before:duration-150 motion-reduce:before:transition-none",
          "group-hover/promptbox:before:opacity-100 group-focus-within/promptbox:before:opacity-100 hover:before:bg-ring/60 focus-visible:before:bg-ring focus-visible:before:opacity-100",
          dragging &&
            dragAxis === "height" &&
            "before:bg-ring before:opacity-100",
        )}
      >
        <span id={heightInstructionsId} className="sr-only">
          Drag up to make the composer taller. Use Arrow Up and Arrow Down, or
          double-click to reset its height.
        </span>
      </div>
      {(["left", "right"] as const).map((side) => {
        const isLeft = side === "left";
        return (
          <div
            key={side}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={`Resize chat width from ${side} corner`}
            aria-describedby={widthInstructionsId}
            aria-valuemin={baseContentWidth}
            aria-valuemax={Math.max(
              baseContentWidth,
              Math.floor(window.innerWidth - 32),
            )}
            aria-valuenow={Math.round(currentContentWidth)}
            aria-valuetext={`Chat width ${Math.round(currentContentWidth)} pixels.`}
            data-promptbox-resize-handle=""
            data-promptbox-width-resize-handle={side}
            data-promptbox-width-resize-side={side}
            data-promptbox-resize-dragging={
              dragging && dragAxis === "width" && dragWidthHandleSide === side
                ? ""
                : undefined
            }
            onPointerDown={(event) => handlePointerDown(event, "width", side)}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => finishDrag(event, true)}
            onPointerCancel={(event) => finishDrag(event, false)}
            onDoubleClick={resetComposerContentWidth}
            onKeyDown={(event) => handleKeyDown(event, "width", side)}
            className={cn(
              "absolute -top-1 z-30 size-4 cursor-col-resize touch-none outline-none",
              isLeft ? "-left-1" : "-right-1",
              "before:absolute before:top-1 before:size-2 before:border-border before:opacity-0 before:transition-opacity before:duration-150 motion-reduce:before:transition-none",
              isLeft
                ? "before:left-1 before:rounded-tl-sm before:border-l before:border-t"
                : "before:right-1 before:rounded-tr-sm before:border-r before:border-t",
              "group-hover/promptbox:before:opacity-100 group-focus-within/promptbox:before:opacity-100 hover:before:border-ring/60 hover:before:opacity-100 focus-visible:before:border-ring focus-visible:before:opacity-100",
              dragging &&
                dragAxis === "width" &&
                dragWidthHandleSide === side &&
                "before:border-ring before:opacity-100",
            )}
          />
        );
      })}
      <span id={widthInstructionsId} className="sr-only">
        Drag either top corner outward to make the chat wider. Use the matching
        outward Arrow key, or double-click either corner to reset its width.
      </span>
    </>
  );
}
