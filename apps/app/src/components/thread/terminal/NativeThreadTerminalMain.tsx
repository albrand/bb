import { useEffect } from "react";
import { Button } from "@bb/shared-ui/button";
import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import type {
  NativeTerminalThread,
  TerminalSession,
} from "@bb/server-contract";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import {
  useNativeTerminalThread,
  useOpenNativeTerminal,
} from "@/hooks/queries/native-terminal-queries";
import { useThreadTerminals } from "@/hooks/queries/thread-terminal-queries";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";

interface NativeThreadTerminalMainProps {
  onOpenLink?: MarkdownPreviewLinkHandler;
  threadId: string;
  threadIsProvisioning: boolean;
  view: NativeTerminalThread;
}

type NativeTerminalState =
  | { kind: "preparing" }
  | { kind: "live"; terminalId: string }
  | { kind: "ended"; exitCode: number | null };

function resolveNativeTerminalState(args: {
  session: TerminalSession | null;
  threadIsProvisioning: boolean;
}): NativeTerminalState {
  if (args.session === null) {
    return args.threadIsProvisioning
      ? { kind: "preparing" }
      : { kind: "ended", exitCode: null };
  }
  if (args.session.status === "exited") {
    return { kind: "ended", exitCode: args.session.exitCode };
  }
  return { kind: "live", terminalId: args.session.id };
}

export function NativeThreadTerminalMain({
  onOpenLink,
  threadId,
  threadIsProvisioning,
  view,
}: NativeThreadTerminalMainProps) {
  const terminalsQuery = useThreadTerminals(threadId);
  const nativeQuery = useNativeTerminalThread(threadId);
  const openNative = useOpenNativeTerminal();
  const terminalId = view.terminal?.id ?? null;
  const session =
    terminalsQuery.data?.sessions.find((entry) => entry.id === terminalId) ??
    view.terminal;
  const state = resolveNativeTerminalState({ session, threadIsProvisioning });
  const providerLabel = view.displayName;
  const paneIsFocused = useOptionalPaneContext()?.isFocused ?? true;
  const isTouchDevice = useMediaQuery("(pointer: coarse)");
  const { refetch } = nativeQuery;
  const terminalsUpdatedAt = terminalsQuery.dataUpdatedAt;

  useEffect(() => {
    if (state.kind === "live") return;
    void refetch();
  }, [refetch, state.kind, terminalsUpdatedAt]);

  if (state.kind === "live") {
    return (
      <div
        className="flex h-full min-h-0 min-w-0 flex-col"
        data-native-terminal-thread={view.providerId}
        data-no-sidebar-swipe=""
      >
        <LazyThreadTerminalPanel
          autoFocus={paneIsFocused}
          isPanelOpen
          isPanelPersistedOpen
          onOpenLink={onOpenLink}
          target={{ kind: "thread", threadId }}
          terminalId={state.terminalId}
        />
        {isTouchDevice ? (
          <NativeTerminalPromptBar
            providerLabel={providerLabel}
            threadId={threadId}
          />
        ) : null}
      </div>
    );
  }

  if (state.kind === "preparing") {
    return (
      <div
        className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
        data-native-terminal-thread={view.providerId}
      >
        Preparing the workspace for {providerLabel}…
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm"
      data-native-terminal-thread={view.providerId}
    >
      <p className="font-medium text-foreground">
        {providerLabel} session ended
        {state.exitCode !== null && state.exitCode !== 0
          ? ` (exit ${state.exitCode})`
          : ""}
      </p>
      {view.nativeSessionId === null ? null : (
        <p className="text-muted-foreground">Session {view.nativeSessionId}</p>
      )}
      <Button
        disabled={openNative.isPending}
        onClick={() => {
          openNative.mutate({ threadId });
        }}
      >
        {view.nativeSessionId === null ? "Start session" : "Resume session"}
      </Button>
    </div>
  );
}
