import { z } from "zod";

export const dictationSegmentResponseSchema = z
  .object({
    raw: z.string(),
    text: z.string(),
    formatted: z.boolean(),
  })
  .strict();
export type DictationSegmentResponse = z.infer<
  typeof dictationSegmentResponseSchema
>;
