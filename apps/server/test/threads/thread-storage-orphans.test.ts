import { posix as path } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { runThreadStorageOrphanSweep } from "../../src/services/threads/thread-storage-orphans.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const ORPHANED_THREAD_ID = "thr_abcdefghij";
const THREAD_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

function orphanedThreadIdAt(index: number): string {
  let suffix = "";
  for (let value = index; suffix.length < 10; value = Math.floor(value / 32)) {
    suffix = THREAD_ID_ALPHABET[value % 32] + suffix;
  }
  return `thr_${suffix}`;
}

describe("thread storage orphan cleanup", () => {
  it("skips the sweep while app work is active", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });
      try {
        runThreadStorageOrphanSweep(harness.deps);
        await sleep(20);
        expect(responder.requests).toEqual([]);
      } finally {
        responder.unregister();
      }
    });
  });

  it("lists orphaned thread storage but never asks the host to remove it, and never counts it as reclaimed", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rootPath = path.join(session.dataDir, "thread-storage");
      const storedIds = [ORPHANED_THREAD_ID, orphanedThreadIdAt(1)];
      const commandTypes: string[] = [];
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          commandTypes.push(request.command.type);
          if (request.command.type === "host.browse_directory") {
            return {
              ok: true,
              result: {
                directory: rootPath,
                parent: session.dataDir,
                roots: ["/"],
                entries: storedIds.map((name) => ({
                  kind: "directory" as const,
                  name,
                  path: path.join(rootPath, name),
                })),
              },
            };
          }
          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });
      try {
        runThreadStorageOrphanSweep(harness.deps);
        await vi.waitFor(() => {
          expect(commandTypes).toContain("host.browse_directory");
        });
        await sleep(50);

        expect(commandTypes).not.toContain("host.remove_path");
      } finally {
        responder.unregister();
      }
    });
  });
});
