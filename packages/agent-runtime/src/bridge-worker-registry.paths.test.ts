import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeWorkerRegistryEntry,
  BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
  readBridgeWorkerEntries,
  readProcessIdentity,
  reapDeadBridgeWorkers,
  writeBridgeWorkerEntry,
} from "./bridge-worker-registry.js";
import { privateSocketDirectory } from "./bridge-worker-socket.js";

describe.skipIf(process.platform === "win32")(
  "bridge worker registry socket paths",
  () => {
    const uid = process.getuid?.() ?? -1;
    let root: string;
    let dir: string;
    let outside: string;

    beforeEach(() => {
      root = mkdtempSync(join("/tmp", "bbr-"));
      dir = join(root, "bridge-workers");
      mkdirSync(dir, { mode: 0o700 });
      outside = join(root, "outside");
      mkdirSync(outside);
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    function entryAt(id: string, socketPath: string): BridgeWorkerRegistryEntry {
      return {
        id,
        formatVersion: BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
        pid: process.pid,
        processIdentity: readProcessIdentity(process.pid) ?? "unreadable",
        socketPath,
        pluginId: "provider-codex",
        providerId: "codex",
        processKey: "codex#bridge:0123456789abcdef",
        environmentId: "env_1",
        bridgeProtocolVersion: 2,
        transportVersion: 1,
        capabilities: null,
        startedAt: "2026-09-11T00:00:00.000Z",
        workspace: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
          personalWorkspaceRoot: null,
        },
        threads: {},
      };
    }

    it("accepts a socket beside the registry and one in the private fallback directory", () => {
      const fallback = privateSocketDirectory({
        root: `/tmp/bb-${uid}`,
        uid,
        workerDir: dir,
      });
      try {
        const beside = entryAt("aaaaaaaaaaaa", join(dir, "aaaaaaaaaaaa.sock"));
        const relocated = entryAt(
          "bbbbbbbbbbbb",
          join(fallback, "bbbbbbbbbbbb.sock"),
        );
        writeBridgeWorkerEntry(dir, beside);
        writeBridgeWorkerEntry(dir, relocated);

        const { entries, invalid } = readBridgeWorkerEntries(dir);

        expect(invalid).toEqual([]);
        expect(entries).toHaveLength(2);
        expect(entries).toEqual(expect.arrayContaining([beside, relocated]));
      } finally {
        rmSync(fallback, { recursive: true, force: true });
      }
    });

    it("drops an entry whose socket path is anywhere else, and never touches that path", () => {
      const targets = {
        cccccccccccc: join(outside, "cccccccccccc.sock"),
        dddddddddddd: `${dir}/../outside/dddddddddddd.sock`,
        eeeeeeeeeeee: join(dir, "ffffffffffff.sock"),
      };
      for (const [id, socketPath] of Object.entries(targets)) {
        writeFileSync(socketPath, "keep");
        writeBridgeWorkerEntry(dir, entryAt(id, socketPath));
      }

      const { live } = reapDeadBridgeWorkers(dir);

      expect(live).toEqual([]);
      for (const socketPath of Object.values(targets)) {
        expect(existsSync(socketPath)).toBe(true);
      }
      expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual(
        [],
      );
    });

    it("drops an entry whose socket beside the registry is a symlink", () => {
      const target = join(outside, "target");
      writeFileSync(target, "keep");
      const socketPath = join(dir, "aaaaaaaaaaaa.sock");
      symlinkSync(target, socketPath);
      writeBridgeWorkerEntry(dir, entryAt("aaaaaaaaaaaa", socketPath));

      const { live } = reapDeadBridgeWorkers(dir);

      expect(live).toEqual([]);
      expect(existsSync(target)).toBe(true);
    });
  },
);
