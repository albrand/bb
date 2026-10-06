import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbAppProcessExit } from "../src/bb-process.js";
import {
  waitForOwnedRuntimeStartup,
  type OwnedRuntimeStartupResult,
} from "../src/owned-runtime-startup.js";
import type { ServerProbeFetch } from "../src/server-probe.js";
import { STARTUP_TIMEOUT_MS } from "../src/types.js";

const SERVER_URL = "http://127.0.0.1:65535";

interface SettledStartup {
  elapsedMs: number;
  result: OwnedRuntimeStartupResult;
}

function serverListeningAfter(delayMs: number): ServerProbeFetch {
  const startedAt = Date.now();
  return async (input) => {
    if (Date.now() - startedAt < delayMs) {
      throw new TypeError("fetch failed");
    }
    return new URL(input).pathname === "/health"
      ? Response.json({ ok: true })
      : Response.json({
          hostDaemonPort: 4_242,
          voiceTranscriptionEnabled: false,
        });
  };
}

function exitAfter(
  delayMs: number,
  exit: BbAppProcessExit,
): Promise<BbAppProcessExit> {
  return new Promise((resolvePromise) => {
    setTimeout(() => resolvePromise(exit), delayMs);
  });
}

function trackStartup(
  startup: Promise<OwnedRuntimeStartupResult>,
): () => SettledStartup | null {
  const startedAt = Date.now();
  let settled: SettledStartup | null = null;
  void startup.then((result) => {
    settled = { elapsedMs: Date.now() - startedAt, result };
  });
  return () => settled;
}

describe("waitForOwnedRuntimeStartup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a server that exits non-zero during startup at once", async () => {
    const settled = trackStartup(
      waitForOwnedRuntimeStartup({
        exit: exitAfter(2_000, { code: 1, signal: null }),
        fetchImpl: serverListeningAfter(Number.POSITIVE_INFINITY),
        serverUrl: SERVER_URL,
      }),
    );

    await vi.advanceTimersByTimeAsync(2_000);

    expect(settled()).toEqual({
      elapsedMs: 2_000,
      result: { exit: { code: 1, signal: null }, kind: "process-exited" },
    });
  });

  it.each([90_000, 130_000])(
    "keeps waiting through a %i ms database migration before the server listens",
    async (migrationMs) => {
      const settled = trackStartup(
        waitForOwnedRuntimeStartup({
          exit: new Promise<BbAppProcessExit>(() => {}),
          fetchImpl: serverListeningAfter(migrationMs),
          serverUrl: SERVER_URL,
        }),
      );

      await vi.advanceTimersByTimeAsync(migrationMs - 1_000);
      expect(settled()).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(settled()?.result).toEqual({
        kind: "server-probe",
        result: { dataDir: null, kind: "compatible", serverUrl: SERVER_URL },
      });
    },
  );

  it("still gives up on a server that never listens", async () => {
    const settled = trackStartup(
      waitForOwnedRuntimeStartup({
        exit: new Promise<BbAppProcessExit>(() => {}),
        fetchImpl: serverListeningAfter(Number.POSITIVE_INFINITY),
        serverUrl: SERVER_URL,
      }),
    );

    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS + 500);

    expect(settled()?.result).toMatchObject({
      kind: "server-probe",
      result: { kind: "unavailable" },
    });
    expect(settled()?.elapsedMs).toBeLessThanOrEqual(STARTUP_TIMEOUT_MS + 500);
  });
});
