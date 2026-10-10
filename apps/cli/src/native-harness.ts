import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fillNativeTerminalTemplate,
  type ProviderNativeTerminal,
} from "@bb/domain";
import type { NativeTerminalLaunchSpec } from "@bb/server-contract";

const SESSION_HEADER_MAX_BYTES = 4 * 1024 * 1024;
const SESSION_CLOCK_SKEW_MS = 5_000;
const DAY_MS = 86_400_000;

export interface NativeHarnessLaunch {
  command: string;
  args: string[];
  discoverSession: boolean;
}

export type NativeHarnessEnv = Readonly<Record<string, string | undefined>>;

type DiscoveredSession = Extract<
  ProviderNativeTerminal["session"],
  { kind: "discovered" }
>;

function homeDir(env: NativeHarnessEnv): string {
  return env.HOME ?? os.homedir();
}

export function nativeSessionRoot(
  cli: ProviderNativeTerminal,
  env: NativeHarnessEnv,
): string {
  const override =
    cli.sessionRoot.env === null ? undefined : env[cli.sessionRoot.env];
  return override !== undefined && override.length > 0
    ? override
    : path.join(homeDir(env), cli.sessionRoot.home);
}

function listDirectory(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function segmentPattern(segment: string): RegExp {
  const source = segment
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "u");
}

export function expandSessionFiles(root: string, pattern: string): string[] {
  let current = [root];
  for (const segment of pattern.split("/")) {
    if (!segment.includes("*")) {
      current = current.map((dir) => path.join(dir, segment));
      continue;
    }
    const matcher = segmentPattern(segment);
    current = current.flatMap((dir) =>
      listDirectory(dir)
        .filter((name) => matcher.test(name))
        .map((name) => path.join(dir, name)),
    );
  }
  return current.filter(isFile);
}

function fill(
  values: readonly string[],
  tokens: Readonly<Record<string, string>>,
): string[] {
  return values.map((value) => fillNativeTerminalTemplate(value, tokens));
}

export function resolveNativeHarnessLaunch(
  spec: NativeTerminalLaunchSpec,
  env: NativeHarnessEnv,
): NativeHarnessLaunch {
  const { cli } = spec;
  const model =
    spec.model === null ? [] : fill(cli.modelArgs, { model: spec.model });
  const prompt = spec.initialPrompt === null ? [] : [spec.initialPrompt];
  const session = cli.session;
  if (session.kind === "assigned") {
    if (spec.nativeSessionId === null) {
      throw new Error(
        `${cli.executable} native threads need a preassigned session id`,
      );
    }
    const tokens = { sessionId: spec.nativeSessionId };
    const transcriptExists =
      expandSessionFiles(
        nativeSessionRoot(cli, env),
        fillNativeTerminalTemplate(session.transcript, tokens),
      ).length > 0;
    return {
      command: cli.executable,
      args: transcriptExists
        ? [...model, ...fill(session.resumeArgs, tokens)]
        : [...model, ...fill(session.startArgs, tokens), ...prompt],
      discoverSession: false,
    };
  }
  if (spec.nativeSessionId !== null) {
    return {
      command: cli.executable,
      args: [
        ...model,
        ...fill(session.resumeArgs, { sessionId: spec.nativeSessionId }),
      ],
      discoverSession: false,
    };
  }
  return {
    command: cli.executable,
    args: [...model, ...prompt],
    discoverSession: true,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function candidateDayTokens(
  times: readonly number[],
): Array<Record<string, string>> {
  const seen = new Map<string, Record<string, string>>();
  for (const time of times) {
    for (const offsetDays of [-1, 0]) {
      const day = new Date(time + offsetDays * DAY_MS);
      const tokens = {
        yyyy: String(day.getFullYear()),
        mm: pad(day.getMonth() + 1),
        dd: pad(day.getDate()),
      };
      seen.set(`${tokens.yyyy}-${tokens.mm}-${tokens.dd}`, tokens);
    }
  }
  return [...seen.values()];
}

function readFirstLine(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (total < SESSION_HEADER_MAX_BYTES) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) return null;
      const chunk = buffer.subarray(0, read);
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(chunk));
      total += read;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function readField(value: unknown, fieldPath: string): unknown {
  let current = value;
  for (const key of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

interface SessionHeader {
  id: string;
  cwd: string;
  startedAtMs: number;
}

function parseSessionHeader(
  line: string,
  header: DiscoveredSession["header"],
): SessionHeader | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  for (const [field, expected] of Object.entries(header.match)) {
    if (readField(json, field) !== expected) return null;
  }
  const id = readField(json, header.id);
  const cwd = readField(json, header.cwd);
  const startedAt = readField(json, header.startedAt);
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  if (typeof startedAt !== "string") return null;
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return null;
  return { id, cwd, startedAtMs };
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export type NativeSessionMatch =
  | { kind: "none" }
  | { kind: "unique"; sessionId: string }
  | { kind: "ambiguous"; sessionIds: string[] };

export function findNativeSession(args: {
  cli: ProviderNativeTerminal;
  cwd: string;
  env: NativeHarnessEnv;
  launchedAtMs: number;
  nowMs: number;
}): NativeSessionMatch {
  const session = args.cli.session;
  if (session.kind !== "discovered") return { kind: "none" };
  const root = nativeSessionRoot(args.cli, args.env);
  const sinceMs = args.launchedAtMs - SESSION_CLOCK_SKEW_MS;
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const tokens of candidateDayTokens([args.launchedAtMs, args.nowMs])) {
    for (const file of expandSessionFiles(
      root,
      fillNativeTerminalTemplate(session.transcripts, tokens),
    )) {
      files.add(file);
    }
  }
  for (const filePath of files) {
    let modifiedMs: number;
    try {
      modifiedMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedMs < sinceMs) continue;
    const line = readFirstLine(filePath);
    const header =
      line === null ? null : parseSessionHeader(line, session.header);
    if (header === null) continue;
    if (header.startedAtMs < sinceMs) continue;
    if (!samePath(header.cwd, args.cwd)) continue;
    ids.add(header.id);
  }
  if (ids.size === 0) return { kind: "none" };
  if (ids.size === 1) return { kind: "unique", sessionId: [...ids][0]! };
  return { kind: "ambiguous", sessionIds: [...ids].sort() };
}
