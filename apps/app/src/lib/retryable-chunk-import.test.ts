import { afterEach, describe, expect, it, vi } from "vitest";
import { createRetryableChunkImport } from "./retryable-chunk-import";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRetryableChunkImport", () => {
  it("retries a rejected import and caches the successful module", async () => {
    vi.useFakeTimers();
    const module = { value: "loaded" };
    const load = vi
      .fn<() => Promise<typeof module>>()
      .mockRejectedValueOnce(
        new Error("Failed to fetch dynamically imported module"),
      )
      .mockResolvedValue(module);
    const importChunk = createRetryableChunkImport(load);

    const result = importChunk();
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBe(module);
    await expect(importChunk()).resolves.toBe(module);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries a later request after all download retries fail", async () => {
    vi.useFakeTimers();
    const module = { value: "loaded" };
    const load = vi
      .fn<() => Promise<typeof module>>()
      .mockRejectedValueOnce(
        new Error("Failed to fetch dynamically imported module"),
      )
      .mockRejectedValueOnce(
        new Error("Failed to fetch dynamically imported module"),
      )
      .mockRejectedValueOnce(
        new Error("Failed to fetch dynamically imported module"),
      )
      .mockResolvedValue(module);
    const importChunk = createRetryableChunkImport(load);

    const failed = importChunk();
    const rejection = expect(failed).rejects.toThrow(
      "Failed to fetch dynamically imported module",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;

    await expect(importChunk()).resolves.toBe(module);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
