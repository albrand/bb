import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  codexMcpConfigPaths,
  codexMcpConfigSignature,
} from "./mcp-config-signature.js";

const HASH_DEADLINE_MS = 60_000;

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "bb-codex-mcp-signature-"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

it("covers CODEX_HOME and every project .codex directory from the cwd up", () => {
  const cwd = join(rootDir, "repo", "packages", "app");
  const paths = codexMcpConfigPaths({
    cwd,
    env: { CODEX_HOME: join(rootDir, "home") },
  });

  expect(paths[0]).toBe(join(rootDir, "home", "config.toml"));
  expect(paths).toContain(join(cwd, ".codex", "config.toml"));
  expect(paths).toContain(join(rootDir, "repo", ".codex", "config.toml"));
  expect(paths.at(-1)).toBe("/.codex/config.toml");
});

it("falls back to ~/.codex when CODEX_HOME is unset or blank", () => {
  expect(codexMcpConfigPaths({ cwd: rootDir, env: {} })[0]).toBe(
    join(homedir(), ".codex", "config.toml"),
  );
  expect(
    codexMcpConfigPaths({ cwd: rootDir, env: { CODEX_HOME: "  " } })[0],
  ).toBe(join(homedir(), ".codex", "config.toml"));
});

it("changes when a watched config file is created, edited, or removed", async () => {
  const env = { CODEX_HOME: join(rootDir, "home") };
  const cwd = join(rootDir, "repo");
  mkdirSync(join(rootDir, "home"));
  mkdirSync(join(cwd, ".codex"), { recursive: true });
  const signature = () =>
    codexMcpConfigSignature({ cwd, env, deadlineMs: HASH_DEADLINE_MS });

  const absent = await signature();
  expect(await signature()).toBe(absent);

  writeFileSync(join(rootDir, "home", "config.toml"), "a = 1\n");
  const created = await signature();
  expect(created).not.toBe(absent);

  writeFileSync(join(cwd, ".codex", "config.toml"), "b = 2\n");
  const projectCreated = await signature();
  expect(projectCreated).not.toBe(created);

  writeFileSync(join(rootDir, "home", "config.toml"), "a = 12\n");
  expect(await signature()).not.toBe(projectCreated);

  rmSync(join(cwd, ".codex", "config.toml"));
  rmSync(join(rootDir, "home", "config.toml"));
  expect(await signature()).toBe(absent);
});

function writeByteAt(path: string, position: number, byte: string): void {
  const descriptor = openSync(path, "r+");
  writeSync(descriptor, Buffer.from(byte), 0, 1, position);
  closeSync(descriptor);
}

it("changes when a byte past 2 GiB of a sparse config changes but its inode, size, and modification time do not", async () => {
  const env = { CODEX_HOME: rootDir };
  const configPath = join(rootDir, "config.toml");
  const farOffset = 2 ** 31;
  writeFileSync(configPath, "");
  truncateSync(configPath, farOffset + 2);
  writeByteAt(configPath, farOffset, "a");
  utimesSync(configPath, 1_700_000_000, 1_700_000_000);
  const before = statSync(configPath);
  const original = await codexMcpConfigSignature({
    cwd: rootDir,
    env,
    deadlineMs: HASH_DEADLINE_MS,
  });

  writeByteAt(configPath, farOffset, "b");
  utimesSync(configPath, 1_700_000_000, 1_700_000_000);
  const after = statSync(configPath);

  expect([after.ino, after.size, after.mtimeMs]).toEqual([
    before.ino,
    before.size,
    before.mtimeMs,
  ]);
  expect(
    await codexMcpConfigSignature({
      cwd: rootDir,
      env,
      deadlineMs: HASH_DEADLINE_MS,
    }),
  ).not.toBe(original);
}, 120_000);

it("signs a FIFO or a directory without reading it", async () => {
  const env = { CODEX_HOME: rootDir };
  const configPath = join(rootDir, "config.toml");
  const absent = await codexMcpConfigSignature({
    cwd: rootDir,
    env,
    deadlineMs: HASH_DEADLINE_MS,
  });

  execFileSync("mkfifo", [configPath]);
  const fifo = await codexMcpConfigSignature({
    cwd: rootDir,
    env,
    deadlineMs: HASH_DEADLINE_MS,
  });
  expect(fifo).not.toBe(absent);
  expect(fifo).toContain(`${configPath}=not-a-file:`);

  rmSync(configPath);
  mkdirSync(configPath);
  const directory = await codexMcpConfigSignature({
    cwd: rootDir,
    env,
    deadlineMs: HASH_DEADLINE_MS,
  });
  expect(directory).toContain(`${configPath}=not-a-file:`);
  expect(directory).not.toBe(fifo);
});

it.each([
  ["a small config", 0],
  ["a config over 1 MiB", 1024 * 1024],
])(
  "changes when the contents of %s change but the inode, size, and modification time do not",
  async (_label, padding) => {
    const env = { CODEX_HOME: rootDir };
    const configPath = join(rootDir, "config.toml");
    const comment = padding === 0 ? "" : `# ${"x".repeat(padding)}\n`;
    writeFileSync(configPath, `${comment}command = "alpha"\n`);
    utimesSync(configPath, 1_700_000_000, 1_700_000_000);
    const before = statSync(configPath);
    const original = await codexMcpConfigSignature({
      cwd: rootDir,
      env,
      deadlineMs: HASH_DEADLINE_MS,
    });

    writeFileSync(configPath, `${comment}command = "bravo"\n`);
    utimesSync(configPath, 1_700_000_000, 1_700_000_000);
    const after = statSync(configPath);

    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);
    expect(
      await codexMcpConfigSignature({
        cwd: rootDir,
        env,
        deadlineMs: HASH_DEADLINE_MS,
      }),
    ).not.toBe(original);
  },
);

function growSparseFileForever(path: string): () => void {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const fs = require('node:fs'); const path = process.argv[1]; let size = fs.statSync(path).size; for (;;) { size += 1024 * 1024; fs.truncateSync(path, size); }",
      path,
    ],
    { stdio: "ignore" },
  );
  return () => {
    child.kill("SIGKILL");
  };
}

it("keeps the event loop responsive while it hashes a 2 GiB config", async () => {
  const env = { CODEX_HOME: rootDir };
  const configPath = join(rootDir, "config.toml");
  writeFileSync(configPath, "");
  truncateSync(configPath, 2 ** 31 + 2);
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 1);
  try {
    await codexMcpConfigSignature({
      cwd: rootDir,
      env,
      deadlineMs: HASH_DEADLINE_MS,
    });
  } finally {
    clearInterval(timer);
  }

  expect(ticks).toBeGreaterThan(5);
}, 120_000);

it("returns within its deadline while a watched config keeps growing, and reports a change every time", async () => {
  const env = { CODEX_HOME: rootDir };
  const configPath = join(rootDir, "config.toml");
  writeFileSync(configPath, "a = 1\n");
  const stopGrowing = growSparseFileForever(configPath);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const startedAt = Date.now();
    const first = await codexMcpConfigSignature({
      cwd: rootDir,
      env,
      deadlineMs: 300,
    });
    const second = await codexMcpConfigSignature({
      cwd: rootDir,
      env,
      deadlineMs: 300,
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(first).toContain(`${configPath}=unhashed:`);
    expect(second).not.toBe(first);
  } finally {
    stopGrowing();
  }
}, 30_000);
