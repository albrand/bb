import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_REFRESH_LOCK_POLL_MS,
  CLAUDE_REFRESH_LOCK_WAIT_MS,
  claudeRefreshLockPath,
  runAfterClaudeRenewalSettles,
} from "../claude-refresh-lock.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "bb-claude-refresh-lock-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(configDir, { recursive: true, force: true });
});

function holdRenewalLock(): string {
  const lockPath = claudeRefreshLockPath({ CLAUDE_CONFIG_DIR: configDir });
  mkdirSync(lockPath);
  return lockPath;
}

describe("runAfterClaudeRenewalSettles", () => {
  it("runs at once when Claude Code holds no renewal lock", () => {
    const action = vi.fn();

    runAfterClaudeRenewalSettles({
      env: { CLAUDE_CONFIG_DIR: configDir },
      action,
    });

    expect(action).toHaveBeenCalledOnce();
  });

  it("waits while a renewal lock is held and runs once it clears", async () => {
    const lockPath = holdRenewalLock();
    const action = vi.fn();

    runAfterClaudeRenewalSettles({
      env: { CLAUDE_CONFIG_DIR: configDir },
      action,
    });
    await vi.advanceTimersByTimeAsync(CLAUDE_REFRESH_LOCK_POLL_MS * 4);
    expect(action).not.toHaveBeenCalled();

    rmSync(lockPath, { recursive: true });
    await vi.advanceTimersByTimeAsync(CLAUDE_REFRESH_LOCK_POLL_MS);
    expect(action).toHaveBeenCalledOnce();
  });

  it("stops waiting for a renewal lock after the bound", async () => {
    const lockPath = holdRenewalLock();
    const action = vi.fn();

    runAfterClaudeRenewalSettles({
      env: { CLAUDE_CONFIG_DIR: configDir },
      action,
    });
    await vi.advanceTimersByTimeAsync(
      CLAUDE_REFRESH_LOCK_WAIT_MS - CLAUDE_REFRESH_LOCK_POLL_MS,
    );
    expect(action).not.toHaveBeenCalled();
    utimesSync(lockPath, new Date(), new Date());
    await vi.advanceTimersByTimeAsync(CLAUDE_REFRESH_LOCK_POLL_MS);
    expect(action).toHaveBeenCalledOnce();
  });

  it("ignores a lock abandoned by a process that exited mid-renewal", () => {
    const lockPath = holdRenewalLock();
    const abandonedAt = new Date(Date.now() - 120_000);
    utimesSync(lockPath, abandonedAt, abandonedAt);
    const action = vi.fn();

    runAfterClaudeRenewalSettles({
      env: { CLAUDE_CONFIG_DIR: configDir },
      action,
    });

    expect(action).toHaveBeenCalledOnce();
  });

  it("follows Claude Code's secure-storage config directory override", () => {
    expect(
      claudeRefreshLockPath({
        CLAUDE_CONFIG_DIR: "/config",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/secure",
      }),
    ).toBe(join("/secure", ".oauth_refresh.lock"));
  });
});
