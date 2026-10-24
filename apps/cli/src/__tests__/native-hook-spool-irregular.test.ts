import { spawn, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const script = fileURLToPath(
  new URL("./helpers/read-hook-dir.ts", import.meta.url),
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function root(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bb-spool-irregular-"));
  roots.push(directory);
  return directory;
}

interface ReadResult {
  late?: unknown[];
  records: unknown[];
  unreadable: number;
}

async function readInChild(
  kind: "append" | "spool",
  target: string,
): Promise<{ reads: ReadResult[]; timedOut: boolean }> {
  const child = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", script, kind, target],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "ignore"] },
  );
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 25_000);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  clearTimeout(killer);
  return { reads: timedOut ? [] : JSON.parse(stdout), timedOut };
}

const opener = (tool: string): string =>
  JSON.stringify({
    hook_event_name: "PermissionRequest",
    session_id: "s",
    tool_name: tool,
  });

describe.skipIf(process.platform === "win32")(
  "the reader never opens a hook file that is not a regular file (native Windows is not exercised: the hook command needs a POSIX shell)",
  () => {
    it("a FIFO or a symlink to a regular file with a spool name is counted once, not opened, not applied, and left in place", async () => {
      const spool = root();
      const elsewhere = path.join(root(), "target.json");
      writeFileSync(elsewhere, opener("FromSymlink"));
      spawnSync("mkfifo", [path.join(spool, "000000000001")]);
      writeFileSync(path.join(spool, "000000000002"), opener("Two"));
      symlinkSync(elsewhere, path.join(spool, "000000000003"));
      writeFileSync(path.join(spool, "000000000004"), opener("Four"));

      const { reads, timedOut } = await readInChild("spool", spool);

      expect(timedOut).toBe(false);
      expect(reads[0]?.records).toEqual([
        {
          hook_event_name: "PermissionRequest",
          session_id: "s",
          tool_name: "Two",
        },
        {
          hook_event_name: "PermissionRequest",
          session_id: "s",
          tool_name: "Four",
        },
      ]);
      expect(reads[0]?.unreadable).toBe(2);
      expect(reads[1]).toEqual({ records: [], unreadable: 0 });
      expect(lstatSync(path.join(spool, "000000000001")).isFIFO()).toBe(true);
      expect(lstatSync(path.join(spool, "000000000003")).isSymbolicLink()).toBe(
        true,
      );
      expect(readFileSync(elsewhere, "utf8")).toBe(opener("FromSymlink"));
    }, 40_000);

    it("a FIFO or a symlink to a regular file with a late-file name is counted once, not opened, not applied, and left in place", async () => {
      const directory = root();
      const file = path.join(directory, "hooks.jsonl");
      writeFileSync(file, "");
      const elsewhere = path.join(root(), "target.json");
      writeFileSync(elsewhere, opener("FromSymlink"));
      const began = Math.floor(Date.now() / 1000);
      spawnSync("mkfifo", [path.join(directory, `.late.1.${began}`)]);
      symlinkSync(elsewhere, path.join(directory, `.late.2.${began}`));

      const { reads, timedOut } = await readInChild("append", file);

      expect(timedOut).toBe(false);
      expect(reads[0]?.late).toBeUndefined();
      expect(reads[0]?.records).toEqual([]);
      expect(reads[0]?.unreadable).toBe(2);
      expect(reads[1]?.unreadable).toBe(0);
      expect(lstatSync(path.join(directory, `.late.1.${began}`)).isFIFO()).toBe(
        true,
      );
      expect(
        lstatSync(path.join(directory, `.late.2.${began}`)).isSymbolicLink(),
      ).toBe(true);
      expect(readFileSync(elsewhere, "utf8")).toBe(opener("FromSymlink"));
    }, 40_000);

    it("control: a regular spool file and a regular late file are read normally", async () => {
      const spool = root();
      writeFileSync(path.join(spool, "000000000001"), opener("One"));
      const spoolRun = await readInChild("spool", spool);
      expect(spoolRun.reads[0]?.records).toHaveLength(1);
      expect(spoolRun.reads[0]?.unreadable).toBe(0);

      const directory = root();
      const file = path.join(directory, "hooks.jsonl");
      writeFileSync(file, "");
      writeFileSync(
        path.join(directory, `.late.1.${Math.floor(Date.now() / 1000)}`),
        opener("Late"),
      );
      const appendRun = await readInChild("append", file);
      expect(appendRun.reads[0]?.late).toHaveLength(1);
      expect(appendRun.reads[0]?.unreadable).toBe(1);
    }, 40_000);
  },
);
