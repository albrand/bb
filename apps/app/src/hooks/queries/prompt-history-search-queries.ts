import { useQuery } from "@tanstack/react-query";
import type { PromptHistorySearchResult } from "@bb/domain";
import { sdk } from "@/lib/sdk";
import { useDebouncedValue } from "../useDebouncedValue";

const PROMPT_HISTORY_SEARCH_DEBOUNCE_MS = 120;
const PROMPT_HISTORY_SEARCH_LIMIT = 100;

interface UsePromptHistorySearchArgs {
  enabled: boolean;
  projectId: string | null;
  query: string;
}

interface UsePromptHistorySearchResult {
  data: readonly PromptHistorySearchResult[] | undefined;
  debouncedQuery: string;
  isError: boolean;
  isFetching: boolean;
  isPending: boolean;
  retry: () => void;
}

export function promptHistorySearchQueryKey(args: {
  projectId: string | null;
  query: string;
}) {
  return ["prompt-history-search", args.projectId, args.query] as const;
}

export function usePromptHistorySearch({
  enabled,
  projectId,
  query,
}: UsePromptHistorySearchArgs): UsePromptHistorySearchResult {
  const debouncedQuery = useDebouncedValue(
    query,
    PROMPT_HISTORY_SEARCH_DEBOUNCE_MS,
  ).trim();
  const result = useQuery({
    queryKey: promptHistorySearchQueryKey({
      projectId,
      query: debouncedQuery,
    }),
    queryFn: ({ signal }) =>
      sdk.threads.experimental_searchPromptHistory({
        limit: String(PROMPT_HISTORY_SEARCH_LIMIT),
        ...(debouncedQuery.length === 0 ? {} : { query: debouncedQuery }),
        ...(projectId === null ? {} : { projectId }),
        signal,
      }),
    enabled,
    staleTime: 0,
    gcTime: 60_000,
  });
  return {
    data: result.data,
    debouncedQuery,
    isError: result.isError,
    isFetching: result.isFetching,
    isPending: result.isPending,
    retry: () => {
      void result.refetch();
    },
  };
}
