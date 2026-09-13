import { rm } from "node:fs/promises";

export const WORKSPACE_REMOVAL_MAX_RETRIES = 5;
export const WORKSPACE_REMOVAL_RETRY_DELAY_MS = 100;

export async function removeDirectoryTree(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: WORKSPACE_REMOVAL_MAX_RETRIES,
    retryDelay: WORKSPACE_REMOVAL_RETRY_DELAY_MS,
  });
}
