import { BbHttpError, type BbSdk } from "@bb/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  describeThreadStorageDeletion,
  readThreadStorageDeletion,
  waitForThreadStorageDeletion,
} from "./storage-deletion.js";

type Recorded = { deletedAt: number | null; keptReason: string | null };

function sdkAnswering(answers: (Recorded | "gone")[]): BbSdk {
  const next = vi.fn(async () => {
    const answer = answers.shift() ?? "gone";
    if (answer === "gone")
      throw new BbHttpError({
        status: 404,
        code: "thread_not_found",
        message: "Thread not found",
        body: null,
      });
    return answer;
  });
  return { threads: { storageDeletion: next } } as unknown as BbSdk;
}

describe("thread storage deletion", () => {
  it("reads a deleted thread whose files are kept, naming why", async () => {
    const sdk = sdkAnswering([
      { deletedAt: 1, keptReason: "pid 4242 holds it" },
    ]);

    expect(await readThreadStorageDeletion(sdk, "thr_a")).toEqual({
      state: "kept",
      reason: "pid 4242 holds it",
    });
  });

  it("reads a deleted thread whose files are still being removed", async () => {
    const sdk = sdkAnswering([{ deletedAt: 1, keptReason: null }]);

    expect(await readThreadStorageDeletion(sdk, "thr_a")).toEqual({
      state: "removing",
    });
  });

  it("reads a thread that is gone as removed, and passes any other failure on", async () => {
    expect(
      await readThreadStorageDeletion(sdkAnswering(["gone"]), "thr_a"),
    ).toEqual({
      state: "removed",
    });
    const failing = {
      threads: {
        storageDeletion: async () => {
          throw new BbHttpError({
            status: 500,
            code: null,
            message: "boom",
            body: null,
          });
        },
      },
    } as unknown as BbSdk;
    await expect(readThreadStorageDeletion(failing, "thr_a")).rejects.toThrow(
      "boom",
    );
  });

  it("waits while the files are being removed, and stops at the first kept reason or removal", async () => {
    const removing: Recorded = { deletedAt: 1, keptReason: null };

    expect(
      await waitForThreadStorageDeletion(
        sdkAnswering([removing, removing, "gone"]),
        "thr_a",
        5_000,
      ),
    ).toEqual({ state: "removed" });
    expect(
      await waitForThreadStorageDeletion(
        sdkAnswering([removing, { deletedAt: 1, keptReason: "pid 1" }]),
        "thr_a",
        5_000,
      ),
    ).toEqual({ state: "kept", reason: "pid 1" });
  });

  it("gives up at its bound and says the files are still being removed", async () => {
    const removing: Recorded = { deletedAt: 1, keptReason: null };

    expect(
      await waitForThreadStorageDeletion(
        sdkAnswering(Array.from({ length: 20 }, () => removing)),
        "thr_a",
        0,
      ),
    ).toEqual({ state: "removing" });
  });

  it("describes each state for a person", () => {
    expect(
      describeThreadStorageDeletion("thr_a", { state: "removed" }),
    ).toContain("files are removed");
    expect(
      describeThreadStorageDeletion("thr_a", {
        state: "kept",
        reason: "pid 4242",
      }),
    ).toContain("kept: pid 4242");
    expect(
      describeThreadStorageDeletion("thr_a", { state: "removing" }),
    ).toContain("being removed");
  });
});
