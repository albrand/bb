import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import { isPathWithinDirectory } from "@bb/process-utils";
import { CommandDispatchError } from "../command-dispatch-support.js";
import type { CommandOf } from "../command-dispatch-support.js";
import { refuseWhileHeld } from "./refuse-while-held.js";
import { resolveNonSymlinkDirectoryPath } from "./root-path.js";
import { resolveWriteTarget } from "./file-write.js";

function assertAbsolute(value: string, field: string): void {
  if (!path.isAbsolute(value)) {
    throw new CommandDispatchError("invalid_path", `${field} must be absolute`);
  }
}

async function requireRoot(
  rootPath: string | undefined,
): Promise<string | null> {
  if (rootPath === undefined) return null;
  assertAbsolute(rootPath, "rootPath");
  return resolveNonSymlinkDirectoryPath({
    description: "Root path",
    path: rootPath,
  });
}

function refuseOnWindows(action: string): void {
  if (process.platform === "win32") {
    throw new CommandDispatchError(
      "invalid_path",
      `Refusing to ${action}: this host cannot refuse links and aliases reliably on Windows, so the path cannot be proven to be what it names. Nothing was changed.`,
    );
  }
}

function refuseAlias(given: string, resolved: string): void {
  if (path.resolve(given) !== resolved) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${given}" reaches ${resolved} through a symbolic link or alias; pass the real path. Nothing was changed.`,
    );
  }
}

async function requireExistingWithin(
  targetPath: string,
  rootPath: string | undefined,
): Promise<{ target: string; root: string | null }> {
  assertAbsolute(targetPath, "Path");
  const targetInfo = await fs.lstat(targetPath);
  if (targetInfo.isSymbolicLink()) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${targetPath}" must not be a symbolic link`,
    );
  }
  const [target, root] = await Promise.all([
    fs.realpath(targetPath),
    requireRoot(rootPath),
  ]);
  refuseAlias(targetPath, target);
  if (root !== null && !isPathWithinDirectory(root, target)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${targetPath}" escapes root`,
    );
  }
  return { target, root };
}

async function requireDestinationWithin(
  destinationPath: string,
  rootPath: string | undefined,
): Promise<string> {
  assertAbsolute(destinationPath, "destinationPath");
  const [parent, root] = await Promise.all([
    fs.realpath(path.dirname(destinationPath)),
    requireRoot(rootPath),
  ]);
  refuseAlias(path.dirname(destinationPath), parent);
  const target = path.join(parent, path.basename(destinationPath));
  if (root !== null && !isPathWithinDirectory(root, target)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${destinationPath}" escapes root`,
    );
  }
  return target;
}

export async function mkdirHostPath(
  command: CommandOf<"host.mkdir">,
): Promise<HostDaemonOnlineRpcResult<"host.mkdir">> {
  assertAbsolute(command.path, "Path");
  const root = await requireRoot(command.rootPath);
  const target = await resolveWriteTarget(command.path, command.path);
  if (root !== null && !isPathWithinDirectory(root, target.writePath)) {
    throw new CommandDispatchError(
      "invalid_path",
      `Path "${command.path}" escapes root`,
    );
  }
  await fs.mkdir(target.writePath, { recursive: command.recursive });
  return { ok: true };
}

function refuseMove(sourcePath: string, reason: string): never {
  throw new CommandDispatchError(
    "invalid_path",
    `Refusing to move ${sourcePath}: ${reason}. Nothing was moved.`,
  );
}

export interface MoveHostFileHooks {
  afterOpen?: () => Promise<void>;
  afterLink?: () => Promise<void>;
  afterHold?: () => Promise<void>;
}

function isSameFile(
  info: { dev: number | bigint; ino: number | bigint; isFile(): boolean },
  opened: { dev: number | bigint; ino: number | bigint },
): boolean {
  return info.isFile() && info.dev === opened.dev && info.ino === opened.ino;
}

export async function moveHostFile(
  command: CommandOf<"host.move_file">,
  hooks: MoveHostFileHooks = {},
): Promise<HostDaemonOnlineRpcResult<"host.move_file">> {
  refuseOnWindows(`move ${command.sourcePath}`);
  const { target: source } = await requireExistingWithin(
    command.sourcePath,
    command.rootPath,
  );
  const destination = await requireDestinationWithin(
    command.destinationPath,
    command.rootPath,
  );
  let handle;
  try {
    handle = await fs.open(
      source,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      refuseMove(command.sourcePath, "it is a symbolic link or alias");
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      refuseMove(command.sourcePath, "it is not a single regular file");
    }
    await hooks.afterOpen?.();
    try {
      await fs.link(source, destination);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "EEXIST") {
        throw new CommandDispatchError(
          "path_exists",
          `Destination already exists: ${command.destinationPath}`,
        );
      }
      if (code === "EPERM" || code === "EISDIR" || code === "ENOENT") {
        refuseMove(
          command.sourcePath,
          "it is not a regular file that can be moved within one filesystem",
        );
      }
      if (code === "EXDEV") {
        refuseMove(
          command.sourcePath,
          "the destination is on another filesystem, and bb does not copy and delete",
        );
      }
      throw error;
    }
    const linked = await fs.lstat(destination);
    if (!isSameFile(linked, opened)) {
      await fs.unlink(destination);
      refuseMove(command.sourcePath, "it changed while it was being moved");
    }
    await hooks.afterLink?.();
    const holding = path.join(
      path.dirname(source),
      `.bb-moving-${randomUUID()}`,
    );
    try {
      await fs.rename(source, holding);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { ok: true };
      throw error;
    }
    const held = await fs.lstat(holding);
    if (isSameFile(held, opened)) {
      await fs.unlink(holding);
      return { ok: true };
    }
    const movedNote = `The file was moved to ${command.destinationPath}, but something else replaced ${command.sourcePath} while it was moving`;
    if (!held.isFile()) {
      throw new CommandDispatchError(
        "invalid_path",
        `${movedNote}. It is not a regular file, so it was left at ${holding} and not moved back.`,
      );
    }
    await hooks.afterHold?.();
    try {
      await fs.link(holding, source);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "";
      throw new CommandDispatchError(
        "invalid_path",
        `${movedNote}, and it could not be put back (${code || "error"}), so it was left at ${holding}.`,
      );
    }
    await fs.unlink(holding);
    return { ok: true };
  } finally {
    await handle.close();
  }
}

export async function removeHostPath(
  command: CommandOf<"host.remove_path">,
): Promise<HostDaemonOnlineRpcResult<"host.remove_path">> {
  refuseOnWindows(`remove ${command.path}`);
  const { target, root } = await requireExistingWithin(
    command.path,
    command.rootPath,
  );
  if (root !== null && target === root) {
    throw new CommandDispatchError(
      "invalid_path",
      "Cannot remove the declared root",
    );
  }
  const targetInfo = await fs.lstat(target);
  if (targetInfo.isDirectory() && command.recursive) {
    await refuseWhileHeld({ directory: target, action: "remove" });
  }
  if (targetInfo.isDirectory() && !command.recursive) {
    await fs.rmdir(target);
  } else {
    await fs.rm(target, { recursive: command.recursive, force: false });
  }
  return { ok: true };
}
