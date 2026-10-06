const DOWNLOAD_RETRY_DELAYS = [500, 1500];

function isChunkDownloadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)/i.test(
      error.message,
    )
  );
}

export async function loadChunkWithRetries<T>(
  load: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      const delay = DOWNLOAD_RETRY_DELAYS[attempt];
      if (delay === undefined || !isChunkDownloadError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function createRetryableChunkImport<T>(load: () => Promise<T>) {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= loadChunkWithRetries(load).catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
