import { useEffect } from "react";
import { Button } from "@bb/shared-ui/button";
import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import type { NativeTerminalThread } from "@bb/server-contract";
import type { ThreadRuntimeState } from "@bb/domain";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import {
  useNativeTerminalThread,
  useOpenNativeTerminal,
} from "@/hooks/queries/native-terminal-queries";
import { useThreadPendingInteractions } from "@/hooks/queries/thread-queries";
import { useThreadTerminals } from "@/hooks/queries/thread-terminal-queries";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";
import { useNativeActivityUnconfirmed } from "@/hooks/useNativeActivityUnconfirmed";
import {
  NativeTerminalWaitingBanner,
  nativeTerminalWaitingPrompts,
} from "./NativeTerminalWaitingBanner";
import {
  resolveNativeTerminalSession,
  resolveNativeTerminalState,
} from "./native-terminal-state";

interface NativeThreadTerminalMainProps {
  onOpenLink?: MarkdownPreviewLinkHandler;
  projectId: string;
  runtime: ThreadRuntimeState;
  threadId: string;
  threadIsProvisioning: boolean;
  view: NativeTerminalThread;
}

export function NativeThreadTerminalMain({
  onOpenLink,
  projectId,
  runtime,
  threadId,
  threadIsProvisioning,
  view,
}: NativeThreadTerminalMainProps) {
  const activityUnconfirmed = useNativeActivityUnconfirmed(runtime);
  const terminalsQuery = useThreadTerminals(threadId);
  const interactionsQuery = useThreadPendingInteractions(threadId);
  const nativeQuery = useNativeTerminalThread(threadId);
  const openNative = useOpenNativeTerminal();
  const session = resolveNativeTerminalSession({
    listedSessions: terminalsQuery.data?.sessions,
    listUpdatedAt: terminalsQuery.dataUpdatedAt,
    view,
    viewUpdatedAt: nativeQuery.dataUpdatedAt,
  });
  const state = resolveNativeTerminalState({ session, threadIsProvisioning });
  const providerLabel = view.displayName;
  const paneIsFocused = useOptionalPaneContext()?.isFocused ?? true;
  const isTouchDevice = useMediaQuery("(pointer: coarse)");
  const { refetch } = nativeQuery;
  const terminalsUpdatedAt = terminalsQuery.dataUpdatedAt;

  useEffect(() => {
    void LazyThreadTerminalPanel.preload();
  }, []);

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
        <NativeTerminalWaitingBanner
          prompts={nativeTerminalWaitingPrompts(interactionsQuery.data ?? [])}
          providerLabel={providerLabel}
        />
        {activityUnconfirmed ? (
          <p className="px-3 py-1 text-xs text-muted-foreground" role="status">
            Activity unconfirmed — No recent report from this native session
          </p>
        ) : null}
        <LazyThreadTerminalPanel
          autoFocus={paneIsFocused && !isTouchDevice}
          isPanelOpen
          isPanelPersistedOpen
          onOpenLink={onOpenLink}
          onCloseStart={() => {}}
          onRetryStart={() => {}}
          target={{ kind: "thread", threadId }}
          terminalId={state.terminalId}
        />
        {isTouchDevice ? (
          <NativeTerminalPromptBar
            projectId={projectId}
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

  if (session === null && terminalsQuery.isLoading) {
    return (
      <div
        aria-busy="true"
        className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
        data-native-terminal-thread={view.providerId}
        role="status"
      >
        Loading terminals...
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
