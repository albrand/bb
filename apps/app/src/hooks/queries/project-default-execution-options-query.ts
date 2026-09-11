import { useQuery } from "@tanstack/react-query";
import type { ProjectExecutionDefaults } from "@bb/domain";
import { sdk } from "@/lib/sdk";
import { useProjectDetailRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { requireProjectId, type QueryOptions } from "./query-helpers";
import { projectDefaultExecutionOptionsQueryKey } from "./query-keys";

interface UseProjectDefaultExecutionOptionsArgs {
  projectId: string | undefined;
  /** Fork (albrand/bb): a named provider's remembered settings. */
  providerId?: string;
}

export function useProjectDefaultExecutionOptions(
  args: UseProjectDefaultExecutionOptionsArgs,
  options?: QueryOptions,
) {
  const { projectId, providerId } = args;
  const enabled = (options?.enabled ?? true) && Boolean(projectId);
  useProjectDetailRealtimeSubscription(projectId, { enabled });

  return useQuery<ProjectExecutionDefaults | null>({
    queryKey: projectDefaultExecutionOptionsQueryKey({
      projectId: projectId ?? "",
      ...(providerId === undefined ? {} : { providerId }),
    }),
    queryFn: ({ signal }) =>
      sdk.projects.defaultExecutionOptions({
        projectId: requireProjectId(
          projectId,
          "useProjectDefaultExecutionOptions",
        ),
        ...(providerId === undefined ? {} : { providerId }),
        signal,
      }),
    enabled,
    staleTime: 10_000,
    placeholderData: (previousData) => (projectId ? previousData : undefined),
  });
}
