import { z } from "zod";

const spendDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "expected a YYYY-MM-DD day");

export const spendGroupBySchema = z.enum([
  "day",
  "thread",
  "provider",
  "model",
]);
export type SpendGroupByQueryValue = z.infer<typeof spendGroupBySchema>;

export const spendRollupQuerySchema = z.object({
  from: spendDaySchema.optional(),
  to: spendDaySchema.optional(),
  groupBy: spendGroupBySchema.optional(),
  threadId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
});
export type SpendRollupQuery = z.infer<typeof spendRollupQuerySchema>;

export const spendRollupRowSchema = z.object({
  day: z.string(),
  threadId: z.string(),
  providerId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number(),
  weightedUnits: z.number(),
  turns: z.number(),
  firstEventAt: z.number(),
  lastEventAt: z.number(),
  costUsd: z.number().nullable(),
});
export type SpendRollupRowResponse = z.infer<typeof spendRollupRowSchema>;

export const spendRollupResponseSchema = z.object({
  rows: z.array(spendRollupRowSchema),
  coverage: z.object({
    threads: z.number(),
    historyComplete: z.number(),
    historyPartial: z.number(),
    totalsAreLowerBound: z.boolean(),
  }),
});
export type SpendRollupResponse = z.infer<typeof spendRollupResponseSchema>;

export const spendBackfillResponseSchema = z.object({
  threadsScanned: z.number(),
  usageEventsScanned: z.number(),
  contributionsApplied: z.number(),
  threadsHistoryComplete: z.number(),
  threadsHistoryPartial: z.number(),
});
export type SpendBackfillResponse = z.infer<typeof spendBackfillResponseSchema>;

export const spendAnalysisPayloadQuerySchema = z.object({
  from: spendDaySchema.optional(),
  to: spendDaySchema.optional(),
});
export type SpendAnalysisPayloadQuery = z.infer<
  typeof spendAnalysisPayloadQuerySchema
>;

export const spendAnalysisPayloadResponseSchema = z.object({
  payload: z.string(),
  sha256: z.string(),
  rows: z.number(),
  windowFrom: z.string(),
  windowTo: z.string(),
});
export type SpendAnalysisPayloadResponse = z.infer<
  typeof spendAnalysisPayloadResponseSchema
>;

export const spendAssessmentSchema = z.object({
  topic: z.string().min(1),
  requestedAt: z.number(),
  windowFrom: z.string(),
  windowTo: z.string(),
  payloadSha256: z.string(),
  response: z.string(),
  host: z.string(),
  threadId: z.string(),
});
export type SpendAssessment = z.infer<typeof spendAssessmentSchema>;

export const spendAssessmentListQuerySchema = z.object({
  topic: z.string().min(1).optional(),
});
export type SpendAssessmentListQuery = z.infer<
  typeof spendAssessmentListQuerySchema
>;

export const spendAssessmentListResponseSchema = z.object({
  assessments: z.array(spendAssessmentSchema),
});
export type SpendAssessmentListResponse = z.infer<
  typeof spendAssessmentListResponseSchema
>;
