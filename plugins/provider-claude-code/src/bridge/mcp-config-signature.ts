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

async function hashFile(
  handle: FileHandle,
  size: number,
  deadline: number,
): Promise<string | null> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0;
  while (position < size) {
    let readResult: { bytesRead: number };
    try {
      readResult = await withinDeadline(
        handle.read(
          chunk,
          0,
          Math.min(chunk.length, size - position),
          position,
        ),
        deadline,
      );
    } catch (error) {
      if (error === CONFIG_READ_DEADLINE_EXCEEDED) return null;
      throw error;
    }
    const { bytesRead } = readResult;
    if (bytesRead === 0) return null;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `${position}:${hash.digest("hex")}`;
}

async function fileSignature(path: string, deadline: number): Promise<string> {
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
      return unhashedSignature();
    }
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : code;
  }
  let signature: string;
  try {
    const stats = await withinDeadline(handle.stat(), deadline);
    if (!stats.isFile()) {
      signature = `not-a-file:${stats.ino}:${stats.mode}`;
    } else {
      try {
        signature =
          (await hashFile(handle, stats.size, deadline)) ?? unhashedSignature();
      } catch (error) {
        signature =
          error === CONFIG_READ_DEADLINE_EXCEEDED
            ? unhashedSignature()
            : `${errorCode(error)}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
      }
    }
  } catch (error) {
    signature =
      error === CONFIG_READ_DEADLINE_EXCEEDED
        ? unhashedSignature()
        : errorCode(error);
  }
  const closed = await closeFileHandle(handle, deadline);
  return closed ? signature : unhashedSignature();
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

async function readConfig(path: string, deadline: number): Promise<unknown> {
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
      return {};
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
    const read = (async (): Promise<string> => {
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
      return Buffer.concat(chunks).toString("utf8");
    })();
    const contents = await withinDeadline(read, deadline);
    return JSON.parse(contents) as unknown;
  } finally {
    if (!(await closeFileHandle(handle, deadline))) {
      throw CONFIG_READ_DEADLINE_EXCEEDED;
    }
  }
}

export async function loadClaudeMcpServers(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  deadlineMs?: number;
}): Promise<Record<string, McpServerConfig>> {
  const deadline =
    performance.now() + (args.deadlineMs ?? CONFIG_READ_DEADLINE_MS);
  const paths = claudeMcpConfigPaths(args);
  const servers = Object.create(null) as Record<string, McpServerConfig>;
  for (const path of paths) {
    const config = await readConfig(path, deadline);
    const sources = [mcpServersFromConfig(config)];
    if (path.endsWith(".claude.json") && isRecord(config)) {
      const projects = config.projects;
      if (projects !== undefined) {
        if (!isRecord(projects)) {
          invalidMcpConfig("projects must be an object");
        }
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
        servers[name] = server;
      }
    }
  }
  return servers;
}
