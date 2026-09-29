import { z } from "zod";
import { promptInputSchema } from "./shared-types.js";

export const PROMPT_HISTORY_SEARCH_LIMIT_DEFAULT = 50;
export const PROMPT_HISTORY_SEARCH_LIMIT_MAX = 200;
export const PROMPT_HISTORY_SEARCH_QUERY_MAX_LENGTH = 500;

export const promptHistorySearchResultSchema = z
  .object({
    id: z.string().min(1),
    input: z.array(promptInputSchema).min(1),
    lastUsedAt: z.number(),
    useCount: z.number().int().positive(),
    projectId: z.string().min(1),
    projectName: z.string(),
    threadId: z.string().min(1),
    threadTitle: z.string().nullable(),
  })
  .strict();
export type PromptHistorySearchResult = z.infer<
  typeof promptHistorySearchResultSchema
>;

export function promptHistorySearchTerms(query: string): string[] {
  const terms = query
    .trim()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  return [...new Set(terms)];
}
