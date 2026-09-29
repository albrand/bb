import { z } from "zod";
import {
  PROMPT_HISTORY_SEARCH_QUERY_MAX_LENGTH,
  promptHistorySearchResultSchema,
} from "@bb/domain";

export const promptHistorySearchQuerySchema = z
  .object({
    query: z.string().max(PROMPT_HISTORY_SEARCH_QUERY_MAX_LENGTH),
    projectId: z.string().min(1),
    limit: z.string().regex(/^\d+$/),
  })
  .partial();
export type PromptHistorySearchQuery = z.infer<
  typeof promptHistorySearchQuerySchema
>;

export const promptHistorySearchResponseSchema = z.array(
  promptHistorySearchResultSchema,
);
export type PromptHistorySearchResponse = z.infer<
  typeof promptHistorySearchResponseSchema
>;
