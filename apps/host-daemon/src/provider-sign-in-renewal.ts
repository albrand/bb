import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDER_SIGN_IN_RENEWAL_WAIT_MS = 30_000;
export const PROVIDER_SIGN_IN_RENEWAL_POLL_MS = 250;
const PROVIDER_SIGN_IN_RENEWAL_LOCK_STALE_MS = 30_000;

type ShellEnv = Readonly<Record<string, string | undefined>>;

export function claudeSignInRenewalLockPath(env: ShellEnv): string {
  const configDir =
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim() ||
    env.CLAUDE_CONFIG_DIR?.trim() ||
    path.join(env.HOME?.trim() || os.homedir(), ".claude");
  return path.join(configDir, ".oauth_refresh.lock");
}

function isRenewalInProgress(lockPath: string, nowMs: number): boolean {
  try {
    const lock = statSync(lockPath);
    return nowMs - lock.mtimeMs < PROVIDER_SIGN_IN_RENEWAL_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export async function waitWhileProviderSignInRenews(
  env: ShellEnv,
): Promise<"clear" | "waited" | "gave-up"> {
  const lockPath = claudeSignInRenewalLockPath(env);
  const deadline = Date.now() + PROVIDER_SIGN_IN_RENEWAL_WAIT_MS;
  let waited = false;
  while (isRenewalInProgress(lockPath, Date.now())) {
    if (Date.now() >= deadline) {
      return "gave-up";
    }
    waited = true;
    await new Promise((resolve) =>
      setTimeout(resolve, PROVIDER_SIGN_IN_RENEWAL_POLL_MS),
    );
  }
  return waited ? "waited" : "clear";
}
