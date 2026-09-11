import fs from "node:fs/promises";
import path from "node:path";
import { isNodeError, removePathWithRetry } from "./helpers/remove-path.js";
import {
  HARNESS_TMP_ROOT_PREFIX,
  integrationTmpBase,
} from "./helpers/tmp-base.js";
import {
  isProcessAlive,
  killProcessesHoldingFilesUnder,
} from "./helpers/tmp-root-processes.js";

const STALE_TMP_ROOT_AGE_MS = 60 * 60_000;

async function readParentPid(tmpRoot: string): Promise<number | null> {
  try {
    const rawPid = await fs.readFile(path.join(tmpRoot, "parent.pid"), "utf8");
    const pid = Number.parseInt(rawPid.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function cleanupTmpRoot(tmpRoot: string): Promise<void> {
  await killProcessesHoldingFilesUnder(tmpRoot, { exclude: [] });
  await removePathWithRetry(tmpRoot);
}

async function listIntegrationTmpRoots(): Promise<string[]> {
  const entries = await fs.readdir(integrationTmpBase(), {
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(HARNESS_TMP_ROOT_PREFIX),
    )
    .map((entry) => path.join(integrationTmpBase(), entry.name));
}

async function sweepIntegrationTmpRoots(minAgeMs: number): Promise<void> {
  const now = Date.now();
  for (const tmpRoot of await listIntegrationTmpRoots()) {
    const metadata = await fs.stat(tmpRoot).catch(() => null);
    if (!metadata || now - metadata.mtimeMs < minAgeMs) {
      continue;
    }

    const parentPid = await readParentPid(tmpRoot);
    if (parentPid && isProcessAlive(parentPid)) {
      continue;
    }

    await cleanupTmpRoot(tmpRoot).catch(() => undefined);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await sweepIntegrationTmpRoots(STALE_TMP_ROOT_AGE_MS);
  return () => sweepIntegrationTmpRoots(0);
}
