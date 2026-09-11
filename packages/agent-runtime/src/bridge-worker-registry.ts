import { execFile, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { BRIDGE_SHUTDOWN_METHOD } from "@bb/provider-bridge-protocol/bridge-kit";
import { workspaceProvisionTypeSchema } from "@bb/domain";
import { z } from "zod";

const bridgeWorkerWorkspaceSchema = z.object({
  workspacePath: z.string().min(1),
  workspaceProvisionType: workspaceProvisionTypeSchema,
  personalWorkspaceRoot: z.string().min(1).nullable(),
});

export type BridgeWorkerWorkspace = z.infer<typeof bridgeWorkerWorkspaceSchema>;

const bridgeWorkerThreadSchema = z.object({
  providerThreadId: z.string().min(1).nullable(),
  activeTurnId: z.string().min(1).nullable(),
  activeProviderTurnId: z.string().min(1).nullable(),
  config: z.record(z.string(), z.unknown()),
});

export type BridgeWorkerThread = z.infer<typeof bridgeWorkerThreadSchema>;

const bridgeWorkerRegistryEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]+$/u),
  formatVersion: z.number().int(),
  pid: z.number().int().positive(),
  processIdentity: z.string().min(1),
  socketPath: z.string().min(1),
  pluginId: z.string().min(1),
  providerId: z.string().min(1),
  processKey: z.string().min(1),
  environmentId: z.string().min(1),
  bridgeProtocolVersion: z.number().int(),
  transportVersion: z.number().int(),
  startedAt: z.string().min(1),
  workspace: bridgeWorkerWorkspaceSchema,
  threads: z.record(z.string().min(1), bridgeWorkerThreadSchema),
});

export type BridgeWorkerRegistryEntry = z.infer<
  typeof bridgeWorkerRegistryEntrySchema
>;

const ENTRY_SUFFIX = ".json";
const SOCKET_DIRECTORY_DIGEST_CHARS = 16;

export const BRIDGE_WORKER_REGISTRY_FORMAT_VERSION = 1 as const;

export function fallbackSocketRoot(uid: number): string {
  return `/tmp/bb-${uid}`;
}

export function socketDirectoryFor(root: string, workerDir: string): string {
  const digest = createHash("sha256").update(workerDir).digest("hex");
  return join(root, digest.slice(0, SOCKET_DIRECTORY_DIGEST_CHARS));
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export function privateDirectoryProblem(
  path: string,
  uid: number,
): string | null {
  const stat = lstatOrNull(path);
  if (stat === null) return "it does not exist";
  if (stat.isSymbolicLink()) return "it is a symlink";
  if (!stat.isDirectory()) return "it is not a directory";
  if (stat.uid !== uid) {
    return `it is owned by uid ${stat.uid}, not the current user (${uid})`;
  }
  if ((stat.mode & 0o077) !== 0) {
    return `it has mode ${(stat.mode & 0o777).toString(8)}, not 700`;
  }
  return null;
}

function isTrustedSocketPath(
  dir: string,
  id: string,
  socketPath: string,
): boolean {
  if (process.platform === "win32") {
    return socketPath === `\\\\.\\pipe\\bb-bridge-worker-${id}`;
  }
  if (lstatOrNull(socketPath)?.isSymbolicLink() === true) return false;
  const name = `${id}.sock`;
  if (socketPath === join(dir, name)) return true;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const root = fallbackSocketRoot(uid);
  const fallbackDir = socketDirectoryFor(root, dir);
  return (
    socketPath === join(fallbackDir, name) &&
    privateDirectoryProblem(root, uid) === null &&
    privateDirectoryProblem(fallbackDir, uid) === null
  );
}

function entryPath(dir: string, id: string): string {
  return join(dir, `${id}${ENTRY_SUFFIX}`);
}

export function writeBridgeWorkerEntry(
  dir: string,
  entry: BridgeWorkerRegistryEntry,
): void {
  const target = entryPath(dir, entry.id);
  const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
  try {
    renameSync(temporary, target);
  } catch (error) {
    removeIfPresent(temporary);
    throw error;
  }
}

export function removeBridgeWorkerFiles(args: {
  dir: string;
  id: string;
  socketPath: string;
}): void {
  removeIfPresent(entryPath(args.dir, args.id));
  removeIfPresent(join(args.dir, `${args.id}.log`));
  removeIfPresent(join(args.dir, `${args.id}.buf`));
  if (!args.socketPath.startsWith("\\\\")) removeIfPresent(args.socketPath);
}

export interface InvalidBridgeWorkerEntry {
  id: string;
  socketPath: string | null;
}

export function readBridgeWorkerEntries(dir: string): {
  entries: BridgeWorkerRegistryEntry[];
  invalid: InvalidBridgeWorkerEntry[];
} {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { entries: [], invalid: [] };
  }
  const entries: BridgeWorkerRegistryEntry[] = [];
  const invalid: InvalidBridgeWorkerEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(ENTRY_SUFFIX)) continue;
    const id = name.slice(0, -ENTRY_SUFFIX.length);
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const parsed = bridgeWorkerRegistryEntrySchema.safeParse(raw);
      if (
        parsed.success &&
        parsed.data.id === id &&
        isTrustedSocketPath(dir, id, parsed.data.socketPath)
      ) {
        entries.push(parsed.data);
        continue;
      }
    } catch {}
    invalid.push({ id, socketPath: salvagedSocketPath(dir, id, raw) });
  }
  return { entries, invalid };
}

function salvagedSocketPath(
  dir: string,
  id: string,
  raw: unknown,
): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const socketPath: unknown = Reflect.get(raw, "socketPath");
  if (typeof socketPath !== "string") return null;
  return isTrustedSocketPath(dir, id, socketPath) ? socketPath : null;
}

const execFileAsync = promisify(execFile);
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const DARWIN_PS_PATH = "/bin/ps";
const LINUX_STAT_START_TIME_FIELD = 19;

function darwinPsArgs(pid: number): string[] {
  return ["-o", "lstart=", "-p", String(pid)];
}

function darwinProcessIdentity(psOutput: string): string | null {
  const started = psOutput.trim();
  return started === "" ? null : `darwin:${started}`;
}

function linuxProcessIdentity(stat: string, bootId: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTime = fields[LINUX_STAT_START_TIME_FIELD];
  return startTime === undefined || startTime === ""
    ? null
    : `linux:${bootId.trim()}:${startTime}`;
}

export function readProcessIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return linuxProcessIdentity(
        readFileSync(`/proc/${pid}/stat`, "utf8"),
        readFileSync(LINUX_BOOT_ID_PATH, "utf8"),
      );
    } catch {
      return null;
    }
  }
  if (process.platform !== "darwin") return null;
  const result = spawnSync(DARWIN_PS_PATH, darwinPsArgs(pid), {
    encoding: "utf8",
    env: { LC_ALL: "C" },
  });
  return result.status === 0 ? darwinProcessIdentity(result.stdout) : null;
}

export async function readProcessIdentityAsync(
  pid: number,
): Promise<string | null> {
  if (process.platform !== "darwin") return readProcessIdentity(pid);
  try {
    const { stdout } = await execFileAsync(DARWIN_PS_PATH, darwinPsArgs(pid), {
      encoding: "utf8",
      env: { LC_ALL: "C" },
    });
    return darwinProcessIdentity(stdout);
  } catch {
    return null;
  }
}

export function isBridgeWorkerAlive(
  entry: Pick<BridgeWorkerRegistryEntry, "pid" | "processIdentity">,
): boolean {
  return readProcessIdentity(entry.pid) === entry.processIdentity;
}

export function reapDeadBridgeWorkers(
  dir: string,
  isAlive: (
    entry: BridgeWorkerRegistryEntry,
  ) => boolean = isBridgeWorkerAlive,
): {
  live: BridgeWorkerRegistryEntry[];
  reaped: BridgeWorkerRegistryEntry[];
  retirable: { id: string; socketPath: string }[];
} {
  const { entries, invalid } = readBridgeWorkerEntries(dir);
  const retirable: { id: string; socketPath: string }[] = [];
  for (const item of invalid) {
    const socketPath = item.socketPath;
    if (socketPath !== null) {
      retirable.push({ id: item.id, socketPath });
      continue;
    }
    removeIfPresent(entryPath(dir, item.id));
    removeIfPresent(join(dir, `${item.id}.log`));
    removeIfPresent(join(dir, `${item.id}.buf`));
  }
  const live: BridgeWorkerRegistryEntry[] = [];
  const reaped: BridgeWorkerRegistryEntry[] = [];
  for (const entry of entries) {
    if (isAlive(entry)) {
      live.push(entry);
      continue;
    }
    removeBridgeWorkerFiles({
      dir,
      id: entry.id,
      socketPath: entry.socketPath,
    });
    reaped.push(entry);
  }
  return { live, reaped, retirable };
}

export async function retireBridgeWorker(args: {
  dir: string;
  id: string;
  socketPath: string;
  timeoutMs: number;
}): Promise<"retired" | "unreachable"> {
  const outcome = await new Promise<"retired" | "unreachable">((resolve) => {
    const socket = connect(args.socketPath);
    let requested = false;
    const timer = setTimeout(() => socket.destroy(), args.timeoutMs);
    socket.once("connect", () => {
      requested = true;
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: BRIDGE_SHUTDOWN_METHOD })}\n`,
      );
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(requested ? "retired" : "unreachable");
    });
  });
  removeBridgeWorkerFiles({
    dir: args.dir,
    id: args.id,
    socketPath: args.socketPath,
  });
  return outcome;
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
