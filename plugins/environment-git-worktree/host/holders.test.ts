import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink as fsReadlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeHolderScan,
  hostProc,
  linuxVisibilityProblem,
  scanLinux,
  scanWorktreeHolders,
  type ProcReader,
} from "./holders.js";

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];
const platform = process.platform;

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-holders-"));
  roots.push(root);
  return realpath(root);
}

function hold(script: string, cwd: string, args: string[] = []) {
  const child = spawn(process.execPath, ["-e", script, ...args], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  children.push(child);
  return child;
}

describe("scanWorktreeHolders", () => {
  it("never reports an unused folder as held, and is clear only when every process could be inspected", async () => {
    const directory = await makeDirectory();
    const scan = await scanWorktreeHolders(directory);
    expect(["clear", "unknown"]).toContain(scan.status);
    if (process.platform !== "linux") expect(scan.status).toBe("unknown");
  });

  it("reports a program whose working folder is inside, without signalling it", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no holder scan on Windows");
    const directory = await makeDirectory();
    const child = hold("setTimeout(() => {}, 300_000)", directory);

    await expect
      .poll(async () => (await scanWorktreeHolders(directory)).status, {
        timeout: 10_000,
      })
      .toBe("held");
    const scan = await scanWorktreeHolders(directory);

    expect(scan).toMatchObject({
      status: "held",
      holders: [{ pid: child.pid, through: "working folder" }],
    });
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
  });

  it("reports a program that holds a file open inside the folder", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no holder scan on Windows");
    const directory = await makeDirectory();
    const elsewhere = await makeDirectory();
    const file = join(directory, "open.txt");
    await writeFile(file, "x");
    const child = hold(
      'require("node:fs").openSync(process.argv[1], "r+"); setTimeout(() => {}, 300_000)',
      elsewhere,
      [file],
    );

    await expect
      .poll(async () => (await scanWorktreeHolders(directory)).status, {
        timeout: 10_000,
      })
      .toBe("held");
    expect(await scanWorktreeHolders(directory)).toMatchObject({
      status: "held",
      holders: [{ pid: child.pid, through: "open file" }],
    });
  });

  it("is inconclusive, not clear, where the platform cannot be inspected", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const scan = await scanWorktreeHolders(await makeDirectory());
    expect(scan.status).toBe("unknown");
    expect(describeHolderScan(scan)).toContain("could not check");
  });

  it("words a held result with the program and how it holds the folder", () => {
    expect(
      describeHolderScan({
        status: "held",
        holders: [{ pid: 42, command: "node", through: "open file" }],
      }),
    ).toContain("node (pid 42, open file)");
    expect(describeHolderScan({ status: "clear" })).toBeNull();
  });
});

interface FakeProcess {
  uid?: number;
  state?: string;
  comm?: string;
  mount?: string;
  root?: string;
  cwd?: string;
  denied?: boolean;
  fdTargets?: string[];
  mapFiles?: string[];
  exe?: string;
  magic?: Record<string, string>;
  mapDevice?: string;
  containerIds?: Record<string, string>;
  name?: string;
  argv0?: string | null;
  startTicks?: number;
}

const TREE_DIRECTORIES: Record<string, string> = {
  "/work/tree": "1:100",
  "/work/tree/sub": "1:101",
  "/work/tree/sub/x": "1:104",
  "/work/tree/sub/deep": "1:102",
  "/work/tree/other": "1:103",
};
const CONTAINER_IDS: Record<string, string> = {
  "/": "9:1",
  "/data": "1:101",
  "/data/x": "1:104",
  "/data/x/file.txt": "9:50",
  "/data/x/lib.so": "9:51",
  "/mnt": "1:100",
  "/mnt/other": "1:103",
  "/home": "9:2",
  "/home/other": "1:900",
  "/usr": "9:3",
  "/usr/bin": "9:4",
  "/usr/bin/node": "9:5",
  "/var": "9:6",
  "/var/log": "9:7",
  "/var/log/a": "9:8",
  "/lib": "9:9",
  "/lib/x.so": "9:10",
};

function fakeProc(options: {
  self?: { uid?: number; groups?: number[]; nspid?: string };
  mountinfo?: string;
  ourView?: Record<string, string>;
  ownMount?: string;
  denyInit?: boolean;
  processes?: Record<number, FakeProcess>;
  createdMs?: number | null;
  noBoot?: boolean;
}): ProcReader {
  const self = options.self ?? {};
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  const denied = new Set<string>();
  const dirs = new Map<string, string[]>();
  const ids = new Map<string, string>(
    Object.entries({ ...TREE_DIRECTORIES, ...(options.ourView ?? {}) }),
  );
  files.set(
    "/proc/self/status",
    `Name:\tnode\nState:\tR (running)\nNSpid:\t${self.nspid ?? "4242"}\nUid:\t${self.uid ?? 1000}\t${self.uid ?? 1000}\t${self.uid ?? 1000}\t${self.uid ?? 1000}\nGid:\t1000\t1000\t1000\t1000\nGroups:\t${(self.groups ?? [1000]).join(" ")}\n`,
  );
  links.set("/proc/self/ns/mnt", options.ownMount ?? "mnt:[1]");
  links.set("/proc/self/root", "/");
  if (options.noBoot !== true)
    files.set("/proc/stat", "cpu  1 2 3\nbtime 1000000\n");
  files.set(
    "/proc/self/mountinfo",
    options.mountinfo ??
      "26 20 0:5 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n",
  );
  denied.add("/proc/1/ns/pid");
  denied.add("/proc/1/ns/mnt");
  const processes = options.processes ?? {};
  dirs.set("/proc", ["self", "1", ...Object.keys(processes), "cpuinfo"]);
  for (const [key, process] of Object.entries(processes)) {
    const base = `/proc/${key}`;
    files.set(
      `${base}/status`,
      `Name:\t${process.name ?? "x"}\nState:\t${process.state ?? "S (sleeping)"}\nUid:\t${process.uid ?? 1000}\t${process.uid ?? 1000}\t${process.uid ?? 1000}\t${process.uid ?? 1000}\n`,
    );
    files.set(`${base}/comm`, `${process.comm ?? "node"}\n`);
    files.set(
      `${base}/stat`,
      `${key} (${process.name ?? "x"}) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${process.startTicks ?? 0} 0 0\n`,
    );
    if (process.argv0 === null) denied.add(`${base}/cmdline`);
    else files.set(`${base}/cmdline`, `${process.argv0 ?? "node"}\0--x\0`);
    if (process.denied === true) {
      for (const leaf of ["ns/mnt", "root", "task", "fd", "maps"])
        denied.add(`${base}/${leaf}`);
      continue;
    }
    links.set(`${base}/ns/mnt`, process.mount ?? options.ownMount ?? "mnt:[1]");
    links.set(`${base}/root`, process.root ?? "/");
    dirs.set(`${base}/task`, [key]);
    links.set(
      `${base}/task/${key}/ns/mnt`,
      process.mount ?? options.ownMount ?? "mnt:[1]",
    );
    links.set(`${base}/task/${key}/cwd`, process.cwd ?? "/home/other");
    links.set(`${base}/exe`, process.exe ?? "/usr/bin/node");
    for (const [magicPath, id] of Object.entries(process.magic ?? {}))
      ids.set(magicPath, id);
    for (const [containerPath, id] of Object.entries(
      process.containerIds ?? {},
    ))
      ids.set(`${base}/root${containerPath}`, id);
    const fdTargets = process.fdTargets ?? [];
    for (const [containerPath, id] of Object.entries(CONTAINER_IDS))
      ids.set(`${base}/root${containerPath === "/" ? "/" : containerPath}`, id);
    files.set(
      `${base}/maps`,
      (process.mapFiles ?? [])
        .map(
          (file) =>
            `7f0000000000-7f0000001000 r--p 00000000 ${process.mapDevice ?? "08:01 12"} ${file}`,
        )
        .join("\n"),
    );
    dirs.set(
      `${base}/fd`,
      fdTargets.map((_, index) => String(index + 3)),
    );
    fdTargets.forEach((target, index) =>
      links.set(`${base}/fd/${index + 3}`, target),
    );
  }
  const fail = (path: string): never => {
    throw Object.assign(new Error(path), {
      code: denied.has(path) ? "EACCES" : "ENOENT",
    });
  };
  return {
    readlink: async (path) => links.get(path) ?? fail(path),
    readFile: async (path) => files.get(path) ?? fail(path),
    readdir: async (path) => dirs.get(path) ?? fail(path),
    lstatId: async (path) => ids.get(path) ?? fail(path),
    statId: async (path) => ids.get(path) ?? fail(path),
    creationMs: async () => {
      if (options.createdMs === null) return null;
      return options.createdMs ?? 1_000_060_000;
    },
    subdirectories: async (path) => {
      if (!(path in TREE_DIRECTORIES)) return fail(path);
      return Object.keys(TREE_DIRECTORIES)
        .filter(
          (candidate) =>
            candidate.startsWith(`${path}/`) &&
            !candidate.slice(path.length + 1).includes("/"),
        )
        .map((candidate) => candidate.slice(path.length + 1));
    },
  };
}

describe("the Linux process-list visibility rule", () => {
  it("accepts a process whose /proc/1 it may not read when it sits alone in its process namespace", async () => {
    const proc = fakeProc({});
    expect((await linuxVisibilityProblem(proc)).problem).toBeNull();
    expect(await scanLinux("/work/tree", proc, 4242)).toEqual({
      status: "clear",
    });
  });

  it("keeps the worktree when the process runs in a nested process namespace", async () => {
    const proc = fakeProc({ self: { nspid: "4242\t17" } });
    expect((await linuxVisibilityProblem(proc)).problem).toContain(
      "nested process namespace",
    );
    expect((await scanLinux("/work/tree", proc, 4242)).status).toBe("unknown");
  });

  it("keeps the worktree when /proc hides other users' processes, unless the user is in the exempt group", async () => {
    const hidden = fakeProc({
      mountinfo:
        "26 20 0:5 / /proc rw,nosuid,relatime - proc proc rw,hidepid=2,gid=999\n",
    });
    expect((await linuxVisibilityProblem(hidden)).problem).toContain("hidden");
    for (const value of ["1", "invisible", "4"]) {
      const other = fakeProc({
        mountinfo: `26 20 0:5 / /proc rw - proc proc rw,hidepid=${value}\n`,
      });
      expect((await linuxVisibilityProblem(other)).problem).toContain("hidden");
    }
    const exempt = fakeProc({
      self: { groups: [1000, 999] },
      mountinfo:
        "26 20 0:5 / /proc rw,nosuid,relatime - proc proc rw,hidepid=2,gid=999\n",
    });
    expect((await linuxVisibilityProblem(exempt)).problem).toBeNull();
    const visible = fakeProc({
      mountinfo: "26 20 0:5 / /proc rw - proc proc rw,hidepid=0\n",
    });
    expect((await linuxVisibilityProblem(visible)).problem).toBeNull();
  });

  it("keeps the worktree when it cannot tell which namespaces it is in", async () => {
    const proc = fakeProc({});
    const broken: ProcReader = {
      ...proc,
      readlink: async (path) => {
        if (path === "/proc/self/ns/mnt")
          throw Object.assign(new Error(path), { code: "EACCES" });
        return proc.readlink(path);
      },
    };
    expect((await linuxVisibilityProblem(broken)).problem).toContain(
      "mount namespace",
    );
  });

  it("reports a same-user process working inside the folder, even when other users' processes are unreadable", async () => {
    const proc = fakeProc({
      processes: {
        100: { uid: 0, denied: true, comm: "systemd" },
        200: { uid: 1000, cwd: "/work/tree/sub", comm: "node" },
      },
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
      status: "held",
      holders: [{ pid: 200, through: "working folder" }],
    });
  });

  it("is clear when only other users' processes are unreadable, and for a zombie", async () => {
    const proc = fakeProc({
      processes: {
        100: { uid: 0, denied: true, comm: "systemd" },
        101: { uid: 1001, denied: true },
        102: { uid: 1000, state: "Z (zombie)", denied: true },
      },
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toEqual({
      status: "clear",
    });
  });

  it("is clear when the only unreadable same-user process is a known session helper, and unknown for any other", async () => {
    const helper = fakeProc({
      processes: { 300: { uid: 1000, denied: true, comm: "sshd-session" } },
    });
    expect(await scanLinux("/work/tree", helper, 4242)).toEqual({
      status: "clear",
    });
    const stranger = fakeProc({
      processes: { 300: { uid: 1000, denied: true, comm: "node" } },
    });
    expect(await scanLinux("/work/tree", stranger, 4242)).toMatchObject({
      status: "unknown",
    });
  });

  it("leaves out a same-user process in another mount namespace when nothing it holds is in the worktree, even on the worktree's device", async () => {
    const proc = fakeProc({
      processes: {
        300: {
          uid: 1000,
          mount: "mnt:[2]",
          cwd: "/home/other",
          fdTargets: ["/var/log/a", "socket:[1]", "pipe:[2]"],
          mapFiles: ["/lib/x.so"],
        },
      },
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toEqual({
      status: "clear",
    });
  });

  it.each([
    ["working folder", { cwd: "/data/x" }, "working folder"],
    [
      "working folder at the bind mount itself",
      { cwd: "/data" },
      "working folder",
    ],
    [
      "open file",
      { cwd: "/home/other", fdTargets: ["/data/x/file.txt"] },
      "open file",
    ],
    [
      "mapped file",
      { cwd: "/home/other", mapFiles: ["/data/x/lib.so"] },
      "mapped file",
    ],
    [
      "bind mount of the worktree root",
      { cwd: "/mnt/other" },
      "working folder",
    ],
  ])(
    "reports a process in another mount namespace that holds the worktree through a bind mount of a subfolder: %s",
    async (_name, process, through) => {
      const proc = fakeProc({
        processes: {
          300: { uid: 1000, mount: "mnt:[2]", comm: "node", ...process },
        },
      });
      expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
        status: "held",
        holders: [{ pid: 300, command: "node", through }],
      });
    },
  );

  it("keeps the worktree when a path of a process in another mount namespace cannot be placed", async () => {
    const lost = fakeProc({
      processes: { 300: { uid: 1000, mount: "mnt:[2]", cwd: "/gone/away" } },
    });
    expect(await scanLinux("/work/tree", lost, 4242)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("cannot be found"),
    });
    const deleted = fakeProc({
      processes: {
        300: { uid: 1000, mount: "mnt:[2]", cwd: "/data/x (deleted)" },
      },
    });
    expect(await scanLinux("/work/tree", deleted, 4242)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("was deleted"),
    });
  });

  it("keeps the worktree when a link of a process in another mount namespace cannot be read", async () => {
    for (const failing of [
      "/proc/300/task/300/cwd",
      "/proc/300/exe",
      "/proc/300/fd/3",
      "/proc/300/fd",
      "/proc/300/maps",
      "/proc/300/root/home/other",
    ]) {
      const proc = fakeProc({
        processes: {
          300: {
            uid: 1000,
            mount: "mnt:[2]",
            comm: "node",
            cwd: "/home/other",
            fdTargets: ["/var/log/a"],
          },
        },
      });
      const broken: ProcReader = {
        ...proc,
        readlink: async (path) => {
          if (path === failing)
            throw Object.assign(new Error(path), { code: "EACCES" });
          return proc.readlink(path);
        },
        readFile: async (path) => {
          if (path === failing)
            throw Object.assign(new Error(path), { code: "EACCES" });
          return proc.readFile(path);
        },
        readdir: async (path) => {
          if (path === failing)
            throw Object.assign(new Error(path), { code: "EACCES" });
          return proc.readdir(path);
        },
        lstatId: async (path) => {
          if (path === failing)
            throw Object.assign(new Error(path), { code: "EACCES" });
          return proc.lstatId(path);
        },
      };
      expect(await scanLinux("/work/tree", broken, 4242)).toMatchObject({
        status: "unknown",
      });
    }
  });

  describe("a path that cannot be found from the process's own root", () => {
    const view = {
      "/opt/tool/runner": "2:77",
      "/opt/tool": "2:76",
      "/opt": "2:75",
      "/opt/lib/x.so": "2049:12",
      "/opt/lib": "2:78",
      "/": "2:1",
      "/work/tree/sub/tool": "1:300",
    };
    const exeProcess = (
      magic: string,
      ours: string,
      exe = "/opt/tool/runner",
    ) =>
      fakeProc({
        ourView: { ...view, [exe]: ours },
        processes: {
          300: {
            uid: 1000,
            mount: "mnt:[2]",
            comm: "node",
            exe,
            magic: { "/proc/300/exe": magic },
          },
        },
      });

    it("leaves the process out when the same path in this view is the same file and lies outside the worktree, and records why", async () => {
      expect(
        await scanLinux("/work/tree", exeProcess("2:77", "2:77"), 4242),
      ).toEqual({
        status: "clear",
        clearances: [
          {
            pid: 300,
            link: "/proc/300/exe",
            path: "/opt/tool/runner",
            identity: "2:77",
          },
        ],
      });
    });

    it("reports the process when the same file lies in a directory of the worktree", async () => {
      expect(
        await scanLinux(
          "/work/tree",
          exeProcess("1:300", "1:300", "/work/tree/sub/tool"),
          4242,
        ),
      ).toMatchObject({
        status: "held",
        holders: [{ pid: 300, command: "node", through: "open file" }],
      });
    });

    it("reports a working folder that cannot be found from its root when its identity is a directory of the worktree", async () => {
      const proc = fakeProc({
        ourView: { "/work/tree/sub/x": "1:104" },
        processes: {
          300: {
            uid: 1000,
            mount: "mnt:[2]",
            comm: "node",
            cwd: "/work/tree/sub/x",
            magic: { "/proc/300/task/300/cwd": "1:104" },
          },
        },
      });
      expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
        status: "held",
        holders: [{ pid: 300, command: "node", through: "working folder" }],
      });
    });

    it("keeps the worktree when the same path in this view is a different file, or is not there", async () => {
      expect(
        await scanLinux("/work/tree", exeProcess("2:99", "2:77"), 4242),
      ).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("different file"),
      });
      const absent = fakeProc({
        processes: {
          300: {
            uid: 1000,
            mount: "mnt:[2]",
            exe: "/opt/tool/runner",
            magic: { "/proc/300/exe": "2:77" },
          },
        },
      });
      expect(await scanLinux("/work/tree", absent, 4242)).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("not in this view"),
      });
    });

    it("identifies a mapped file by the device and inode of its maps line", async () => {
      const proc = fakeProc({
        ourView: view,
        processes: {
          300: { uid: 1000, mount: "mnt:[2]", mapFiles: ["/opt/lib/x.so"] },
        },
      });
      expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
        status: "clear",
        clearances: [
          {
            pid: 300,
            link: "/proc/300/maps:7f0000000000-7f0000001000",
            path: "/opt/lib/x.so",
            identity: "2049:12",
          },
        ],
      });
      const other = fakeProc({
        ourView: { ...view, "/opt/lib/x.so": "2049:13" },
        processes: {
          300: { uid: 1000, mount: "mnt:[2]", mapFiles: ["/opt/lib/x.so"] },
        },
      });
      expect(await scanLinux("/work/tree", other, 4242)).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("different file"),
      });
    });

    it("compares a maps device with the whole Linux st_dev encoding, for a major and a minor above 255", async () => {
      const mapped = (stDev: string) =>
        fakeProc({
          ourView: { ...view, "/opt/lib/x.so": `${stDev}:12` },
          processes: {
            300: {
              uid: 1000,
              mount: "mnt:[2]",
              mapFiles: ["/opt/lib/x.so"],
              mapDevice: "103:1a2 12",
            },
          },
        });
      expect(
        await scanLinux("/work/tree", mapped("1115042"), 4242),
      ).toMatchObject({
        status: "clear",
        clearances: [
          { pid: 300, path: "/opt/lib/x.so", identity: "1115042:12" },
        ],
      });
    });

    it("keeps the worktree for a different device that the truncated major<<8|minor encoding would also match", async () => {
      const proc = fakeProc({
        ourView: { ...view, "/opt/lib/x.so": "66466:12" },
        processes: {
          300: {
            uid: 1000,
            mount: "mnt:[2]",
            mapFiles: ["/opt/lib/x.so"],
            mapDevice: "103:1a2 12",
          },
        },
      });
      expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("different file"),
      });
    });

    it("keeps the worktree for a deleted mapped path and for a maps device or inode that does not parse", async () => {
      const deleted = fakeProc({
        ourView: view,
        processes: {
          300: {
            uid: 1000,
            mount: "mnt:[2]",
            mapFiles: ["/opt/lib/x.so (deleted)"],
          },
        },
      });
      expect(await scanLinux("/work/tree", deleted, 4242)).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("was deleted"),
      });
      for (const mapDevice of [
        "zz:01 12",
        "08:0g 12",
        "08 12",
        "08:01:02 12",
        "08:01 x12",
        "08:01 012",
        "123456789:01 12",
      ]) {
        const proc = fakeProc({
          ourView: view,
          processes: {
            300: {
              uid: 1000,
              mount: "mnt:[2]",
              mapFiles: ["/opt/lib/x.so"],
              mapDevice,
            },
          },
        });
        expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
          status: "unknown",
          reason: expect.stringContaining("cannot be identified"),
        });
      }
    });

    it("keeps the worktree when the maps line of a mapped file has no usable identity", async () => {
      const proc = fakeProc({
        ourView: view,
        processes: {
          300: {
            uid: 1000,
            mount: "mnt:[2]",
            mapFiles: ["/opt/lib/x.so"],
            mapDevice: "00:00 0",
          },
        },
      });
      expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining("cannot be identified"),
      });
    });

    it("keeps the worktree when the program's link cannot be read", async () => {
      const proc = exeProcess("2:77", "2:77");
      const denied: ProcReader = {
        ...proc,
        statId: async (path) => {
          if (path === "/proc/300/exe")
            throw Object.assign(new Error(path), { code: "EACCES" });
          return proc.statId(path);
        },
      };
      expect(await scanLinux("/work/tree", denied, 4242)).toMatchObject({
        status: "unknown",
      });
    });

    it("never overrides a path that resolves inside the process's own root", async () => {
      const proc = fakeProc({
        ourView: {
          "/work/tree/sub/tool": "1:300",
        },
        processes: {
          300: {
            uid: 1000,
            mount: "mnt:[2]",
            comm: "node",
            exe: "/work/tree/sub/tool",
            magic: { "/proc/300/exe": "1:300" },
            containerIds: {
              "/work": "9:20",
              "/work/tree": "9:21",
              "/work/tree/sub": "9:22",
              "/work/tree/sub/tool": "9:23",
            },
          },
        },
      });
      expect(await scanLinux("/work/tree", proc, 4242)).toEqual({
        status: "clear",
      });
    });
  });

  it("keeps the worktree when the path of a process in another mount namespace has too many parts to follow", async () => {
    const proc = fakeProc({
      processes: {
        300: { uid: 1000, mount: "mnt:[2]", cwd: `/${"a/".repeat(4100)}z` },
      },
    });
    const deep: ProcReader = {
      ...proc,
      lstatId: async (path) =>
        path.startsWith("/proc/300/root/a")
          ? `7:${path.length}`
          : proc.lstatId(path),
    };
    expect(await scanLinux("/work/tree", deep, 4242)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("too many parts"),
    });
  });

  it("keeps the worktree, saying it is too large to scan, when it has more directories than the limit and a process runs in another mount namespace", async () => {
    const foreign = fakeProc({
      processes: { 300: { uid: 1000, mount: "mnt:[2]" } },
    });
    expect(
      await scanLinux("/work/tree", foreign, 4242, { maxDirectories: 3 }),
    ).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("too large to scan"),
    });
    const none = fakeProc({ processes: { 300: { uid: 1000 } } });
    expect(
      await scanLinux("/work/tree", none, 4242, { maxDirectories: 3 }),
    ).toEqual({ status: "clear" });
  });

  it("inspects every user's processes when it runs as root", async () => {
    const proc = fakeProc({
      self: { uid: 0 },
      processes: { 100: { uid: 1001, denied: true, comm: "node" } },
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
      status: "unknown",
    });
  });

  it("looks again at a same-user process that is unreadable for a moment, such as one in the middle of exec", async () => {
    const proc = fakeProc({
      processes: { 300: { uid: 1000, cwd: "/elsewhere" } },
    });
    let denied = 2;
    const flaky: ProcReader = {
      ...proc,
      readdir: async (path) => {
        if (path === "/proc/300/fd" && denied > 0) {
          denied -= 1;
          throw Object.assign(new Error(path), { code: "EACCES" });
        }
        return proc.readdir(path);
      },
    };
    expect(await scanLinux("/work/tree", flaky, 4242)).toEqual({
      status: "clear",
    });
    expect(denied).toBe(0);
  });

  it.each([
    ["its mount namespace link", "/proc/300/ns/mnt"],
    ["its root link", "/proc/300/root"],
    ["its list of threads", "/proc/300/task"],
    ["a thread's mount namespace link", "/proc/300/task/300/ns/mnt"],
    ["a thread's working folder link", "/proc/300/task/300/cwd"],
    ["its program link", "/proc/300/exe"],
    ["its list of open files", "/proc/300/fd"],
    ["the link of one open file", "/proc/300/fd/3"],
    ["its memory maps", "/proc/300/maps"],
    ["its status", "/proc/300/status"],
  ])(
    "keeps the worktree when a read of %s fails for a same-user process",
    async (_what, failing) => {
      const proc = fakeProc({
        processes: {
          300: {
            uid: 1000,
            comm: "node",
            fdTargets: ["/data/one", "/data/two"],
          },
        },
      });
      expect(await scanLinux("/work/tree", proc, 4242)).toEqual({
        status: "clear",
      });
      const broken: ProcReader = {
        ...proc,
        readlink: async (path) => {
          if (path === failing)
            throw Object.assign(new Error(path), { code: "EACCES" });
          return proc.readlink(path);
        },
        readFile: async (path) => {
          if (path === failing)
            throw Object.assign(new Error(path), { code: "EACCES" });
          return proc.readFile(path);
        },
        readdir: async (path) => {
          if (path === failing)
            throw Object.assign(new Error(path), { code: "EACCES" });
          return proc.readdir(path);
        },
      };
      expect(await scanLinux("/work/tree", broken, 4242)).toMatchObject({
        status: "unknown",
      });
    },
  );
});

describe("a same-user process that cannot be read because it is non-dumpable", () => {
  const agent = (
    process: FakeProcess,
    options: { createdMs?: number | null } = {},
  ) =>
    fakeProc({
      createdMs: options.createdMs,
      processes: { 300: { uid: 1000, denied: true, ...process } },
    });

  it.each([
    ["ssh-agent", "/usr/bin/ssh-agent"],
    ["gpg-agent", "gpg-agent"],
    ["gnome-keyring-d", "/usr/bin/gnome-keyring-daemon"],
    ["keepassxc-proxy", "/usr/bin/keepassxc-proxy"],
  ])(
    "clears a credential agent named %s that started before the worktree, and records it",
    async (name, argv0) => {
      const proc = agent({ name, comm: name, argv0, startTicks: 100 });
      expect(await scanLinux("/work/tree", proc, 4242)).toEqual({
        status: "clear",
        agentClearances: [
          {
            pid: 300,
            name,
            startedMs: 1_000_001_000,
            worktreeCreatedMs: 1_000_060_000,
          },
        ],
      });
    },
  );

  it("keeps the worktree, naming the process, when the agent started after the worktree or within the margin before it", async () => {
    for (const startTicks of [6001, 5950]) {
      const proc = agent({
        name: "ssh-agent",
        comm: "ssh-agent",
        argv0: "ssh-agent",
        startTicks,
      });
      expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining(
          'process 300 mount namespace (EACCES), named "ssh-agent" (it started after the worktree was created)',
        ),
      });
    }
  });

  it("keeps the worktree for any other name, even with an agent's command line", async () => {
    const proc = agent({
      name: "node",
      comm: "node",
      argv0: "ssh-agent",
      startTicks: 100,
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining(
        'named "node" (not a known credential agent)',
      ),
    });
  });

  it("requires the exact kernel name, which is cut to 15 characters, and the agent's own command line", async () => {
    for (const process of [
      { name: "gnome-keyring-daemon", argv0: "gnome-keyring-daemon" },
      { name: "ssh-agent2", argv0: "ssh-agent" },
      { name: "ssh-agent", argv0: "/usr/bin/python3" },
      { name: "ssh-agent", argv0: "" },
    ]) {
      const proc = agent({ ...process, comm: process.name, startTicks: 100 });
      expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
        status: "unknown",
      });
    }
  });

  it("accepts an agent whose command line cannot be read", async () => {
    const proc = agent({
      name: "ssh-agent",
      comm: "ssh-agent",
      argv0: null,
      startTicks: 100,
    });
    expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
      status: "clear",
      agentClearances: [{ pid: 300, name: "ssh-agent" }],
    });
  });

  it("keeps the worktree when the creation time of the worktree or the boot time is unknown or the start time does not parse", async () => {
    const base = {
      name: "ssh-agent",
      comm: "ssh-agent",
      argv0: "ssh-agent",
      startTicks: 100,
    };
    expect(
      await scanLinux("/work/tree", agent(base, { createdMs: null }), 4242),
    ).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("creation time of the worktree"),
    });
    expect(
      await scanLinux(
        "/work/tree",
        fakeProc({
          noBoot: true,
          processes: { 300: { uid: 1000, denied: true, ...base } },
        }),
        4242,
      ),
    ).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("boot time"),
    });
    expect(
      await scanLinux(
        "/work/tree",
        agent({ ...base, startTicks: "x" as unknown as number }),
        4242,
      ),
    ).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("start time cannot be read"),
    });
  });

  it("no longer clears ssh-agent or gpg-agent by name alone", async () => {
    for (const name of ["ssh-agent", "gpg-agent"]) {
      const proc = agent({ name, comm: name, argv0: name, startTicks: 9000 });
      expect(await scanLinux("/work/tree", proc, 4242)).toMatchObject({
        status: "unknown",
      });
    }
  });
});

describe.skipIf(
  process.platform !== "linux" ||
    (typeof process.getuid === "function" && process.getuid() === 0),
)("a real non-dumpable process", () => {
  const children: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });
  const python = spawnSync("python3", ["--version"]);

  async function start(name: string, argv0: string) {
    const child = spawn(
      "python3",
      [
        "-c",
        `import ctypes, sys, time
libc = ctypes.CDLL(None)
libc.prctl(4, 0, 0, 0, 0)
libc.prctl(15, ${JSON.stringify(name)}.encode(), 0, 0, 0)
print("ready", flush=True)
time.sleep(120)`,
      ],
      { argv0, stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(child);
    await new Promise<void>((resolve) =>
      child.stdout?.once("data", () => resolve()),
    );
    return child;
  }

  async function worktree() {
    const root = await mkdtemp(join(tmpdir(), "bb-nondump-"));
    roots.push(root);
    const dir = join(root, "wt");
    await mkdir(dir);
    await writeFile(join(dir, ".git"), "gitdir: nowhere\n");
    return dir;
  }

  async function scanOnly(directory: string, pid: number) {
    const only: ProcReader = {
      ...hostProc,
      readdir: async (path) =>
        path === "/proc" ? ["self", String(pid)] : hostProc.readdir(path),
    };
    return scanLinux(directory, only);
  }

  async function nonDumpable(pid: number): Promise<boolean> {
    try {
      await fsReadlink(`/proc/${pid}/ns/mnt`);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EACCES";
    }
  }

  const sleepMs = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("named ssh-agent and started before the worktree: the worktree is not held", async ({
    skip,
  }) => {
    skip(python.status !== 0, "python3 is not available");
    const child = await start("ssh-agent", "ssh-agent");
    skip(
      !(await nonDumpable(child.pid ?? 0)),
      "the kernel lets this user read it",
    );
    await sleepMs(1500);
    const dir = await worktree();
    const scan = await scanOnly(dir, child.pid ?? 0);
    expect(scan).toMatchObject({
      status: "clear",
      agentClearances: [{ pid: child.pid, name: "ssh-agent" }],
    });
  });

  it("named ssh-agent and started after the worktree: the worktree is kept", async ({
    skip,
  }) => {
    skip(python.status !== 0, "python3 is not available");
    const dir = await worktree();
    const child = await start("ssh-agent", "ssh-agent");
    skip(
      !(await nonDumpable(child.pid ?? 0)),
      "the kernel lets this user read it",
    );
    const scan = await scanOnly(dir, child.pid ?? 0);
    expect(scan).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("started after the worktree was created"),
    });
  });

  it("with any other name, even started before the worktree: the worktree is kept, naming the process", async ({
    skip,
  }) => {
    skip(python.status !== 0, "python3 is not available");
    const child = await start("renamed-helper", "ssh-agent");
    skip(
      !(await nonDumpable(child.pid ?? 0)),
      "the kernel lets this user read it",
    );
    await sleepMs(1500);
    const dir = await worktree();
    const scan = await scanOnly(dir, child.pid ?? 0);
    expect(scan).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining(
        `process ${child.pid} mount namespace (EACCES), named "renamed-helper"`,
      ),
    });
  });
});
