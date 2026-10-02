interface CreateOwnedRuntimeRecoveryArgs {
  isCurrent: () => boolean;
  onUnavailable?: () => void;
  onRestoreFailure?: () => void;
  onRecovered?: () => void;
  onRetry?: (error?: unknown) => void;
  restart: () => Promise<boolean>;
  restore?: () => Promise<boolean>;
  wait?: (delayMs: number) => Promise<void>;
}

interface CreateDesktopOwnedRuntimeRecoveryArgs {
  getRuntime: () => { serverUrl: string } | null;
  isCurrent: () => boolean;
  loadLoadingView: () => Promise<void>;
  loadServer: (serverUrl: string) => Promise<void>;
  onLoadFailure: (error: unknown) => void;
  onRestoreFailure?: () => void;
  onRecovered?: () => void;
  onRetry?: (error?: unknown) => void;
  onUnavailable?: () => void;
  refreshApplicationMenu: () => void;
  restartRuntime: () => Promise<boolean>;
  startSystemConfigSync: (serverUrl: string) => void;
  wait?: (delayMs: number) => Promise<void>;
}

interface OwnedRuntimeRecovery {
  isRunning: () => boolean;
  start: () => Promise<void>;
}

interface ResolveOwnedRuntimeExitActionArgs {
  appLoaded: boolean;
  hasRecoveryController: boolean;
  isCurrentRuntime: boolean;
  isRecoveryActive: boolean;
  isServerMoving: boolean;
  isQuitting: boolean;
}

export type OwnedRuntimeExitAction =
  | "ignore"
  | "recover"
  | "show-error"
  | "server-moving";

interface HandleOwnedRuntimeExitArgs extends ResolveOwnedRuntimeExitActionArgs {
  clearCurrentRuntime: () => void;
  recover: () => Promise<void>;
  showError: () => void;
  showServerMoving: () => void;
}

interface WatchOwnedRuntimeExitArgs<TExit> {
  clearCurrentRuntime: () => void;
  clearPidFile: (exit: TExit) => void;
  exit: Promise<TExit>;
  getState: () => ResolveOwnedRuntimeExitActionArgs;
  recover: (exit: TExit) => Promise<void>;
  showError: (exit: TExit) => void;
  showServerMoving: (exit: TExit) => void;
}

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;

export function resolveOwnedRuntimeExitAction({
  appLoaded,
  hasRecoveryController,
  isCurrentRuntime,
  isRecoveryActive,
  isServerMoving,
  isQuitting,
}: ResolveOwnedRuntimeExitActionArgs): OwnedRuntimeExitAction {
  if (isQuitting || !isCurrentRuntime) {
    return "ignore";
  }
  if (isServerMoving) {
    return "server-moving";
  }
  if (hasRecoveryController && (appLoaded || isRecoveryActive)) {
    return "recover";
  }
  return "show-error";
}

export async function handleOwnedRuntimeExit({
  clearCurrentRuntime,
  recover,
  showError,
  showServerMoving,
  ...state
}: HandleOwnedRuntimeExitArgs): Promise<void> {
  const action = resolveOwnedRuntimeExitAction(state);
  if (action === "ignore") {
    return;
  }

  clearCurrentRuntime();
  if (action === "server-moving") {
    showServerMoving();
    return;
  }
  if (action === "recover") {
    await recover();
    return;
  }
  showError();
}

export function watchOwnedRuntimeExit<TExit>({
  clearCurrentRuntime,
  clearPidFile,
  exit,
  getState,
  recover,
  showError,
  showServerMoving,
}: WatchOwnedRuntimeExitArgs<TExit>): Promise<void> {
  return exit.then(async (exitResult) => {
    clearPidFile(exitResult);
    await handleOwnedRuntimeExit({
      ...getState(),
      clearCurrentRuntime,
      recover: () => recover(exitResult),
      showError: () => showError(exitResult),
      showServerMoving: () => showServerMoving(exitResult),
    });
  });
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createOwnedRuntimeRecovery({
  isCurrent,
  onUnavailable,
  onRestoreFailure,
  onRecovered,
  onRetry,
  restart,
  restore = async () => true,
  wait: waitForRetry = wait,
}: CreateOwnedRuntimeRecoveryArgs): OwnedRuntimeRecovery {
  let running = false;
  let restartRequested = false;

  return {
    isRunning: () => running,
    async start() {
      if (running) {
        restartRequested = true;
        return;
      }
      running = true;
      let delayMs = INITIAL_RETRY_DELAY_MS;
      let runtimeStarted = false;

      try {
        while (isCurrent()) {
          await waitForRetry(delayMs);
          if (!isCurrent()) {
            return;
          }

          if (restartRequested) {
            runtimeStarted = false;
          }
          restartRequested = false;
          try {
            if (!runtimeStarted) {
              runtimeStarted = await restart();
              if (!runtimeStarted) {
                onUnavailable?.();
                delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
                continue;
              }
            }
            if (await restore()) {
              if (restartRequested) {
                delayMs = INITIAL_RETRY_DELAY_MS;
                continue;
              }
              onRecovered?.();
              return;
            }
            onRestoreFailure?.();
          } catch (error) {
            onRetry?.(error);
          }

          delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
        }
      } finally {
        running = false;
      }
    },
  };
}

export function createDesktopOwnedRuntimeRecovery({
  getRuntime,
  isCurrent,
  loadLoadingView,
  loadServer,
  onLoadFailure,
  onRestoreFailure,
  onRecovered,
  onRetry,
  onUnavailable,
  refreshApplicationMenu,
  restartRuntime,
  startSystemConfigSync,
  wait: waitForRetry,
}: CreateDesktopOwnedRuntimeRecoveryArgs): OwnedRuntimeRecovery {
  return createOwnedRuntimeRecovery({
    isCurrent,
    onUnavailable,
    onRestoreFailure,
    onRetry,
    onRecovered,
    restart: async () => {
      await loadLoadingView();
      return restartRuntime();
    },
    restore: async () => {
      const runtime = getRuntime();
      if (runtime === null) {
        return false;
      }

      try {
        await loadServer(runtime.serverUrl);
        startSystemConfigSync(runtime.serverUrl);
        refreshApplicationMenu();
        return true;
      } catch (error) {
        onLoadFailure(error);
        return false;
      }
    },
    wait: waitForRetry,
  });
}
