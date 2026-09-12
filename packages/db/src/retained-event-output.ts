import type { ThreadEventItemType } from "@bb/domain";

export const COMPLETED_EVENT_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS = 32 * 1024;
export const COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS = 2 * 1024;
export const COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS = 2 * 1024;

export type RetainedEventOutputItemKind = Extract<
  ThreadEventItemType,
  "commandExecution" | "imageGeneration" | "toolCall" | "webFetch" | "webSearch"
>;

export type RetainedEventOutputPath =
  | "aggregatedOutput"
  | "result"
  | "resultText";

export interface RetainedEventOutputTarget {
  itemKind: RetainedEventOutputItemKind;
  outputPath: RetainedEventOutputPath;
}

export interface CompletedEventOutputTruncationLimits {
  retainedHeadChars: number;
  retainedTailChars: number;
  thresholdChars: number;
}

const DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_LIMITS: CompletedEventOutputTruncationLimits =
  {
    retainedHeadChars: COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
    retainedTailChars: COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
    thresholdChars: COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
  };

const COMPLETED_EVENT_OUTPUT_TRUNCATION_LIMITS: Record<
  RetainedEventOutputItemKind,
  CompletedEventOutputTruncationLimits
> = {
  commandExecution: {
    retainedHeadChars: 4 * 1024,
    retainedTailChars: 4 * 1024,
    thresholdChars: 8 * 1024,
  },
  imageGeneration: DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_LIMITS,
  toolCall: {
    retainedHeadChars: 2 * 1024,
    retainedTailChars: 2 * 1024,
    thresholdChars: 4 * 1024,
  },
  webFetch: DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_LIMITS,
  webSearch: DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_LIMITS,
};

export function getCompletedEventOutputTruncationLimits(
  itemKind: RetainedEventOutputItemKind,
): CompletedEventOutputTruncationLimits {
  return COMPLETED_EVENT_OUTPUT_TRUNCATION_LIMITS[itemKind];
}

export const RETAINED_EVENT_OUTPUT_TARGETS = [
  { itemKind: "commandExecution", outputPath: "aggregatedOutput" },
  { itemKind: "imageGeneration", outputPath: "result" },
  { itemKind: "toolCall", outputPath: "result" },
  { itemKind: "webFetch", outputPath: "resultText" },
  { itemKind: "webSearch", outputPath: "resultText" },
] as const satisfies readonly RetainedEventOutputTarget[];
