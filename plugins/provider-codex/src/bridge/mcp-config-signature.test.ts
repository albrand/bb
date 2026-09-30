import { execFileSync } from "node:child_process";
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

it("changes when a watched config file is created, edited, or removed", () => {
  const env = { CODEX_HOME: join(rootDir, "home") };
  const cwd = join(rootDir, "repo");
  mkdirSync(join(rootDir, "home"));
  mkdirSync(join(cwd, ".codex"), { recursive: true });
  const signature = () => codexMcpConfigSignature({ cwd, env });

  const absent = signature();
  expect(signature()).toBe(absent);

  writeFileSync(join(rootDir, "home", "config.toml"), "a = 1\n");
  const created = signature();
  expect(created).not.toBe(absent);

  writeFileSync(join(cwd, ".codex", "config.toml"), "b = 2\n");
  const projectCreated = signature();
  expect(projectCreated).not.toBe(created);

  writeFileSync(join(rootDir, "home", "config.toml"), "a = 12\n");
  expect(signature()).not.toBe(projectCreated);

  rmSync(join(cwd, ".codex", "config.toml"));
  rmSync(join(rootDir, "home", "config.toml"));
  expect(signature()).toBe(absent);
});

function writeByteAt(path: string, position: number, byte: string): void {
  const descriptor = openSync(path, "r+");
  writeSync(descriptor, Buffer.from(byte), 0, 1, position);
  closeSync(descriptor);
}

it("changes when a byte past 2 GiB of a sparse config changes but its inode, size, and modification time do not", () => {
  const env = { CODEX_HOME: rootDir };
  const configPath = join(rootDir, "config.toml");
  const farOffset = 2 ** 31;
  writeFileSync(configPath, "");
  truncateSync(configPath, farOffset + 2);
  writeByteAt(configPath, farOffset, "a");
  utimesSync(configPath, 1_700_000_000, 1_700_000_000);
  const before = statSync(configPath);
  const original = codexMcpConfigSignature({ cwd: rootDir, env });

  writeByteAt(configPath, farOffset, "b");
  utimesSync(configPath, 1_700_000_000, 1_700_000_000);
  const after = statSync(configPath);

  expect([after.ino, after.size, after.mtimeMs]).toEqual([
    before.ino,
    before.size,
    before.mtimeMs,
  ]);
  expect(codexMcpConfigSignature({ cwd: rootDir, env })).not.toBe(original);
}, 120_000);

it("signs a FIFO or a directory without reading it", () => {
  const env = { CODEX_HOME: rootDir };
  const configPath = join(rootDir, "config.toml");
  const absent = codexMcpConfigSignature({ cwd: rootDir, env });

  execFileSync("mkfifo", [configPath]);
  const fifo = codexMcpConfigSignature({ cwd: rootDir, env });
  expect(fifo).not.toBe(absent);
  expect(fifo).toContain(`${configPath}=not-a-file:`);

  rmSync(configPath);
  mkdirSync(configPath);
  const directory = codexMcpConfigSignature({ cwd: rootDir, env });
  expect(directory).toContain(`${configPath}=not-a-file:`);
  expect(directory).not.toBe(fifo);
});

it.each([
  ["a small config", 0],
  ["a config over 1 MiB", 1024 * 1024],
])(
  "changes when the contents of %s change but the inode, size, and modification time do not",
  (_label, padding) => {
    const env = { CODEX_HOME: rootDir };
    const configPath = join(rootDir, "config.toml");
    const comment = padding === 0 ? "" : `# ${"x".repeat(padding)}\n`;
    writeFileSync(configPath, `${comment}command = "alpha"\n`);
    utimesSync(configPath, 1_700_000_000, 1_700_000_000);
    const before = statSync(configPath);
    const original = codexMcpConfigSignature({ cwd: rootDir, env });

    writeFileSync(configPath, `${comment}command = "bravo"\n`);
    utimesSync(configPath, 1_700_000_000, 1_700_000_000);
    const after = statSync(configPath);

    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);
    expect(codexMcpConfigSignature({ cwd: rootDir, env })).not.toBe(original);
  },
);
