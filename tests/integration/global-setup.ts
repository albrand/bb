import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isNodeError, removePathWithRetry } from "./helpers/remove-path.js";
import { integrationTmpBase } from "./helpers/tmp-base.js";

const execFile = promisify(execFileCallback);

const INTEGRATION_TMP_PREFIX = "bb-integration-";
const STALE_TMP_ROOT_AGE_MS = 60 * 60_000;

function isExecExitCodeOne(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return Reflect.get(error, "code") === 1;
}

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
