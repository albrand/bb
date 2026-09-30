import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { codexMcpConfigSignature } from "./mcp-config-signature.js";

type StalledOperation = "open" | "stat" | "read" | "close";

const io = vi.hoisted(() => ({
  stalls: new Map<
    string,
    { operation: StalledOperation; gate: Promise<void> }
  >(),
  opens: new Map<string, number>(),
  closes: new Map<string, number>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (path: string, flags: number) => {
    io.opens.set(path, (io.opens.get(path) ?? 0) + 1);
    const stall = io.stalls.get(path);
    if (stall?.operation === "open") {
      await stall.gate;
    }
    const handle = await actual.open(path, flags);
    const gated =
      <T>(operation: StalledOperation, run: () => Promise<T>) =>
      async (): Promise<T> => {
        if (stall?.operation === operation) {
          await stall.gate;
        }
        return run();
      };
    return {
      stat: gated("stat", () => handle.stat()),
      read: (...readArgs: Parameters<FileHandle["read"]>) =>
        gated("read", () => handle.read(...readArgs))(),
      close: async () => {
        await gated("close", () => handle.close())();
        io.closes.set(path, (io.closes.get(path) ?? 0) + 1);
      },
    };
  };
  return { ...actual, open };
});

const DEADLINE_MS = 300;

let rootDir: string;
let configPath: string;
let releases: Array<() => void>;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "bb-codex-mcp-stall-"));
  configPath = join(rootDir, "config.toml");
  writeFileSync(configPath, "a = 1\n");
  releases = [];
  io.stalls.clear();
  io.opens.clear();
  io.closes.clear();
});

afterEach(() => {
  for (const release of releases) {
    release();
  }
  rmSync(rootDir, { recursive: true, force: true });
});

function stall(operation: StalledOperation): () => void {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  io.stalls.set(configPath, { operation, gate });
  releases.push(release);
  return release;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > 5_000) {
      throw new Error("condition not met within 5 s");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const signature = () =>
  codexMcpConfigSignature({
    cwd: rootDir,
    env: { CODEX_HOME: rootDir },
    deadlineMs: DEADLINE_MS,
  });

it.each<StalledOperation>(["open", "stat", "read", "close"])(
  "returns a changed signature by the deadline when %s stalls, starts no second read of a stalled config, and recovers once it completes",
  async (operation) => {
    const healthy = await signature();
    const release = stall(operation);
    io.opens.clear();

    const startedAt = Date.now();
    const stalled = await signature();
    const elapsed = Date.now() - startedAt;
    expect(stalled).toMatch(/^unhashed:/);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 1_000);

    const whileStalled = await signature();
    expect(whileStalled).toMatch(/^unhashed:/);
    expect(whileStalled).not.toBe(stalled);
    expect(io.opens.get(configPath)).toBe(1);

    io.stalls.delete(configPath);
    release();
    await waitFor(() => (io.closes.get(configPath) ?? 0) >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await signature()).toBe(healthy);
  },
);

it("ignores a digest that arrives after the deadline", async () => {
  io.stalls.set(configPath, {
    operation: "read",
    gate: new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 300)),
  });

  const startedAt = Date.now();
  const late = await signature();

  expect(late).toMatch(/^unhashed:/);
  expect(Date.now() - startedAt).toBeLessThan(DEADLINE_MS + 250);
});

it("stops reading an abandoned config soon after the deadline", async () => {
  truncateSync(configPath, 8 * 2 ** 30);
  const startedAt = Date.now();

  expect(await signature()).toMatch(/^unhashed:/);
  await waitFor(() => (io.closes.get(configPath) ?? 0) >= 1);

  expect(Date.now() - startedAt).toBeLessThan(DEADLINE_MS + 700);
});
