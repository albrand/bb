import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import {
  isProcessAlive,
  isProcessGroupAlive,
  stopProcessGroupByPid,
} from "@bb/process-utils";
import type { HostDaemonLogger } from "./logger.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MINIMUM_ORPHAN_AGE_MS = 2 * 60_000;
const DEFAULT_MAX_RECLAIMS_PER_SWEEP = 4;
const DEFAULT_STARTUP_PROTECTION_MS = 15 * 60_000;

interface ManagedLeaseFile {
  run_id?: unknown;
  caller_pid?: unknown;
  child_pid?: unknown;
  thread_id?: unknown;
  environment_id?: unknown;
  provider_id?: unknown;
  state?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  lease?: unknown;
}

export interface ManagedProcessLease {
  runId: string;
  leasePath: string;
  callerPid: number | null;
  childPid: number | null;
  threadId: string | null;
  environmentId: string | null;
  providerId: string | null;
  state: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  callerAlive: boolean;
  childAlive: boolean;
  groupAlive: boolean;
}

export interface HostMemorySnapshot {
  daemonRssBytes: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  leaseCount: number;
  runningLeaseCount: number;
  reclaimableLeaseCount: number;
  protectedThreadCount: number;
}

export interface HostMemoryCollectionResult {
  before: HostMemorySnapshot;
  after: HostMemorySnapshot;
  reclaimed: Array<{
    runId: string;
    threadId: string;
    pid: number;
    stopped: boolean;
  }>;
  skipped: Array<{ runId: string; reason: string }>;
}

export interface HostDaemonMemoryController {
  status(): Promise<HostMemorySnapshot>;
  collect(args?: { force?: boolean }): Promise<HostMemoryCollectionResult>;
  stop(): void;
}

interface StartHostDaemonMemoryControllerOptions {
  dataDir: string;
  logger: Pick<HostDaemonLogger, "info" | "warn">;
  getProtectedThreadIds: () => readonly string[];
  nowMs?: () => number;
  setIntervalFn?: (
    callback: () => void,
    intervalMs: number,
  ) => { clear(): void; unref(): void };
  sweepIntervalMs?: number;
  minimumOrphanAgeMs?: number;
  maxReclaimsPerSweep?: number;
  startupProtectionMs?: number;
}

function asPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 1
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function leaseDirs(dataDir: string): string[] {
  // Never sweep the shared system temp directory: another BB installation may
  // own those leases. Managed runners inherit BB_DATA_DIR and write here.
  return [join(dataDir, "opencode-context", "leases")];
}

async function readLeases(dataDir: string): Promise<ManagedProcessLease[]> {
  const leases: ManagedProcessLease[] = [];
  for (const directory of leaseDirs(dataDir)) {
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) =>
        name.endsWith(".json"),
      );
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      let raw: ManagedLeaseFile;
      try {
        raw = JSON.parse(await readFile(path, "utf8")) as ManagedLeaseFile;
      } catch {
        continue;
      }
      const childPid = asPid(raw.child_pid);
      const callerPid = asPid(raw.caller_pid);
      const runId = asString(raw.run_id);
      if (runId === null) continue;
      leases.push({
        runId,
        leasePath: path,
        callerPid,
        childPid,
        threadId: asString(raw.thread_id),
        environmentId: asString(raw.environment_id),
        providerId: asString(raw.provider_id),
        state: asString(raw.state) ?? "unknown",
        startedAtMs: asTimestamp(raw.started_at),
        endedAtMs: asTimestamp(raw.ended_at),
        callerAlive: isProcessAlive(callerPid ?? undefined),
        childAlive: isProcessAlive(childPid ?? undefined),
        groupAlive: childPid !== null && isProcessGroupAlive({ pid: childPid }),
      });
    }
  }
  return leases;
}

function snapshot(args: {
  leases: readonly ManagedProcessLease[];
  protectedThreadIds: ReadonlySet<string>;
  daemonRssBytes: number;
}): HostMemorySnapshot {
  return {
    daemonRssBytes: args.daemonRssBytes,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    leaseCount: args.leases.length,
    runningLeaseCount: args.leases.filter((lease) => lease.state === "running")
      .length,
    reclaimableLeaseCount: args.leases.filter(
      (lease) =>
        lease.state === "running" &&
        lease.threadId !== null &&
        !args.protectedThreadIds.has(lease.threadId) &&
        lease.groupAlive,
    ).length,
    protectedThreadCount: args.protectedThreadIds.size,
  };
}

export function startHostDaemonMemoryController(
  options: StartHostDaemonMemoryControllerOptions,
): HostDaemonMemoryController {
  const nowMs = options.nowMs ?? Date.now;
  const minimumOrphanAgeMs =
    options.minimumOrphanAgeMs ?? DEFAULT_MINIMUM_ORPHAN_AGE_MS;
  const maxReclaimsPerSweep =
    options.maxReclaimsPerSweep ?? DEFAULT_MAX_RECLAIMS_PER_SWEEP;
  const startupProtectionUntilMs =
    nowMs() + (options.startupProtectionMs ?? DEFAULT_STARTUP_PROTECTION_MS);
  const setIntervalFn =
    options.setIntervalFn ??
    ((callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs);
      return { clear: () => clearInterval(timer), unref: () => timer.unref() };
    });
  let running = false;

  const status = async (): Promise<HostMemorySnapshot> => {
    const leases = await readLeases(options.dataDir);
    return snapshot({
      leases,
      protectedThreadIds: new Set(options.getProtectedThreadIds()),
      daemonRssBytes: process.memoryUsage().rss,
    });
  };

  const collect = async (
    args: { force?: boolean } = {},
  ): Promise<HostMemoryCollectionResult> => {
    const protectedThreadIds = new Set(options.getProtectedThreadIds());
    const leases = await readLeases(options.dataDir);
    const before = snapshot({
      leases,
      protectedThreadIds,
      daemonRssBytes: process.memoryUsage().rss,
    });
    const reclaimed: HostMemoryCollectionResult["reclaimed"] = [];
    const skipped: HostMemoryCollectionResult["skipped"] = [];
    const candidates = leases
      .filter((lease) => lease.state === "running")
      .sort(
        (left, right) => (left.startedAtMs ?? 0) - (right.startedAtMs ?? 0),
      );
    for (const lease of candidates) {
      if (reclaimed.length >= maxReclaimsPerSweep) break;
      if (lease.threadId === null || lease.childPid === null) {
        skipped.push({
          runId: lease.runId,
          reason: "missing-thread-ownership",
        });
        continue;
      }
      if (protectedThreadIds.has(lease.threadId)) {
        skipped.push({
          runId: lease.runId,
          reason: "active-or-adopted-thread",
        });
        continue;
      }
      if (!args.force && nowMs() < startupProtectionUntilMs) {
        skipped.push({
          runId: lease.runId,
          reason: "restart-adoption-protection",
        });
        continue;
      }
      if (
        lease.startedAtMs === null ||
        nowMs() - lease.startedAtMs < minimumOrphanAgeMs
      ) {
        skipped.push({ runId: lease.runId, reason: "lease-too-new" });
        continue;
      }
      if (!lease.groupAlive && !lease.childAlive) continue;
      const result = await stopProcessGroupByPid({ pid: lease.childPid });
      reclaimed.push({
        runId: lease.runId,
        threadId: lease.threadId,
        pid: lease.childPid,
        stopped: result.stopped,
      });
      if (!result.stopped) {
        options.logger.warn(
          { runId: lease.runId, pid: lease.childPid, threadId: lease.threadId },
          "Managed agent lease did not quiesce after bounded termination",
        );
      }
    }
    const after = await status();
    if (reclaimed.length > 0) {
      options.logger.info(
        { reclaimed: reclaimed.length, before, after },
        "Reclaimed orphaned managed agent process groups",
      );
    }
    return { before, after, reclaimed, skipped };
  };

  const timer = setIntervalFn(() => {
    if (running) return;
    running = true;
    void collect()
      .catch((error) => {
        options.logger.warn(
          { err: error },
          "Managed agent memory sweep failed",
        );
      })
      .finally(() => {
        running = false;
      });
  }, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  timer.unref();

  return {
    status,
    collect,
    stop: () => timer.clear(),
  };
}
