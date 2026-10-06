import type { BbAppProcessExit } from "./bb-process.js";
import {
  waitForCompatibleServer,
  type ServerProbeFetch,
  type ServerProbeResult,
} from "./server-probe.js";
import { STARTUP_POLL_INTERVAL_MS, STARTUP_TIMEOUT_MS } from "./types.js";

export type OwnedRuntimeStartupResult =
  | ProcessExitedStartupResult
  | ServerProbeStartupResult;

interface ProcessExitedStartupResult {
  exit: BbAppProcessExit;
  kind: "process-exited";
}

interface ServerProbeStartupResult {
  kind: "server-probe";
  result: ServerProbeResult;
}

interface WaitForOwnedRuntimeStartupArgs {
  exit: Promise<BbAppProcessExit>;
  fetchImpl?: ServerProbeFetch;
  serverUrl: string;
}

export function waitForOwnedRuntimeStartup(
  args: WaitForOwnedRuntimeStartupArgs,
): Promise<OwnedRuntimeStartupResult> {
  return Promise.race<OwnedRuntimeStartupResult>([
    waitForCompatibleServer({
      ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
      intervalMs: STARTUP_POLL_INTERVAL_MS,
      serverUrl: args.serverUrl,
      timeoutMs: STARTUP_TIMEOUT_MS,
    }).then((result) => ({
      kind: "server-probe",
      result,
    })),
    args.exit.then((exit) => ({
      exit,
      kind: "process-exited",
    })),
  ]);
}
