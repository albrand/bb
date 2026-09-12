import { atomWithStorage } from "jotai/utils";
import { createJsonLocalStorage } from "@/lib/browser-storage";

export type ComposerEditorLayout = "thread" | "root-compose";

export const COMPOSER_EDITOR_HEIGHT_STORAGE_KEY = "bb.composer.editorHeight";

export const COMPOSER_EDITOR_MAX_HEIGHT_BY_LAYOUT: Record<
  ComposerEditorLayout,
  { viewportFraction: number; insetRem: number }
> = {
  thread: { viewportFraction: 0.5, insetRem: 3 },
  "root-compose": { viewportFraction: 0.7, insetRem: 3 },
};

const ROOT_FONT_SIZE_PX = 16;

export const COMPOSER_RESIZE_KEYBOARD_STEP_PX = 24;

export const COMPOSER_EDITOR_PREVIEW_HEIGHT_CSS_VARIABLE =
  "--bb-composer-preview-height";

function isStoredComposerEditorHeight(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export const composerEditorHeightAtom = atomWithStorage<number | null>(
  COMPOSER_EDITOR_HEIGHT_STORAGE_KEY,
  null,
  createJsonLocalStorage<number | null>(isStoredComposerEditorHeight),
  { getOnInit: true },
);

export function getComposerEditorMaxHeightCss(
  layout: ComposerEditorLayout,
): string {
  const { viewportFraction, insetRem } = COMPOSER_EDITOR_MAX_HEIGHT_BY_LAYOUT[layout];
  return `calc(${viewportFraction * 100}dvh - ${insetRem}rem)`;
}

export function getComposerEditorMaxHeightPx(
  layout: ComposerEditorLayout,
  viewportHeightPx: number,
): number {
  const { viewportFraction, insetRem } = COMPOSER_EDITOR_MAX_HEIGHT_BY_LAYOUT[layout];
  return Math.max(
    0,
    Math.floor(viewportHeightPx * viewportFraction - insetRem * ROOT_FONT_SIZE_PX),
  );
}

export function clampComposerEditorHeight({
  heightPx,
  floorPx,
  layout,
  viewportHeightPx,
}: {
  heightPx: number;
  floorPx: number;
  layout: ComposerEditorLayout;
  viewportHeightPx: number;
}): number {
  const maxPx = Math.max(floorPx, getComposerEditorMaxHeightPx(layout, viewportHeightPx));
  return Math.round(Math.min(maxPx, Math.max(floorPx, heightPx)));
}

export function resolveComposerEditorMinHeightCss({
  floorPx,
  userHeightPx,
  layout,
}: {
  floorPx: number;
  userHeightPx: number | null;
  layout: ComposerEditorLayout;
}): string {
  if (userHeightPx === null || userHeightPx <= floorPx) return `${floorPx}px`;
  return `max(${floorPx}px, min(${Math.round(userHeightPx)}px, ${getComposerEditorMaxHeightCss(layout)}))`;
}
