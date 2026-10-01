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

const HASH_CHUNK_BYTES = 1024 * 1024;
const CONFIG_READ_DEADLINE_MS = 2_000;
const CONFIG_FILE_MAX_BYTES = 4 * 1024 * 1024;

function unhashedSignature(): string {
  return `unhashed:${randomUUID()}`;
}

async function hashFile(
  handle: FileHandle,
  size: number,
  deadline: number,
): Promise<string | null> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0;
  while (position < size) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return null;
    let timer: NodeJS.Timeout | undefined;
    const readResult = await Promise.race([
      handle.read(chunk, 0, Math.min(chunk.length, size - position), position),
      new Promise<null>((resolveRead) => {
        timer = setTimeout(() => resolveRead(null), remainingMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (readResult === null) return null;
    const { bytesRead } = readResult;
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `${position}:${hash.digest("hex")}`;
}

async function fileSignature(path: string, deadline: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : code;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return `not-a-file:${stats.ino}:${stats.mode}`;
    try {
      return (
        (await hashFile(handle, stats.size, deadline)) ?? unhashedSignature()
      );
    } catch (error) {
      return `${errorCode(error)}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    }
  } catch (error) {
    return errorCode(error);
  } finally {
    await handle.close();
  }
}

const fileSignaturesInFlight = new Map<
  string,
  { signature: Promise<string>; deadline: number }
>();

async function singleFlightFileSignature(
  path: string,
  deadline: number,
): Promise<string> {
  for (
    let inFlight = fileSignaturesInFlight.get(path);
    inFlight !== undefined;
    inFlight = fileSignaturesInFlight.get(path)
  ) {
    if (performance.now() > inFlight.deadline) return unhashedSignature();
    await inFlight.signature;
    if (performance.now() > deadline) return unhashedSignature();
  }
  const signature = fileSignature(path, deadline)
    .catch(unhashedSignature)
    .finally(() => {
      if (fileSignaturesInFlight.get(path)?.signature === signature) {
        fileSignaturesInFlight.delete(path);
      }
    });
  fileSignaturesInFlight.set(path, { signature, deadline });
  return signature;
}

async function computeSignature(
  paths: string[],
  deadline: number,
): Promise<string> {
  const lines: string[] = [];
  for (const path of paths) {
    const signature = await singleFlightFileSignature(path, deadline);
    if (signature.startsWith("unhashed:")) return unhashedSignature();
    lines.push(`${path}=${signature}`);
  }
  return lines.join("\n");
}

export async function claudeMcpConfigSignature(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  deadlineMs?: number;
}): Promise<string> {
  const deadlineMs = args.deadlineMs ?? CONFIG_READ_DEADLINE_MS;
  const deadline = performance.now() + deadlineMs;
  const computation = computeSignature(
    claudeMcpConfigPaths(args),
    deadline,
  ).catch(unhashedSignature);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<string>((resolveSignature) => {
    timer = setTimeout(() => resolveSignature(unhashedSignature()), deadlineMs);
  });
  try {
    const signature = await Promise.race([computation, timedOut]);
    return performance.now() > deadline ? unhashedSignature() : signature;
  } finally {
    clearTimeout(timer);
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

function resolveServerConfig(
  value: unknown,
  env: NodeJS.ProcessEnv,
): McpServerConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "http" || value.type === "sse") {
    if (typeof value.url !== "string") return undefined;
    const config: Record<string, unknown> = {
      ...value,
      url: expandEnvironment(value.url, env),
    };
    if (isRecord(value.headers)) {
      config.headers = Object.fromEntries(
        Object.entries(value.headers)
          .filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          )
          .map(([key, header]) => [key, expandEnvironment(header, env)]),
      );
    }
    return config as McpServerConfig;
  }
  if (value.type === undefined || value.type === "stdio") {
    if (typeof value.command !== "string") return undefined;
    const config: Record<string, unknown> = {
      ...value,
      type: "stdio",
      command: expandEnvironment(value.command, env),
    };
    if (Array.isArray(value.args)) {
      config.args = value.args
        .filter((item): item is string => typeof item === "string")
        .map((item) => expandEnvironment(item, env));
    }
    if (isRecord(value.env)) {
      config.env = Object.fromEntries(
        Object.entries(value.env)
          .filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          )
          .map(([key, item]) => [key, expandEnvironment(item, env)]),
      );
    }
    return config as McpServerConfig;
  }
  return undefined;
}

function mcpServersFromConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.mcpServers)) return {};
  return value.mcpServers;
}

async function readConfig(path: string): Promise<unknown> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return {};
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return {};
    if (stats.size > CONFIG_FILE_MAX_BYTES) {
      throw new Error("Claude MCP config exceeds the supported file size");
    }
    const startedAt = performance.now();
    const read = (async (): Promise<string> => {
      const chunks: Buffer[] = [];
      let position = 0;
      while (position < stats.size) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, stats.size - position),
        );
        const result = await handle.read(chunk, 0, chunk.length, position);
        if (result.bytesRead === 0) break;
        chunks.push(chunk.subarray(0, result.bytesRead));
        position += result.bytesRead;
      }
      return Buffer.concat(chunks).toString("utf8");
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Claude MCP config read exceeded its deadline")),
          CONFIG_READ_DEADLINE_MS,
        );
      });
      const contents = await Promise.race([read, timedOut]);
      if (performance.now() - startedAt > CONFIG_READ_DEADLINE_MS) {
        throw new Error("Claude MCP config read exceeded its deadline");
      }
      return JSON.parse(contents) as unknown;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await handle.close();
  }
}

export async function loadClaudeMcpServers(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, McpServerConfig>> {
  const paths = claudeMcpConfigPaths(args);
  const servers = Object.create(null) as Record<string, McpServerConfig>;
  for (const path of paths) {
    const config = await readConfig(path);
    const sources = [mcpServersFromConfig(config)];
    if (path.endsWith(".claude.json") && isRecord(config)) {
      const projects = config.projects;
      if (isRecord(projects)) {
        for (const [projectPath, project] of Object.entries(projects)) {
          if (resolve(projectPath) === resolve(args.cwd)) {
            sources.push(mcpServersFromConfig(project));
          }
        }
      }
    }
    for (const source of sources) {
      for (const [name, value] of Object.entries(source)) {
        const server = resolveServerConfig(value, args.env);
        if (server) servers[name] = server;
      }
    }
  }
  return servers;
}
