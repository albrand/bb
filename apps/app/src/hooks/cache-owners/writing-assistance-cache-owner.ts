import type { QueryClient } from "@tanstack/react-query";
import type { WritingAssistanceView } from "@bb/server-contract";
import { writingAssistanceQueryKey } from "../queries/query-keys";

export function writeCachedWritingAssistance(
  queryClient: QueryClient,
  view: WritingAssistanceView,
): void {
  queryClient.setQueryData(writingAssistanceQueryKey(), view);
}
