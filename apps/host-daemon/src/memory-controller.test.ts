import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { startHostDaemonMemoryController } from "./memory-controller.js";

function logger() {
  return { info: () => undefined, warn: () => undefined };
}

describe("host daemon memory controller", () => {
  it("protects active leases and reports them as non-reclaimable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bb-memory-controller-"));
    const leases = join(dataDir, "opencode-context", "leases");
    await mkdir(leases, { recursive: true });
    await writeFile(
      join(leases, "active.json"),
      JSON.stringify({
        run_id: "run-active",
        caller_pid: process.pid,
        child_pid: process.pid,
        thread_id: "thread-active",
        state: "running",
        started_at: new Date(0).toISOString(),
      }),
    );
    const controller = startHostDaemonMemoryController({
      dataDir,
      logger: logger(),
      getProtectedThreadIds: () => ["thread-active"],
      setIntervalFn: () => ({ clear: () => undefined, unref: () => undefined }),
    });
    const result = await controller.collect();
    expect(result.reclaimed).toEqual([]);
    expect(result.skipped).toContainEqual({
      runId: "run-active",
      reason: "active-or-adopted-thread",
    });
    expect(result.after.protectedThreadCount).toBe(1);
    controller.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reclaims an old orphaned managed process group and verifies termination", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bb-memory-controller-"));
    const leases = join(dataDir, "opencode-context", "leases");
    await mkdir(leases, { recursive: true });
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    if (child.pid === undefined) throw new Error("child did not start");
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    await writeFile(
      join(leases, "orphan.json"),
      JSON.stringify({
        run_id: "run-orphan",
        caller_pid: 999999,
        child_pid: child.pid,
        thread_id: "thread-orphan",
        state: "running",
        started_at: new Date(0).toISOString(),
      }),
    );
    const controller = startHostDaemonMemoryController({
      dataDir,
      logger: logger(),
      getProtectedThreadIds: () => [],
      setIntervalFn: () => ({ clear: () => undefined, unref: () => undefined }),
      minimumOrphanAgeMs: 1,
      startupProtectionMs: 0,
    });
    const result = await controller.collect();
    expect(result.reclaimed).toEqual([
      {
        runId: "run-orphan",
        threadId: "thread-orphan",
        pid: child.pid,
        stopped: true,
      },
    ]);
    expect(result.after.reclaimableLeaseCount).toBe(0);
    controller.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
});
