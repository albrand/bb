import { describe, expect, it, vi } from "vitest";
import {
  createOwnedRuntimeRecovery,
  resolveOwnedRuntimeExitAction,
  watchOwnedRuntimeExit,
} from "../src/owned-runtime-recovery.js";

describe("owned runtime recovery", () => {
  it("restarts an owned server that exits after the application has loaded", () => {
    expect(
      resolveOwnedRuntimeExitAction({
        appLoaded: true,
        hasRecoveryController: true,
        isCurrentRuntime: true,
        isRecovering: false,
        isQuitting: false,
        isServerMoving: false,
      }),
    ).toBe("recover");
  });

  it("keeps startup failures and deliberate shutdowns out of runtime recovery", () => {
    expect(
      resolveOwnedRuntimeExitAction({
        appLoaded: false,
        hasRecoveryController: true,
        isCurrentRuntime: true,
        isRecovering: false,
        isQuitting: false,
        isServerMoving: false,
      }),
    ).toBe("show-error");
    expect(
      resolveOwnedRuntimeExitAction({
        appLoaded: true,
        hasRecoveryController: true,
        isCurrentRuntime: true,
        isRecovering: false,
        isQuitting: true,
        isServerMoving: false,
      }),
    ).toBe("ignore");
  });

  it("retries an unavailable server and restores the application after it recovers", async () => {
    let serverAvailable = false;
    let attempts = 0;
    const wait = vi.fn(async () => {
      attempts += 1;
      serverAvailable = attempts === 2;
    });
    const recovered = vi.fn();
    const restart = vi.fn(async () => serverAvailable);
    const recovery = createOwnedRuntimeRecovery({
      isCurrent: () => true,
      onRecovered: recovered,
      restart,
      wait,
    });

    await recovery.start();

    expect(wait).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("routes the process exit promise through loading, retry, and renderer reload", async () => {
    const events: string[] = [];
    let attempts = 0;
    let resolveExit: (exit: string) => void = () => {};
    const exit = new Promise<string>((resolve) => {
      resolveExit = resolve;
    });
    const recovery = createOwnedRuntimeRecovery({
      isCurrent: () => true,
      onRecovered: () => {
        events.push("reload renderer");
        events.push("refresh system config and menu");
      },
      restart: async () => {
        events.push("show loading view");
        events.push("start owned runtime");
        return attempts === 2;
      },
      wait: async () => {
        attempts += 1;
        events.push("wait before retry");
      },
    });

    const watching = watchOwnedRuntimeExit({
      exit,
      getState: () => ({
        appLoaded: true,
        hasRecoveryController: true,
        isCurrentRuntime: true,
        isRecovering: false,
        isQuitting: false,
        isServerMoving: false,
      }),
      clearPidFile: (exitResult) => {
        events.push(`clear pid file: ${exitResult}`);
      },
      clearCurrentRuntime: () => events.push("clear current runtime"),
      recover: async (exitResult) => {
        events.push(`recover after exit: ${exitResult}`);
        await recovery.start();
      },
      showError: () => events.push("show startup error"),
      showServerMoving: () => events.push("show server moving"),
    });
    resolveExit("owned process stopped");
    await watching;

    expect(events).toEqual([
      "clear pid file: owned process stopped",
      "clear current runtime",
      "recover after exit: owned process stopped",
      "wait before retry",
      "show loading view",
      "start owned runtime",
      "wait before retry",
      "show loading view",
      "start owned runtime",
      "reload renderer",
      "refresh system config and menu",
    ]);
  });

  it("stops retrying when the desktop runtime is no longer current", async () => {
    const wait = vi.fn(async () => {});
    const restart = vi.fn(async () => false);
    const recovery = createOwnedRuntimeRecovery({
      isCurrent: () => false,
      restart,
      wait,
    });

    await recovery.start();

    expect(wait).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});
