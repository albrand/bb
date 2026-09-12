import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_REFRESH_LOCK_WAIT_MS = 30_000;
export const CLAUDE_REFRESH_LOCK_POLL_MS = 250;
const CLAUDE_REFRESH_LOCK_STALE_MS = 30_000;

export function claudeRefreshLockPath(env: NodeJS.ProcessEnv): string {
  const configDir =
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim() ||
    env.CLAUDE_CONFIG_DIR?.trim() ||
    path.join(os.homedir(), ".claude");
  return path.join(configDir, ".oauth_refresh.lock");
}

function isClaudeRenewalInProgress(lockPath: string, now: number): boolean {
  try {
    return now - statSync(lockPath).mtimeMs < CLAUDE_REFRESH_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export function runAfterClaudeRenewalSettles(args: {
  env: NodeJS.ProcessEnv;
  action: () => void;
}): void {
  const lockPath = claudeRefreshLockPath(args.env);
  const deadline = Date.now() + CLAUDE_REFRESH_LOCK_WAIT_MS;
  const attempt = (): void => {
    const now = Date.now();
    if (now >= deadline || !isClaudeRenewalInProgress(lockPath, now)) {
      args.action();
      return;
    }
    setTimeout(attempt, CLAUDE_REFRESH_LOCK_POLL_MS);
  };
  attempt();
}

export function afterClaudeRenewalSettles(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve) => {
    runAfterClaudeRenewalSettles({ env, action: resolve });
  });
}
