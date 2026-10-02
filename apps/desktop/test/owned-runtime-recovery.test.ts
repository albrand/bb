import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopOwnedRuntimeRecovery,
  createOwnedRuntimeRecovery,
  resolveOwnedRuntimeExitAction,
  watchOwnedRuntimeExit,
} from "../src/owned-runtime-recovery.js";

describe("owned runtime recovery", () => {
  it("wires the owned process exit watcher to the window recovery callbacks in main", () => {
    const mainSource = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");
    const exitWatcherStart = mainSource.indexOf("void watchOwnedRuntimeExit({");
    const exitWatcherEnd = mainSource.indexOf(
      "return { bbProcess, runtime }",
      exitWatcherStart,
    );
    const recoveryStart = mainSource.indexOf(
      "ownedRuntimeRecovery = createDesktopOwnedRuntimeRecovery({",
    );
    const recoveryEnd = mainSource.indexOf(
      "const existingProbe",
      recoveryStart,
    );
    const exitWatcher = mainSource.slice(exitWatcherStart, exitWatcherEnd);
    const recoverySetup = mainSource.slice(recoveryStart, recoveryEnd);

    expect(exitWatcherStart).toBeGreaterThanOrEqual(0);
    expect(exitWatcherEnd).toBeGreaterThan(exitWatcherStart);
    expect(exitWatcher).toContain("exit: bbProcess.exit");
    expect(exitWatcher).toContain("await ownedRuntimeRecovery?.start()");
    expect(exitWatcher).toContain(
      "isRecoveryActive: ownedRuntimeRecovery?.isRunning() ?? false",
    );
    expect(recoverySetup).toContain("getRuntime: () => currentRuntime");
    expect(recoverySetup).toContain("loadLoadingView,");
    expect(recoverySetup).toContain("loadServer: loadBbApp");
    expect(recoverySetup).toContain(
      "startOwnedRuntime(args, { suppressStartupError: true })",
    );
    expect(recoverySetup).toContain("startSystemConfigSync,");
    expect(recoverySetup).toContain("refreshApplicationMenu,");
    expect(recoverySetup).toContain("onUnavailable: () =>");
    expect(recoverySetup).toContain("onRestoreFailure: () =>");
    expect(recoverySetup).toContain(
      "bb-app restart did not reach a healthy server; retrying",
    );
    expect(recoverySetup).toContain(
      "could not reload the restarted bb server; retrying the window load",
    );
  });

  it("restarts an owned server that exits after the application has loaded", () => {
    expect(
      resolveOwnedRuntimeExitAction({
        appLoaded: true,
        hasRecoveryController: true,
        isCurrentRuntime: true,
        isRecoveryActive: false,
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
        isRecoveryActive: false,
        isQuitting: false,
        isServerMoving: false,
      }),
    ).toBe("show-error");
    expect(
      resolveOwnedRuntimeExitAction({
        appLoaded: true,
        hasRecoveryController: true,
        isCurrentRuntime: true,
        isRecoveryActive: false,
        isQuitting: true,
        isServerMoving: false,
      }),
    ).toBe("ignore");
  });

  it("preserves server-move handling for an owned process exit", async () => {
    const clearRuntime = vi.fn();
    const showServerMoving = vi.fn();
    const recover = vi.fn(async () => {});
    const showError = vi.fn();

    await watchOwnedRuntimeExit({
      exit: Promise.resolve("server moved"),
      getState: () => ({
        appLoaded: true,
        hasRecoveryController: true,
        isCurrentRuntime: true,
        isRecoveryActive: false,
        isQuitting: false,
        isServerMoving: true,
      }),
      clearPidFile: vi.fn(),
      clearCurrentRuntime: clearRuntime,
      recover,
      showError,
      showServerMoving,
    });

    expect(clearRuntime).toHaveBeenCalledOnce();
    expect(showServerMoving).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it("retries an unavailable server and restores the application after it recovers", async () => {
    let serverAvailable = false;
    let attempts = 0;
    const wait = vi.fn(async () => {
      attempts += 1;
      serverAvailable = attempts === 2;
    });
    const recovered = vi.fn();
    const unavailable = vi.fn();
    const restart = vi.fn(async () => serverAvailable);
    const recovery = createOwnedRuntimeRecovery({
      isCurrent: () => true,
      onUnavailable: unavailable,
      onRecovered: recovered,
      restart,
      wait,
    });

    await recovery.start();

    expect(wait).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("routes the process exit promise through the desktop recovery flow", async () => {
    const events: string[] = [];
    let attempts = 0;
    let loadAttempts = 0;
    let resolveExit: (exit: string) => void = () => {};
    const exit = new Promise<string>((resolve) => {
      resolveExit = resolve;
    });
    const recovery = createDesktopOwnedRuntimeRecovery({
      isCurrent: () => true,
      getRuntime: () => ({ serverUrl: "http://127.0.0.1:38886" }),
      loadLoadingView: async () => {
        events.push("show loading view");
      },
      loadServer: async (serverUrl) => {
        events.push(`load server: ${serverUrl}`);
        loadAttempts += 1;
        if (loadAttempts === 1) {
          throw new Error("renderer load failed");
        }
      },
      onLoadFailure: (error) => events.push(`load failed: ${String(error)}`),
      onRestoreFailure: () => events.push("retry window load"),
      onRecovered: () => {
        events.push("recovered");
      },
      onUnavailable: () => events.push("startup unavailable"),
      onRetry: (error) => events.push(`restart failed: ${String(error)}`),
      refreshApplicationMenu: () => events.push("refresh menu"),
      restartRuntime: async () => {
        events.push("start owned runtime");
        return attempts === 2;
      },
      startSystemConfigSync: (serverUrl) =>
        events.push(`sync system config: ${serverUrl}`),
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
        isRecoveryActive: false,
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
    await vi.waitFor(() => expect(events).toContain("refresh menu"));

    expect(events).toEqual([
      "clear pid file: owned process stopped",
      "clear current runtime",
      "recover after exit: owned process stopped",
      "wait before retry",
      "show loading view",
      "start owned runtime",
      "startup unavailable",
      "wait before retry",
      "show loading view",
      "start owned runtime",
      "load server: http://127.0.0.1:38886",
      "load failed: Error: renderer load failed",
      "retry window load",
      "wait before retry",
      "load server: http://127.0.0.1:38886",
      "sync system config: http://127.0.0.1:38886",
      "refresh menu",
      "recovered",
    ]);
  });

  it("queues a current-process exit that arrives during recovery", async () => {
    let resolveFirstRestart: (started: boolean) => void = () => {};
    let attempts = 0;
    const restarted = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return await new Promise<boolean>((resolve) => {
          resolveFirstRestart = resolve;
        });
      }
      return true;
    });
    const recovered = vi.fn();
    const recovery = createOwnedRuntimeRecovery({
      isCurrent: () => true,
      onRecovered: recovered,
      restart: restarted,
      wait: async () => {},
    });
    const runningRecovery = recovery.start();
    await vi.waitFor(() => expect(restarted).toHaveBeenCalledOnce());

    await watchOwnedRuntimeExit({
      exit: Promise.resolve("restarted process exited"),
      getState: () => ({
        appLoaded: true,
        hasRecoveryController: true,
        isCurrentRuntime: true,
        isRecoveryActive: false,
        isQuitting: false,
        isServerMoving: false,
      }),
      clearPidFile: vi.fn(),
      clearCurrentRuntime: vi.fn(),
      recover: () => recovery.start(),
      showError: vi.fn(),
      showServerMoving: vi.fn(),
    });
    resolveFirstRestart(true);
    await runningRecovery;

    expect(restarted).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("restarts when a recovering process exits before the renderer loads", async () => {
    let runtimeAvailable = false;
    let continueRecovery = true;
    let restartAttempts = 0;
    let resolveExit: (exit: string) => void = () => {};
    const recover = createDesktopOwnedRuntimeRecovery({
      isCurrent: () => continueRecovery,
      getRuntime: () =>
        runtimeAvailable ? { serverUrl: "http://127.0.0.1:38886" } : null,
      loadLoadingView: async () => {},
      loadServer: async () => {},
      onLoadFailure: vi.fn(),
      restartRuntime: async () => {
        restartAttempts += 1;
        if (restartAttempts === 1) {
          runtimeAvailable = true;
          const exit = new Promise<string>((resolve) => {
            resolveExit = resolve;
          });
          const watching = watchOwnedRuntimeExit({
            exit,
            getState: () => ({
              appLoaded: false,
              hasRecoveryController: true,
              isCurrentRuntime: true,
              isRecoveryActive: recover.isRunning(),
              isQuitting: false,
              isServerMoving: false,
            }),
            clearPidFile: vi.fn(),
            clearCurrentRuntime: () => {
              runtimeAvailable = false;
            },
            recover: () => recover.start(),
            showError: () => {
              events.push("show error");
              continueRecovery = false;
            },
            showServerMoving: vi.fn(),
          });
          resolveExit("restarted process exited before renderer load");
          await watching;
          return true;
        }
        runtimeAvailable = true;
        return true;
      },
      startSystemConfigSync: vi.fn(),
      refreshApplicationMenu: vi.fn(),
      wait: async () => {},
      onRecovered: () => events.push("recovered"),
    });
    const events: string[] = [];

    await recover.start();

    expect(restartAttempts).toBe(2);
    expect(events).not.toContain("show error");
    expect(events).toContain("recovered");
  });

  it("ignores a stale process exit while another recovery is active", async () => {
    const clearRuntime = vi.fn();
    const recover = vi.fn(async () => {});
    const watching = watchOwnedRuntimeExit({
      exit: Promise.resolve("duplicate exit"),
      getState: () => ({
        appLoaded: true,
        hasRecoveryController: true,
        isCurrentRuntime: false,
        isRecoveryActive: false,
        isQuitting: false,
        isServerMoving: false,
      }),
      clearPidFile: vi.fn(),
      clearCurrentRuntime: clearRuntime,
      recover,
      showError: vi.fn(),
      showServerMoving: vi.fn(),
    });

    await watching;

    expect(clearRuntime).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
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
