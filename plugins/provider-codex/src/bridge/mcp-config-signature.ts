import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function codexMcpConfigPaths(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const codexHome = args.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const paths = [join(resolve(codexHome), "config.toml")];
  let directory = resolve(args.cwd);
  for (;;) {
    const projectConfig = join(directory, ".codex", "config.toml");
    if (!paths.includes(projectConfig)) {
      paths.push(projectConfig);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return paths;
    }
    directory = parent;
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : "error";
}

const HASH_CHUNK_BYTES = 1024 * 1024;

function hashDescriptor(descriptor: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  for (;;) {
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      return hash.digest("hex");
    }
    hash.update(chunk.subarray(0, bytesRead));
  }
}

function fileSignature(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : code;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      return `not-a-file:${stats.ino}:${stats.mode}`;
    }
    try {
      return hashDescriptor(descriptor);
    } catch (error) {
      return `${errorCode(error)}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    }
  } catch (error) {
    return errorCode(error);
  } finally {
    closeSync(descriptor);
  }
}

export function codexMcpConfigSignature(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): string {
  return codexMcpConfigPaths(args)
    .map((path) => `${path}=${fileSignature(path)}`)
    .join("\n");
}
