import { z } from "zod";

/**
 * Fork (albrand/bb): the spend rollup, read back.
 *
 * The server maintains it because `thread/tokenUsage/updated` is prunable and
 * the pruner keeps at most two per thread, so a poller outside the server races
 * deletion and cannot be made correct at any interval.
 */
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

/**
 * `weightedUnits` is a cost proxy, not money.
 *
 * It applies the published price ratios (fresh input 1, cached input 0.1,
 * output 5) so providers and periods are comparable. Both providers in use here
 * are on flat subscriptions, so there is no rate to turn it into a currency
 * figure, and inventing one would be worse than leaving it out.
 *
 * `firstEventAt`/`lastEventAt` bound the real time span behind a row, whose
 * `day` is the local calendar day on the machine running the server. A consumer
 * in another timezone needs them to know whether the row straddles its own day
 * boundary.
 */
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
  /**
   * Dollars, when `fork_spend_prices` holds a rate for this provider and model.
   *
   * That table ships empty, so this is normally null. bb does not guess a rate:
   * the providers here are on flat subscriptions, and a null is visibly absent
   * where a wrong number would read as fact. A grouped row is null if any row
   * behind it is, rather than quietly reporting a partial sum as a total.
   */
  costUsd: z.number().nullable(),
});
export type SpendRollupRowResponse = z.infer<typeof spendRollupRowSchema>;

/**
 * Coverage, and why it is not a deficiency report.
 *
 * `historyPartial` counts threads that spent tokens before this rollup existed,
 * whose usage events bb had already deleted. Deletion leaves no trace, so there
 * is no missing amount to compute and bb will not guess one: those threads
 * contribute a LOWER BOUND. Render them as "at least", never as a shortfall or
 * a gap, and never subtract one figure from another to imply what is absent.
 *
 * It heals without intervention. A thread started after this rollup ships is
 * counted from its first turn, so the share of lower bounds falls on its own as
 * old threads stop being used. A high count is a statement about history, not
 * about the tracker.
 *
 * `totalsAreLowerBound` is the flag to branch a renderer on; it is true exactly
 * when `historyPartial` is above zero.
 */
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

/**
 * `threadsHistoryPartial` carries the same meaning as `historyPartial` above: a
 * lower bound, not a shortfall.
 */
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

/**
 * What an analysis request would send, returned rather than sent.
 *
 * `payload` is the literal text, so `bb spend analyze --dry-run` can print the
 * bytes instead of describing them, and `sha256` lets a stored assessment be
 * checked against the figures it was actually given.
 */
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
