import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  scanProcessesWithCwdUnder,
  type CwdScanIo,
} from "../src/cwd-scan.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeLinux(
  cwds: Record<number, string | NodeJS.ErrnoException>,
  owners: Record<number, number> = {},
  comms: Record<number, string> = {},
): CwdScanIo {
  return {
    platform: "linux",
    uid: 1000,
    selfPid: 1,
    listProcessIds: async () => Object.keys(cwds),
    readCwd: async (pid) => {
      const value = cwds[pid];
      if (value === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (typeof value !== "string") throw value;
      return value;
    },
    ownerUid: async (pid) => owners[pid] ?? 1000,
    readComm: async (pid) => comms[pid] ?? "node",
    runLsof: async () => {
      throw new Error("unused");
    },
  };
}

const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });
const dir = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "bb-cwd-scan-")));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return base;
};

describe("scanProcessesWithCwdUnder", () => {
  it("reports a same-user process working inside the directory as held", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux({ 10: `${base}/sub`, 11: "/elsewhere" }),
    );
    expect(scan).toEqual({
      status: "held",
      holders: [{ pid: 10, cwd: `${base}/sub` }],
      excludedOtherUsers: 0,
      unvouchedHelpers: [],
    });
  });

  it.each([
    "systemd",
    "(sd-pam)",
    "ssh-agent",
    "sshd",
    "sshd-session",
    "gpg-agent",
    "dbus-daemon",
  ])("is clear, and reports it by name and pid, when the unreadable same-user process is the allow-listed helper %s", async (comm) => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux({ 10: denied() }, {}, { 10: comm }),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 0,
      unvouchedHelpers: [{ pid: 10, comm }],
    });
  });

  it.each(["node", "bash", "ssh-agent-fake", "sshd-sessionx", "SSHD"])(
    "is unknown when the unreadable same-user process is %s, which is not an allow-listed helper",
    async (comm) => {
      const base = await dir();
      const scan = await scanProcessesWithCwdUnder(
        { directories: [base] },
        fakeLinux({ 10: denied() }, {}, { 10: comm }),
      );
      expect(scan.status).toBe("unknown");
      expect(scan.status === "unknown" ? scan.reason : "").toContain("10");
    },
  );

  it("is unknown when the name of an unreadable same-user process cannot be read", async () => {
    const base = await dir();
    const io = fakeLinux({ 10: denied() });
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      {
        ...io,
        readComm: async () => {
          throw denied();
        },
      },
    );
    expect(scan.status).toBe("unknown");
  });

  it("does not block on another user's unreadable process and says it was excluded", async () => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      fakeLinux({ 10: denied(), 11: "/elsewhere" }, { 10: 0 }),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 1,
      unvouchedHelpers: [],
    });
  });

  it("is unknown when the process list cannot be read, on Windows, and for a symlinked target", async () => {
    const base = await dir();
    const unreadable: CwdScanIo = {
      ...fakeLinux({}),
      listProcessIds: async () => {
        throw denied();
      },
    };
    expect((await scanProcessesWithCwdUnder({ directories: [base] }, unreadable)).status).toBe("unknown");
    expect(
      (
        await scanProcessesWithCwdUnder(
          { directories: [base] },
          { ...fakeLinux({}), platform: "win32" },
        )
      ).status,
    ).toBe("unknown");
    await mkdir(join(base, "real"));
    await symlink(join(base, "real"), join(base, "link"));
    expect(
      (
        await scanProcessesWithCwdUnder(
          { directories: [join(base, "link")] },
          fakeLinux({}),
        )
      ).status,
    ).toBe("unknown");
  });

  it.each([
    ["a spawn error", async () => { throw new Error("spawn lsof ENOENT"); }],
    ["a timeout", async () => { throw new Error("lsof timed out"); }],
    ["an exit code above 1", async () => ({ code: 2, stdout: "", stderr: "" })],
    [
      "exit 0 together with a warning on stderr",
      async () => ({
        code: 0,
        stdout: "",
        stderr: "lsof: WARNING: can't stat() nfs file system /mnt/x",
      }),
    ],
    [
      "exit 1 together with a warning on stderr",
      async () => ({
        code: 1,
        stdout: "",
        stderr: "lsof: WARNING: can't stat() fuse file system /Volumes/x",
      }),
    ],
  ])("is unknown on macOS when lsof has %s", async (_label, runLsof) => {
    const base = await dir();
    const scan = await scanProcessesWithCwdUnder(
      { directories: [base] },
      { ...fakeLinux({}), platform: "darwin", runLsof },
    );
    expect(scan.status).toBe("unknown");
  });

  it("is clear on macOS when lsof finds nothing under the directory (exit 1) and held when it does", async () => {
    const base = await dir();
    const darwin = (stdout: string, code: number) => ({
      ...fakeLinux({}),
      platform: "darwin" as const,
      runLsof: async () => ({ code, stdout, stderr: "" }),
    });
    expect(
      await scanProcessesWithCwdUnder({ directories: [base] }, darwin("", 1)),
    ).toEqual({
      status: "clear",
      excludedOtherUsers: null,
      unvouchedHelpers: null,
    });
    expect(
      await scanProcessesWithCwdUnder(
        { directories: [base] },
        darwin(`p77\nn${base}/x\n`, 0),
      ),
    ).toMatchObject({ status: "held", holders: [{ pid: 77 }] });
  });

  it.skipIf(process.platform === "win32")("finds a real process and leaves it running", async () => {
    const base = await dir();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: base,
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    cleanups.push(async () => {
      child.kill("SIGKILL");
      await exited;
    });
    await expect
      .poll(async () => (await scanProcessesWithCwdUnder({ directories: [base] })).status)
      .toBe("held");
    expect(child.exitCode).toBeNull();
  });
});
