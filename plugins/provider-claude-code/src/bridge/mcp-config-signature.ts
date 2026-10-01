import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export function claudeMcpConfigPaths(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const home = args.env.HOME?.trim() || homedir();
  const configDir = args.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const paths = [join(home, ".claude.json"), join(configDir, "settings.json")];
  const directories: string[] = [];
  let directory = resolve(args.cwd);
  for (;;) {
    directories.push(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const projectDirectories = directories.reverse();
  for (const projectDirectory of projectDirectories) {
    paths.push(
      join(projectDirectory, ".claude", "settings.json"),
      join(projectDirectory, ".mcp.json"),
    );
  }
  paths.push(join(configDir, "settings.local.json"));
  for (const projectDirectory of projectDirectories) {
    paths.push(join(projectDirectory, ".claude", "settings.local.json"));
  }
  return [...new Set(paths)];
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : "error";
}

const CONFIG_READ_DEADLINE_MS = 2_000;
const CONFIG_FILE_MAX_BYTES = 4 * 1024 * 1024;
const CONFIG_READ_DEADLINE_EXCEEDED = new Error(
  "Claude MCP config read exceeded its deadline",
);

function unhashedSignature(): string {
  return `unhashed:${randomUUID()}`;
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) throw CONFIG_READ_DEADLINE_EXCEEDED;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(CONFIG_READ_DEADLINE_EXCEEDED),
          remainingMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeFileHandle(
  handle: FileHandle,
  deadline: number,
): Promise<boolean> {
  const closing = handle.close();
  try {
    await withinDeadline(closing, deadline);
    return true;
  } catch {
    void closing.catch(() => {});
    return false;
  }
}

const configSnapshotsInFlight = new Map<
  string,
  { snapshot: Promise<ConfigFileSnapshot>; deadline: number }
>();

interface ConfigFileSnapshot {
  config: unknown;
}

export async function claudeMcpConfigSignature(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  deadlineMs?: number;
}): Promise<string> {
  try {
    return (await loadClaudeMcpServersSnapshot(args)).signature;
  } catch {
    return unhashedSignature();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expandEnvironment(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, key: string) => env[key] ?? "",
  );
}

function invalidMcpConfig(reason: string): never {
  throw new Error(`Invalid Claude MCP configuration: ${reason}`);
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) invalidMcpConfig(`${field} must be an object`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    invalidMcpConfig(`${field} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function resolveHttpUrl(value: string, env: NodeJS.ProcessEnv): string {
  const resolved = expandEnvironment(value, env);
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    invalidMcpConfig("HTTP and SSE server urls must be absolute HTTP(S) urls");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalidMcpConfig("HTTP and SSE server urls must be absolute HTTP(S) urls");
  }
  return resolved;
}

function resolveServerConfig(
  value: unknown,
  env: NodeJS.ProcessEnv,
): McpServerConfig {
  if (!isRecord(value)) invalidMcpConfig("server config must be an object");
  if (value.type === "http" || value.type === "sse") {
    if (typeof value.url !== "string") {
      invalidMcpConfig(`${value.type} server url must be a string`);
    }
    const config: Record<string, unknown> = {
      ...value,
      url: resolveHttpUrl(value.url, env),
    };
    if (value.headers !== undefined) {
      config.headers = Object.fromEntries(
        Object.entries(stringRecord(value.headers, "headers")).map(
          ([key, header]) => [key, expandEnvironment(header, env)],
        ),
      );
    }
    return config as McpServerConfig;
  }
  if (value.type === undefined || value.type === "stdio") {
    if (typeof value.command !== "string") {
      invalidMcpConfig("stdio server command must be a string");
    }
    const config: Record<string, unknown> = {
      ...value,
      type: "stdio",
      command: expandEnvironment(value.command, env),
    };
    if (value.args !== undefined) {
      if (
        !Array.isArray(value.args) ||
        value.args.some((item) => typeof item !== "string")
      ) {
        invalidMcpConfig("stdio server args must be an array of strings");
      }
      config.args = value.args.map((item: string) =>
        expandEnvironment(item, env),
      );
    }
    if (value.env !== undefined) {
      config.env = Object.fromEntries(
        Object.entries(stringRecord(value.env, "stdio server env")).map(
          ([key, item]) => [key, expandEnvironment(item, env)],
        ),
      );
    }
    return config as McpServerConfig;
  }
  invalidMcpConfig("server type must be stdio, sse, or http");
}

function mcpServersFromConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalidMcpConfig("config root must be an object");
  if (value.mcpServers === undefined) return {};
  if (!isRecord(value.mcpServers)) {
    invalidMcpConfig("mcpServers must be an object");
  }
  return value.mcpServers;
}

interface McpDecisionSettings {
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  disabledMcpServers?: string[];
  enabledMcpServers?: string[];
  enableAllProjectMcpServers?: boolean;
}

function mcpDecisionSettings(value: unknown): McpDecisionSettings {
  if (!isRecord(value)) return {};
  const decisions: McpDecisionSettings = {};
  if (Object.hasOwn(value, "enabledMcpjsonServers")) {
    decisions.enabledMcpjsonServers = mcpServerNameList(
      value.enabledMcpjsonServers,
      "enabledMcpjsonServers",
    );
  }
  if (Object.hasOwn(value, "disabledMcpjsonServers")) {
    decisions.disabledMcpjsonServers = mcpServerNameList(
      value.disabledMcpjsonServers,
      "disabledMcpjsonServers",
    );
  }
  if (Object.hasOwn(value, "disabledMcpServers")) {
    decisions.disabledMcpServers = mcpServerNameList(
      value.disabledMcpServers,
      "disabledMcpServers",
    );
  }
  if (Object.hasOwn(value, "enabledMcpServers")) {
    decisions.enabledMcpServers = mcpServerNameList(
      value.enabledMcpServers,
      "enabledMcpServers",
    );
  }
  if (Object.hasOwn(value, "enableAllProjectMcpServers")) {
    const setting = value.enableAllProjectMcpServers;
    if (typeof setting !== "boolean") {
      invalidMcpConfig("enableAllProjectMcpServers must be a boolean");
    }
    decisions.enableAllProjectMcpServers = setting;
  }
  return decisions;
}

function mcpServerNameList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidMcpConfig(`${field} must be an array of strings`);
  }
  return [...new Set(value)].sort();
}

async function readConfig(
  path: string,
  deadline: number,
): Promise<ConfigFileSnapshot> {
  let handle: FileHandle | undefined;
  const opening = open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  ).then((opened) => {
    handle = opened;
    return opened;
  });
  try {
    handle = await withinDeadline(opening, deadline);
  } catch (error) {
    if (error === CONFIG_READ_DEADLINE_EXCEEDED) {
      void opening.then(
        (opened) => opened.close().catch(() => {}),
        () => {},
      );
      throw error;
    }
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return { config: {} };
    }
    throw error;
  }
  try {
    const stats = await withinDeadline(handle.stat(), deadline);
    if (!stats.isFile()) {
      throw new Error("Claude MCP config is not a regular file");
    }
    if (stats.size > CONFIG_FILE_MAX_BYTES) {
      throw new Error("Claude MCP config exceeds the supported file size");
    }
    const read = (async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      let position = 0;
      while (position < stats.size) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, stats.size - position),
        );
        const result = await handle.read(chunk, 0, chunk.length, position);
        if (result.bytesRead === 0) {
          throw new Error("Claude MCP config changed while it was being read");
        }
        chunks.push(chunk.subarray(0, result.bytesRead));
        position += result.bytesRead;
      }
      return Buffer.concat(chunks);
    })();
    const contents = await withinDeadline(read, deadline);
    return { config: JSON.parse(contents.toString("utf8")) as unknown };
  } finally {
    if (!(await closeFileHandle(handle, deadline))) {
      throw CONFIG_READ_DEADLINE_EXCEEDED;
    }
  }
}

async function singleFlightConfigSnapshot(
  path: string,
  deadline: number,
): Promise<ConfigFileSnapshot> {
  for (
    let inFlight = configSnapshotsInFlight.get(path);
    inFlight !== undefined;
    inFlight = configSnapshotsInFlight.get(path)
  ) {
    if (performance.now() > inFlight.deadline) {
      throw CONFIG_READ_DEADLINE_EXCEEDED;
    }
    try {
      await withinDeadline(inFlight.snapshot, deadline);
    } catch (error) {
      if (error === CONFIG_READ_DEADLINE_EXCEEDED) throw error;
    }
    if (performance.now() > deadline) {
      throw CONFIG_READ_DEADLINE_EXCEEDED;
    }
  }
  const snapshot = readConfig(path, deadline).finally(() => {
    if (configSnapshotsInFlight.get(path)?.snapshot === snapshot) {
      configSnapshotsInFlight.delete(path);
    }
  });
  configSnapshotsInFlight.set(path, { snapshot, deadline });
  return snapshot;
}

export async function loadClaudeMcpServers(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  deadlineMs?: number;
}): Promise<Record<string, McpServerConfig>> {
  return (await loadClaudeMcpServersSnapshot(args)).servers;
}

export async function loadClaudeMcpServersSnapshot(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  deadlineMs?: number;
}): Promise<{ servers: Record<string, McpServerConfig>; signature: string }> {
  const deadline =
    performance.now() + (args.deadlineMs ?? CONFIG_READ_DEADLINE_MS);
  const paths = claudeMcpConfigPaths(args);
  const servers = Object.create(null) as Record<string, McpServerConfig>;
  const signatureInputs: unknown[] = [];
  const sourcesByPrecedence: {
    servers: Record<string, unknown>;
    isProjectMcpJson: boolean;
  }[][] = [[], [], []];
  const disabledProjectMcpServers = new Set<string>();
  const disabledProjectMcpJsonServers = new Set<string>();
  const enabledProjectMcpJsonServers = new Set<string>();
  let autoApproveProjectMcpJsonServers = false;
  const home = args.env.HOME?.trim() || homedir();
  const configDir = args.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const userConfigPath = join(home, ".claude.json");
  const userSettingsPaths = new Set([
    join(configDir, "settings.json"),
    join(configDir, "settings.local.json"),
  ]);
  const localProjectSettingsSuffix = join(".claude", "settings.local.json");
  for (const path of paths) {
    const snapshot = await singleFlightConfigSnapshot(path, deadline);
    const { config } = snapshot;
    const precedence =
      path.endsWith(".claude.json") || userSettingsPaths.has(path)
        ? 0
        : path.endsWith(localProjectSettingsSuffix)
          ? 2
          : 1;
    const isCheckedInProjectSettings =
      path.endsWith(join(".claude", "settings.json")) &&
      !userSettingsPaths.has(path);
    sourcesByPrecedence[precedence]?.push({
      servers: isCheckedInProjectSettings ? {} : mcpServersFromConfig(config),
      isProjectMcpJson: path.endsWith(".mcp.json"),
    });
    const decisions = mcpDecisionSettings(config);
    if (Object.keys(decisions).length > 0) {
      signatureInputs.push({ path, decisions });
    }
    for (const name of decisions.disabledMcpjsonServers ?? []) {
      disabledProjectMcpJsonServers.add(name);
    }
    if (
      path === userConfigPath ||
      userSettingsPaths.has(path) ||
      path.endsWith(localProjectSettingsSuffix)
    ) {
      for (const name of decisions.enabledMcpjsonServers ?? []) {
        enabledProjectMcpJsonServers.add(name);
      }
      if (decisions.enableAllProjectMcpServers !== undefined) {
        autoApproveProjectMcpJsonServers = decisions.enableAllProjectMcpServers;
      }
    }
    if (path === userConfigPath && isRecord(config)) {
      const projects = config.projects;
      if (projects !== undefined) {
        if (!isRecord(projects)) {
          invalidMcpConfig("projects must be an object");
        }
        const project = projects[resolve(args.cwd)];
        if (project !== undefined) {
          const projectServers = mcpServersFromConfig(project);
          const projectDecisions = mcpDecisionSettings(project);
          sourcesByPrecedence[2]?.push({
            servers: projectServers,
            isProjectMcpJson: false,
          });
          for (const name of projectDecisions.disabledMcpServers ?? []) {
            disabledProjectMcpServers.add(name);
          }
          for (const name of projectDecisions.disabledMcpjsonServers ?? []) {
            disabledProjectMcpJsonServers.add(name);
          }
          for (const name of projectDecisions.enabledMcpjsonServers ?? []) {
            enabledProjectMcpJsonServers.add(name);
          }
          if (projectDecisions.enableAllProjectMcpServers !== undefined) {
            autoApproveProjectMcpJsonServers =
              projectDecisions.enableAllProjectMcpServers;
          }
          if (Object.keys(projectDecisions).length > 0) {
            signatureInputs.push({
              path: `${path}#projects.${resolve(args.cwd)}`,
              decisions: projectDecisions,
            });
          }
        }
      }
    }
  }
  for (const sources of sourcesByPrecedence) {
    for (const source of sources) {
      for (const [name, value] of Object.entries(source.servers)) {
        if (
          source.isProjectMcpJson &&
          (disabledProjectMcpJsonServers.has(name) ||
            (!autoApproveProjectMcpJsonServers &&
              !enabledProjectMcpJsonServers.has(name)))
        ) {
          continue;
        }
        const server = resolveServerConfig(value, args.env);
        servers[name] = server;
      }
    }
  }
  for (const name of disabledProjectMcpServers) delete servers[name];
  const canonicalServers = canonicalize(servers);
  const canonicalInputs = canonicalize(signatureInputs);
  const signature = createHash("sha256")
    .update(
      JSON.stringify({ servers: canonicalServers, inputs: canonicalInputs }),
    )
    .digest("hex");
  return { servers, signature };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) =>
        value[key] === undefined ? [] : [[key, canonicalize(value[key])]],
      ),
  );
}
