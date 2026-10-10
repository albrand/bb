import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NativeTerminalLaunchSpec } from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCodexRolloutSession,
  resolveNativeHarnessLaunch,
} from "../native-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-native-harness-"));
  roots.push(root);
  return root;
}

function spec(
  overrides: Partial<NativeTerminalLaunchSpec>,
): NativeTerminalLaunchSpec {
  return {
    threadId: "thr_native",
    harness: "claude",
    nativeSessionId: "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
    initialPrompt: null,
    model: null,
    ...overrides,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function writeRollout(args: {
  home: string;
  id: string;
  cwd: string;
  timestamp: Date;
}): string {
  const day = args.timestamp;
  const dir = path.join(
    args.home,
    ".codex",
    "sessions",
    String(day.getFullYear()),
    pad(day.getMonth() + 1),
    pad(day.getDate()),
  );
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-x-${args.id}.jsonl`);
  const meta = {
    timestamp: args.timestamp.toISOString(),
    type: "session_meta",
    payload: {
      id: args.id,
      cwd: args.cwd,
      timestamp: args.timestamp.toISOString(),
      base_instructions: { text: "x".repeat(200_000) },
    },
  };
  writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"event_msg"}\n`);
  const seconds = args.timestamp.getTime() / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}

describe("resolveNativeHarnessLaunch", () => {
  it("starts a fresh claude session with the preassigned id and first prompt", () => {
    const home = tempHome();
    expect(
      resolveNativeHarnessLaunch(
        spec({ initialPrompt: "fix the build", model: "opus" }),
        { HOME: home },
      ),
    ).toEqual({
      command: "claude",
      args: [
        "--model",
        "opus",
        "--session-id",
        "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
        "fix the build",
      ],
      discoverCodexSession: false,
    });
  });

  it("resumes a claude session once its transcript exists in any project dir", () => {
    const home = tempHome();
    const project = path.join(home, ".claude", "projects", "-tmp-worktree");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      path.join(project, "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b.jsonl"),
      "{}\n",
    );
    expect(resolveNativeHarnessLaunch(spec({}), { HOME: home }).args).toEqual([
      "--resume",
      "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
    ]);
  });

  it("honours CLAUDE_CONFIG_DIR when looking for the transcript", () => {
    const home = tempHome();
    const config = path.join(home, "pooled-claude");
    mkdirSync(path.join(config, "projects", "p"), { recursive: true });
    writeFileSync(
      path.join(
        config,
        "projects",
        "p",
        "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b.jsonl",
      ),
      "{}\n",
    );
    expect(
      resolveNativeHarnessLaunch(spec({}), {
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
      }).args[0],
    ).toBe("--resume");
  });

  it("launches codex fresh and asks for session discovery until an id is known", () => {
    expect(
      resolveNativeHarnessLaunch(
        spec({ harness: "codex", nativeSessionId: null, initialPrompt: "go" }),
        { HOME: tempHome() },
      ),
    ).toEqual({ command: "codex", args: ["go"], discoverCodexSession: true });
    expect(
      resolveNativeHarnessLaunch(
        spec({ harness: "codex", nativeSessionId: "abc-123", model: "gpt-6" }),
        { HOME: tempHome() },
      ),
    ).toEqual({
      command: "codex",
      args: ["resume", "-c", 'model="gpt-6"', "abc-123"],
      discoverCodexSession: false,
    });
  });
});

describe("findCodexRolloutSession", () => {
  it("finds the rollout started in this worktree after launch", () => {
    const home = tempHome();
    const launchedAtMs = Date.now();
    writeRollout({
      home,
      id: "11111111-aaaa-bbbb-cccc-000000000001",
      cwd: "/work/thread-a",
      timestamp: new Date(launchedAtMs + 1_000),
    });
    writeRollout({
      home,
      id: "11111111-aaaa-bbbb-cccc-000000000002",
      cwd: "/work/thread-b",
      timestamp: new Date(launchedAtMs + 1_000),
    });
    writeRollout({
      home,
      id: "11111111-aaaa-bbbb-cccc-000000000003",
      cwd: "/work/thread-a",
      timestamp: new Date(launchedAtMs - 60_000),
    });
    expect(
      findCodexRolloutSession({
        cwd: "/work/thread-a/",
        env: { HOME: home },
        launchedAtMs,
        nowMs: launchedAtMs + 2_000,
      }),
    ).toEqual({
      kind: "unique",
      sessionId: "11111111-aaaa-bbbb-cccc-000000000001",
    });
  });

  it("refuses to guess between two sessions started in the same worktree", () => {
    const home = tempHome();
    const launchedAtMs = Date.now();
    for (const suffix of ["1", "2"]) {
      writeRollout({
        home,
        id: `22222222-aaaa-bbbb-cccc-00000000000${suffix}`,
        cwd: "/work/shared",
        timestamp: new Date(launchedAtMs + 500),
      });
    }
    expect(
      findCodexRolloutSession({
        cwd: "/work/shared",
        env: { HOME: home },
        launchedAtMs,
        nowMs: launchedAtMs + 1_000,
      }).kind,
    ).toBe("ambiguous");
  });

  it("reports none when codex has not written a rollout yet", () => {
    expect(
      findCodexRolloutSession({
        cwd: "/work/none",
        env: { HOME: tempHome() },
        launchedAtMs: Date.now(),
        nowMs: Date.now(),
      }),
    ).toEqual({ kind: "none" });
  });
});
