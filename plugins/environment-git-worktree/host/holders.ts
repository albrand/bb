import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const LSOF_TIMEOUT_MS = 30_000;
const LINUX_SCAN_CONCURRENCY = 32;
const PERMISSION_RETRIES = 3;
const PERMISSION_RETRY_MS = 40;

export interface WorktreeHolder {
  pid: number;
  command: string | null;
  through: "working folder" | "open file" | "mapped file";
}

export interface FallbackClearance {
  pid: number;
  link: string;
  path: string;
  identity: string;
}

export type WorktreeHolderScan =
  | {
      status: "clear";
      clearances?: FallbackClearance[];
      agentClearances?: AgentClearance[];
    }
  | { status: "held"; holders: WorktreeHolder[] }
  | { status: "unknown"; reason: string };

function errorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
    ? ((error as NodeJS.ErrnoException).code ?? null)
    : null;
}

function isUnder(candidate: string, directory: string): boolean {
  const normalized = candidate.endsWith(" (deleted)")
    ? candidate.slice(0, -" (deleted)".length)
    : candidate;
  return (
    normalized === directory || normalized.startsWith(`${directory}${path.sep}`)
  );
}

const GONE_CODES = new Set(["ENOENT", "ESRCH", "ENOTDIR"]);

type Read<T> = { value: T } | { gone: true } | { failed: string };

async function readOptional<T>(read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { value: await read() };
  } catch (error) {
    const code = errorCode(error);
    return code !== null && GONE_CODES.has(code)
      ? { gone: true }
      : { failed: code ?? "unreadable" };
  }
}

export const UNREADABLE_SAME_USER_HELPER_COMMS: ReadonlySet<string> = new Set([
  "systemd",
  "(sd-pam)",
  "sshd",
  "sshd-session",
  "dbus-daemon",
]);

export const CREDENTIAL_AGENTS: readonly {
  kernelName: string;
  argv0: string;
}[] = [
  { kernelName: "ssh-agent", argv0: "ssh-agent" },
  { kernelName: "gpg-agent", argv0: "gpg-agent" },
  { kernelName: "gnome-keyring-d", argv0: "gnome-keyring-daemon" },
  { kernelName: "keepassxc-proxy", argv0: "keepassxc-proxy" },
];

export const AGENT_START_MARGIN_MS = 1000;
const CLOCK_TICK_MS = 10;

export interface AgentClearance {
  pid: number;
  name: string;
  startedMs: number;
  worktreeCreatedMs: number;
}

export interface ProcReader {
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  lstatId(path: string): Promise<string>;
  statId(path: string): Promise<string>;
  creationMs(directory: string): Promise<number | null>;
  subdirectories(path: string): Promise<string[]>;
}

export const hostProc: ProcReader = {
  readlink: (path) => fs.readlink(path),
  readFile: (path) => fs.readFile(path, "utf8"),
  readdir: (path) => fs.readdir(path),
  lstatId: async (path) => {
    const info = await fs.lstat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  },
  statId: async (path) => {
    const info = await fs.stat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  },
  creationMs: async (directory) => {
    const info = await fs.stat(directory, { bigint: true });
    if (info.birthtimeNs > 0n) return Number(info.birthtimeNs / 1_000_000n);
    const marker = await fs.stat(path.join(directory, ".git"), {
      bigint: true,
    });
    return Number(marker.ctimeNs / 1_000_000n);
  },
  subdirectories: async (path) =>
    (await fs.readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
};

let activeProc: ProcReader = hostProc;

export function useProcReaderForTests(reader: ProcReader | null): void {
  activeProc = reader ?? hostProc;
}

export const MAX_TREE_DIRECTORIES = 500_000;
export const MAX_WALK_STEPS = 4096;

type TreeIds = { ids: Set<string> } | { tooLarge: number } | { failed: string };
type TreeIdsReader = () => Promise<TreeIds>;

interface ScanContext {
  tree: TreeIdsReader;
  creationMs: () => Promise<Read<number | null>>;
  bootMs: () => Promise<Read<number>>;
}

async function listTreeIds(
  proc: ProcReader,
  directory: string,
  limit: number,
): Promise<TreeIds> {
  const ids = new Set<string>();
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop() ?? directory;
    const id = await readOptional(() => proc.lstatId(current));
    if ("gone" in id) continue;
    if ("failed" in id) return { failed: `${current} (${id.failed})` };
    ids.add(id.value);
    if (ids.size > limit) return { tooLarge: ids.size };
    const children = await readOptional(() => proc.subdirectories(current));
    if ("gone" in children) continue;
    if ("failed" in children)
      return { failed: `${current} (${children.failed})` };
    for (const child of children.value) pending.push(path.join(current, child));
  }
  return { ids };
}

interface ProcessResultUnknown {
  unknown: string;
  vouchable: boolean;
}
type ProcessResult =
  | WorktreeHolder
  | ProcessResultUnknown
  | { otherUser: true }
  | { helper: string }
  | { cleared: FallbackClearance[] }
  | { agent: AgentClearance }
  | null;

function unreadable(what: string, failed: string): ProcessResultUnknown {
  return {
    unknown: `${what} (${failed})`,
    vouchable: failed === "EACCES" || failed === "EPERM",
  };
}

function notVouchable(reason: string): ProcessResultUnknown {
  return { unknown: reason, vouchable: false };
}

async function checkLink(
  proc: ProcReader,
  pid: number,
  name: string,
  link: string,
  directory: string,
  through: WorktreeHolder["through"],
  command: string | null,
): Promise<ProcessResult> {
  const target = await readOptional(() => proc.readlink(link));
  if ("failed" in target)
    return unreadable(`process ${pid} ${name}`, target.failed);
  if ("value" in target && isUnder(target.value, directory)) {
    return { pid, command, through };
  }
  return null;
}

export interface ProcessIdentity {
  uid: number;
  gids: number[];
}

function parseStatusNumbers(status: string, key: string): number[] | null {
  for (const line of status.split("\n")) {
    if (!line.startsWith(`${key}:`)) continue;
    const values = line
      .slice(key.length + 1)
      .trim()
      .split(/\s+/u)
      .filter((value) => value !== "");
    const numbers = values.map(Number);
    return numbers.every((value) => Number.isInteger(value)) ? numbers : null;
  }
  return null;
}

async function scanLinuxProcess(
  proc: ProcReader,
  pid: number,
  directory: string,
  mountNamespace: string,
  self: ProcessIdentity,
  context: ScanContext,
): Promise<ProcessResult> {
  const base = `/proc/${pid}`;
  const status = await readOptional(() => proc.readFile(`${base}/status`));
  if ("gone" in status) return null;
  if ("failed" in status)
    return unreadable(`process ${pid} status`, status.failed);
  const uids = parseStatusNumbers(status.value, "Uid");
  if (uids === null || uids[0] === undefined)
    return notVouchable(`process ${pid} owner could not be read`);
  if (/^State:\s+Z/mu.test(status.value)) return null;
  if (self.uid !== 0 && uids[0] !== self.uid) return { otherUser: true };

  const comm = await readOptional(() => proc.readFile(`${base}/comm`));
  const command = "value" in comm ? comm.value.trim() || null : null;
  let result = await scanOwnProcess(
    proc,
    pid,
    base,
    directory,
    mountNamespace,
    command,
    context.tree,
  );
  for (
    let attempt = 0;
    attempt < PERMISSION_RETRIES &&
    result !== null &&
    "unknown" in result &&
    result.vouchable;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, PERMISSION_RETRY_MS));
    result = await scanOwnProcess(
      proc,
      pid,
      base,
      directory,
      mountNamespace,
      command,
      context.tree,
    );
  }
  if (result === null || !("unknown" in result) || !result.vouchable)
    return result;
  if (command !== null && UNREADABLE_SAME_USER_HELPER_COMMS.has(command))
    return { helper: command };
  const verdict = await credentialAgentVerdict(
    proc,
    pid,
    base,
    status.value,
    context,
  );
  if ("agent" in verdict) return verdict;
  return {
    unknown: `${result.unknown}, named ${verdict.name === null ? "unknown" : `"${verdict.name}"`} (${verdict.why})`,
    vouchable: false,
  };
}

function statusName(status: string): string | null {
  return /^Name:\t(.*)$/mu.exec(status)?.[1] ?? null;
}

async function credentialAgentVerdict(
  proc: ProcReader,
  pid: number,
  base: string,
  status: string,
  context: ScanContext,
): Promise<{ agent: AgentClearance } | { name: string | null; why: string }> {
  const name = statusName(status);
  const agent = CREDENTIAL_AGENTS.find((entry) => entry.kernelName === name);
  if (agent === undefined || name === null)
    return { name, why: "not a known credential agent" };
  const cmdline = await readOptional(() => proc.readFile(`${base}/cmdline`));
  if ("value" in cmdline) {
    const argv0 = cmdline.value.split("\0")[0] ?? "";
    if (path.posix.basename(argv0) !== agent.argv0)
      return { name, why: "its command line does not name the agent" };
  }
  const stat = await readOptional(() => proc.readFile(`${base}/stat`));
  if (!("value" in stat)) return { name, why: "its start time cannot be read" };
  const fields = stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  if (!/^\d+$/u.test(fields[19] ?? "") || !Number.isSafeInteger(ticks))
    return { name, why: "its start time cannot be read" };
  const boot = await context.bootMs();
  if (!("value" in boot)) return { name, why: "the boot time cannot be read" };
  const created = await context.creationMs();
  if (!("value" in created) || created.value === null)
    return { name, why: "the creation time of the worktree is unknown" };
  const startedMs = boot.value + ticks * CLOCK_TICK_MS;
  if (startedMs + AGENT_START_MARGIN_MS >= created.value)
    return { name, why: "it started after the worktree was created" };
  return {
    agent: { pid, name, startedMs, worktreeCreatedMs: created.value },
  };
}
interface ForeignTarget {
  what: string;
  through: WorktreeHolder["through"];
  path: string;
  magic: string | null;
  identity?: string;
}

async function foreignTargets(
  proc: ProcReader,
  pid: number,
  base: string,
): Promise<{ targets: ForeignTarget[] } | { stop: ProcessResult }> {
  const targets: ForeignTarget[] = [
    { what: "root folder", through: "working folder", path: "/", magic: null },
  ];
  const link = async (
    what: string,
    through: WorktreeHolder["through"],
    path: string,
  ): Promise<ProcessResult> => {
    const target = await readOptional(() => proc.readlink(path));
    if ("gone" in target) return null;
    if ("failed" in target)
      return unreadable(`process ${pid} ${what}`, target.failed);
    targets.push({ what, through, path: target.value, magic: path });
    return null;
  };
  const tasks = await readOptional(() => proc.readdir(`${base}/task`));
  if ("gone" in tasks) return { stop: null };
  if ("failed" in tasks)
    return { stop: unreadable(`process ${pid} tasks`, tasks.failed) };
  for (const task of tasks.value) {
    const failed = await link(
      "working folder",
      "working folder",
      `${base}/task/${task}/cwd`,
    );
    if (failed !== null) return { stop: failed };
  }
  const exe = await link("program", "open file", `${base}/exe`);
  if (exe !== null) return { stop: exe };
  const descriptors = await readOptional(() => proc.readdir(`${base}/fd`));
  if ("gone" in descriptors) return { stop: null };
  if ("failed" in descriptors)
    return {
      stop: unreadable(`process ${pid} open files`, descriptors.failed),
    };
  for (const descriptor of descriptors.value) {
    const failed = await link(
      "open file",
      "open file",
      `${base}/fd/${descriptor}`,
    );
    if (failed !== null) return { stop: failed };
  }
  const maps = await readOptional(() => proc.readFile(`${base}/maps`));
  if ("gone" in maps) return { stop: null };
  if ("failed" in maps)
    return { stop: unreadable(`process ${pid} memory maps`, maps.failed) };
  const mapped = new Set<string>();
  for (const line of maps.value.split("\n")) {
    const fields = line.split(/\s+/u);
    const file = fields.slice(5).join(" ");
    if (file !== "" && !file.startsWith("[") && !mapped.has(file)) {
      mapped.add(file);
      targets.push({
        what: "memory maps",
        through: "mapped file",
        path: file,
        magic: `${base}/maps:${fields[0] ?? ""}`,
        ...identityOfMapsLine(fields[3] ?? "", fields[4] ?? ""),
      });
    }
  }
  return { targets };
}

function identityOfMapsLine(
  device: string,
  inode: string,
): { identity?: string } {
  const parts = device.split(":");
  const [majorText, minorText] = parts;
  if (
    parts.length !== 2 ||
    !/^[0-9a-f]{1,8}$/iu.test(majorText ?? "") ||
    !/^[0-9a-f]{1,8}$/iu.test(minorText ?? "")
  )
    return {};
  const major = Number.parseInt(majorText ?? "", 16);
  const minor = Number.parseInt(minorText ?? "", 16);
  if (!/^[1-9]\d*$/u.test(inode)) return {};
  const encoded =
    ((BigInt(major) & 0xfffn) << 8n) |
    (BigInt(minor) & 0xffn) |
    ((BigInt(minor) & ~0xffn) << 12n) |
    ((BigInt(major) & ~0xfffn) << 32n);
  return { identity: `${encoded}:${inode}` };
}

async function placeByIdentity(
  proc: ProcReader,
  pid: number,
  target: ForeignTarget,
  worktreeIds: Set<string>,
  command: string | null,
): Promise<ProcessResult> {
  const where = `process ${pid} runs in another mount namespace and its ${target.what} ${target.path} cannot be found from its root`;
  if (target.magic === null) return notVouchable(where);
  const actual =
    target.identity !== undefined
      ? { value: target.identity }
      : await readOptional(() => proc.statId(target.magic ?? ""));
  if ("gone" in actual)
    return notVouchable(`${where}, and its file cannot be identified`);
  if ("failed" in actual)
    return unreadable(
      `${where}, and its file cannot be identified`,
      actual.failed,
    );
  const ours = await readOptional(() => proc.statId(target.path));
  if ("gone" in ours)
    return notVouchable(
      `${where}, and the same path is not in this view either`,
    );
  if ("failed" in ours)
    return unreadable(`${where}, and the same path in this view`, ours.failed);
  if (ours.value !== actual.value)
    return notVouchable(
      `${where}, and the same path in this view is a different file`,
    );
  let current = target.path;
  for (let steps = 0; ; steps += 1) {
    if (steps > MAX_WALK_STEPS)
      return notVouchable(
        `${where}, and its path has too many parts to follow`,
      );
    const id = await readOptional(() => proc.lstatId(current));
    if ("gone" in id)
      return notVouchable(
        `${where}, and ${current} cannot be found in this view`,
      );
    if ("failed" in id)
      return unreadable(`${where}, ${current} in this view`, id.failed);
    if (worktreeIds.has(id.value))
      return { pid, command, through: target.through };
    if (current === "/")
      return {
        cleared: [
          {
            pid,
            link: target.magic,
            path: target.path,
            identity: actual.value,
          },
        ],
      };
    current = path.posix.dirname(current);
  }
}

async function reachesWorktree(
  proc: ProcReader,
  pid: number,
  base: string,
  command: string | null,
  tree: TreeIdsReader,
): Promise<ProcessResult> {
  const where = `process ${pid} runs in another mount namespace`;
  const ids = await tree();
  if ("tooLarge" in ids)
    return notVouchable(
      `${where} and the folder is too large to scan (more than ${MAX_TREE_DIRECTORIES} directories)`,
    );
  if ("failed" in ids)
    return notVouchable(
      `${where} and the folder could not be listed (${ids.failed})`,
    );
  const found = await foreignTargets(proc, pid, base);
  if ("stop" in found) return found.stop;
  const outside = new Set<string>();
  const clearances: FallbackClearance[] = [];
  for (const target of found.targets) {
    if (!target.path.startsWith("/")) continue;
    if (target.path.endsWith(" (deleted)"))
      return notVouchable(
        `${where} and its ${target.what} ${target.path} was deleted, so it cannot be placed`,
      );
    const walked: string[] = [];
    let current = target.path;
    for (let steps = 0; ; steps += 1) {
      if (steps > MAX_WALK_STEPS)
        return notVouchable(
          `${where} and the path of its ${target.what} has too many parts to follow`,
        );
      if (outside.has(current)) break;
      const id = await readOptional(() =>
        proc.lstatId(`/proc/${pid}/root${current}`),
      );
      if ("gone" in id) {
        if (steps !== 0 || target.magic === null)
          return notVouchable(
            `${where} and its ${target.what} ${current} cannot be found from its root`,
          );
        const placed = await placeByIdentity(
          proc,
          pid,
          target,
          ids.ids,
          command,
        );
        if (placed === null || !("cleared" in placed)) return placed;
        clearances.push(...placed.cleared);
        break;
      }
      if ("failed" in id)
        return unreadable(`${where}, its ${target.what} ${current}`, id.failed);
      if (ids.ids.has(id.value))
        return { pid, command, through: target.through };
      walked.push(current);
      if (current === "/") break;
      current = path.posix.dirname(current);
    }
    for (const done of walked) outside.add(done);
  }
  return clearances.length > 0 ? { cleared: clearances } : null;
}

async function scanOwnProcess(
  proc: ProcReader,
  pid: number,
  base: string,
  directory: string,
  mountNamespace: string,
  command: string | null,
  tree: TreeIdsReader,
): Promise<ProcessResult> {
  const mount = await readOptional(() => proc.readlink(`${base}/ns/mnt`));
  if ("gone" in mount) return null;
  if ("failed" in mount)
    return unreadable(`process ${pid} mount namespace`, mount.failed);
  if (mount.value !== mountNamespace)
    return reachesWorktree(proc, pid, base, command, tree);
  const root = await readOptional(() => proc.readlink(`${base}/root`));
  if ("gone" in root) return null;
  if ("failed" in root)
    return unreadable(`process ${pid} root folder`, root.failed);
  if (root.value !== "/")
    return notVouchable(`process ${pid} runs under a different root folder`);

  const tasks = await readOptional(() => proc.readdir(`${base}/task`));
  if ("gone" in tasks) return null;
  if ("failed" in tasks)
    return unreadable(`process ${pid} tasks`, tasks.failed);
  for (const task of tasks.value) {
    const taskMount = await readOptional(() =>
      proc.readlink(`${base}/task/${task}/ns/mnt`),
    );
    if ("failed" in taskMount)
      return unreadable(
        `process ${pid} thread ${task} mount namespace`,
        taskMount.failed,
      );
    if ("value" in taskMount && taskMount.value !== mountNamespace)
      return reachesWorktree(proc, pid, base, command, tree);
    const found = await checkLink(
      proc,
      pid,
      "working folder",
      `${base}/task/${task}/cwd`,
      directory,
      "working folder",
      command,
    );
    if (found !== null) return found;
  }

  const exe = await checkLink(
    proc,
    pid,
    "program",
    `${base}/exe`,
    directory,
    "open file",
    command,
  );
  if (exe !== null) return exe;

  const descriptors = await readOptional(() => proc.readdir(`${base}/fd`));
  if ("gone" in descriptors) return null;
  if ("failed" in descriptors)
    return unreadable(`process ${pid} open files`, descriptors.failed);
  for (const descriptor of descriptors.value) {
    const found = await checkLink(
      proc,
      pid,
      "open file",
      `${base}/fd/${descriptor}`,
      directory,
      "open file",
      command,
    );
    if (found !== null) return found;
  }

  const maps = await readOptional(() => proc.readFile(`${base}/maps`));
  if ("gone" in maps) return null;
  if ("failed" in maps)
    return unreadable(`process ${pid} memory maps`, maps.failed);
  for (const line of maps.value.split("\n")) {
    const fields = line.split(/\s+/u);
    const permissions = fields[1] ?? "";
    const mapped = fields.slice(5).join(" ");
    if (
      permissions[1] === "w" &&
      permissions[3] === "s" &&
      mapped !== "" &&
      isUnder(mapped, directory)
    ) {
      return { pid, command, through: "mapped file" };
    }
  }
  return null;
}

interface LinuxVisibility {
  problem: string | null;
  mountNamespace: string;
  self: ProcessIdentity;
}

const NO_IDENTITY: ProcessIdentity = { uid: -1, gids: [] };

export async function linuxVisibilityProblem(
  proc: ProcReader = hostProc,
): Promise<LinuxVisibility> {
  const status = await readOptional(() => proc.readFile("/proc/self/status"));
  if (!("value" in status)) {
    return {
      problem: "the process list settings are unreadable",
      mountNamespace: "",
      self: NO_IDENTITY,
    };
  }
  const nspid = parseStatusNumbers(status.value, "NSpid");
  const uids = parseStatusNumbers(status.value, "Uid");
  const gids = parseStatusNumbers(status.value, "Groups") ?? [];
  const gid = parseStatusNumbers(status.value, "Gid");
  const self: ProcessIdentity = {
    uid: uids?.[0] ?? -1,
    gids: [...gids, ...(gid ?? [])],
  };
  if (nspid === null || self.uid < 0) {
    return {
      problem: "this process cannot tell which process namespace it is in",
      mountNamespace: "",
      self,
    };
  }
  if (nspid.length !== 1) {
    return {
      problem:
        "this process may not see every process (it runs in a nested process namespace)",
      mountNamespace: "",
      self,
    };
  }
  const ownMount = await readOptional(() => proc.readlink("/proc/self/ns/mnt"));
  if (!("value" in ownMount)) {
    return {
      problem: "this process cannot tell which mount namespace it is in",
      mountNamespace: "",
      self,
    };
  }
  const ownRoot = await readOptional(() => proc.readlink("/proc/self/root"));
  if (!("value" in ownRoot) || ownRoot.value !== "/") {
    return {
      problem: "this process runs under a different root folder",
      mountNamespace: ownMount.value,
      self,
    };
  }
  const mounts = await readOptional(() =>
    proc.readFile("/proc/self/mountinfo"),
  );
  if (!("value" in mounts)) {
    return {
      problem: "the process list settings are unreadable",
      mountNamespace: ownMount.value,
      self,
    };
  }
  for (const line of mounts.value.split("\n")) {
    const fields = line.split(" ");
    if (fields[4] !== "/proc") continue;
    const options = line.slice(line.indexOf(" - ") + 3);
    const hidepid = /hidepid=([^,\s]+)/u.exec(options);
    if (hidepid === null || hidepid[1] === "0" || hidepid[1] === "off")
      continue;
    const group = /gid=(\d+)/u.exec(options);
    if (group !== null && self.gids.includes(Number(group[1]))) continue;
    return {
      problem: "the process list is hidden from this user",
      mountNamespace: ownMount.value,
      self,
    };
  }
  return { problem: null, mountNamespace: ownMount.value, self };
}

export async function scanLinux(
  directory: string,
  proc: ProcReader = hostProc,
  ownPid: number = process.pid,
  limits: { maxDirectories: number } = { maxDirectories: MAX_TREE_DIRECTORIES },
): Promise<WorktreeHolderScan> {
  const visibility = await linuxVisibilityProblem(proc);
  if (visibility.problem !== null) {
    return { status: "unknown", reason: visibility.problem };
  }
  const listing = await readOptional(() => proc.readdir("/proc"));
  if (!("value" in listing)) {
    return { status: "unknown", reason: "the process list is unreadable" };
  }
  const pids = listing.value
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number)
    .filter((pid) => pid !== ownPid);
  const holders: WorktreeHolder[] = [];
  const unknown: string[] = [];
  const clearances: FallbackClearance[] = [];
  const agentClearances: AgentClearance[] = [];
  let listed: Promise<TreeIds> | null = null;
  const tree: TreeIdsReader = () => {
    listed ??= listTreeIds(proc, directory, limits.maxDirectories);
    return listed;
  };
  let created: Promise<Read<number | null>> | null = null;
  let booted: Promise<Read<number>> | null = null;
  const context: ScanContext = {
    tree,
    creationMs: () => {
      created ??= readOptional(() => proc.creationMs(directory));
      return created;
    },
    bootMs: () => {
      booted ??= readOptional(async () => {
        const stat = await proc.readFile("/proc/stat");
        const boot = /^btime (\d+)$/mu.exec(stat)?.[1];
        if (boot === undefined) throw new Error("no btime");
        return Number(boot) * 1000;
      });
      return booted;
    },
  };
  for (let offset = 0; offset < pids.length; offset += LINUX_SCAN_CONCURRENCY) {
    const batch = pids.slice(offset, offset + LINUX_SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map((pid) =>
        scanLinuxProcess(
          proc,
          pid,
          directory,
          visibility.mountNamespace,
          visibility.self,
          context,
        ),
      ),
    );
    for (const result of results) {
      if (result === null) continue;
      if ("agent" in result) {
        agentClearances.push(result.agent);
        continue;
      }
      if ("cleared" in result) {
        clearances.push(...result.cleared);
        continue;
      }
      if ("otherUser" in result || "helper" in result) continue;
      if ("unknown" in result) unknown.push(result.unknown);
      else holders.push(result);
    }
  }
  if (holders.length > 0) return { status: "held", holders };
  if (unknown.length > 0) {
    return {
      status: "unknown",
      reason: `${unknown.length} processes could not be inspected, such as ${unknown[0]}`,
    };
  }
  return clearances.length > 0 || agentClearances.length > 0
    ? {
        status: "clear",
        ...(clearances.length > 0 ? { clearances } : {}),
        ...(agentClearances.length > 0 ? { agentClearances } : {}),
      }
    : { status: "clear" };
}

function runLsof(directory: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
}> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-n", "-F", "pcn", "+D", directory],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, spawnFailed: false });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        resolve({
          code: typeof code === "number" ? code : null,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          spawnFailed: typeof code !== "number",
        });
      },
    );
  });
}

async function scanWithLsof(directory: string): Promise<WorktreeHolderScan> {
  const result = await runLsof(directory);
  if (result.spawnFailed) {
    return { status: "unknown", reason: "lsof could not be run" };
  }
  const holders = new Map<number, WorktreeHolder>();
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      command = null;
    } else if (line.startsWith("c")) {
      command = line.slice(1) || null;
    } else if (line.startsWith("n") && pid !== null && pid !== process.pid) {
      if (!holders.has(pid)) {
        holders.set(pid, {
          pid,
          command,
          through: isUnder(line.slice(1), directory)
            ? "open file"
            : "working folder",
        });
      }
    }
  }
  if (holders.size > 0)
    return { status: "held", holders: [...holders.values()] };
  return {
    status: "unknown",
    reason: "lsof cannot prove it sees every process",
  };
}

export async function scanWorktreeHolders(
  directory: string,
): Promise<WorktreeHolderScan> {
  if (process.platform === "linux") return scanLinux(directory, activeProc);
  if (process.platform === "win32") {
    return {
      status: "unknown",
      reason: "this platform cannot list the programs using a folder",
    };
  }
  return scanWithLsof(directory);
}

export function describeHolderScan(scan: WorktreeHolderScan): string | null {
  if (scan.status === "clear") return null;
  if (scan.status === "unknown") {
    return `could not check which programs are using it (${scan.reason}), so it was kept`;
  }
  const shown = scan.holders
    .slice(0, 5)
    .map(
      (holder) =>
        `${holder.command ?? "a process"} (pid ${holder.pid}, ${holder.through})`,
    )
    .join(", ");
  const more =
    scan.holders.length > 5 ? `, and ${scan.holders.length - 5} more` : "";
  return `is in use by ${shown}${more}; bb does not stop other programs, so ask whoever runs them to finish and close them`;
}
