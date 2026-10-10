import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NativeTerminalLaunchSpec } from "@bb/server-contract";
import { z } from "zod";

const ROLLOUT_HEADER_MAX_BYTES = 4 * 1024 * 1024;
const ROLLOUT_CLOCK_SKEW_MS = 5_000;

export interface NativeHarnessLaunch {
  command: string;
  args: string[];
  discoverCodexSession: boolean;
}

export type NativeHarnessEnv = Readonly<Record<string, string | undefined>>;

function homeDir(env: NativeHarnessEnv): string {
  return env.HOME ?? os.homedir();
}

export function claudeConfigDir(env: NativeHarnessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(homeDir(env), ".claude");
}

export function codexHome(env: NativeHarnessEnv): string {
  return env.CODEX_HOME ?? path.join(homeDir(env), ".codex");
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

export function claudeSessionFileExists(
  env: NativeHarnessEnv,
  sessionId: string,
): boolean {
  const projectsDir = path.join(claudeConfigDir(env), "projects");
  return listDirectory(projectsDir).some((project) =>
    isFile(path.join(projectsDir, project, `${sessionId}.jsonl`)),
  );
}

export function resolveNativeHarnessLaunch(
  spec: NativeTerminalLaunchSpec,
  env: NativeHarnessEnv,
): NativeHarnessLaunch {
  const prompt = spec.initialPrompt === null ? [] : [spec.initialPrompt];
  switch (spec.harness) {
    case "claude": {
      if (spec.nativeSessionId === null) {
        throw new Error("Claude native threads need a preassigned session id");
      }
      const model = spec.model === null ? [] : ["--model", spec.model];
      const session = claudeSessionFileExists(env, spec.nativeSessionId)
        ? ["--resume", spec.nativeSessionId]
        : ["--session-id", spec.nativeSessionId, ...prompt];
      return {
        command: "claude",
        args: [...model, ...session],
        discoverCodexSession: false,
      };
    }
    case "codex": {
      const model =
        spec.model === null
          ? []
          : ["-c", `model=${JSON.stringify(spec.model)}`];
      if (spec.nativeSessionId !== null) {
        return {
          command: "codex",
          args: ["resume", ...model, spec.nativeSessionId],
          discoverCodexSession: false,
        };
      }
      return {
        command: "codex",
        args: [...model, ...prompt],
        discoverCodexSession: true,
      };
    }
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function sessionDayDirs(root: string, times: readonly number[]): string[] {
  const dirs = new Set<string>();
  for (const time of times) {
    for (const offsetDays of [-1, 0]) {
      const day = new Date(time + offsetDays * 86_400_000);
      dirs.add(
        path.join(
          root,
          String(day.getFullYear()),
          pad(day.getMonth() + 1),
          pad(day.getDate()),
        ),
      );
    }
  }
  return [...dirs];
}

function readFirstLine(filePath: string): string | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (total < ROLLOUT_HEADER_MAX_BYTES) {
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
  } finally {
    closeSync(fd);
  }
}

interface RolloutSessionMeta {
  id: string;
  cwd: string;
  timestampMs: number;
}

const sessionMetaLineSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string().min(1),
    cwd: z.string().min(1),
    timestamp: z.string().min(1),
  }),
});

function parseSessionMeta(line: string): RolloutSessionMeta | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = sessionMetaLineSchema.safeParse(json);
  if (!parsed.success) return null;
  const timestampMs = Date.parse(parsed.data.payload.timestamp);
  if (Number.isNaN(timestampMs)) return null;
  return {
    id: parsed.data.payload.id,
    cwd: parsed.data.payload.cwd,
    timestampMs,
  };
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export type CodexRolloutMatch =
  | { kind: "none" }
  | { kind: "unique"; sessionId: string }
  | { kind: "ambiguous"; sessionIds: string[] };

export function findCodexRolloutSession(args: {
  cwd: string;
  env: NativeHarnessEnv;
  launchedAtMs: number;
  nowMs: number;
}): CodexRolloutMatch {
  const sessionsRoot = path.join(codexHome(args.env), "sessions");
  const sinceMs = args.launchedAtMs - ROLLOUT_CLOCK_SKEW_MS;
  const ids = new Set<string>();
  for (const dir of sessionDayDirs(sessionsRoot, [
    args.launchedAtMs,
    args.nowMs,
  ])) {
    for (const name of listDirectory(dir)) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, name);
      let modifiedMs: number;
      try {
        modifiedMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      if (modifiedMs < sinceMs) continue;
      const line = readFirstLine(filePath);
      const meta = line === null ? null : parseSessionMeta(line);
      if (meta === null) continue;
      if (meta.timestampMs < sinceMs) continue;
      if (!samePath(meta.cwd, args.cwd)) continue;
      ids.add(meta.id);
    }
  }
  if (ids.size === 0) return { kind: "none" };
  if (ids.size === 1) return { kind: "unique", sessionId: [...ids][0]! };
  return { kind: "ambiguous", sessionIds: [...ids].sort() };
}
