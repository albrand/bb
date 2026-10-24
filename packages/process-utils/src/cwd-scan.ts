import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { resolveSweepDirectory } from "./cwd-processes.js";
import { spawnPortableOutputProcess } from "./spawn.js";

export interface CwdHolder {
  pid: number;
  cwd: string;
}

export interface CwdUnvouchedHelper {
  pid: number;
  comm: string;
}

export interface CwdScanCoverage {
  excludedOtherUsers: number | null;
  unvouchedHelpers: CwdUnvouchedHelper[] | null;
}

export const UNREADABLE_SAME_USER_HELPER_COMMS: ReadonlySet<string> = new Set([
  "systemd",
  "(sd-pam)",
  "ssh-agent",
  "sshd",
  "sshd-session",
  "gpg-agent",
  "dbus-daemon",
]);

export type CwdHolderScan =
  | ({ status: "clear" } & CwdScanCoverage)
  | ({ status: "held"; holders: CwdHolder[] } & CwdScanCoverage)
  | { status: "unknown"; reason: string };

export interface CwdScanIo {
  platform: NodeJS.Platform;
  uid: number | null;
  selfPid: number;
  listProcessIds(): Promise<string[]>;
  readCwd(pid: number): Promise<string>;
  ownerUid(pid: number): Promise<number>;
  readComm(pid: number): Promise<string>;
  runLsof(
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const GONE = new Set(["ENOENT", "ESRCH", "ENOTDIR"]);

function codeOf(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "";
}

function isUnder(candidate: string, directory: string): boolean {
  const normalized = candidate.endsWith(" (deleted)")
    ? candidate.slice(0, -" (deleted)".length)
    : candidate;
  return (
    normalized === directory || normalized.startsWith(`${directory}/`)
  );
}

const defaultIo: CwdScanIo = {
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  selfPid: process.pid,
  listProcessIds: () => readdir("/proc"),
  readCwd: (pid) => readlink(`/proc/${pid}/cwd`),
  ownerUid: async (pid) => (await stat(`/proc/${pid}`)).uid,
  readComm: async (pid) => {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    if (open === -1 || close <= open)
      throw Object.assign(new Error("unparsable stat"), { code: "EINVAL" });
    return text.slice(open + 1, close);
  },
  runLsof: (timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = spawnPortableOutputProcess({
        command: "lsof",
        args: ["-a", "-d", "cwd", "-F", "pn", "-n"],
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const errChunks: Buffer[] = [];
      child.stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("lsof timed out"));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(chunks).toString("utf8"),
          stderr: Buffer.concat(errChunks).toString("utf8"),
        });
      });
    }),
};

export async function scanProcessesWithCwdUnder(
  args: { directories: readonly string[]; timeoutMs?: number },
  io: CwdScanIo = defaultIo,
): Promise<CwdHolderScan> {
  if (io.platform === "win32") {
    return {
      status: "unknown",
      reason: "working directories of processes cannot be listed on Windows",
    };
  }
  const directories: string[] = [];
  for (const directory of args.directories) {
    const resolved = await resolveSweepDirectory(directory);
    if (resolved === null) {
      return {
        status: "unknown",
        reason: `${directory} is a symbolic link, so which folder it names cannot be vouched for`,
      };
    }
    directories.push(resolved);
  }
  const holders: CwdHolder[] = [];
  if (io.platform === "linux") {
    let entries: string[];
    try {
      entries = await io.listProcessIds();
    } catch (error) {
      return {
        status: "unknown",
        reason: `the process list could not be read (${codeOf(error) || "error"})`,
      };
    }
    let excluded = 0;
    const unvouchedHelpers: CwdUnvouchedHelper[] = [];
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      if (pid === io.selfPid) continue;
      let cwd: string;
      try {
        cwd = await io.readCwd(pid);
      } catch (error) {
        const code = codeOf(error);
        if (GONE.has(code)) continue;
        if (code === "EACCES" || code === "EPERM") {
          let owner: number;
          try {
            owner = await io.ownerUid(pid);
          } catch (ownerError) {
            if (GONE.has(codeOf(ownerError))) continue;
            return {
              status: "unknown",
              reason: `the owner of process ${pid} could not be read`,
            };
          }
          if (io.uid !== null && owner !== io.uid) {
            excluded += 1;
            continue;
          }
          if (io.uid !== null) {
            let comm: string;
            try {
              comm = await io.readComm(pid);
            } catch (commError) {
              if (GONE.has(codeOf(commError))) continue;
              return {
                status: "unknown",
                reason: `the working directory of process ${pid} could not be read and its name could not be read either`,
              };
            }
            if (UNREADABLE_SAME_USER_HELPER_COMMS.has(comm)) {
              unvouchedHelpers.push({ pid, comm });
              continue;
            }
            return {
              status: "unknown",
              reason: `the working directory of process ${pid} (${comm}) could not be read and it is not a known session helper`,
            };
          }
        }
        return {
          status: "unknown",
          reason: `the working directory of process ${pid} could not be read (${code || "error"})`,
        };
      }
      if (directories.some((directory) => isUnder(cwd, directory)))
        holders.push({ pid, cwd });
    }
    const coverage = { excludedOtherUsers: excluded, unvouchedHelpers };
    return holders.length > 0
      ? { status: "held", holders, ...coverage }
      : { status: "clear", ...coverage };
  }
  let output: { code: number | null; stdout: string; stderr: string };
  try {
    output = await io.runLsof(args.timeoutMs ?? 30_000);
  } catch (error) {
    return {
      status: "unknown",
      reason: `lsof failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (output.code !== 0 && output.code !== 1) {
    return {
      status: "unknown",
      reason: `lsof exited with ${output.code === null ? "a signal" : `code ${output.code}`}`,
    };
  }
  if (output.stderr.trim() !== "") {
    return {
      status: "unknown",
      reason: `lsof exited with code ${output.code} and reported: ${output.stderr.trim().split("\n")[0]}`,
    };
  }
  let pid: number | null = null;
  for (const line of output.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) {
      const cwd = line.slice(1);
      if (pid !== io.selfPid && directories.some((d) => isUnder(cwd, d)))
        holders.push({ pid, cwd });
    }
  }
  const coverage = { excludedOtherUsers: null, unvouchedHelpers: null };
  return holders.length > 0
    ? { status: "held", holders, ...coverage }
    : { status: "clear", ...coverage };
}
