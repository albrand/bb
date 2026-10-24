import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WritingAssistanceSettingsUpdate,
  WritingAssistanceView,
  WritingVocabularyEdit,
} from "@bb/domain";
import { writeCachedWritingAssistance } from "@/hooks/cache-owners/writing-assistance-cache-owner";
import { useSystemRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { sdk } from "@/lib/sdk";
import { writingAssistanceQueryKey } from "./query-keys";

export function useWritingAssistanceView(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  useSystemRealtimeSubscription({ enabled });
  return useQuery<WritingAssistanceView>({
    queryKey: writingAssistanceQueryKey(),
    queryFn: ({ signal }) => sdk.writingAssistance.view({ signal }),
    staleTime: 30_000,
    enabled,
  });
}

export function useUpdateWritingAssistanceSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Failed to save writing assistance settings." },
    mutationFn: (update: WritingAssistanceSettingsUpdate) =>
      sdk.writingAssistance.updateSettings(update),
    onSuccess: (view) => {
      writeCachedWritingAssistance(queryClient, view);
    },
  });
}

export function useEditWritingVocabulary() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorMessage: "Failed to save the vocabulary." },
    mutationFn: (edit: WritingVocabularyEdit) =>
      sdk.writingAssistance.editVocabulary(edit),
    onSuccess: (view) => {
      writeCachedWritingAssistance(queryClient, view);
    },
  });
}
