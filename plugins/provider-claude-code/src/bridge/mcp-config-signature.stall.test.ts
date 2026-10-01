import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));

vi.mock("node:fs/promises", () => ({ open: openMock }));

import {
  claudeMcpConfigPaths,
  claudeMcpConfigSignature,
  loadClaudeMcpServers,
} from "./mcp-config-signature.js";

const tempDirs: string[] = [];
const releasePendingOperations: Array<() => void> = [];

afterEach(() => {
  for (const releaseOperation of releasePendingOperations.splice(0)) {
    releaseOperation();
  }
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
  const watchedPath = join(home, ".claude.json");
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
        return { bytesRead: buffer.write("{}", offset) };
      },
      stat: async () => ({ isFile: () => true, size: 2 }),
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

it.each(["open", "stat", "close"] as const)(
  "bounds a stalled config %s and retries with a fresh read",
  async (stalledOperation) => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-stall-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
    const watchedPath = join(home, ".claude.json");
    let releaseOperation = (): void => {};
    const operationGate = new Promise<void>((resolveOperation) => {
      releaseOperation = resolveOperation;
    });
    releasePendingOperations.push(releaseOperation);
    let targetOpenCount = 0;
    let firstDelayedOperationSettled = false;
    const close = vi.fn(async () => {
      if (stalledOperation === "close" && targetOpenCount === 1) {
        await operationGate;
        firstDelayedOperationSettled = true;
      }
    });
    openMock.mockImplementation(async (path: string) => {
      if (path !== watchedPath) {
        const error = new Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      targetOpenCount += 1;
      const isFirstOpen = targetOpenCount === 1;
      if (stalledOperation === "open" && isFirstOpen) {
        await operationGate;
      }
      return {
        close,
        read: async (buffer: Buffer, offset: number) => {
          return { bytesRead: buffer.write("{}", offset) };
        },
        stat: async () => {
          if (stalledOperation === "stat" && isFirstOpen) {
            await operationGate;
            firstDelayedOperationSettled = true;
          }
          return { isFile: () => true, size: 2 };
        },
      };
    });

    const first = await claudeMcpConfigSignature({
      cwd,
      env,
      deadlineMs: 250,
    });
    expect(first).toMatch(/^unhashed:/);
    if (stalledOperation !== "open") {
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    }

    releaseOperation();
    if (stalledOperation === "open" || stalledOperation === "stat") {
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    } else {
      await vi.waitFor(() => expect(firstDelayedOperationSettled).toBe(true));
    }
    expect(
      await claudeMcpConfigSignature({ cwd, env, deadlineMs: 250 }),
    ).not.toMatch(/^unhashed:/);
    expect(targetOpenCount).toBe(2);
  },
  2_000,
);

it("rejects premature EOF instead of returning a partial MCP server set", async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-truncated-"));
  tempDirs.push(home);
  const cwd = join(home, "project");
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
  const watchedPath = join(home, ".claude.json");
  const contents = JSON.stringify({
    mcpServers: { fixture: { command: "fixture-mcp" } },
  });
  let shortRead = true;
  let position = 0;
  let targetOpenCount = 0;
  const close = vi.fn(async () => {});
  openMock.mockImplementation(async (path: string) => {
    if (path !== watchedPath) {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    targetOpenCount += 1;
    position = 0;
    return {
      close,
      read: async (buffer: Buffer, offset: number, length: number) => {
        if (shortRead) {
          if (position > 0) return { bytesRead: 0 };
          position += buffer.write("{}", offset);
          return { bytesRead: position };
        }
        const bytesRead = buffer.write(contents, offset, length);
        position += bytesRead;
        return { bytesRead };
      },
      stat: async () => ({
        isFile: () => true,
        size: Buffer.byteLength(contents),
      }),
    };
  });

  await expect(
    loadClaudeMcpServers({ cwd, env, deadlineMs: 250 }),
  ).rejects.toThrow("Claude MCP config changed while it was being read");
  expect(close).toHaveBeenCalledTimes(1);

  shortRead = false;
  expect(
    await loadClaudeMcpServers({ cwd, env, deadlineMs: 250 }),
  ).toMatchObject({ fixture: { type: "stdio", command: "fixture-mcp" } });
  expect(targetOpenCount).toBe(2);
  expect(close).toHaveBeenCalledTimes(2);
});

it("marks a signature unhashed when a file ends before its stat size", async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-hash-truncated-"));
  tempDirs.push(home);
  const cwd = join(home, "project");
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
  const watchedPath = join(cwd, ".mcp.json");
  const contents = JSON.stringify({ mcpServers: {} });
  let shortRead = true;
  let position = 0;
  let targetOpenCount = 0;
  const close = vi.fn(async () => {});
  openMock.mockImplementation(async (path: string) => {
    if (path !== watchedPath) {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    targetOpenCount += 1;
    position = 0;
    return {
      close,
      read: async (buffer: Buffer, offset: number, length: number) => {
        if (shortRead) {
          if (position > 0) return { bytesRead: 0 };
          position += buffer.write("{}", offset);
          return { bytesRead: position };
        }
        const bytesRead = buffer.write(contents, offset, length);
        position += bytesRead;
        return { bytesRead };
      },
      stat: async () => ({
        isFile: () => true,
        size: Buffer.byteLength(contents),
      }),
    };
  });

  expect(await claudeMcpConfigSignature({ cwd, env, deadlineMs: 250 })).toMatch(
    /^unhashed:/,
  );
  shortRead = false;
  expect(
    await claudeMcpConfigSignature({ cwd, env, deadlineMs: 250 }),
  ).not.toMatch(/^unhashed:/);
  expect(targetOpenCount).toBe(2);
  expect(close).toHaveBeenCalledTimes(2);
});

it.each(["open", "stat", "close"] as const)(
  "does not return servers when config %s stalls and succeeds on retry",
  async (stalledOperation) => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-loader-stall-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
    const watchedPath = join(home, ".claude.json");
    const contents = JSON.stringify({
      mcpServers: { fixture: { command: "fixture-mcp" } },
    });
    let releaseOperation = (): void => {};
    const operationGate = new Promise<void>((resolveOperation) => {
      releaseOperation = resolveOperation;
    });
    releasePendingOperations.push(releaseOperation);
    let targetOpenCount = 0;
    let firstCloseSettled = false;
    const close = vi.fn(async () => {
      if (stalledOperation === "close" && targetOpenCount === 1) {
        await operationGate;
        firstCloseSettled = true;
      }
    });
    openMock.mockImplementation(async (path: string) => {
      if (path !== watchedPath) {
        const error = new Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      targetOpenCount += 1;
      const isFirstOpen = targetOpenCount === 1;
      if (stalledOperation === "open" && isFirstOpen) {
        await operationGate;
      }
      return {
        close,
        read: async (buffer: Buffer, offset: number) => {
          const bytesRead = buffer.write(contents, offset);
          return { bytesRead };
        },
        stat: async () => {
          if (stalledOperation === "stat" && isFirstOpen) {
            await operationGate;
          }
          return {
            isFile: () => true,
            size: Buffer.byteLength(contents),
          };
        },
      };
    });

    await expect(
      loadClaudeMcpServers({ cwd, env, deadlineMs: 250 }),
    ).rejects.toThrow("Claude MCP config read exceeded its deadline");
    releaseOperation();
    await vi.waitFor(() => {
      if (stalledOperation === "open") {
        expect(close).toHaveBeenCalledTimes(1);
      }
      if (stalledOperation === "stat") {
        expect(close).toHaveBeenCalledTimes(1);
      }
      if (stalledOperation === "close") {
        expect(firstCloseSettled).toBe(true);
      }
    });

    expect(
      await loadClaudeMcpServers({ cwd, env, deadlineMs: 250 }),
    ).toMatchObject({
      fixture: { type: "stdio", command: "fixture-mcp" },
    });
    expect(targetOpenCount).toBe(2);
  },
  2_000,
);
