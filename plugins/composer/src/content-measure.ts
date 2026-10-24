export type ContentMeasure = "comfortable" | "wide";

export const CONTENT_MEASURE_VIEWPORT_GUTTER_PX = 32;
export const CONTENT_MEASURE_WIDTH_PX: Record<ContentMeasure, number> = {
  comfortable: 760,
  wide: 960,
};

export function resolveContentMeasureWidth({
  measure,
  customWidthPx,
}: {
  measure: ContentMeasure;
  customWidthPx: number | null;
}): number {
  return customWidthPx ?? CONTENT_MEASURE_WIDTH_PX[measure];
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

