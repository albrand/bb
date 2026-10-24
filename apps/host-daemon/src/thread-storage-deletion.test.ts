import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { makeDispatchOptions } from "../test/command/dispatch-helpers.js";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "./command-dispatch.js";
import { RuntimeManager } from "./runtime-manager.js";

it.for(["thread deletion", "orphan removal"] as const)(
  "%s refuses while a process works in nested thread storage, names it, stops nothing, and removes the folder once nothing works there",
  async (cleanup, { skip }) => {
    skip(
      process.platform === "win32",
      "process working directories are not enumerated on Windows",
    );
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "bb-storage-delete-")),
    );
    const storageRoot = path.join(root, "thread-storage");
    const storagePath = path.join(storageRoot, "thr_busy");
    const checkout = path.join(storagePath, "checkout", "app");
    const neighbor = path.join(storageRoot, "thr_busy-other");
    await fs.mkdir(checkout, { recursive: true });
    await fs.mkdir(neighbor, { recursive: true });
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000); process.send('ready');"],
      {
        cwd: checkout,
        detached: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const sibling = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000); process.send('ready');"],
      {
        cwd: neighbor,
        detached: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const childReady = once(child, "message");
    const siblingReady = once(sibling, "message");
    try {
      await Promise.all([childReady, siblingReady]);
      const options = makeDispatchOptions({
        runtimeManager: new RuntimeManager(),
        threadStorageRootPath: storageRoot,
      });
      const run = () =>
        cleanup === "thread deletion"
          ? dispatchCommand(
              {
                type: "thread.storage.delete",
                threadId: "thr_busy",
                environmentId: "env_busy",
              },
              options,
            )
          : dispatchOnlineRpcCommand(
              {
                type: "host.remove_path",
                path: storagePath,
                rootPath: storageRoot,
                recursive: true,
              },
              options,
              new AbortController().signal,
            );
      await expect(run()).rejects.toThrow(/still working inside/);
      await expect(fs.stat(checkout)).resolves.toMatchObject({});
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(sibling.exitCode).toBeNull();
      expect(sibling.signalCode).toBeNull();
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await run();
      await expect(fs.stat(storagePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(sibling.exitCode).toBeNull();
      expect(sibling.signalCode).toBeNull();
      await expect(fs.stat(neighbor)).resolves.toMatchObject({});
    } finally {
      await Promise.all(
        [child, sibling].map(async (running) => {
          if (running.exitCode !== null || running.signalCode !== null) return;
          const exited = once(running, "exit");
          running.kill("SIGKILL");
          await exited;
        }),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
