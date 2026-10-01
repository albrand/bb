import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));

vi.mock("node:fs/promises", () => ({ open: openMock }));

import {
  claudeMcpConfigPaths,
  claudeMcpConfigSignature,
} from "./mcp-config-signature.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("bounds stalled config reads and does not keep later calls waiting on them", async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-stall-"));
  tempDirs.push(home);
  const cwd = join(home, "project");
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
  const watchedPath = join(cwd, ".mcp.json");
  let releaseRead = (): void => {};
  const readGate = new Promise<void>((resolveRead) => {
    releaseRead = resolveRead;
  });
  const close = vi.fn(async () => {});
  let targetOpenCount = 0;
  openMock.mockImplementation(async (path: string) => {
    if (path !== watchedPath) {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    targetOpenCount += 1;
    const isStalledRead = targetOpenCount === 1;
    return {
      close,
      read: async (
        buffer: Buffer,
        offset: number,
      ): Promise<{ bytesRead: number }> => {
        if (isStalledRead) await readGate;
        buffer[offset] = 123;
        return { bytesRead: 1 };
      },
      stat: async () => ({ isFile: () => true, size: 1 }),
    };
  });
  const signature = () =>
    claudeMcpConfigSignature({ cwd, env, deadlineMs: 250 });

  expect(claudeMcpConfigPaths({ cwd, env })).toContain(watchedPath);
  const first = await signature();
  expect(first).toMatch(/^unhashed:/);
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  const second = await signature();
  expect(second).not.toMatch(/^unhashed:/);
  expect(targetOpenCount).toBe(2);

  releaseRead();
});
