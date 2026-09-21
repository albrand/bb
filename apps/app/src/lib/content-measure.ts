import { getDefaultStore, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  createJsonLocalStorage,
  createLocalStorageEnumStorage,
} from "@/lib/browser-storage";

export type ContentMeasure = "comfortable" | "wide";

export const CONTENT_MEASURE_STORAGE_KEY = "bb.layout.contentMeasure";
export const COMPOSER_CONTENT_WIDTH_STORAGE_KEY =
  "bb.layout.composerContentWidth";
export const CONTENT_MEASURE_CSS_VARIABLE = "--bb-content-measure";
export const DEFAULT_CONTENT_MEASURE: ContentMeasure = "comfortable";
export const CONTENT_MEASURE_VIEWPORT_GUTTER_PX = 32;

export const CONTENT_MEASURE_WIDTH_PX: Record<ContentMeasure, number> = {
  comfortable: 760,
  wide: 960,
};

export const CONTENT_MEASURE_LABELS: Record<ContentMeasure, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
};

export const CONTENT_MEASURE_OPTIONS: readonly ContentMeasure[] = [
  "comfortable",
  "wide",
];

export const CONTENT_MEASURE_CSS_VALUE = `var(${CONTENT_MEASURE_CSS_VARIABLE}, ${CONTENT_MEASURE_WIDTH_PX.comfortable}px)`;

export const CONTENT_MEASURE_MAX_WIDTH_CLASS =
  "max-w-[var(--bb-content-measure,760px)]";

function isContentMeasure(value: string): value is ContentMeasure {
  return value === "comfortable" || value === "wide";
}

export const contentMeasureAtom = atomWithStorage<ContentMeasure>(
  CONTENT_MEASURE_STORAGE_KEY,
  DEFAULT_CONTENT_MEASURE,
  createLocalStorageEnumStorage<ContentMeasure>(isContentMeasure),
  { getOnInit: true },
);

function isStoredComposerContentWidth(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export const composerContentWidthAtom = atomWithStorage<number | null>(
  COMPOSER_CONTENT_WIDTH_STORAGE_KEY,
  null,
  createJsonLocalStorage<number | null>(isStoredComposerContentWidth),
  { getOnInit: true },
);

export function resolveContentMeasureWidth({
  measure,
  customWidthPx,
}: {
  measure: ContentMeasure;
  customWidthPx: number | null;
}): number {
  return customWidthPx ?? CONTENT_MEASURE_WIDTH_PX[measure];
}

export function applyContentMeasureWidth(widthPx: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    CONTENT_MEASURE_CSS_VARIABLE,
    `${Math.round(widthPx)}px`,
  );
}

export function applyContentMeasure(): void {
  applyContentMeasureWidth(
    resolveContentMeasureWidth({
      measure: getContentMeasure(),
      customWidthPx: getComposerContentWidth(),
    }),
  );
}

export function getContentMeasure(): ContentMeasure {
  return getDefaultStore().get(contentMeasureAtom);
}

export function getComposerContentWidth(): number | null {
  return getDefaultStore().get(composerContentWidthAtom);
}

export function getEffectiveContentMeasureWidth(): number {
  return resolveContentMeasureWidth({
    measure: getContentMeasure(),
    customWidthPx: getComposerContentWidth(),
  });
}

export function setContentMeasure(measure: ContentMeasure): void {
  getDefaultStore().set(contentMeasureAtom, measure);
  getDefaultStore().set(composerContentWidthAtom, null);
  applyContentMeasure();
}

export function setComposerContentWidth(widthPx: number | null): void {
  getDefaultStore().set(composerContentWidthAtom, widthPx);
  applyContentMeasure();
}

export function resetComposerContentWidth(): void {
  setComposerContentWidth(null);
}

export function clampComposerContentWidth({
  widthPx,
  baseWidthPx,
  viewportWidthPx,
}: {
  widthPx: number;
  baseWidthPx: number;
  viewportWidthPx: number;
}): number {
  const maxWidthPx = Math.max(
    baseWidthPx,
    Math.floor(viewportWidthPx - CONTENT_MEASURE_VIEWPORT_GUTTER_PX),
  );
  return Math.round(Math.min(maxWidthPx, Math.max(baseWidthPx, widthPx)));
}

let unsubscribeContentMeasure: (() => void) | null = null;

export function initializeContentMeasure(): void {
  applyContentMeasure();
  unsubscribeContentMeasure?.();
  const unsubscribeMeasure = getDefaultStore().sub(contentMeasureAtom, () => {
    applyContentMeasure();
  });
  const unsubscribeComposerWidth = getDefaultStore().sub(composerContentWidthAtom, () => {
    applyContentMeasure();
  });
  unsubscribeContentMeasure = () => {
    unsubscribeMeasure();
    unsubscribeComposerWidth();
  };
}

export function useContentMeasure(): ContentMeasure {
  return useAtomValue(contentMeasureAtom);
}
