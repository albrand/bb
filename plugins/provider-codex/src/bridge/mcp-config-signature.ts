import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

function fileSignature(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "error";
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : code;
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
