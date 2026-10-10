import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeTerminalThread } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { applyTerminalSessionUpsert } from "../cache-owners/terminal-cache-owner";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";

const NATIVE_TERMINAL_THREAD_QUERY_KEY = "native-terminal-thread";

export function nativeTerminalThreadQueryKey(threadId: string) {
  return [NATIVE_TERMINAL_THREAD_QUERY_KEY, threadId] as const;
}

export function useNativeTerminalThread(threadId: string) {
  return useQuery<NativeTerminalThread | null>({
    queryKey: nativeTerminalThreadQueryKey(threadId),
    queryFn: ({ signal }) => sdk.nativeTerminals.get({ threadId, signal }),
    enabled: threadId.length > 0,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
  });
}

interface OpenNativeTerminalArgs {
  cols?: number;
  rows?: number;
  threadId: string;
}

export function useOpenNativeTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to open the native session.",
      lifecycleOperation: "open_terminal",
    },
    mutationFn: (args: OpenNativeTerminalArgs) =>
      sdk.nativeTerminals.open(args),
    onSuccess: (view: NativeTerminalThread) => {
      queryClient.setQueryData(
        nativeTerminalThreadQueryKey(view.threadId),
        view,
      );
      if (view.terminal !== null) {
        applyTerminalSessionUpsert({ queryClient, session: view.terminal });
      }
    },
  });
}
