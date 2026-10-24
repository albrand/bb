import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  providerNativeTerminalActivitySchema,
  type ProviderNativeTerminalActivity,
} from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyHookRecord,
  classifyTranscriptRecord,
  fileSize,
  JsonlTail,
  nativeActivityHookSettings,
  NativeActivityTracker,
} from "../native-activity.js";
import { HookSpoolReader } from "../native-hook-spool.js";

const CLAUDE_ACTIVITY: ProviderNativeTerminalActivity =
  providerNativeTerminalActivitySchema.parse({
    hooks: {
      args: ["--settings", "{settings}"],
      working: ["UserPromptSubmit", "PreToolUse"],
      idle: ["Stop"],
      promptField: "prompt",
    },
    transcript: {
      working: [],
      idle: [
        {
          equals: { type: "user" },
          startsWith: {
            "message.content.0.text": "[Request interrupted by user",
          },
        },
      ],
      prompt: [],
    },
  });

const CODEX_ACTIVITY: ProviderNativeTerminalActivity =
  providerNativeTerminalActivitySchema.parse({
    transcript: {
      working: [
        { equals: { type: "event_msg", "payload.type": "task_started" } },
      ],
      idle: [
        { equals: { type: "event_msg", "payload.type": "task_complete" } },
        { equals: { type: "event_msg", "payload.type": "turn_aborted" } },
      ],
      prompt: [
        {
          match: {
            equals: { type: "event_msg", "payload.type": "user_message" },
          },
          text: "payload.message",
        },
        {
          match: {
            equals: {
              type: "event_msg",
              "payload.type": "item_completed",
              "payload.item.type": "UserMessage",
            },
          },
          text: "payload.item.content.0.text",
        },
      ],
    },
  });

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-native-activity-"));
  roots.push(root);
  return root;
}

describe("native terminal activity", () => {
  it("accepts a provider-declared hook identity field and rejects malformed paths", () => {
    expect(
      providerNativeTerminalActivitySchema.parse({
        hooks: {
          args: ["--settings", "{settings}"],
          working: ["Start"],
          idle: [],
          promptField: "prompt",
          sessionIdField: "session_id",
        },
      }).hooks?.sessionIdField,
    ).toBe("session_id");
    expect(() =>
      providerNativeTerminalActivitySchema.parse({
        hooks: {
          args: ["--settings", "{settings}"],
          working: ["Start"],
          idle: [],
          promptField: "prompt",
          sessionIdField: "session-id",
        },
      }),
    ).toThrow();
  });

  it("installs hooks that publish each event's input as its own numbered record, in order, and leave nothing else behind", () => {
    const hooks = {
      ...CLAUDE_ACTIVITY.hooks!,
      idle: [],
      pending: ["Stop"],
    };
    const spool = path.join(tempDir(), "it's spool");
    mkdirSync(spool);
    const settings = JSON.parse(nativeActivityHookSettings(hooks, spool));
    const home = tempDir();
    mkdirSync(path.join(home, ".claude"));
    const userSettings = path.join(home, ".claude", "settings.json");
    const existing =
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-stop-hook"}]}]}}';
    writeFileSync(userSettings, existing);
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    const command: string = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    for (const record of [
      { hook_event_name: "UserPromptSubmit", prompt: "fix the build" },
      { hook_event_name: "Stop" },
      { hook_event_name: "PreToolUse" },
      { hook_event_name: "Stop", stop_hook_active: true },
    ]) {
      const output = execFileSync("/bin/sh", ["-c", command], {
        env: { ...process.env, HOME: home },
        input: JSON.stringify(record),
      });
      expect(output.toString()).toBe("");
    }
    expect(readFileSync(userSettings, "utf8")).toBe(existing);
    expect(readdirSync(spool).sort()).toEqual([
      ".hint",
      "000000000001",
      "000000000002",
      "000000000003",
      "000000000004",
    ]);
    const signals = new HookSpoolReader(spool)
      .read()
      .records.map((record) => classifyHookRecord(hooks, record));
    expect(signals).toEqual([
      { state: "working", prompt: "fix the build" },
      { state: null, prompt: null },
      { state: "working", prompt: null },
      { state: null, prompt: null },
    ]);
  });

  it("reads a Claude interrupt and Codex turns from their session files", () => {
    const claude = CLAUDE_ACTIVITY.transcript!;
    expect(
      classifyTranscriptRecord(claude, {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[Request interrupted by user for tool use]",
            },
          ],
        },
      }),
    ).toEqual({ state: "idle", prompt: null });
    expect(
      classifyTranscriptRecord(claude, {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "ok" }],
        },
      }),
    ).toEqual({ state: null, prompt: null });
    expect(
      classifyTranscriptRecord(claude, {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "fix the build" }],
        },
      }),
    ).toEqual({ state: null, prompt: null });

    const codex = CODEX_ACTIVITY.transcript!;
    const event = (type: string, extra: Record<string, unknown> = {}) => ({
      type: "event_msg",
      payload: { type, ...extra },
    });
    expect(
      [
        event("task_started"),
        event("user_message", { message: "  add a test  " }),
        event("item_completed", {
          item: {
            type: "UserMessage",
            content: [{ type: "text", text: "count to five" }],
          },
        }),
        event("item_completed", {
          item: {
            type: "AgentMessage",
            content: [{ type: "Text", text: "counted" }],
          },
        }),
        event("token_count"),
        event("turn_aborted"),
        event("task_complete"),
      ].map((record) => classifyTranscriptRecord(codex, record)),
    ).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "add a test" },
      { state: "working", prompt: "count to five" },
      { state: null, prompt: null },
      { state: null, prompt: null },
      { state: "idle", prompt: null },
      { state: "idle", prompt: null },
    ]);
  });

  it("reads only records appended after launch when resuming, across partial writes", () => {
    const file = path.join(tempDir(), "session.jsonl");
    writeFileSync(file, `${JSON.stringify({ old: true })}\n`);
    const resumed = new JsonlTail(statSync(file).size);
    const fresh = new JsonlTail(0);
    expect(fresh.readRecords(file)).toEqual([{ old: true }]);

    appendFileSync(file, `${JSON.stringify({ n: 1 })}\n{"n":`);
    expect(resumed.readRecords(file)).toEqual([{ n: 1 }]);
    appendFileSync(file, `2}\nnot json\n`);
    expect(resumed.readRecords(file)).toEqual([{ n: 2 }]);
    expect(readFileSync(file, "utf8")).toContain("not json");
    expect(fileSize(file)).toBe(statSync(file).size);
    expect(fileSize(path.join(file, "missing"))).toBeNull();
    expect(new JsonlTail(0).readRecords(path.join(file, "missing"))).toEqual(
      [],
    );
  });

  it("reports byte offsets across resumed, malformed and split UTF-8 records", () => {
    const file = path.join(tempDir(), "offsets.jsonl");
    const old = '{"old":true}\n';
    writeFileSync(file, old);
    const tail = new JsonlTail(Buffer.byteLength(old));
    const large = {
      text: "x".repeat(4 * 1024 * 1024 - 20) + "\u{1f642}",
      uuid: "split",
    };
    const content = `not json\n${JSON.stringify(large)}\n${JSON.stringify({ uuid: "last" })}\n`;
    appendFileSync(file, content);
    const entries: { record: unknown; offset: number; length: number }[] = [];
    const accept = (
      record: unknown,
      location: { offset: number; length: number },
    ) => {
      entries.push({ record, ...location });
    };
    tail.readRecords(file, accept);
    expect(entries).toEqual([]);
    tail.readRecords(file, accept);
    expect(entries.map(({ record }) => record)).toEqual([
      large,
      { uuid: "last" },
    ]);
    const bytes = readFileSync(file);
    for (const entry of entries) {
      expect(
        JSON.parse(
          bytes
            .subarray(entry.offset, entry.offset + entry.length)
            .toString("utf8"),
        ),
      ).toEqual(entry.record);
    }
    expect(entries[0].offset).toBe(Buffer.byteLength(old + "not json\n"));
    writeFileSync(file, '{"uuid":"replacement"}\n');
    const replacement: unknown[] = [];
    tail.readRecords(file, (record, location) => {
      replacement.push(record);
      expect(location.offset).toBe(0);
    });
    expect(replacement).toEqual([{ uuid: "replacement" }]);
  });

  it("keeps a resumed turn written before the first poll", () => {
    const file = path.join(tempDir(), "rollout.jsonl");
    writeFileSync(file, `${JSON.stringify({ old: true })}\n`);
    const resumed = new JsonlTail(statSync(file).size);
    appendFileSync(
      file,
      [
        { type: "event_msg", payload: { type: "task_started" } },
        { type: "event_msg", payload: { type: "task_complete" } },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );
    const codex = CODEX_ACTIVITY.transcript!;
    expect(
      resumed
        .readRecords(file)
        .map((record) => classifyTranscriptRecord(codex, record)),
    ).toEqual([
      { state: "working", prompt: null },
      { state: "idle", prompt: null },
    ]);
  });

  it("reports each turn once, new prompts once, and idle on exit", () => {
    const tracker = new NativeActivityTracker();
    expect(tracker.apply({ state: "idle", prompt: null })).toBeNull();
    expect(tracker.apply({ state: "working", prompt: null })).toEqual({
      state: "working",
      prompt: null,
    });
    expect(tracker.apply({ state: "working", prompt: null })).toBeNull();
    expect(tracker.apply({ state: "working", prompt: "first" })).toEqual({
      state: "working",
      prompt: "first",
    });
    expect(tracker.apply({ state: "working", prompt: "first" })).toBeNull();
    expect(tracker.apply({ state: "idle", prompt: null })).toEqual({
      state: "idle",
      prompt: null,
    });
    expect(tracker.finish()).toBeNull();
    expect(tracker.heartbeat()).toBeNull();
    tracker.apply({ state: "working", prompt: "first" });
    expect(tracker.heartbeat()).toEqual({ state: "working", prompt: null });
    expect(tracker.finish()).toEqual({ state: "idle", prompt: null });
  });
});
