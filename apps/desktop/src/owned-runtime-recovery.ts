interface CreateOwnedRuntimeRecoveryArgs {
  isCurrent: () => boolean;
  onRecovered?: () => void;
  onRetry?: (error?: unknown) => void;
  restart: () => Promise<boolean>;
  wait?: (delayMs: number) => Promise<void>;
}

interface OwnedRuntimeRecovery {
  isRecovering: () => boolean;
  start: () => Promise<void>;
}

interface ResolveOwnedRuntimeExitActionArgs {
  appLoaded: boolean;
  hasRecoveryController: boolean;
  isCurrentRuntime: boolean;
  isRecovering: boolean;
  isServerMoving: boolean;
  isQuitting: boolean;
}

export type OwnedRuntimeExitAction =
  | "ignore"
  | "recover"
  | "show-error"
  | "server-moving";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;

export function resolveOwnedRuntimeExitAction({
  appLoaded,
  hasRecoveryController,
  isCurrentRuntime,
  isRecovering,
  isServerMoving,
  isQuitting,
}: ResolveOwnedRuntimeExitActionArgs): OwnedRuntimeExitAction {
  if (isQuitting || !isCurrentRuntime) {
    return "ignore";
  }
  if (isServerMoving) {
    return "server-moving";
  }
  if (isRecovering) {
    return "ignore";
  }
  if (appLoaded && hasRecoveryController) {
    return "recover";
  }
  return "show-error";
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createOwnedRuntimeRecovery({
  isCurrent,
  onRecovered,
  onRetry,
  restart,
  wait: waitForRetry = wait,
}: CreateOwnedRuntimeRecoveryArgs): OwnedRuntimeRecovery {
  let running = false;

  return {
    isRecovering: () => running,
    async start() {
      if (running) {
        return;
      }
      running = true;
      let delayMs = INITIAL_RETRY_DELAY_MS;

      try {
        while (isCurrent()) {
          await waitForRetry(delayMs);
          if (!isCurrent()) {
            return;
          }

          try {
            if (await restart()) {
              onRecovered?.();
              return;
            }
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
