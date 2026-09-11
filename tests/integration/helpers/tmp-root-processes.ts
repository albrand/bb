import { listOpenFilePids } from "@bb/test-helpers";
import { isNodeError } from "./remove-path.js";

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
