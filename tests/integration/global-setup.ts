import fs from "node:fs/promises";
import path from "node:path";
import { listOpenFilePids, readPositivePidFile } from "@bb/test-helpers";
import { isNodeError, removePathWithRetry } from "./helpers/remove-path.js";
import { integrationTmpBase } from "./helpers/tmp-base.js";

const INTEGRATION_TMP_PREFIX = "bb-integration-";
const STALE_TMP_ROOT_AGE_MS = 60 * 60_000;

function isProcessAlive(pid: number): boolean {
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

async function cleanupTmpRoot(tmpRoot: string): Promise<void> {
  const openFilePids = new Set(await listOpenFilePids(tmpRoot));
  for (const pid of openFilePids) {
    await killProcess(pid).catch(() => undefined);
  }
  await removePathWithRetry(tmpRoot);
}

async function listIntegrationTmpRoots(): Promise<string[]> {
  const entries = await fs.readdir(integrationTmpBase(), {
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(INTEGRATION_TMP_PREFIX),
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

    const parentPid = await readPositivePidFile(
      path.join(tmpRoot, "parent.pid"),
    );
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
