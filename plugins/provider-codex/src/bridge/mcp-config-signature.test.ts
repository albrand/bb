import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
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

it("changes when the contents change but the inode, size, and modification time do not", () => {
  const env = { CODEX_HOME: rootDir };
  const configPath = join(rootDir, "config.toml");
  writeFileSync(configPath, 'command = "alpha"\n');
  utimesSync(configPath, 1_700_000_000, 1_700_000_000);
  const before = statSync(configPath);
  const original = codexMcpConfigSignature({ cwd: rootDir, env });

  writeFileSync(configPath, 'command = "bravo"\n');
  utimesSync(configPath, 1_700_000_000, 1_700_000_000);
  const after = statSync(configPath);

  expect([after.ino, after.size, after.mtimeMs]).toEqual([
    before.ino,
    before.size,
    before.mtimeMs,
  ]);
  expect(codexMcpConfigSignature({ cwd: rootDir, env })).not.toBe(original);
});
