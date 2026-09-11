import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { isNodeError } from "./remove-path.js";

const execFile = promisify(execFileCallback);

function isExecExitCodeOne(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return Reflect.get(error, "code") === 1;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function killProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!isProcessAlive(pid)) {
    return;
  }

  process.kill(pid, "SIGKILL");
}

async function listOpenFilePids(tmpRoot: string): Promise<number[]> {
  let stdout: string;
  try {
    stdout = (
      await execFile("lsof", ["-t", "+D", tmpRoot], { encoding: "utf8" })
    ).stdout;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    if (!isExecExitCodeOne(error)) {
      throw error;
    }
    const partial =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "stdout")
        : undefined;
    stdout = typeof partial === "string" ? partial : "";
  }
  return stdout
    .split("\n")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export async function killProcessesHoldingFilesUnder(
  root: string,
  options: { exclude: readonly number[] },
): Promise<void> {
  const excluded = new Set(options.exclude);
  for (const pid of new Set(await listOpenFilePids(root))) {
    if (excluded.has(pid)) continue;
    await killProcess(pid).catch(() => undefined);
  }
}
