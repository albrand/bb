import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { internal_DO_NOT_USE_scanProcessesWithCwdUnder } from "../host.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;
const cleanupDirs: string[] = [];
const cleanupPids: number[] = [];

afterEach(() => {
  for (const pid of cleanupPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const dir of cleanupDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

posixOnly("internal_DO_NOT_USE_scanProcessesWithCwdUnder", () => {
  it("lists a process working under the directory and leaves it running", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bb-sdk-cwd-list-")));
    cleanupDirs.push(dir);
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: dir, stdio: "ignore" },
    );
    cleanupPids.push(child.pid ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const scan = await internal_DO_NOT_USE_scanProcessesWithCwdUnder({
      directories: [dir],
    });

    expect(scan.status).toBe("held");
    if (scan.status !== "held") return;
    expect(scan.holders.map((holder) => holder.pid)).toContain(child.pid);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
  });

  it("lists nothing for a directory no process uses", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bb-sdk-cwd-list-")));
    cleanupDirs.push(dir);
    expect(
      (await internal_DO_NOT_USE_scanProcessesWithCwdUnder({ directories: [dir] }))
        .status,
    ).toBe("clear");
  });
});
