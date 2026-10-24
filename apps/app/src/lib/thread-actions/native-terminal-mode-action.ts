import { useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type {
  NativeTerminalMode,
  NativeTerminalThread,
} from "@bb/server-contract";
import type {
  PluginThreadAction,
  PluginThreadActionDataInput,
  PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk";
import { appToast } from "@/components/ui/app-toast";
import { applyNativeTerminalModeSwitch } from "@/hooks/cache-owners/terminal-cache-owner";
import { nativeTerminalThreadQueryKey } from "@/hooks/queries/query-keys";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "@/hooks/queries/query-policies";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import { lookupCachedThread } from "@/lib/cached-thread";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { useSidebarThreadEntries } from "@/lib/sidebar-thread-entries";
import { sdk } from "@/lib/sdk";

type NativeTerminalModeState = "chat" | "terminal" | "terminalOnly" | "unknown";

export interface NativeTerminalModeData {
  providerIdOf: (threadId: string) => string | null;
  isNativeProvider: (providerId: string) => boolean;
  modeOf: (threadId: string) => NativeTerminalModeState;
  switchMode: (
    threadId: string,
    mode: NativeTerminalMode,
    projectId: string,
  ) => Promise<void>;
}

export function useNativeTerminalModeData({
  threadIds,
}: PluginThreadActionDataInput): NativeTerminalModeData {
  const queryClient = useQueryClient();
  const entries = useSidebarThreadEntries();
  const providers = useSystemProviders().data;
  const nativeProvidersKey = (providers ?? [])
    .filter((provider) => provider.capabilities.supportsNativeTerminal === true)
    .map((provider) => provider.id)
    .join("\n");
  const providerIdOf = (threadId: string) =>
    (entries.get(threadId) ?? lookupCachedThread(queryClient, threadId))
      ?.providerId ?? null;
  const nativeProviderIds = new Set(
    nativeProvidersKey === "" ? [] : nativeProvidersKey.split("\n"),
  );
  const views = useQueries({
    queries: threadIds.map((threadId) => {
      const providerId = providerIdOf(threadId);
      return {
        queryKey: nativeTerminalThreadQueryKey(threadId),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          sdk.nativeTerminals.get({ threadId, signal }),
        enabled: providerId !== null && nativeProviderIds.has(providerId),
        ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
      };
    }),
    combine: (results) =>
      results.map((result) =>
        result.status === "success"
          ? (result.data as NativeTerminalThread | null)
          : undefined,
      ),
  });
  const terminalThreadsKey = threadIds
    .map((threadId, index) => {
      const view = views[index];
      const mode: NativeTerminalModeState =
        view === undefined
          ? "unknown"
          : view === null
            ? "chat"
            : view.canReturnToChat
              ? "terminal"
              : "terminalOnly";
      return `${threadId}:${mode}`;
    })
    .join("\n");
  return useMemo(() => {
    const terminalModes = new Map(
      (terminalThreadsKey === "" ? [] : terminalThreadsKey.split("\n")).map(
        (entry) => {
          const separator = entry.lastIndexOf(":");
          return [
            entry.slice(0, separator),
            entry.slice(separator + 1) as NativeTerminalModeState,
          ] as const;
        },
      ),
    );
    const nativeProviders = new Set(
      nativeProvidersKey === "" ? [] : nativeProvidersKey.split("\n"),
    );
    return {
      providerIdOf: (threadId) =>
        (entries.get(threadId) ?? lookupCachedThread(queryClient, threadId))
          ?.providerId ?? null,
      isNativeProvider: (providerId) => nativeProviders.has(providerId),
      modeOf: (threadId) => terminalModes.get(threadId) ?? "unknown",
      switchMode: async (threadId, mode, projectId) => {
        const view = await sdk.nativeTerminals.switchMode({ threadId, mode });
        if (mode === "terminal") {
          getPromptDraftAccessor({
            kind: "thread",
            projectId,
            threadId,
          }).clear();
        }
        await applyNativeTerminalModeSwitch({ queryClient, threadId, view });
      },
    };
  }, [entries, nativeProvidersKey, queryClient, terminalThreadsKey]);
}

export function nativeTerminalModeItem({
  thread,
  data,
  navigate,
}: PluginThreadActionItemInput<NativeTerminalModeData>): PluginThreadAction | null {
  if (thread.archivedAt !== null) return null;
  const providerId = data.providerIdOf(thread.id);
  if (providerId === null || !data.isNativeProvider(providerId)) return null;
  const mode = data.modeOf(thread.id);
  if (mode === "unknown" || mode === "terminalOnly") return null;
  if (mode === "terminal") {
    return {
      label: "Back to chat",
      icon: "MessageSquare",
      run: async () => {
        try {
          await data.switchMode(thread.id, "chat", thread.projectId);
          appToast.success("Thread is back in chat");
        } catch (error) {
          showMutationErrorToast({
            error,
            fallbackMessage: "Thread could not return to chat.",
          });
        }
      },
    };
  }
  if (thread.environment === null || thread.status === "pending") {
    return null;
  }
  const running = thread.status === "starting" || thread.status === "active";
  return {
    label: "Open in terminal",
    icon: "Terminal",
    ...(running ? { detail: "Stops the running turn first" } : {}),
    run: async () => {
      try {
        await data.switchMode(thread.id, "terminal", thread.projectId);
        navigate.toThread(thread.id);
      } catch (error) {
        showMutationErrorToast({
          error,
          fallbackMessage: "Thread could not open in its terminal.",
        });
      }
    },
  };
}
