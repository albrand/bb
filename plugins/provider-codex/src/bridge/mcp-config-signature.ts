import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
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

const MAX_HASHED_CONFIG_BYTES = 1024 * 1024;

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : "error";
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
    if (stats.size > MAX_HASHED_CONFIG_BYTES) {
      return `large:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    }
    return createHash("sha256").update(readFileSync(descriptor)).digest("hex");
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
