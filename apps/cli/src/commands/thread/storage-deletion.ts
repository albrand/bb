import { BbHttpError, type BbSdk } from "@bb/sdk";

export type ThreadStorageDeletionOutcome =
  | { state: "removed" }
  | { state: "kept"; reason: string }
  | { state: "removing" };

const POLL_INTERVAL_MS = 500;
export const STORAGE_DELETION_WAIT_MS = 30_000;

export async function readThreadStorageDeletion(
  sdk: BbSdk,
  threadId: string,
): Promise<ThreadStorageDeletionOutcome> {
  try {
    const recorded = await sdk.threads.storageDeletion({ threadId });
    return recorded.keptReason === null
      ? { state: "removing" }
      : { state: "kept", reason: recorded.keptReason };
  } catch (error) {
    if (error instanceof BbHttpError && error.status === 404) {
      return { state: "removed" };
    }
    throw error;
  }
}

export async function waitForThreadStorageDeletion(
  sdk: BbSdk,
  threadId: string,
  timeoutMs: number = STORAGE_DELETION_WAIT_MS,
): Promise<ThreadStorageDeletionOutcome> {
  const deadline = Date.now() + timeoutMs;
  let outcome = await readThreadStorageDeletion(sdk, threadId);
  while (outcome.state === "removing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    outcome = await readThreadStorageDeletion(sdk, threadId);
  }
  return outcome;
}

export function describeThreadStorageDeletion(
  threadId: string,
  outcome: ThreadStorageDeletionOutcome,
): string {
  if (outcome.state === "removed")
    return `Thread ${threadId} was deleted and its files are removed`;
  if (outcome.state === "kept")
    return `Thread ${threadId} was deleted. Its files are kept: ${outcome.reason}`;
  return `Thread ${threadId} was deleted. Its files are being removed`;
}
