import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeWorkerRegistryEntry,
  readBridgeWorkerEntries,
  readProcessIdentity,
  reapDeadBridgeWorkers,
  writeBridgeWorkerEntry,
} from "./bridge-worker-registry.js";

function entry(
  overrides: Partial<BridgeWorkerRegistryEntry>,
): BridgeWorkerRegistryEntry {
  return {
    id: "a1b2c3d4e5f6",
    pid: process.pid,
    processIdentity: readProcessIdentity(process.pid) ?? "unreadable",
    socketPath: "/tmp/unused.sock",
    pluginId: "provider-codex",
    providerId: "codex",
    processKey: "codex#bridge:0123456789abcdef",
    environmentId: "env_1",
    bridgeProtocolVersion: 2,
    transportVersion: 1,
    startedAt: "2026-09-11T00:00:00.000Z",
    workspace: {
      workspacePath: "/tmp/workspace",
      workspaceProvisionType: "unmanaged",
      personalWorkspaceRoot: null,
    },
    threads: {},
    ...overrides,
  };
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""]);
  if (result.pid === undefined) throw new Error("could not spawn");
  return result.pid;
}

describe("bridge worker registry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bb-worker-registry-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips an entry through an atomic, owner-only file", () => {
    const written = entry({});
    writeBridgeWorkerEntry(dir, written);

    expect(readBridgeWorkerEntries(dir)).toEqual({
      entries: [written],
      invalidIds: [],
    });
    expect(readdirSync(dir)).toEqual([`${written.id}.json`]);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, `${written.id}.json`)).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("reaps entries whose worker is gone, with their socket and log, and keeps live ones", () => {
    const live = entry({ id: "aaaaaaaaaaaa" });
    const dead = entry({
      id: "bbbbbbbbbbbb",
      pid: deadPid(),
      socketPath: join(dir, "bbbbbbbbbbbb.sock"),
    });
    writeBridgeWorkerEntry(dir, live);
    writeBridgeWorkerEntry(dir, dead);
    writeFileSync(join(dir, "bbbbbbbbbbbb.sock"), "");
    writeFileSync(join(dir, "bbbbbbbbbbbb.log"), "worker log");
    writeFileSync(join(dir, "cccccccccccc.json"), "{ not json");

    const result = reapDeadBridgeWorkers(dir);

    expect(result.live).toEqual([live]);
    expect(result.reaped).toEqual([dead]);
    expect(readdirSync(dir).sort()).toEqual(["aaaaaaaaaaaa.json"]);
    expect(existsSync(join(dir, "bbbbbbbbbbbb.log"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "reaps an entry whose pid is running a different process, without signalling it",
    () => {
      const reused = entry({ id: "dddddddddddd", processIdentity: "stale" });
      writeBridgeWorkerEntry(dir, reused);

      const result = reapDeadBridgeWorkers(dir);

      expect(result.live).toEqual([]);
      expect(result.reaped).toEqual([reused]);
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it("treats a missing registry directory as empty", () => {
    expect(reapDeadBridgeWorkers(join(dir, "missing"))).toEqual({
      live: [],
      reaped: [],
    });
  });
});
