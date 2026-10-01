import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

const originalHome = process.env.HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "bb-claude-test-home-"));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalClaudeConfigDir === undefined)
    delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  rmSync(home, { recursive: true, force: true });
});
