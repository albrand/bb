import {
  searchStoredPromptHistoryRows,
  type StoredPromptHistorySearchRow,
} from "@bb/db";
import {
  promptHistorySearchTerms,
  promptInputSchema,
  type PromptHistorySearchResult,
} from "@bb/domain";
import { z } from "zod";
import type { AppDeps } from "../types.js";

const storedPromptHistoryInputSchema = z.array(promptInputSchema).min(1);

interface SearchPromptHistoryArgs {
  limit: number;
  projectId: string | null;
  query: string;
}

function toPromptHistorySearchResult(
  row: StoredPromptHistorySearchRow,
): PromptHistorySearchResult | null {
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(row.input);
  } catch {
    return null;
  }
  const input = storedPromptHistoryInputSchema.safeParse(parsedInput);
  if (!input.success) return null;
  return {
    id: row.id,
    input: input.data,
    lastUsedAt: row.lastUsedAt,
    useCount: row.useCount,
    projectId: row.projectId,
    projectName: row.projectName,
    threadId: row.threadId,
    threadTitle: row.threadTitle,
  };
}

export function searchPromptHistory(
  deps: Pick<AppDeps, "db">,
  args: SearchPromptHistoryArgs,
): PromptHistorySearchResult[] {
  return searchStoredPromptHistoryRows(deps.db, {
    limit: args.limit,
    projectId: args.projectId,
    terms: promptHistorySearchTerms(args.query),
  }).flatMap((row) => toPromptHistorySearchResult(row) ?? []);
}
