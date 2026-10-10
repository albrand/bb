import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeTerminalThread } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { applyNativeTerminalThreadView } from "../cache-owners/terminal-cache-owner";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";
import { nativeTerminalThreadQueryKey } from "./query-keys";

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

interface SendNativeTerminalMessageArgs {
  text: string;
  threadId: string;
}

export function useSendNativeTerminalMessage() {
  return useMutation({
    meta: {
      errorMessage: "Failed to send to the native session.",
      lifecycleOperation: "send_message",
    },
    mutationFn: ({ text, threadId }: SendNativeTerminalMessageArgs) =>
      sdk.threads.send({
        threadId,
        input: [{ type: "text", text, mentions: [] }],
        mode: "auto",
      }),
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
