import fs from "node:fs/promises";
import path from "node:path";
import { readPositivePidFile } from "@bb/test-helpers";
import { removePathWithRetry } from "./helpers/remove-path.js";
import { integrationTmpBase } from "./helpers/tmp-base.js";
import {
  isProcessAlive,
  killProcessesHoldingFilesUnder,
} from "./helpers/tmp-root-processes.js";

const INTEGRATION_TMP_PREFIX = "bb-integration-";
const STALE_TMP_ROOT_AGE_MS = 60 * 60_000;

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
