import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "bb-environment-provider-host/git";
import {
  findStructuralReasons,
  gitEnvironment,
  signalOptions,
  type WorktreeIdentity,
} from "./worktree-preservation.js";

export type CopyRecord =
  | { state: "pending" }
  | { state: "recorded"; sha256: string; size: number; mode: number };

export interface CreatedBy {
  head: string;
  copies: Map<string, CopyRecord>;
}

export interface CreatedByInspection {
  reasons: string[];
}

export function beginCopy(createdBy: CreatedBy, relativePath: string): void {
  createdBy.copies.set(relativePath, { state: "pending" });
}

async function fingerprint(
  file: string,
): Promise<{ sha256: string; size: number; mode: number } | null> {
  const before = await fs.lstat(file);
  if (!before.isFile()) return null;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  const after = await fs.lstat(file);
  if (!after.isFile() || after.size !== before.size) return null;
  return { sha256: hash.digest("hex"), size: after.size, mode: after.mode };
}

export interface SourceFingerprint {
  sha256: string;
  size: number;
}

export async function fingerprintSource(
  file: string,
): Promise<SourceFingerprint | null> {
  try {
    const print = await fingerprint(file);
    return print === null ? null : { sha256: print.sha256, size: print.size };
  } catch {
    return null;
  }
}

export async function recordCopy(
  createdBy: CreatedBy,
  relativePath: string,
  file: string,
  expected: SourceFingerprint | null,
): Promise<void> {
  if (expected === null) return;
  try {
    const print = await fingerprint(file);
    if (
      print !== null &&
      print.sha256 === expected.sha256 &&
      print.size === expected.size
    ) {
      createdBy.copies.set(relativePath, { state: "recorded", ...print });
    }
  } catch {
    return;
  }
}

type VerifyOutcome = "unchanged" | "missing" | "changed";

function isInsideWorktree(worktreePath: string, parentReal: string): boolean {
  const relative = path.relative(worktreePath, parentReal);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function verifyCopy(
  worktreePath: string,
  relativePath: string,
  record: CopyRecord,
): Promise<VerifyOutcome> {
  if (record.state !== "recorded") return "changed";
  const file = path.join(worktreePath, relativePath);
  try {
    const parentReal = await fs.realpath(path.dirname(file));
    if (!isInsideWorktree(worktreePath, parentReal)) return "changed";
    const print = await fingerprint(path.join(parentReal, path.basename(file)));
    if (print === null) return "changed";
    return print.sha256 === record.sha256 &&
      print.size === record.size &&
      print.mode === record.mode
      ? "unchanged"
      : "changed";
  } catch (error) {
    return error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "changed";
  }
}

function parseStatusEntries(stdout: string): {
  tracked: boolean;
  paths: string[];
} {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  let tracked = false;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === "") continue;
    const code = field.slice(0, 2);
    if (code === "??" || code === "!!") {
      paths.push(field.slice(3));
      continue;
    }
    tracked = true;
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
  }
  return { tracked, paths };
}

export async function inspectCreatedBy(
  identity: WorktreeIdentity,
  createdBy: CreatedBy,
  signal: AbortSignal | undefined,
): Promise<CreatedByInspection> {
  const reasons = await findStructuralReasons(identity);
  const gitOptions = {
    cwd: identity.path,
    env: gitEnvironment(identity.path),
    allowFailure: true,
    ...signalOptions(signal),
  };

  const head = await runGit(
    ["--no-optional-locks", "rev-parse", "HEAD"],
    gitOptions,
  );
  if (head.exitCode !== 0) {
    reasons.push("could not read HEAD");
  } else if (head.stdout.trim() !== createdBy.head) {
    reasons.push("has a HEAD that changed since this attempt created it");
  }

  const unresolved = [...createdBy.copies.values()].some(
    (record) => record.state !== "recorded",
  );
  if (unresolved) {
    reasons.push("holds a copy whose contents bb could not record");
  }

  const status = await runGit(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=traditional",
      "--ignore-submodules=none",
    ],
    gitOptions,
  );
  if (status.exitCode !== 0) {
    reasons.push("could not read its Git status");
  } else {
    const entries = parseStatusEntries(status.stdout);
    if (entries.tracked) {
      reasons.push("has changes to tracked files");
    }
    let foreign = 0;
    for (const entry of entries.paths) {
      const record = entry.endsWith("/")
        ? undefined
        : createdBy.copies.get(entry);
      if (record === undefined) {
        foreign += 1;
      }
    }
    if (foreign > 0) {
      reasons.push(
        `has ${foreign} file(s) or folder(s) that bb did not create`,
      );
    }
  }

  for (const [relativePath, record] of createdBy.copies) {
    const outcome = await verifyCopy(identity.path, relativePath, record);
    if (outcome === "changed") {
      if (record.state === "recorded") {
        reasons.push("holds a copy that changed after bb made it");
      }
    }
  }
  return { reasons };
}

export interface RetainedCopies {
  directory: string;
  count: number;
}

export interface RetainCopiesResult {
  retained: RetainedCopies | null;
  reasons: string[];
}

function errorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code!
    : null;
}

export function describeRetainedCopies(retained: RetainedCopies): string {
  return `Kept ${retained.count} file(s) bb copied from .worktreeinclude at ${retained.directory} (each under its path in the worktree). They may hold secrets such as .env files and use disk. bb does not delete them automatically, but the folder exists only on this machine, so destroying the machine would lose it.`;
}

export async function retainCreatedCopies(
  identity: WorktreeIdentity,
  createdBy: CreatedBy,
  retainedRoot: string | undefined,
): Promise<RetainCopiesResult> {
  const present: string[] = [];
  for (const relativePath of [...createdBy.copies.keys()].sort()) {
    try {
      await fs.lstat(path.join(identity.path, relativePath));
      present.push(relativePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return {
          retained: null,
          reasons: ["could not check a copy it made before keeping it"],
        };
      }
    }
  }
  if (present.length === 0) return { retained: null, reasons: [] };
  if (retainedRoot === undefined) {
    return {
      retained: null,
      reasons: ["has no private folder to keep the copies it made in"],
    };
  }

  let directory: string;
  let directoryDevice: number;
  try {
    await fs.mkdir(retainedRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await fs.lstat(retainedRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      return {
        retained: null,
        reasons: ["its private folder for kept copies is not a plain folder"],
      };
    }
    directory = await fs.mkdtemp(path.join(retainedRoot, "failed-create-"));
    await fs.chmod(directory, 0o700);
    directoryDevice = (await fs.stat(directory)).dev;
  } catch {
    return {
      retained: null,
      reasons: [
        "could not prepare a private folder to keep the copies it made",
      ],
    };
  }

  let count = 0;
  const finish = (reason: string): RetainCopiesResult => ({
    retained: count > 0 ? { directory, count } : null,
    reasons: [reason],
  });
  for (const relativePath of present) {
    const file = path.join(identity.path, relativePath);
    let source: string;
    try {
      const parentReal = await fs.realpath(path.dirname(file));
      if (!isInsideWorktree(identity.path, parentReal)) {
        return finish("has a copy whose folder now resolves outside it");
      }
      source = path.join(parentReal, path.basename(file));
      const info = await fs.lstat(source);
      if (!info.isFile()) {
        return finish("has a copy that is no longer a plain file");
      }
      if (info.dev !== directoryDevice) {
        return finish(
          "has a copy on a different filesystem than the private folder",
        );
      }
      const destination = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      try {
        await fs.lstat(destination);
        return finish("found its private folder already occupied");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          return finish("could not check its private folder");
        }
      }
      await fs.rename(source, destination);
      count += 1;
    } catch (error) {
      return finish(
        errorCode(error) === "EXDEV"
          ? "has a copy on a different filesystem than the private folder"
          : "could not move a copy it made to its private folder",
      );
    }
  }
  return { retained: { directory, count }, reasons: [] };
}
