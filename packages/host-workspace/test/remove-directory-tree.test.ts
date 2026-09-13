import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  removeDirectoryTree,
  WORKSPACE_REMOVAL_MAX_RETRIES,
  WORKSPACE_REMOVAL_RETRY_DELAY_MS,
} from "../src/remove-directory-tree.js";

describe("removeDirectoryTree", () => {
  it("removes a nested tree that mirrors a built app bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-remove-"));
    const resources = join(
      root,
      "out/App-darwin-arm64/App.app/Contents/Resources",
    );
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "app.asar"), "x");
    await removeDirectoryTree(root);
    expect(existsSync(root)).toBe(false);
  });

  it("is a no-op on a path that is already gone", async () => {
    await expect(
      removeDirectoryTree(join(tmpdir(), "bb-remove-missing-never-created")),
    ).resolves.toBeUndefined();
  });

  it("asks node to retry, which is what ENOTEMPTY needs", async () => {
    vi.resetModules();
    const calls: unknown[] = [];
    vi.doMock("node:fs/promises", () => ({
      rm: (path: string, options: unknown) => {
        calls.push([path, options]);
        return Promise.resolve();
      },
    }));
    const fresh = await import("../src/remove-directory-tree.js");
    await fresh.removeDirectoryTree("/tmp/bb-remove-probe");
    expect(calls).toEqual([
      [
        "/tmp/bb-remove-probe",
        {
          recursive: true,
          force: true,
          maxRetries: WORKSPACE_REMOVAL_MAX_RETRIES,
          retryDelay: WORKSPACE_REMOVAL_RETRY_DELAY_MS,
        },
      ],
    ]);
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });
});
