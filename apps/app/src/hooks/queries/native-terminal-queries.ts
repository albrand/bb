import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PromptInput } from "@bb/domain";
import type { NativeTerminalThread } from "@bb/server-contract";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";
import { sdk } from "@/lib/sdk";
import { applyNativeTerminalThreadView } from "../cache-owners/terminal-cache-owner";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";
import { nativeTerminalThreadQueryKey } from "./query-keys";

export function useNativeTerminalThread(threadId: string) {
  return useQuery<NativeTerminalThread | null>({
    queryKey: nativeTerminalThreadQueryKey(threadId),
    queryFn: async ({ signal }) => {
      const view = await sdk.nativeTerminals.get({ threadId, signal });
      if (view !== null) {
        void LazyThreadTerminalPanel.preload();
        preloadTerminalModules();
      }
      return view;
    },
    enabled: threadId.length > 0,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
  });
}

interface OpenNativeTerminalArgs {
  cols?: number;
  rows?: number;
  threadId: string;
}

interface SendNativeTerminalMessageArgs {
  input: PromptInput[];
  threadId: string;
}

export function useSendNativeTerminalMessage() {
  return useMutation({
    meta: {
      errorMessage: "Failed to send to the native session.",
      lifecycleOperation: "send_message",
    },
    mutationFn: ({ input, threadId }: SendNativeTerminalMessageArgs) =>
      sdk.threads.send({ threadId, input, mode: "auto" }),
  });
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
      applyNativeTerminalThreadView({ queryClient, view });
    },
  });
}
