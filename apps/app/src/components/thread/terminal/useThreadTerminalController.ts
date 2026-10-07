import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TerminalSession } from "@bb/server-contract";
import {
  terminalQueryScopeForTarget,
  useCloseTerminal,
  useCreateTerminal,
  useRenameTerminal,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import {
  useFixedPanelTabsState,
  useRemoveFixedRightTerminalTab,
  useSetFixedRightTerminalActiveTerminal,
} from "@/lib/fixed-panel-tabs";
import {
  applyTerminalSessionClose,
  applyTerminalSessionUpsert,
} from "@/hooks/cache-owners/terminal-cache-owner";
import {
  shouldCloseUnretainedDisconnectedTerminalSession,
  shouldShowRetainedTerminalSession,
} from "@/lib/terminal-session-visibility";
import {
  useMountedTerminalIds,
  useMountedTerminalRegistration,
} from "./mounted-terminals";
import {
  resolveTerminalScopeKey,
  type ThreadTerminalTarget,
} from "./terminal-scope";
import { normalizeTerminalTitle } from "./thread-terminal-title";
import type { TerminalCreateTarget } from "@bb/server-contract";

export const DEFAULT_TERMINAL_COLS = 100;
export const DEFAULT_TERMINAL_ROWS = 30;
const EMPTY_TERMINAL_SESSIONS: readonly TerminalSession[] = [];
const TERMINAL_TITLE_RENAME_DEBOUNCE_MS = 250;

export type { ThreadTerminalTarget };

export interface ThreadTerminalControllerArgs {
  canCreateTerminal?: boolean;
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
  panelStateId?: string;
  preferredTerminalId?: string | null;
  syncThreadId?: string | null;
  terminalId?: string;
  fixedPanelTarget?: TerminalCreateTarget;
  fixedTerminalId?: string;
  target: ThreadTerminalTarget;
}

export interface ThreadTerminalController {
  activeSession: TerminalSession | null;
  canCreateTerminal?: boolean;
  handleActiveTerminalSessionChange: (session: TerminalSession) => void;
  handleActiveTerminalTitleChange: ThreadTerminalTitleChangeHandler;
  handleActiveTerminalUserInput: ThreadTerminalActionHandler;
  handleCreateTerminal: ThreadTerminalActionHandler;
  handleSelectTerminal: ThreadTerminalIdHandler;
  hasTerminalQueryError: boolean;
  isCreateTerminalPending: boolean;
  isPanelOpen: boolean;
  shouldMountTerminalView: boolean;
  shouldRetainActiveTerminalView: boolean;
  terminalBodyMessage: string;
}

interface TerminalTitleRenameRequest {
  terminalId: string;
  title: string;
}

type ThreadTerminalActionHandler = () => void;
type ThreadTerminalIdHandler = (terminalId: string) => void;
type ThreadTerminalTitleChangeHandler = (title: string) => void;
type TerminalTitleRenameTimeout = number;
type TerminalCloseMode = "force" | "if-clean";

export function shouldAutoCloseCleanTerminalSession({
  dirtyTerminalIds,
  session,
  uiCreatedTerminalIds,
}: {
  dirtyTerminalIds: ReadonlySet<string>;
  session: TerminalSession;
  uiCreatedTerminalIds: ReadonlySet<string>;
}): boolean {
  return (
    session.lastUserInputAt === null &&
    uiCreatedTerminalIds.has(session.id) &&
    !dirtyTerminalIds.has(session.id)
  );
}

function shouldMountTerminalViewForPanel({
  hasPanelOpened,
  isPanelOpen,
  isPanelPersistedOpen,
}: {
  hasPanelOpened: boolean;
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
}): boolean {
  return isPanelOpen || (isPanelPersistedOpen && hasPanelOpened);
}

export function shouldAutoCloseCleanTerminalSessionsForPanel({
  isPanelOpen,
  isPanelPersistedOpen,
}: {
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
}): boolean {
  return !isPanelOpen && !isPanelPersistedOpen;
}

export function pickActiveTerminalId(
  sessions: readonly TerminalSession[],
  preferredTerminalId: string | null,
  fixedTerminalId?: string,
): string | null {
  if (fixedTerminalId !== undefined) {
    return sessions.some((session) => session.id === fixedTerminalId)
      ? fixedTerminalId
      : null;
  }
  if (
    preferredTerminalId &&
    sessions.some((session) => session.id === preferredTerminalId)
  ) {
    return preferredTerminalId;
  }
  return sessions[0]?.id ?? null;
}

export function useThreadTerminalController({
  canCreateTerminal = true,
  isPanelOpen,
  isPanelPersistedOpen,
  panelStateId,
  preferredTerminalId: suppliedPreferredTerminalId,
  syncThreadId: suppliedSyncThreadId,
  terminalId,
  fixedPanelTarget,
  fixedTerminalId,
  target,
}: ThreadTerminalControllerArgs): ThreadTerminalController {
  const queryClient = useQueryClient();
  const preferredTerminalId = suppliedPreferredTerminalId ?? terminalId;
  const syncThreadId =
    suppliedSyncThreadId ??
    (target.kind === "thread" ? target.threadId : null);
  const terminalTargetId = resolveTerminalScopeKey(target);
  const fixedPanelStateId = panelStateId ?? terminalTargetId;
  const fixedPanelState = useFixedPanelTabsState(fixedPanelStateId, syncThreadId);
  const activeFixedTab = fixedPanelState.secondary.tabs.find(
    (tab) => tab.id === fixedPanelState.secondary.activeTabId,
  );
  const activeFixedTerminalId =
    activeFixedTab?.kind === "terminal" ? activeFixedTab.terminalId : null;
  const setActiveFixedTerminal = useSetFixedRightTerminalActiveTerminal(
    fixedPanelStateId,
    syncThreadId,
  );
  const removeFixedTerminalTab = useRemoveFixedRightTerminalTab(
    fixedPanelStateId,
    syncThreadId,
  );
  const uiCreatedTerminalIdsRef = useRef<Set<string>>(new Set());
  const dirtyTerminalIdsRef = useRef<Set<string>>(new Set());
  const closingCleanTerminalIdsRef = useRef<Set<string>>(new Set());
  const closingDisconnectedTerminalIdsRef = useRef<Set<string>>(new Set());
  const latestRequestedTitleRenameRef =
    useRef<TerminalTitleRenameRequest | null>(null);
  const pendingTitleRenameTimeoutRef =
    useRef<TerminalTitleRenameTimeout | null>(null);
  const [retainedTerminalViewId, setRetainedTerminalViewId] = useState<
    string | null
  >(null);
  const [hasPanelOpened, setHasPanelOpened] = useState(isPanelOpen);
  if (isPanelOpen && !hasPanelOpened) {
    setHasPanelOpened(true);
  } else if (!isPanelOpen && !isPanelPersistedOpen && hasPanelOpened) {
    setHasPanelOpened(false);
  }
  const shouldMountTerminalView = shouldMountTerminalViewForPanel({
    hasPanelOpened,
    isPanelOpen,
    isPanelPersistedOpen,
  });
  const terminalsQuery = useTerminals(terminalQueryScopeForTarget(target), {
    enabled: isPanelOpen,
  });
  const createTerminal = useCreateTerminal();
  const closeTerminalMutation = useCloseTerminal();
  const renameTerminal = useRenameTerminal();
  const isCreateTerminalPending = createTerminal.isPending;
  const isCloseTerminalPending = closeTerminalMutation.isPending;
  const closingTerminalVariables = closeTerminalMutation.variables;
  const sessions = useMemo(() => {
    const currentSessions =
      terminalsQuery.data?.sessions ?? EMPTY_TERMINAL_SESSIONS;
    if (target.kind !== "host_path") {
      return currentSessions;
    }
    return currentSessions.filter(
      (session) =>
        session.threadId === null &&
        session.environmentId === null &&
        session.hostId === target.hostId &&
        (target.cwd === null || session.initialCwd === target.cwd),
    );
  }, [target, terminalsQuery.data?.sessions]);
  const paneRetainedTerminalIds = useMemo(
    () =>
      new Set<string>(
        retainedTerminalViewId === null ? [] : [retainedTerminalViewId],
      ),
    [retainedTerminalViewId],
  );
  const visibleSessions = useMemo(
    () =>
      sessions.filter((session) =>
        shouldShowRetainedTerminalSession({
          retainedTerminalIds: paneRetainedTerminalIds,
          session,
        }),
      ),
    [paneRetainedTerminalIds, sessions],
  );
  const activeTerminalId = useMemo(
    () =>
      pickActiveTerminalId(
        visibleSessions,
        preferredTerminalId ?? activeFixedTerminalId,
        fixedTerminalId,
      ),
    [
      activeFixedTerminalId,
      fixedTerminalId,
      preferredTerminalId,
      visibleSessions,
    ],
  );
  const activeSession =
    visibleSessions.find((session) => session.id === activeTerminalId) ?? null;
  useMountedTerminalRegistration({
    isMounted: shouldMountTerminalView,
    scopeKey: terminalTargetId,
    terminalId: activeTerminalId,
  });
  const mountedTerminalIds = useMountedTerminalIds(terminalTargetId);
  const shouldRetainActiveTerminalView =
    activeSession?.status === "disconnected" &&
    activeSession.id === retainedTerminalViewId;

  useEffect(() => {
    if (!shouldMountTerminalView) {
      setRetainedTerminalViewId(null);
      return;
    }
    if (activeSession?.status === "running") {
      setRetainedTerminalViewId(activeSession.id);
      return;
    }
    if (
      retainedTerminalViewId !== null &&
      activeTerminalId !== retainedTerminalViewId
    ) {
      setRetainedTerminalViewId(null);
    }
  }, [
    activeSession?.id,
    activeSession?.status,
    activeTerminalId,
    retainedTerminalViewId,
    shouldMountTerminalView,
  ]);

  useEffect(() => {
    if (!isPanelOpen || terminalsQuery.isLoading || terminalsQuery.error) {
      return;
    }
    if (
      preferredTerminalId !== undefined ||
      activeFixedTerminalId === activeTerminalId
    ) {
      return;
    }
    if (activeTerminalId !== null) {
      setActiveFixedTerminal(activeTerminalId, fixedPanelTarget ?? target);
    }
  }, [
    activeFixedTerminalId,
    activeTerminalId,
    isPanelOpen,
    preferredTerminalId,
    setActiveFixedTerminal,
    terminalsQuery.error,
    terminalsQuery.isLoading,
  ]);

  useEffect(() => {
    return () => {
      if (pendingTitleRenameTimeoutRef.current === null) {
        return;
      }
      window.clearTimeout(pendingTitleRenameTimeoutRef.current);
    };
  }, []);

  const startTerminal = useCallback(() => {
    if (!canCreateTerminal || isCreateTerminalPending) {
      return;
    }
    const request = {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    };
    const created = createTerminal.mutateAsync({
      ...request,
      target,
    });
    void created
      .then((session) => {
        uiCreatedTerminalIdsRef.current.add(session.id);
        setActiveFixedTerminal(session.id, fixedPanelTarget ?? target);
      })
      .catch(() => undefined);
  }, [
    canCreateTerminal,
    createTerminal,
    isCreateTerminalPending,
    setActiveFixedTerminal,
    target,
  ]);

  const closeTerminal = useCallback(
    ({
      mode,
      onSettled,
      onSuccess,
      terminalId,
    }: {
      mode: TerminalCloseMode;
      onSettled?: () => void;
      onSuccess?: (session: TerminalSession | null) => void;
      terminalId: string;
    }) => {
      closeTerminalMutation.mutate(
        { mode, terminalId },
        {
          onSettled: () => onSettled?.(),
          onSuccess: (session) => {
            onSuccess?.(session);
          },
        },
      );
    },
    [closeTerminalMutation],
  );

  useEffect(() => {
    if (!isPanelOpen || terminalsQuery.isLoading || terminalsQuery.error) {
      return;
    }
    for (const session of sessions) {
      if (
        !shouldCloseUnretainedDisconnectedTerminalSession({
          retainedTerminalIds: mountedTerminalIds,
          session,
        }) ||
        closingDisconnectedTerminalIdsRef.current.has(session.id)
      ) {
        continue;
      }
      closingDisconnectedTerminalIdsRef.current.add(session.id);
      closeTerminal({
        mode: "force",
        terminalId: session.id,
        onSuccess: (closedSession) => {
          if (closedSession?.status !== "exited") {
            return;
          }
          uiCreatedTerminalIdsRef.current.delete(closedSession.id);
          dirtyTerminalIdsRef.current.delete(closedSession.id);
          closingCleanTerminalIdsRef.current.delete(closedSession.id);
          removeFixedTerminalTab(closedSession.id);
        },
        onSettled: () => {
          closingDisconnectedTerminalIdsRef.current.delete(session.id);
        },
      });
    }
  }, [
    closeTerminal,
    isPanelOpen,
    mountedTerminalIds,
    removeFixedTerminalTab,
    sessions,
    terminalsQuery.error,
    terminalsQuery.isLoading,
  ]);

  const replaceDisconnectedTerminal = useCallback(
    (terminalId: string) => {
      if (
        !canCreateTerminal ||
        isCreateTerminalPending ||
        isCloseTerminalPending
      ) {
        return;
      }
      closeTerminal({
        mode: "force",
        terminalId,
        onSuccess: () => {
          uiCreatedTerminalIdsRef.current.delete(terminalId);
          dirtyTerminalIdsRef.current.delete(terminalId);
          closingCleanTerminalIdsRef.current.delete(terminalId);
          removeFixedTerminalTab(terminalId);
          startTerminal();
        },
      });
    },
    [
      canCreateTerminal,
      closeTerminal,
      isCloseTerminalPending,
      isCreateTerminalPending,
      removeFixedTerminalTab,
      startTerminal,
    ],
  );

  useEffect(() => {
    if (
      !shouldAutoCloseCleanTerminalSessionsForPanel({
        isPanelOpen,
        isPanelPersistedOpen,
      })
    ) {
      return;
    }
    for (const session of visibleSessions) {
      if (
        !shouldAutoCloseCleanTerminalSession({
          dirtyTerminalIds: dirtyTerminalIdsRef.current,
          session,
          uiCreatedTerminalIds: uiCreatedTerminalIdsRef.current,
        }) ||
        closingCleanTerminalIdsRef.current.has(session.id)
      ) {
        continue;
      }
      closingCleanTerminalIdsRef.current.add(session.id);
      closeTerminal({
        mode: "if-clean",
        terminalId: session.id,
        onSuccess: (closedSession) => {
          if (closedSession?.status !== "exited") {
            return;
          }
          uiCreatedTerminalIdsRef.current.delete(closedSession.id);
          dirtyTerminalIdsRef.current.delete(closedSession.id);
          removeFixedTerminalTab(closedSession.id);
        },
        onSettled: () => {
          closingCleanTerminalIdsRef.current.delete(session.id);
        },
      });
    }
  }, [
    closeTerminal,
    isPanelOpen,
    isPanelPersistedOpen,
    removeFixedTerminalTab,
    visibleSessions,
  ]);

  const handleCreateTerminal = useCallback(() => {
    if (activeSession?.status === "disconnected") {
      replaceDisconnectedTerminal(activeSession.id);
      return;
    }
    startTerminal();
  }, [activeSession, replaceDisconnectedTerminal, startTerminal]);

  const handleSelectTerminal = useCallback(
    (terminalId: string) => {
      setActiveFixedTerminal(terminalId, fixedPanelTarget ?? target);
    },
    [setActiveFixedTerminal],
  );

  const handleActiveTerminalSessionChange = useCallback(
    (session: TerminalSession) => {
      if (session.status === "exited") {
        applyTerminalSessionClose({
          queryClient,
          session,
          terminalId: session.id,
        });
        return;
      }
      applyTerminalSessionUpsert({ queryClient, session });
    },
    [queryClient],
  );

  const handleActiveTerminalUserInput = useCallback(() => {
    if (!activeTerminalId) {
      return;
    }
    dirtyTerminalIdsRef.current.add(activeTerminalId);
  }, [activeTerminalId]);

  const handleActiveTerminalTitleChange: ThreadTerminalTitleChangeHandler =
    useCallback(
      (title) => {
        if (!activeSession || activeSession.status !== "running") {
          return;
        }
        const normalizedTitle = normalizeTerminalTitle({ title });
        if (!normalizedTitle || normalizedTitle === activeSession.title) {
          return;
        }

        const request: TerminalTitleRenameRequest = {
          terminalId: activeSession.id,
          title: normalizedTitle,
        };
        const latestRequest = latestRequestedTitleRenameRef.current;
        if (
          latestRequest !== null &&
          latestRequest.terminalId === request.terminalId &&
          latestRequest.title === request.title
        ) {
          return;
        }

        latestRequestedTitleRenameRef.current = request;
        if (pendingTitleRenameTimeoutRef.current !== null) {
          window.clearTimeout(pendingTitleRenameTimeoutRef.current);
        }
        pendingTitleRenameTimeoutRef.current = window.setTimeout(() => {
          pendingTitleRenameTimeoutRef.current = null;
          const onSettled = () => {
            const currentRequest = latestRequestedTitleRenameRef.current;
            if (
              currentRequest !== null &&
              currentRequest.terminalId === request.terminalId &&
              currentRequest.title === request.title
            ) {
              latestRequestedTitleRenameRef.current = null;
            }
          };
          renameTerminal.mutate(
            {
              terminalId: request.terminalId,
              title: request.title,
            },
            { onSettled },
          );
        }, TERMINAL_TITLE_RENAME_DEBOUNCE_MS);
      },
      [
        activeSession,
        renameTerminal,
      ],
    );

  const terminalIsReplacing =
    activeSession?.status === "disconnected" &&
    isCloseTerminalPending &&
    closingTerminalVariables?.terminalId === activeSession.id;
  const terminalIsStarting = isCreateTerminalPending || terminalIsReplacing;

  const inactiveTerminalBodyMessage = canCreateTerminal
    ? "Starting terminal..."
    : "Terminals unavailable.";

  const terminalBodyMessage = terminalIsStarting
    ? inactiveTerminalBodyMessage
    : "No terminals";

  return {
    activeSession,
    canCreateTerminal,
    handleActiveTerminalSessionChange,
    handleActiveTerminalTitleChange,
    handleActiveTerminalUserInput,
    handleCreateTerminal,
    handleSelectTerminal,
    hasTerminalQueryError:
      terminalsQuery.error !== null && terminalsQuery.data === undefined,
    isCreateTerminalPending,
    isPanelOpen,
    shouldMountTerminalView,
    shouldRetainActiveTerminalView,
    terminalBodyMessage,
  };
}
