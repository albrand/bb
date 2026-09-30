import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
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
    if (Date.now() > deadline) {
      return null;
    }
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, size - position),
      position,
    );
    if (bytesRead === 0) {
      break;
    }
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
    if (!stats.isFile()) {
      return `not-a-file:${stats.ino}:${stats.mode}`;
    }
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

async function computeSignature(
  paths: string[],
  deadline: number,
): Promise<string> {
  const lines: string[] = [];
  for (const path of paths) {
    lines.push(`${path}=${await fileSignature(path, deadline)}`);
  }
  return lines.join("\n");
}

const signaturesInFlight = new Map<string, Promise<string>>();

export async function codexMcpConfigSignature(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  deadlineMs: number;
}): Promise<string> {
  const paths = codexMcpConfigPaths(args);
  const key = paths.join("\n");
  if (signaturesInFlight.has(key)) {
    return unhashedSignature();
  }
  const deadline = Date.now() + args.deadlineMs;
  const computation = computeSignature(paths, deadline)
    .catch(unhashedSignature)
    .finally(() => {
      signaturesInFlight.delete(key);
    });
  signaturesInFlight.set(key, computation);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve(unhashedSignature());
    }, args.deadlineMs);
  });
  try {
    const signature = await Promise.race([computation, timedOut]);
    return Date.now() > deadline ? unhashedSignature() : signature;
  } finally {
    clearTimeout(timer);
  }
}
