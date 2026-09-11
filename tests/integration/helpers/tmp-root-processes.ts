import { homedir } from "node:os";
import path from "node:path";
import { listOpenFilePids } from "@bb/test-helpers";
import { isNodeError } from "./remove-path.js";
import { HARNESS_TMP_ROOT_PREFIX, integrationTmpBase } from "./tmp-base.js";

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

export function assertHarnessTmpRoot(root: string): string {
  const resolved = path.resolve(root);
  const base = path.resolve(integrationTmpBase());
  const name = path.basename(resolved);
  const refused = new Set([path.parse(resolved).root, base, homedir()]);
  if (
    refused.has(resolved) ||
    path.dirname(resolved) !== base ||
    !name.startsWith(HARNESS_TMP_ROOT_PREFIX) ||
    name.length <= HARNESS_TMP_ROOT_PREFIX.length
  ) {
    throw new Error(
      `Refusing to kill processes under ${root}: not a harness temp root (${path.join(base, `${HARNESS_TMP_ROOT_PREFIX}*`)})`,
    );
  }
  return resolved;
}

export async function killProcessesHoldingFilesUnder(
  root: string,
  options: { exclude: readonly number[] },
): Promise<void> {
  root = assertHarnessTmpRoot(root);
  const excluded = new Set(options.exclude);
  for (const pid of new Set(await listOpenFilePids(root))) {
    if (excluded.has(pid)) continue;
    await killProcess(pid).catch(() => undefined);
  }
}
