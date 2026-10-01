import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  claudeMcpConfigPaths,
  claudeMcpConfigSignature,
  loadClaudeMcpServers,
} from "./mcp-config-signature.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
} {
  const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-config-"));
  tempDirs.push(home);
  const cwd = join(home, "project", "nested");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(home, "claude-config");
  mkdirSync(configDir, { recursive: true });
  return { cwd, env: { HOME: home, CLAUDE_CONFIG_DIR: configDir }, home };
}

it("watches user, local, and project MCP configuration files", () => {
  const { cwd, env, home } = createFixture();
  const paths = claudeMcpConfigPaths({ cwd, env });

  expect(paths).toContain(join(home, ".claude.json"));
  expect(paths).toContain(join(home, "claude-config", "settings.json"));
  expect(paths).toContain(join(home, "project", ".mcp.json"));
  expect(paths).toContain(join(home, "project", ".claude", "settings.json"));
  expect(paths).toContain(
    join(home, "project", ".claude", "settings.local.json"),
  );
  expect(paths).toContain(join(cwd, ".mcp.json"));
});

it("changes the signature when a watched file is created, edited, and removed", async () => {
  const { cwd, env } = createFixture();
  const configPath = join(cwd, ".mcp.json");
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
  const signature = () => claudeMcpConfigSignature({ cwd, env });
  const absent = await signature();

  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { alpha: { command: "alpha-mcp" } } }),
  );
  const created = await signature();
  expect(created).not.toBe(absent);
  expect(await signature()).toBe(created);

  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { alpha: { command: "alpha-mcp-updated" } } }),
  );
  const edited = await signature();
  expect(edited).not.toBe(created);

  rmSync(configPath);
  expect(await signature()).toBe(absent);
});

it("changes the signature when project MCP enablement changes", async () => {
  const { cwd, env } = createFixture();
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const signature = () => claudeMcpConfigSignature({ cwd, env });

  writeFileSync(settingsPath, JSON.stringify({ enabledMcpjsonServers: [] }));
  const disabled = await signature();
  writeFileSync(
    settingsPath,
    JSON.stringify({ enabledMcpjsonServers: ["fixture"] }),
  );

  expect(await signature()).not.toBe(disabled);
});

it("omits project JSON servers rejected by MCP settings", async () => {
  const { cwd, env } = createFixture();
  const serverPath = join(cwd, ".mcp.json");
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    serverPath,
    JSON.stringify({ mcpServers: { fixture: { command: "fixture-mcp" } } }),
  );
  writeFileSync(
    settingsPath,
    JSON.stringify({ disabledMcpjsonServers: ["fixture"] }),
  );

  expect(await loadClaudeMcpServers({ cwd, env })).not.toHaveProperty(
    "fixture",
  );

  writeFileSync(
    settingsPath,
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
  expect(await loadClaudeMcpServers({ cwd, env })).toHaveProperty("fixture");
});

it("includes only project JSON servers explicitly approved when auto-approval is off", async () => {
  const { cwd, env } = createFixture();
  const serverPath = join(cwd, ".mcp.json");
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    serverPath,
    JSON.stringify({
      mcpServers: {
        approved: { command: "approved-mcp" },
        unapproved: { command: "unapproved-mcp" },
      },
    }),
  );
  writeFileSync(
    settingsPath,
    JSON.stringify({
      enableAllProjectMcpServers: false,
      enabledMcpjsonServers: ["approved"],
    }),
  );

  expect(await loadClaudeMcpServers({ cwd, env })).toEqual({
    approved: { type: "stdio", command: "approved-mcp" },
  });
});

it("does not let checked-in project settings approve their own MCP commands", async () => {
  const { cwd, env } = createFixture();
  const serverPath = join(cwd, ".mcp.json");
  const settingsPath = join(cwd, ".claude", "settings.json");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    serverPath,
    JSON.stringify({ mcpServers: { fixture: { command: "fixture-mcp" } } }),
  );
  writeFileSync(
    settingsPath,
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );

  expect(await loadClaudeMcpServers({ cwd, env })).not.toHaveProperty(
    "fixture",
  );
});

it("merges MCP servers from user, settings, and project files with environment expansion", async () => {
  const { cwd, env, home } = createFixture();
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (!configDir) throw new Error("Expected fixture Claude config directory");
  const projectRoot = join(home, "project");
  mkdirSync(join(projectRoot, ".claude"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
  env.FIXTURE_MCP_TOKEN = "fixture-token";
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { user: { command: "user-mcp" } } }),
  );
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({
      mcpServers: {
        shared: { command: "old-mcp" },
        authenticated: {
          type: "http",
          url: "https://fixture.invalid/mcp",
          headers: { Authorization: "Bearer ${FIXTURE_MCP_TOKEN}" },
        },
      },
    }),
  );
  writeFileSync(
    join(projectRoot, ".claude", "settings.json"),
    JSON.stringify({ mcpServers: { shared: { command: "project-mcp" } } }),
  );
  writeFileSync(
    join(projectRoot, ".claude", "settings.local.json"),
    JSON.stringify({ mcpServers: { localOverride: { command: "root-mcp" } } }),
  );
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({
      enableAllProjectMcpServers: true,
      mcpServers: { localOverride: { command: "nested-mcp" } },
    }),
  );
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { local: { command: "local-mcp" } } }),
  );

  const servers = await loadClaudeMcpServers({ cwd, env });

  expect(servers).toMatchObject({
    user: { type: "stdio", command: "user-mcp" },
    shared: { type: "stdio", command: "project-mcp" },
    local: { type: "stdio", command: "local-mcp" },
    localOverride: { type: "stdio", command: "nested-mcp" },
    authenticated: {
      type: "http",
      headers: { Authorization: "Bearer fixture-token" },
    },
  });
});
