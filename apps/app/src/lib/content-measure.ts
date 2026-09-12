import { getDefaultStore, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageEnumStorage } from "@/lib/browser-storage";

export type ContentMeasure = "comfortable" | "wide";

export const CONTENT_MEASURE_STORAGE_KEY = "bb.layout.contentMeasure";
export const CONTENT_MEASURE_CSS_VARIABLE = "--bb-content-measure";
export const DEFAULT_CONTENT_MEASURE: ContentMeasure = "comfortable";

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

export function applyContentMeasure(measure: ContentMeasure): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    CONTENT_MEASURE_CSS_VARIABLE,
    `${CONTENT_MEASURE_WIDTH_PX[measure]}px`,
  );
}

export function getContentMeasure(): ContentMeasure {
  return getDefaultStore().get(contentMeasureAtom);
}

export function setContentMeasure(measure: ContentMeasure): void {
  getDefaultStore().set(contentMeasureAtom, measure);
  applyContentMeasure(measure);
}

export function initializeContentMeasure(): void {
  applyContentMeasure(getContentMeasure());
}

export function useContentMeasure(): ContentMeasure {
  return useAtomValue(contentMeasureAtom);
}
