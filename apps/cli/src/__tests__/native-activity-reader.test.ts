import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  providerNativeTerminalActivitySchema,
  type ProviderNativeTerminal,
} from "@bb/domain";
import { BbHttpError, BbRequestTimeoutError } from "@bb/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlTail } from "../native-activity.js";
import { publishHooks } from "./helpers/hook-spool.js";
import { createNativeActivityReporter } from "../native-activity-reporter.js";
import { createNativeActivityWiring } from "../native-activity-wiring.js";
import { EvictedRecordIndex } from "../native-activity-index.js";
import {
  MAX_SESSION_ADOPTIONS,
  measureResumedTranscript,
  NativeActivityReader,
} from "../native-activity-reader.js";
interface ClaudePluginTestHost {
  bb: unknown;
  harness: {
    registrations: {
      providerRegistrations: {
        id: string;
        experimental_nativeTerminal?: ProviderNativeTerminal;
      }[];
    };
  };
}

const {
  createFakePluginHost,
}: {
  createFakePluginHost(options: { pluginId: string }): ClaudePluginTestHost;
} = await import(
  new URL(
    "../../../../packages/plugin-sdk/src/testing/fake-plugin-host.ts",
    import.meta.url,
  ).href
);
const { default: claudeCodePlugin }: { default(bb: unknown): void } =
  await import(
    new URL(
      "../../../../plugins/provider-claude-code/server.ts",
      import.meta.url,
    ).href
  );

const CODEX_CLI: ProviderNativeTerminal = {
  executable: "codex",
  launchArgs: ["--no-daemon"],
  modelArgs: ["-c", 'model="{model}"'],
  imageArgs: ["--image", "{image}"],
  pastePlaceholders: [],
  sessionRoot: { env: "CODEX_HOME", home: ".codex" },
  session: {
    kind: "discovered",
    resumeArgs: ["resume", "{sessionId}"],
    transcripts: "sessions/{yyyy}/{mm}/{dd}/rollout-*.jsonl",
    header: {
      match: { type: "session_meta" },
      id: "payload.id",
      cwd: "payload.cwd",
      startedAt: "payload.timestamp",
    },
  },
  activity: providerNativeTerminalActivitySchema.parse({
    transcript: {
      working: [
        { equals: { type: "event_msg", "payload.type": "task_started" } },
      ],
      idle: [
        { equals: { type: "event_msg", "payload.type": "task_complete" } },
      ],
      prompt: [
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
  }),
};

const CLAUDE_CLI: ProviderNativeTerminal = {
  executable: "claude",
  launchArgs: [],
  modelArgs: ["--model", "{model}"],
  imageArgs: [],
  pastePlaceholders: [],
  sessionRoot: { env: "CLAUDE_CONFIG_DIR", home: ".claude" },
  session: {
    kind: "assigned",
    startArgs: ["--session-id", "{sessionId}"],
    resumeArgs: ["--resume", "{sessionId}"],
    transcript: "projects/*/{sessionId}.jsonl",
  },
  activity: providerNativeTerminalActivitySchema.parse({
    hooks: {
      args: ["--settings", "{settings}"],
      working: ["UserPromptSubmit", "PreToolUse"],
      idle: ["Stop"],
      promptField: "prompt",
    },
  }),
};

const SESSION_ID = "019a1f3e-0000-7000-8000-000000000001";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-native-reader-"));
  roots.push(root);
  return root;
}

function jsonl(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function codexTurn(prompt: string): unknown[] {
  return [
    { type: "event_msg", payload: { type: "task_started" } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          content: [{ type: "text", text: prompt }],
        },
      },
    },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
}

function writeRollout(home: string, records: unknown[]): string {
  const dir = path.join(home, ".codex", "sessions", "2026", "10", "11");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-x-${SESSION_ID}.jsonl`);
  const header = {
    type: "session_meta",
    payload: {
      id: SESSION_ID,
      cwd: "/work/a",
      timestamp: "2026-10-11T10:00:00Z",
    },
  };
  writeFileSync(file, jsonl([header, ...records]));
  return file;
}

function claudeFixture(
  extraWorking: boolean = false,
  onUnconfirmed?: (total: number) => void,
  onUnconfirmedHookIdentity?: (
    reason:
      | "missing-session"
      | "foreign-session"
      | "held-overflow"
      | "unreadable-record",
    total: number,
  ) => void,
  onSessionAdopted?: (sessionId: string, previousSessionId: string) => void,
  acceptRotationAtOnce: boolean = true,
) {
  const host = createFakePluginHost({ pluginId: "provider-claude-code" });
  claudeCodePlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "claude-code",
  );
  const cli = declaration?.experimental_nativeTerminal;
  if (cli === undefined) throw new Error("Claude native declaration missing");
  const activity = cli.activity;
  if (activity?.transcript === undefined)
    throw new Error("Claude transcript missing");
  const native = extraWorking
    ? {
        ...cli,
        activity: {
          ...activity,
          transcript: {
            ...activity.transcript,
            working: [{ equals: { type: "assistant", isSidechain: false } }],
          },
        },
      }
    : cli;
  const home = tempHome();
  const dir = path.join(home, ".claude", "projects", "work");
  mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${SESSION_ID}.jsonl`);
  const events = path.join(home, "hooks.jsonl");
  let clock = Date.parse("2026-10-11T10:00:00Z");
  const stamped = (records: unknown[]) =>
    records.map((record) => {
      if (typeof record !== "object" || record === null) return record;
      const timestamp =
        "timestamp" in record
          ? record.timestamp
          : new Date(++clock).toISOString();
      const parsed =
        typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
      if (Number.isFinite(parsed)) clock = Math.max(clock, parsed);
      return { ...record, timestamp };
    });
  writeFileSync(
    transcript,
    jsonl(
      stamped([
        {
          type: "user",
          uuid: "user-1",
          parentUuid: null,
          promptId: "turn-1",
          origin: { kind: "human" },
          message: { content: "first prompt" },
        },
        {
          type: "assistant",
          isSidechain: false,
          uuid: "answer-1",
          parentUuid: "user-1",
          message: {
            id: "message-1",
            content: [{ type: "text", text: "first answer" }],
          },
        },
      ]),
    ),
  );
  publishHooks(
    events,
    jsonl([
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION_ID,
        prompt_id: "turn-1",
        prompt: "first prompt",
      },
    ]),
  );
  let created: NativeActivityReader | undefined;
  const reader = new NativeActivityReader(
    native,
    { HOME: home },
    events,
    {
      kind: "start",
      id: SESSION_ID,
    },
    onUnconfirmed,
    onUnconfirmedHookIdentity,
    onSessionAdopted === undefined
      ? undefined
      : (sessionId, previousSessionId) => {
          onSessionAdopted(sessionId, previousSessionId);
          if (acceptRotationAtOnce) created?.sessionRebound(sessionId);
        },
  );
  created = reader;
  expect(reader.read()).toEqual([{ state: "working", prompt: "first prompt" }]);
  return {
    reader,
    dir,
    transcript,
    hook: (records: unknown[]) =>
      publishHooks(
        events,
        jsonl(
          records.map((record) => ({
            session_id: SESSION_ID,
            ...(typeof record === "object" && record !== null ? record : {}),
          })),
        ),
      ),
    append: (records: unknown[]) =>
      appendFileSync(transcript, jsonl(stamped(records))),
  };
}

function finalClaudeStop(fixture: ReturnType<typeof claudeFixture>) {
  fixture.hook([
    { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: false },
  ]);
  fixture.append([
    {
      type: "system",
      subtype: "stop_hook_summary",
      isSidechain: false,
      hasOutput: false,
      uuid: "end-1",
      parentUuid: "answer-1",
    },
  ]);
  expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
  expect(fixture.reader.heartbeat()).toBeNull();
}

function retainedIdentitySizes(reader: NativeActivityReader) {
  const recordTurns: unknown = Reflect.get(reader, "recordTurns");
  const recordParents: unknown = Reflect.get(reader, "recordParents");
  const knownTurns: unknown = Reflect.get(reader, "knownTurns");
  const completedTurns: unknown = Reflect.get(reader, "completedTurns");
  const recentEvictedIds: unknown = Reflect.get(reader, "recentEvictedIds");
  if (
    !(recordTurns instanceof Map) ||
    !(recordParents instanceof Map) ||
    !(knownTurns instanceof Set) ||
    !(completedTurns instanceof Map) ||
    !(recentEvictedIds instanceof Set)
  ) {
    throw new Error("Native reader identity state unavailable");
  }
  return {
    recordTurns: recordTurns.size,
    recordParents: recordParents.size,
    knownTurns: knownTurns.size,
    completedTurns: completedTurns.size,
    recentEvictedIds: recentEvictedIds.size,
  };
}

describe("NativeActivityReader session rotation", () => {
  const ROTATED = "5c0ffee0-1111-4222-8333-444455556666";
  type Fixture = ReturnType<typeof claudeFixture>;

  const continuedIn = (nextSessionId: string) => ({
    type: "continued-in",
    continuedInSessionId: nextSessionId,
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
  });

  function startRotation(
    fixture: Fixture,
    options: { sessionId?: string; continuation?: boolean } = {},
  ): string {
    const sessionId = options.sessionId ?? ROTATED;
    const file = path.join(fixture.dir, `${sessionId}.jsonl`);
    writeFileSync(file, "");
    if (options.continuation !== false) {
      appendFileSync(fixture.transcript, jsonl([continuedIn(sessionId)]));
    }
    return file;
  }

  const rotatedPrompt = (sessionId = ROTATED) => ({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt_id: `turn-${sessionId}`,
    prompt: "second prompt",
  });

  const adoptions =
    (list: Array<[string, string]>) => (id: string, previous: string) => {
      list.push([id, previous]);
    };

  it("adopts the session the bound transcript continues into, and reads its questions", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    finalClaudeStop(fixture);
    fixture.reader.read();
    const next = startRotation(fixture);
    fixture.hook([rotatedPrompt()]);
    expect(fixture.reader.read()).toEqual([
      { state: "working", prompt: "second prompt" },
    ]);
    expect(adopted).toEqual([[ROTATED, SESSION_ID]]);

    appendFileSync(
      next,
      jsonl([
        {
          type: "assistant",
          isSidechain: false,
          uuid: "ask-1",
          parentUuid: null,
          promptId: `turn-${ROTATED}`,
          timestamp: new Date().toISOString(),
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_ask",
                name: "AskUserQuestion",
                input: { questions: [{ question: "Which layout?" }] },
              },
            ],
          },
        },
      ]),
    );
    expect(fixture.reader.read()).toEqual([
      {
        state: "waiting",
        prompt: null,
        questions: [{ id: "toolu_ask", prompt: "Which layout?" }],
      },
    ]);
  });

  it("negative control: a foreign session with no continuation record is ignored, even with a fresh transcript", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    startRotation(fixture, { continuation: false });
    fixture.hook([rotatedPrompt()]);
    expect(fixture.reader.read()).toEqual([]);
    expect(adopted).toEqual([]);
  });

  it("negative control: a continuation naming a different session does not adopt this one", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    startRotation(fixture, { continuation: false });
    appendFileSync(
      fixture.transcript,
      jsonl([continuedIn("9f0ffee0-1111-4222-8333-444455556666")]),
    );
    fixture.hook([rotatedPrompt()]);
    expect(fixture.reader.read()).toEqual([]);
    expect(adopted).toEqual([]);
  });

  it("negative control: a continuation in some other transcript does not count", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    startRotation(fixture, { continuation: false });
    writeFileSync(
      path.join(fixture.dir, "aaaaaaaa-1111-4222-8333-444455556666.jsonl"),
      jsonl([continuedIn(ROTATED)]),
    );
    fixture.hook([rotatedPrompt()]);
    expect(fixture.reader.read()).toEqual([]);
    expect(adopted).toEqual([]);
  });

  it("negative control: a replay of the session already left is never adopted again", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    const next = startRotation(fixture);
    fixture.hook([rotatedPrompt()]);
    fixture.reader.read();
    expect(adopted).toEqual([[ROTATED, SESSION_ID]]);

    appendFileSync(next, jsonl([continuedIn(SESSION_ID)]));
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION_ID,
        prompt_id: "turn-1-replayed",
        prompt: "replayed prompt",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(adopted).toEqual([[ROTATED, SESSION_ID]]);
  });

  it("negative control: hooks that arrive before the continuation record are held, not applied, and applied once it exists", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    startRotation(fixture, { continuation: false });
    fixture.hook([rotatedPrompt()]);
    expect(fixture.reader.read()).toEqual([]);
    expect(adopted).toEqual([]);

    appendFileSync(fixture.transcript, jsonl([continuedIn(ROTATED)]));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_000);
    expect(fixture.reader.read()).toEqual([
      { state: "working", prompt: "second prompt" },
    ]);
    expect(adopted).toEqual([[ROTATED, SESSION_ID]]);
  });

  it("does not adopt an id that is not a session id, even with a continuation and a transcript", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    const odd = "NOT-a-hex-session";
    writeFileSync(path.join(fixture.dir, `${odd}.jsonl`), "");
    appendFileSync(fixture.transcript, jsonl([continuedIn(odd)]));
    fixture.hook([rotatedPrompt(odd)]);
    expect(fixture.reader.read()).toEqual([]);
    expect(adopted).toEqual([]);
  });

  it("adopts when other records were written after the continuation record", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    startRotation(fixture);
    appendFileSync(
      fixture.transcript,
      jsonl([
        { type: "system", subtype: "turn_duration", isSidechain: false },
        { type: "last-prompt", lastPrompt: "x" },
      ]),
    );
    fixture.hook([rotatedPrompt()]);
    expect(fixture.reader.read()).toEqual([
      { state: "working", prompt: "second prompt" },
    ]);
    expect(adopted).toEqual([[ROTATED, SESSION_ID]]);
  });

  it("negative control: a continuation older than the tail window does not count", () => {
    const adopted: Array<[string, string]> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      adoptions(adopted),
    );
    startRotation(fixture);
    const filler = { type: "system", subtype: "filler", text: "x".repeat(900) };
    appendFileSync(
      fixture.transcript,
      jsonl(Array.from({ length: 120 }, () => filler)),
    );
    fixture.hook([rotatedPrompt()]);
    expect(fixture.reader.read()).toEqual([]);
    expect(adopted).toEqual([]);
  });

  it("makes the cap visible: past it the thread stops confirming and the drop is reported", () => {
    const adopted: Array<[string, string]> = [];
    const drops: Array<{ reason: string; total: number }> = [];
    const fixture = claudeFixture(
      false,
      undefined,
      (reason, total) => drops.push({ reason, total }),
      adoptions(adopted),
    );
    let current = fixture.transcript;
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const rotate = (index: number) => {
      const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const next = path.join(fixture.dir, `${sessionId}.jsonl`);
      writeFileSync(next, "");
      appendFileSync(current, jsonl([continuedIn(sessionId)]));
      current = next;
      clock += 3_000;
      fixture.hook([rotatedPrompt(sessionId)]);
      return fixture.reader.read();
    };
    for (let index = 0; index < MAX_SESSION_ADOPTIONS; index += 1) {
      rotate(index);
    }
    expect(adopted).toHaveLength(MAX_SESSION_ADOPTIONS);
    expect(fixture.reader.heartbeat()).not.toBeNull();
    expect(drops).toEqual([]);

    expect(rotate(MAX_SESSION_ADOPTIONS)).toEqual([]);
    expect(adopted).toHaveLength(MAX_SESSION_ADOPTIONS);
    expect(fixture.reader.heartbeat()).toBeNull();
    expect(drops.at(-1)?.reason).toBe("foreign-session");
  });

  it("stops reporting and confirming once suspended, so the thread shows Activity not reported", () => {
    const fixture = claudeFixture();
    startRotation(fixture);
    fixture.hook([rotatedPrompt()]);
    expect(fixture.reader.read()).toHaveLength(1);
    expect(fixture.reader.heartbeat()).not.toBeNull();

    fixture.reader.suspend();
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        session_id: ROTATED,
        prompt_id: "after-suspend",
        prompt: "ignored",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
  });

  it("reports each identity drop with its reason and no event content", () => {
    const drops: Array<{ reason: string; total: number }> = [];
    const fixture = claudeFixture(false, undefined, (reason, total) =>
      drops.push({ reason, total }),
    );
    fixture.hook([rotatedPrompt()]);
    fixture.reader.read();
    expect(drops).toEqual([{ reason: "foreign-session", total: 1 }]);
    expect(JSON.stringify(drops)).not.toContain("second prompt");
  });
});

describe("NativeActivityReader", () => {
  it("does not recover from a matching Stop, unknown event, or unmatched permission close", () => {
    const fixture = claudeFixture();
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "foreign-session",
        prompt_id: "foreign-turn",
        prompt: "foreign prompt",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    const quarantinedOffset = Reflect.get(
      fixture.reader,
      "unconfirmedTranscriptOffset",
    );
    expect(typeof quarantinedOffset).toBe("number");
    expect(quarantinedOffset).toBeGreaterThan(0);
    fixture.hook([{ hook_event_name: "Stop", prompt_id: "turn-1" }]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
    fixture.hook([{ hook_event_name: "Notification", prompt_id: "turn-1" }]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
    fixture.hook([
      {
        hook_event_name: "PostToolUse",
        prompt_id: "turn-1",
        tool_name: "Bash",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
    expect(Reflect.get(fixture.reader, "unconfirmedTranscriptOffset")).toBe(
      quarantinedOffset,
    );
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        prompt_id: "turn-1",
        prompt: "fresh current turn evidence",
      },
    ]);
    expect(fixture.reader.read()).toEqual([
      { state: "working", prompt: "fresh current turn evidence" },
    ]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
  });

  it.each(["known", "completed"] as const)(
    "does not recover from a matching working hook for a %s turn",
    (turnStatus) => {
      const fixture = claudeFixture();
      if (turnStatus === "completed") finalClaudeStop(fixture);
      fixture.hook([
        {
          hook_event_name: "UserPromptSubmit",
          prompt_id: "turn-current",
          prompt: "current turn",
        },
      ]);
      expect(fixture.reader.read()).toEqual([
        { state: "working", prompt: "current turn" },
      ]);
      fixture.hook([
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "foreign-session",
          prompt_id: "foreign-turn",
          prompt: "foreign prompt",
        },
      ]);
      expect(fixture.reader.read()).toEqual([]);
      fixture.hook([
        {
          hook_event_name: "UserPromptSubmit",
          prompt_id: "turn-1",
          prompt: "replayed old turn",
        },
      ]);
      expect(fixture.reader.read()).toEqual([]);
      expect(fixture.reader.heartbeat()).toBeNull();
    },
  );

  it("recovers on a bound permission close only when that permission is open", () => {
    const fixture = claudeFixture();
    fixture.hook([
      {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "make" },
      },
    ]);
    expect(fixture.reader.read()).toEqual([
      {
        state: "waiting",
        prompt: null,
        questions: [
          {
            id: expect.stringMatching(/^permission:Bash#[0-9a-f]{16}\.1$/u),
            prompt: "Claude Code needs permission to use: Bash",
          },
        ],
      },
    ]);
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "foreign-session",
        prompt_id: "foreign-turn",
        prompt: "foreign prompt",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
    fixture.hook([
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_make",
        tool_input: { command: "make" },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
  });

  it("bounds foreign-hook diagnostics per read and reports the cumulative count", () => {
    const diagnostics: { reason: string; total: number }[] = [];
    const fixture = claudeFixture(false, undefined, (reason, total) => {
      diagnostics.push({ reason, total });
    });
    const foreignRecords = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        hook_event_name: "UserPromptSubmit",
        session_id: "foreign-session",
        prompt_id: `foreign-turn-${index}`,
        prompt: "foreign prompt",
      }));
    fixture.hook(foreignRecords(1000));
    expect(fixture.reader.read()).toEqual([]);
    fixture.hook(foreignRecords(500));
    expect(fixture.reader.read()).toEqual([]);
    expect(diagnostics).toEqual([
      { reason: "foreign-session", total: 1000 },
      { reason: "foreign-session", total: 1500 },
    ]);
  });

  it("holds hooks before discovery and rejects those of another session, rejects stale transcript replay, then recovers on bound evidence", () => {
    const diagnostics: string[] = [];
    const host = createFakePluginHost({ pluginId: "provider-claude-code" });
    claudeCodePlugin(host.bb);
    const cli = host.harness.registrations.providerRegistrations.find(
      (entry) => entry.id === "claude-code",
    )?.experimental_nativeTerminal;
    if (cli === undefined) throw new Error("Claude native declaration missing");
    const home = tempHome();
    const events = path.join(home, "hooks.jsonl");
    const transcript = path.join(
      home,
      ".claude",
      "projects",
      "work",
      `${SESSION_ID}.jsonl`,
    );
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, "");
    mkdirSync(events, { recursive: true });
    const reader = new NativeActivityReader(
      cli,
      { HOME: home },
      events,
      { kind: "discover" },
      undefined,
      (reason) => diagnostics.push(reason),
    );
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "other-session",
          prompt_id: "unbound-turn",
          prompt: "private",
        },
      ]),
    );
    expect(reader.read()).toEqual([]);
    expect(Reflect.get(reader, "currentTurn")).toBeNull();
    reader.sessionDiscovered(SESSION_ID);
    appendFileSync(
      transcript,
      jsonl([
        {
          type: "assistant",
          isSidechain: false,
          uuid: "old-bound-answer",
          parentUuid: null,
          promptId: "old-bound-turn",
          timestamp: "2026-10-20T12:00:00.000Z",
          message: { content: [{ type: "text", text: "stale" }] },
        },
      ]),
    );
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "foreign",
          prompt_id: "foreign-turn",
          prompt: "private",
        },
      ]),
    );
    expect(reader.read()).toEqual([]);
    expect(Reflect.get(reader, "currentTurn")).toBeNull();
    expect(reader.heartbeat()).toBeNull();
    const mismatchBoundary = Reflect.get(reader, "unconfirmedTranscriptOffset");
    expect(mismatchBoundary).toBe(statSync(transcript).size);
    appendFileSync(
      transcript,
      jsonl([
        {
          type: "user",
          uuid: "fresh-bound-user",
          parentUuid: null,
          promptId: "fresh-bound-turn",
          timestamp: "2026-10-20T12:00:01.000Z",
          origin: { kind: "human" },
          message: { content: "fresh" },
        },
      ]),
    );
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "foreign",
          prompt_id: "repeated-foreign-turn",
        },
      ]),
    );
    expect(reader.read()).toEqual([{ state: "working", prompt: null }]);
    expect(Reflect.get(reader, "currentTurn")).toBe("fresh-bound-turn");
    expect(Reflect.get(reader, "unconfirmedTranscriptOffset")).toBeNull();
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "PermissionRequest",
          session_id: "foreign",
          tool_name: "Bash",
        },
      ]),
    );
    expect(reader.read()).toEqual([]);
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_ID,
          prompt_id: "bound-turn",
          prompt: "bound prompt",
        },
      ]),
    );
    expect(reader.read()).toEqual([
      { state: "working", prompt: "bound prompt" },
    ]);
    expect(Reflect.get(reader, "currentTurn")).toBe("bound-turn");
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "PermissionRequest",
          session_id: SESSION_ID,
          tool_name: "Bash",
        },
      ]),
    );
    expect(reader.read()).toEqual([
      { state: "waiting", prompt: null, questions: expect.any(Array) },
    ]);
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "PostToolUse",
          session_id: "foreign",
          tool_name: "Bash",
        },
      ]),
    );
    expect(reader.read()).toEqual([]);
    expect(reader.heartbeat()).toBeNull();
    const tracker: unknown = Reflect.get(reader, "tracker");
    const questions: unknown =
      typeof tracker === "object" && tracker !== null
        ? Reflect.get(tracker, "questions")
        : undefined;
    expect(
      questions instanceof Map &&
        [...questions.keys()].some(
          (id) =>
            typeof id === "string" &&
            /^permission:Bash#[0-9a-f]{16}\.1$/u.test(id),
        ),
    ).toBe(true);
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_ID,
          prompt_id: "bound-turn",
          prompt: "bound recovery prompt",
        },
      ]),
    );
    expect(reader.read()).toEqual([
      { state: "working", prompt: "bound recovery prompt" },
    ]);
    expect(reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    publishHooks(
      events,
      jsonl([
        {
          hook_event_name: "Stop",
          session_id: "foreign",
          prompt_id: "bound-turn",
        },
      ]),
    );
    expect(reader.read()).toEqual([]);
    expect(reader.heartbeat()).toBeNull();
    expect(diagnostics).toEqual([
      "foreign-session",
      "foreign-session",
      "foreign-session",
      "foreign-session",
      "foreign-session",
    ]);
  });

  it("keeps foreign and identity-less hooks from changing a bound turn; transcript summary alone settles it", () => {
    const fixture = claudeFixture();
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "foreign",
        prompt_id: "foreign-turn",
        prompt: "other",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(Reflect.get(fixture.reader, "currentTurn")).toBe("turn-1");
    expect(fixture.reader.heartbeat()).toBeNull();
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        session_id: null,
        prompt_id: "missing-turn",
        prompt: "other",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(Reflect.get(fixture.reader, "currentTurn")).toBe("turn-1");
    fixture.hook([{ hook_event_name: "Stop", prompt_id: "turn-1" }]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
    fixture.hook([{ hook_event_name: "PreToolUse", prompt_id: "turn-1" }]);
    expect(fixture.reader.read()).toEqual([]);
    fixture.hook([{ hook_event_name: "Stop", prompt_id: "turn-1" }]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "bound-stop-summary",
        parentUuid: "answer-1",
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
  });

  it("treats an evicted identity whose stored line was rewritten as unconfirmed, counts it and logs it", () => {
    const counts: number[] = [];
    const fixture = claudeFixture(false, (total) => counts.push(total));
    fixture.append(
      Array.from({ length: 9500 }, (_, index) => ({
        type: "progress",
        uuid: `rewritten-progress-${index}`,
        parentUuid: "answer-1",
      })),
    );
    expect(fixture.reader.read()).toEqual([]);
    const index: unknown = Reflect.get(fixture.reader, "evictedRecords");
    if (!(index instanceof EvictedRecordIndex))
      throw new Error("Evicted index unavailable");
    const handle = openSync(fixture.transcript, "r+");
    writeSync(handle, Buffer.from("x".repeat(40)), 0, 40, 0);
    closeSync(handle);
    fixture.append([
      {
        type: "user",
        uuid: "user-1",
        promptId: "turn-9",
        parentUuid: null,
        origin: { kind: "human" },
        message: { content: "rewritten" },
      },
    ]);
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        prompt_id: "turn-9",
        prompt: "rewritten",
      },
    ]);
    fixture.reader.read();
    const retained: unknown = Reflect.get(fixture.reader, "recordTurns");
    if (!(retained instanceof Map)) throw new Error("Record map unavailable");
    expect(retained.has("user-1")).toBe(true);
    expect(index.unconfirmedReads).toBe(1);
    expect(counts).toEqual([1]);
  });

  it("keeps fresh records free of prefix reads after many evictions", () => {
    const fixture = claudeFixture();
    fixture.append(
      Array.from({ length: 9000 }, (_, index) => ({
        type: "progress",
        uuid: `filter-progress-${index}`,
        parentUuid: "answer-1",
      })),
    );
    expect(fixture.reader.read()).toEqual([]);
    const index: unknown = Reflect.get(fixture.reader, "evictedRecords");
    if (!(index instanceof EvictedRecordIndex))
      throw new Error("Evicted index unavailable");
    expect(index.byteLength).toBeGreaterThan(0);
    const reads = vi.spyOn(JsonlTail.prototype, "readRecords");
    const hookTail = Reflect.get(fixture.reader, "hookTail");
    const transcriptTail = Reflect.get(fixture.reader, "transcriptTail");
    const prefixReads = () =>
      reads.mock.contexts.filter(
        (tail) => tail !== hookTail && tail !== transcriptTail,
      ).length;
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "filter-fresh-end",
        parentUuid: "answer-1",
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    expect(prefixReads()).toBe(0);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "filter-fresh-answer",
        parentUuid: "filter-fresh-end",
        message: { content: [{ type: "text", text: "continue" }] },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    expect(prefixReads()).toBe(0);
    reads.mockRestore();
    fixture.append([
      {
        type: "user",
        uuid: "user-1",
        promptId: "turn-1",
        parentUuid: null,
        origin: { kind: "human" },
        message: { content: "replayed old prompt" },
        timestamp: "2099-01-01T00:00:00.000Z",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "filter-final-end",
        parentUuid: "filter-fresh-answer",
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        prompt_id: "turn-2",
        prompt: "next prompt",
      },
    ]);
    expect(fixture.reader.read()).toEqual([
      { state: "working", prompt: "next prompt" },
    ]);
    expect(
      retainedIdentitySizes(fixture.reader).recentEvictedIds,
    ).toBeLessThanOrEqual(4096);
  });

  it.each(
    ["completion", "assistant"].flatMap((kind) =>
      ["2026-10-11T10:00:02.000Z", "2026-10-11T10:00:03.000Z"].map(
        (timestamp) => ({ kind, timestamp }),
      ),
    ),
  )(
    "ignores evicted $kind UUIDs replayed with advanced timestamp $timestamp",
    ({ kind, timestamp }) => {
      const fixture = claudeFixture();
      const completion = {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "advanced-replay-end",
        promptId: "turn-1",
        parentUuid: "answer-1",
        timestamp: "2026-10-11T10:00:01.000Z",
      };
      const assistant = {
        type: "assistant",
        isSidechain: false,
        uuid: "advanced-replay-answer",
        promptId: "turn-1",
        parentUuid: completion.uuid,
        timestamp: completion.timestamp,
        message: { content: [{ type: "text", text: "continue" }] },
      };
      fixture.append([
        completion,
        assistant,
        {
          ...assistant,
          uuid: "advanced-replay-anchor",
          parentUuid: assistant.uuid,
        },
      ]);
      expect(fixture.reader.read()).toEqual([
        { state: "idle", prompt: null },
        { state: "working", prompt: null },
      ]);
      fixture.append(
        Array.from({ length: 9500 }, (_, index) => ({
          type: "progress",
          uuid: `advanced-replay-progress-${index}`,
          parentUuid: "advanced-replay-anchor",
          timestamp: "2026-10-11T10:00:02.000Z",
        })),
      );
      expect(fixture.reader.read()).toEqual([]);
      const retained: unknown = Reflect.get(fixture.reader, "recordTurns");
      if (!(retained instanceof Map))
        throw new Error("Identity state unavailable");
      expect(retained.has(completion.uuid)).toBe(false);
      expect(retained.has(assistant.uuid)).toBe(false);
      if (kind === "completion") {
        fixture.append([{ ...completion, timestamp }]);
        expect(fixture.reader.read()).toEqual([]);
        expect(fixture.reader.heartbeat()).toEqual({
          state: "working",
          prompt: null,
        });
      }
      fixture.append([
        {
          ...completion,
          uuid: "advanced-fresh-end",
          parentUuid: "advanced-replay-anchor",
          timestamp,
        },
      ]);
      expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
      if (kind === "assistant") {
        fixture.append([
          { ...assistant, parentUuid: "advanced-fresh-end", timestamp },
        ]);
        expect(fixture.reader.read()).toEqual([]);
        expect(fixture.reader.heartbeat()).toBeNull();
      }
      fixture.hook([
        {
          hook_event_name: "Stop",
          prompt_id: "turn-1",
          stop_hook_active: false,
        },
      ]);
      fixture.append([
        {
          ...assistant,
          uuid: "advanced-fresh-continuation",
          parentUuid: "advanced-fresh-end",
          timestamp,
        },
      ]);
      expect(fixture.reader.read()).toEqual([
        { state: "working", prompt: null },
      ]);
      fixture.append([
        {
          ...completion,
          uuid: "advanced-final-end",
          parentUuid: "advanced-fresh-continuation",
          timestamp,
        },
      ]);
      expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
      fixture.hook([
        {
          hook_event_name: "UserPromptSubmit",
          prompt_id: "turn-2",
          prompt: "new prompt",
        },
      ]);
      expect(fixture.reader.read()).toEqual([
        { state: "working", prompt: "new prompt" },
      ]);
      const recent: unknown = Reflect.get(fixture.reader, "recentEvictedIds");
      if (!(recent instanceof Set))
        throw new Error("Recent identities unavailable");
      expect(recent.has(completion.uuid)).toBe(false);
      expect(recent.has(assistant.uuid)).toBe(false);
      const sizes = retainedIdentitySizes(fixture.reader);
      expect(sizes.recordTurns).toBeLessThanOrEqual(4096);
      expect(sizes.recordParents).toBeLessThanOrEqual(4096);
      expect(sizes.knownTurns).toBeLessThanOrEqual(128);
    },
  );

  it("accepts fresh older-timestamp ancestry after eviction while ignoring its later replay", () => {
    const fixture = claudeFixture();
    finalClaudeStop(fixture);
    fixture.append(
      Array.from({ length: 5000 }, (_, index) => ({
        type: "progress",
        uuid: `older-time-progress-${index}`,
        parentUuid: "end-1",
        timestamp: "2026-10-12T10:27:50.475Z",
      })),
    );
    expect(fixture.reader.read()).toEqual([]);
    fixture.hook([
      { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: false },
    ]);
    fixture.append([
      {
        type: "attachment",
        uuid: "older-time-attachment",
        parentUuid: "end-1",
        timestamp: "2026-10-12T10:27:50.474Z",
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "older-time-continuation",
        parentUuid: "older-time-attachment",
        timestamp: "2026-10-12T10:27:51.666Z",
        message: { content: [{ type: "text", text: "continue in text" }] },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    const completion = {
      type: "system",
      subtype: "stop_hook_summary",
      isSidechain: false,
      hasOutput: false,
      uuid: "older-time-end",
      parentUuid: "older-time-continuation",
      timestamp: "2026-10-12T10:27:50.473Z",
    };
    fixture.append([completion]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "older-time-later-continuation",
        parentUuid: completion.uuid,
        timestamp: "2026-10-12T10:27:51.667Z",
        message: { content: [{ type: "text", text: "continue once more" }] },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    fixture.append(
      Array.from({ length: 5000 }, (_, index) => ({
        type: "progress",
        uuid: `older-time-later-progress-${index}`,
        parentUuid: "older-time-later-continuation",
        timestamp: "2026-10-12T10:27:52.000Z",
      })),
    );
    expect(fixture.reader.read()).toEqual([]);
    const retained: unknown = Reflect.get(fixture.reader, "recordTurns");
    if (!(retained instanceof Map))
      throw new Error("Identity state unavailable");
    expect(retained.has(completion.uuid)).toBe(false);
    fixture.append([completion]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    fixture.append([
      {
        ...completion,
        uuid: "older-time-final-end",
        parentUuid: "older-time-later-continuation",
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    const sizes = retainedIdentitySizes(fixture.reader);
    expect(sizes.recordTurns).toBeLessThanOrEqual(4096);
    expect(sizes.recordParents).toBeLessThanOrEqual(4096);
    expect(sizes.knownTurns).toBeLessThanOrEqual(128);
    expect(sizes.recentEvictedIds).toBeLessThanOrEqual(4096);
  });

  it("starts an assistant-only cutoff-timestamp continuation after a blocked Stop and eviction", () => {
    const fixture = claudeFixture();
    finalClaudeStop(fixture);
    const timestamp = "2026-10-11T10:00:01.000Z";
    fixture.append(
      Array.from({ length: 5000 }, (_, index) => ({
        type: "progress",
        uuid: `idle-cutoff-progress-${index}`,
        parentUuid: "end-1",
        timestamp,
      })),
    );
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
    fixture.hook([
      { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: false },
    ]);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "idle-cutoff-continuation",
        parentUuid: "end-1",
        timestamp,
        message: { content: [{ type: "text", text: "two more sentences" }] },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "idle-cutoff-end",
        parentUuid: "idle-cutoff-continuation",
        timestamp,
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    expect(fixture.reader.heartbeat()).toBeNull();
  });

  it.each([5000, 8300])(
    "accepts unique cutoff-timestamp completion and continuation after %i records while rejecting evicted replays",
    (count) => {
      const fixture = claudeFixture();
      const timestamp = "2026-10-11T10:00:01.000Z";
      const evicted = {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "cutoff-evicted-end",
        promptId: "turn-1",
        parentUuid: "answer-1",
        timestamp,
      };
      fixture.append([
        evicted,
        {
          type: "assistant",
          isSidechain: false,
          uuid: "cutoff-anchor",
          parentUuid: evicted.uuid,
          timestamp,
          message: { content: [{ type: "text", text: "continuation" }] },
        },
      ]);
      expect(fixture.reader.read()).toEqual([
        { state: "idle", prompt: null },
        { state: "working", prompt: null },
      ]);
      fixture.append(
        Array.from({ length: count }, (_, index) => ({
          type: "progress",
          uuid: `cutoff-progress-${index}`,
          parentUuid: "cutoff-anchor",
          timestamp,
        })),
      );
      expect(fixture.reader.read()).toEqual([]);
      const retained: unknown = Reflect.get(fixture.reader, "recordTurns");
      if (!(retained instanceof Map))
        throw new Error("Native reader identity state unavailable");
      expect(retained.has(evicted.uuid)).toBe(false);
      fixture.append([evicted]);
      expect(fixture.reader.read()).toEqual([]);
      expect(fixture.reader.heartbeat()).toEqual({
        state: "working",
        prompt: null,
      });
      fixture.append([
        {
          ...evicted,
          uuid: "cutoff-unique-end",
          parentUuid: "cutoff-anchor",
        },
      ]);
      expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
      expect(fixture.reader.heartbeat()).toBeNull();
      fixture.hook([
        {
          hook_event_name: "Stop",
          prompt_id: "turn-1",
          stop_hook_active: false,
        },
      ]);
      fixture.append([
        {
          type: "assistant",
          isSidechain: false,
          uuid: "cutoff-unique-continuation",
          parentUuid: "cutoff-unique-end",
          timestamp,
          message: { content: [{ type: "text", text: "two more sentences" }] },
        },
      ]);
      expect(fixture.reader.read()).toEqual([
        { state: "working", prompt: null },
      ]);
      fixture.append([evicted]);
      expect(fixture.reader.read()).toEqual([]);
      expect(fixture.reader.heartbeat()).toEqual({
        state: "working",
        prompt: null,
      });
      fixture.append([
        {
          ...evicted,
          uuid: "cutoff-final-end",
          parentUuid: "cutoff-unique-continuation",
        },
      ]);
      expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
      expect(fixture.reader.heartbeat()).toBeNull();
      const sizes = retainedIdentitySizes(fixture.reader);
      expect(sizes.recordTurns).toBeLessThanOrEqual(4096);
      expect(sizes.recordParents).toBeLessThanOrEqual(4096);
      expect(sizes.knownTurns).toBeLessThanOrEqual(128);
      expect(sizes.completedTurns).toBeLessThanOrEqual(128);
      const recentIds: unknown = Reflect.get(
        fixture.reader,
        "recentEvictedIds",
      );
      if (!(recentIds instanceof Set))
        throw new Error("Native reader cutoff identity state unavailable");
      expect(recentIds.size).toBeLessThanOrEqual(4096);
      expect(recentIds.has(evicted.uuid)).toBe(count === 5000);
    },
  );

  it("accepts distinct records sharing a timestamp and ignores unordered records", () => {
    const fixture = claudeFixture();
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "invalid-time-end",
        parentUuid: "answer-1",
        timestamp: "invalid timestamp",
      },
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "missing-time-end",
        parentUuid: "answer-1",
        timestamp: null,
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    const timestamp = "2026-10-11T10:00:01.000Z";
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "same-time-end",
        parentUuid: "answer-1",
        timestamp,
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "same-time-continuation",
        parentUuid: "same-time-end",
        timestamp,
        message: {
          content: [{ type: "text", text: "same timestamp continuation" }],
        },
      },
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "same-time-final-end",
        parentUuid: "same-time-continuation",
        timestamp,
      },
    ]);
    expect(fixture.reader.read()).toEqual([
      { state: "idle", prompt: null },
      { state: "working", prompt: null },
      { state: "idle", prompt: null },
    ]);
    expect(fixture.reader.heartbeat()).toBeNull();
  });

  it.each(["assistant", "completion", "user"])(
    "ignores evicted %s and completed-turn replays while preserving later continuation",
    (kind) => {
      const fixture = claudeFixture();
      const replay = {
        type:
          kind === "assistant"
            ? "assistant"
            : kind === "completion"
              ? "system"
              : "user",
        ...(kind === "completion"
          ? { subtype: "stop_hook_summary", hasOutput: false }
          : {}),
        ...(kind === "user" ? { origin: { kind: "human" } } : {}),
        isSidechain: false,
        uuid: "evicted-replay",
        promptId: "turn-1",
        parentUuid: kind === "user" ? null : "answer-1",
        timestamp: "2026-10-11T10:00:01.000Z",
        message: { content: [{ type: "text", text: "original record" }] },
      };
      fixture.append([replay]);
      expect(fixture.reader.read()).toEqual(
        kind === "completion" ? [{ state: "idle", prompt: null }] : [],
      );
      fixture.append([
        {
          type: "assistant",
          isSidechain: false,
          uuid: "current-answer",
          promptId: "turn-1",
          parentUuid: replay.uuid,
          timestamp: "2026-10-11T10:00:02.000Z",
          message: { content: [{ type: "text", text: "current answer" }] },
        },
      ]);
      expect(fixture.reader.read()).toEqual(
        kind === "completion" ? [{ state: "working", prompt: null }] : [],
      );
      fixture.append(
        Array.from({ length: 5000 }, (_, index) => ({
          type: "progress",
          uuid: `replay-noise-${index}`,
          parentUuid: "current-answer",
        })),
      );
      expect(fixture.reader.read()).toEqual([]);
      const retained: unknown = Reflect.get(fixture.reader, "recordTurns");
      expect(retained).toBeInstanceOf(Map);
      if (!(retained instanceof Map))
        throw new Error("Identity records unavailable");
      expect(retained.has(replay.uuid)).toBe(false);
      fixture.append([replay]);
      expect(fixture.reader.read()).toEqual([]);
      expect(fixture.reader.heartbeat()).toEqual({
        state: "working",
        prompt: null,
      });
      fixture.append([
        {
          type: "system",
          subtype: "stop_hook_summary",
          isSidechain: false,
          hasOutput: false,
          uuid: "current-end",
          parentUuid: "current-answer",
        },
      ]);
      expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
      fixture.append([replay]);
      expect(fixture.reader.read()).toEqual([]);
      expect(fixture.reader.heartbeat()).toBeNull();
      fixture.append([
        {
          type: "assistant",
          isSidechain: false,
          uuid: "later-continuation",
          parentUuid: "current-end",
          message: {
            content: [{ type: "text", text: "continue after replay" }],
          },
        },
      ]);
      expect(fixture.reader.read()).toEqual([
        { state: "working", prompt: null },
      ]);
      fixture.append([
        {
          type: "system",
          subtype: "stop_hook_summary",
          isSidechain: false,
          hasOutput: false,
          uuid: "later-end",
          parentUuid: "later-continuation",
        },
      ]);
      expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
      fixture.hook([
        {
          hook_event_name: "UserPromptSubmit",
          prompt_id: "turn-2",
          prompt: "new prompt after eviction",
        },
      ]);
      fixture.append([
        {
          type: "user",
          uuid: "new-prompt",
          promptId: "turn-2",
          parentUuid: "later-end",
          origin: { kind: "human" },
          message: { content: "new prompt after eviction" },
        },
      ]);
      expect(fixture.reader.read()).toEqual([
        { state: "working", prompt: "new prompt after eviction" },
      ]);
      fixture.append([
        replay,
        {
          type: "user",
          uuid: "user-1",
          promptId: "turn-1",
          parentUuid: null,
          origin: { kind: "human" },
          timestamp: "2026-10-11T10:00:00.001Z",
          message: { content: "first prompt" },
        },
        {
          type: "assistant",
          isSidechain: false,
          uuid: "answer-1",
          promptId: "turn-1",
          parentUuid: "user-1",
          timestamp: "2026-10-11T10:00:00.002Z",
          message: { content: [{ type: "text", text: "first answer" }] },
        },
      ]);
      expect(fixture.reader.read()).toEqual([]);
      expect(fixture.reader.heartbeat()).toEqual({
        state: "working",
        prompt: null,
      });
      fixture.append([
        {
          type: "system",
          subtype: "stop_hook_summary",
          isSidechain: false,
          hasOutput: false,
          uuid: "new-prompt-end",
          parentUuid: "new-prompt",
        },
      ]);
      expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
      const sizes = retainedIdentitySizes(fixture.reader);
      expect(sizes.recordTurns).toBeLessThanOrEqual(4096);
      expect(sizes.recordParents).toBeLessThanOrEqual(4096);
      expect(sizes.knownTurns).toBeLessThanOrEqual(128);
      expect(sizes.completedTurns).toBeLessThanOrEqual(128);
    },
  );

  it("bounds retained identity state across 50000 turns with tools, late flushes and duplicates", () => {
    const fixture = claudeFixture();
    finalClaudeStop(fixture);
    const maxima = retainedIdentitySizes(fixture.reader);
    for (let index = 2; index <= 50_001; index += 1) {
      const turn = `turn-${index}`;
      const prompt = `prompt ${index}`;
      const answer = {
        type: "assistant",
        isSidechain: false,
        uuid: `answer-${index}`,
        parentUuid: `tool-${index}`,
        message: { content: [{ type: "text", text: "answer" }] },
      };
      fixture.hook([
        { hook_event_name: "UserPromptSubmit", prompt_id: turn, prompt },
        { hook_event_name: "PreToolUse", prompt_id: turn },
        { hook_event_name: "Stop", prompt_id: turn, stop_hook_active: false },
      ]);
      fixture.append([
        {
          type: "user",
          uuid: `user-${index}`,
          parentUuid: null,
          promptId: turn,
          origin: { kind: "human" },
          message: { content: prompt },
        },
        {
          type: "assistant",
          isSidechain: false,
          uuid: `tool-call-${index}`,
          parentUuid: `user-${index}`,
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        },
        {
          type: "user",
          uuid: `tool-${index}`,
          parentUuid: `tool-call-${index}`,
          message: { content: [{ type: "tool_result", content: "done" }] },
        },
        answer,
        {
          type: "system",
          subtype: "stop_hook_summary",
          isSidechain: false,
          hasOutput: false,
          uuid: `end-${index}`,
          parentUuid: answer.uuid,
        },
        answer,
        {
          ...answer,
          uuid: `late-${index}`,
          parentUuid: answer.uuid,
        },
        {
          ...answer,
          uuid: `older-late-${index}`,
          parentUuid: "answer-1",
          promptId: "turn-1",
        },
      ]);
      const reports = fixture.reader.read();
      if (index % 1000 === 0) {
        expect(reports).toEqual([
          { state: "working", prompt },
          { state: "idle", prompt: null },
        ]);
        expect(fixture.reader.heartbeat()).toBeNull();
      }
      const sizes = retainedIdentitySizes(fixture.reader);
      for (const key of Object.keys(maxima) as (keyof typeof maxima)[]) {
        maxima[key] = Math.max(maxima[key], sizes[key]);
      }
    }
    const evidence = JSON.stringify(maxima);
    expect(maxima.recordTurns, evidence).toBeLessThanOrEqual(4096);
    expect(maxima.recordParents, evidence).toBeLessThanOrEqual(4096);
    expect(maxima.knownTurns, evidence).toBeLessThanOrEqual(128);
    expect(maxima.completedTurns, evidence).toBeLessThanOrEqual(128);
    expect(maxima.recentEvictedIds, evidence).toBeLessThanOrEqual(4096);
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        prompt_id: "last-turn",
        prompt: "continue after the long session",
      },
      { hook_event_name: "Stop", prompt_id: "last-turn" },
    ]);
    fixture.append([
      {
        type: "user",
        isMeta: true,
        uuid: "last-feedback",
        promptId: "last-turn",
        parentUuid: "end-50001",
        message: { content: "Stop hook feedback:\nWrite two more sentences." },
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "last-answer",
        parentUuid: "last-feedback",
        message: { content: [{ type: "text", text: "Two more sentences." }] },
      },
    ]);
    expect(fixture.reader.read()).toEqual([
      { state: "working", prompt: "continue after the long session" },
    ]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    fixture.hook([
      {
        hook_event_name: "Stop",
        prompt_id: "last-turn",
        stop_hook_active: true,
      },
    ]);
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "last-end",
        parentUuid: "last-answer",
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
  }, 120_000);

  it("bounds a single turn while retaining completion ancestry and rejecting evicted late records", () => {
    const fixture = claudeFixture();
    finalClaudeStop(fixture);
    let parent = "end-1";
    for (let batch = 0; batch < 12; batch += 1) {
      const records = Array.from({ length: 1000 }, (_, index) => {
        const uuid = `progress-${batch}-${index}`;
        const record = { type: "progress", uuid, parentUuid: parent };
        parent = uuid;
        return record;
      });
      fixture.append(records);
      expect(fixture.reader.read()).toEqual([]);
      expect(fixture.reader.heartbeat()).toBeNull();
    }
    const sizes = retainedIdentitySizes(fixture.reader);
    expect(sizes.recordTurns, JSON.stringify(sizes)).toBeLessThanOrEqual(4096);
    expect(sizes.recordParents, JSON.stringify(sizes)).toBeLessThanOrEqual(
      4096,
    );
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "answer-1",
        promptId: "turn-1",
        parentUuid: "user-1",
        message: { content: [{ type: "text", text: "old answer" }] },
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "evicted-late-block",
        parentUuid: "answer-1",
        message: { content: [{ type: "text", text: "late block" }] },
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "new-background-answer",
        parentUuid: parent,
        message: { content: [{ type: "text", text: "Background completed." }] },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
  });

  it("retains the working anchor across unrelated transcript records before a blocked Stop", () => {
    const fixture = claudeFixture();
    fixture.append(
      Array.from({ length: 8000 }, (_, index) => ({
        type: "progress",
        uuid: `unrelated-${index}`,
        parentUuid: null,
      })),
    );
    fixture.reader.read();
    fixture.hook([
      { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: false },
    ]);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "after-noise",
        parentUuid: "answer-1",
        message: { content: [{ type: "text", text: "Continued answer." }] },
      },
    ]);
    fixture.reader.read();
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    fixture.hook([
      { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: true },
    ]);
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "after-noise-end",
        parentUuid: "after-noise",
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    const sizes = retainedIdentitySizes(fixture.reader);
    expect(sizes.recordTurns, JSON.stringify(sizes)).toBeLessThanOrEqual(4096);
    expect(sizes.recordParents, JSON.stringify(sizes)).toBeLessThanOrEqual(
      4096,
    );
  });

  it("keeps a blocked Stop and assistant-only continuation working until the final Stop outcome", () => {
    const fixture = claudeFixture();
    fixture.hook([
      { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: false },
    ]);
    fixture.reader.read();
    fixture.append([
      {
        type: "user",
        isMeta: true,
        promptId: "turn-1",
        uuid: "feedback-1",
        parentUuid: "answer-1",
        message: {
          content:
            "Stop hook feedback:\nWrite two more sentences without tools.",
        },
      },
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: true,
        uuid: "blocked-1",
        parentUuid: "feedback-1",
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "answer-2",
        parentUuid: "blocked-1",
        message: {
          id: "message-2",
          content: [{ type: "text", text: "Two more sentences." }],
        },
      },
    ]);
    fixture.reader.read();
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    fixture.hook([
      { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: true },
    ]);
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "end-2",
        parentUuid: "answer-2",
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    expect(fixture.reader.heartbeat()).toBeNull();
  });

  it("reports one waiting entry for a real AskUserQuestion with its PermissionRequest hook and clears it on the answer", () => {
    const fixture = claudeFixture();
    fixture.hook([
      {
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        prompt_id: "turn-1",
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "ask-1",
        parentUuid: "answer-1",
        promptId: "turn-1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_ask",
              name: "AskUserQuestion",
              input: { questions: [{ question: "Which target?" }] },
            },
          ],
        },
      },
    ]);
    const waiting = fixture.reader.read();
    expect(waiting).toEqual([
      {
        state: "waiting",
        prompt: null,
        questions: [{ id: "toolu_ask", prompt: "Which target?" }],
      },
    ]);
    expect(fixture.reader.heartbeat()).toEqual(waiting[0]);
    fixture.hook([
      {
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        prompt_id: "turn-1",
      },
    ]);
    fixture.append([
      {
        type: "user",
        uuid: "result-1",
        parentUuid: "ask-1",
        promptId: "turn-1",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_ask" }],
        },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
  });

  it("keeps final idle when an already-seen assistant message flushes late with a later timestamp", () => {
    const fixture = claudeFixture(true);
    finalClaudeStop(fixture);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "answer-1",
        parentUuid: "user-1",
        timestamp: "2099-01-01T00:00:00Z",
        message: {
          id: "message-1",
          content: [{ type: "text", text: "first answer" }],
        },
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "late-block-1",
        parentUuid: "answer-1",
        message: {
          id: "message-1",
          content: [{ type: "text", text: "late content block" }],
        },
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
  });

  it("starts a new prompt after idle despite delayed completion records from the previous prompt", () => {
    const fixture = claudeFixture();
    finalClaudeStop(fixture);
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        prompt_id: "turn-2",
        prompt: "second prompt",
      },
    ]);
    fixture.append([
      {
        type: "user",
        uuid: "unread-old-user",
        parentUuid: null,
        promptId: "unread-old-turn",
        origin: { kind: "human" },
        message: { content: "an older prompt flushed late" },
      },
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "unread-old-end",
        parentUuid: "unread-old-user",
      },
      {
        type: "user",
        uuid: "late-interrupt-1",
        parentUuid: "answer-1",
        message: {
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      },
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "late-end-1",
        parentUuid: "answer-1",
      },
    ]);
    expect(fixture.reader.read()).toEqual([
      { state: "working", prompt: "second prompt" },
    ]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
  });

  it("recognizes a new assistant continuation chained after a completed turn without another prompt hook", () => {
    const fixture = claudeFixture();
    finalClaudeStop(fixture);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "background-1",
        parentUuid: "end-1",
        message: {
          id: "background-message",
          content: [{ type: "text", text: "Background task completed." }],
        },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
  });

  it("reports a resumed turn written before the first poll, not the turns before launch", async () => {
    const home = tempHome();
    const file = writeRollout(home, codexTurn("an earlier prompt"));
    const sizeBeforeLaunch = statSync(file).size;
    const baseline = await measureResumedTranscript(
      CODEX_CLI,
      { HOME: home },
      SESSION_ID,
    );
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
      ...baseline,
    });
    appendFileSync(file, jsonl(codexTurn("the resumed prompt")));

    expect(baseline).toEqual({
      transcriptFile: file,
      offset: sizeBeforeLaunch,
    });
    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
    expect(reader.read()).toEqual([]);
  });

  it("keeps the first resumed turn when the transcript ended mid-record before launch", async () => {
    const home = tempHome();
    const file = writeRollout(home, codexTurn("an earlier prompt"));
    appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_');
    const baseline = await measureResumedTranscript(
      CODEX_CLI,
      { HOME: home },
      SESSION_ID,
    );
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
      ...baseline,
    });
    appendFileSync(file, jsonl(codexTurn("the resumed prompt")));

    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
  });

  it("drops the rest of a record begun before launch and keeps the resumed turn after it", async () => {
    const home = tempHome();
    const file = writeRollout(home, []);
    appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_');
    const baseline = await measureResumedTranscript(
      CODEX_CLI,
      { HOME: home },
      SESSION_ID,
    );
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
      ...baseline,
    });
    appendFileSync(
      file,
      `started"}}\n${jsonl(codexTurn("the resumed prompt"))}`,
    );

    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
  });

  it("retries a failed baseline measurement before launch and keeps the size it then measures", async () => {
    const home = tempHome();
    const file = writeRollout(home, codexTurn("an earlier prompt"));
    const sizeBeforeLaunch = statSync(file).size;
    const measured: number[] = [];
    const baseline = await measureResumedTranscript(
      CODEX_CLI,
      { HOME: home },
      SESSION_ID,
      {
        delayMs: 0,
        measure: (filePath) => {
          measured.push(measured.length + 1);
          return measured.length < 3 ? null : statSync(filePath).size;
        },
      },
    );
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
      ...baseline,
    });
    appendFileSync(file, jsonl(codexTurn("the resumed prompt")));

    expect(measured).toEqual([1, 2, 3]);
    expect(baseline).toEqual({
      transcriptFile: file,
      offset: sizeBeforeLaunch,
    });
    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
  });

  it("refuses to resume when no baseline can be measured before launch", async () => {
    const home = tempHome();
    writeRollout(home, codexTurn("an earlier prompt"));
    let attempts = 0;

    await expect(
      measureResumedTranscript(CODEX_CLI, { HOME: home }, SESSION_ID, {
        attempts: 4,
        delayMs: 0,
        measure: () => {
          attempts += 1;
          return null;
        },
      }),
    ).rejects.toThrow(
      `could not read the codex transcript of session ${SESSION_ID}`,
    );
    expect(attempts).toBe(4);
    await expect(
      measureResumedTranscript(CODEX_CLI, { HOME: tempHome() }, SESSION_ID, {
        attempts: 2,
        delayMs: 0,
      }),
    ).rejects.toThrow("so it did not resume it");
  });

  it("reads a started session's transcript that appears after launch from its first record", () => {
    const home = tempHome();
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "start",
      id: SESSION_ID,
    });
    writeRollout(home, codexTurn("the first prompt"));

    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the first prompt" },
      { state: "idle", prompt: null },
    ]);
  });

  it("reads a session discovered after launch from its first record", () => {
    const home = tempHome();
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "discover",
    });
    writeRollout(home, codexTurn("the first prompt").slice(0, 2));
    expect(reader.read()).toEqual([]);

    reader.sessionDiscovered(SESSION_ID);
    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the first prompt" },
    ]);
    expect(reader.heartbeat()).toEqual({ state: "working", prompt: null });
    expect(reader.finish()).toEqual({ state: "idle", prompt: null });
    expect(reader.heartbeat()).toBeNull();
  });

  it("reads hook events while the assigned transcript does not exist yet", () => {
    const home = tempHome();
    const events = path.join(home, "events.jsonl");
    mkdirSync(events, { recursive: true });
    const reader = new NativeActivityReader(
      CLAUDE_CLI,
      { HOME: home },
      events,
      { kind: "start", id: SESSION_ID },
    );
    publishHooks(
      events,
      jsonl([
        { hook_event_name: "UserPromptSubmit", prompt: "fix the build" },
        { hook_event_name: "Stop" },
      ]),
    );

    expect(reader.read()).toEqual([
      { state: "working", prompt: "fix the build" },
      { state: "idle", prompt: null },
    ]);
    publishHooks(events, jsonl([{ hook_event_name: "PreToolUse" }]));
    expect(reader.read()).toEqual([{ state: "working", prompt: null }]);
    publishHooks(
      events,
      jsonl(
        Array.from({ length: 100 }, () => ({ hook_event_name: "PreToolUse" })),
      ),
    );
    expect(reader.read()).toEqual([]);
    publishHooks(
      events,
      jsonl([{ hook_event_name: "Stop", stop_hook_active: true }]),
    );
    expect(reader.read()).toEqual([{ state: "idle", prompt: null }]);
    expect(reader.read()).toEqual([]);
    expect(reader.heartbeat()).toBeNull();
  });
});

describe("idle delivery through the real reader, reporter and wiring", () => {
  const HEARTBEAT_MS = 30_000;
  const http = (status: number, code: string) =>
    new BbHttpError({ body: null, code, message: code, status });

  afterEach(() => {
    vi.useRealTimers();
  });

  function holder(answers: { idle?: unknown[]; working?: unknown[] }) {
    vi.useFakeTimers();
    const fixture = claudeFixture();
    const accepted: string[] = [];
    const sent: string[] = [];
    const scripts = {
      idle: [...(answers.idle ?? [])],
      working: [...(answers.working ?? [])],
    };
    const reporter = createNativeActivityReporter({
      currentCredential: () => "current",
      send: async (args) => {
        sent.push(args.state);
        const script = args.state === "idle" ? scripts.idle : scripts.working;
        const next = script.shift();
        if (next instanceof Error) throw next;
        accepted.push(args.state);
        return { ok: true };
      },
      threadId: "thr_1",
    });
    const wiring = createNativeActivityWiring({
      currentCredential: () => "current",
      log: () => undefined,
      reader: () => fixture.reader,
      recordSession: async () => ({}),
      report: reporter.report,
      retryReport: reporter.retry,
    });
    const timer = setInterval(wiring.onHeartbeatTick, HEARTBEAT_MS);
    const forward = () => {
      for (const next of fixture.reader.read()) reporter.report(next);
    };
    reporter.report({ state: "working", prompt: "first prompt" });
    const stopTurn = () => {
      fixture.hook([
        {
          hook_event_name: "Stop",
          prompt_id: "turn-1",
          stop_hook_active: false,
        },
      ]);
      fixture.append([
        {
          type: "system",
          subtype: "stop_hook_summary",
          isSidechain: false,
          hasOutput: false,
          uuid: "end-1",
          parentUuid: "answer-1",
        },
      ]);
      forward();
    };
    const tick = async (times: number) => {
      for (let index = 0; index < times; index += 1) {
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
        await reporter.settled();
      }
    };
    return {
      accepted,
      fixture,
      forward,
      reporter,
      sent,
      stopTurn,
      stop: () => clearInterval(timer),
      tick,
      wiring,
    };
  }

  it("delivers an idle report exactly once after a 401 and then a network failure, by the second heartbeat tick", async () => {
    const h = holder({
      idle: [
        http(401, "native_terminal_credential_invalid"),
        new TypeError("fetch failed"),
      ],
    });
    h.stopTurn();
    await h.reporter.settled();
    expect(h.accepted).toEqual(["working"]);
    await h.tick(1);
    expect(h.accepted).toEqual(["working"]);
    await h.tick(1);
    expect(h.accepted).toEqual(["working", "idle"]);
    await h.tick(4);
    expect(h.accepted).toEqual(["working", "idle"]);
    expect(h.sent.filter((state) => state === "idle")).toHaveLength(3);
    h.stop();
  });

  it("retries an idle report whose first send failed on the network, and delivers it once", async () => {
    const h = holder({ idle: [new TypeError("fetch failed")] });
    h.stopTurn();
    await h.reporter.settled();
    expect(h.accepted).toEqual(["working"]);
    await h.tick(1);
    expect(h.accepted).toEqual(["working", "idle"]);
    await h.tick(3);
    expect(h.sent.filter((state) => state === "idle")).toHaveLength(2);
    h.stop();
  });

  it("sends an idle report exactly once after an ambiguous client timeout", async () => {
    const h = holder({ idle: [new BbRequestTimeoutError(10_000)] });
    h.stopTurn();
    await h.reporter.settled();
    await h.tick(1);
    expect(h.accepted).toEqual(["working", "idle"]);
    await h.tick(3);
    expect(h.sent.filter((state) => state === "idle")).toHaveLength(2);
    h.stop();
  });

  it("never retries a refusal that is not transient", async () => {
    const h = holder({ idle: [http(403, "forbidden")] });
    h.stopTurn();
    await h.reporter.settled();
    await h.tick(4);
    expect(h.sent.filter((state) => state === "idle")).toHaveLength(1);
    expect(h.accepted).toEqual(["working"]);
    h.stop();
  });

  it("does not let the retained idle report overwrite a newer report", async () => {
    const h = holder({
      idle: [http(401, "native_terminal_credential_invalid")],
    });
    h.stopTurn();
    await h.reporter.settled();
    h.fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        prompt_id: "turn-2",
        prompt: "second prompt",
      },
    ]);
    h.forward();
    await h.reporter.settled();
    expect(h.accepted).toEqual(["working", "working"]);
    await h.tick(3);
    expect(h.sent.filter((state) => state === "idle")).toHaveLength(1);
    expect(h.accepted).not.toContain("idle");
    h.stop();
  });
});

describe("a rotated session is followed only after its binding is accepted", () => {
  const ROTATED = "5c0ffee0-1111-4222-8333-444455556666";
  const releases: Array<() => void> = [];

  afterEach(() => {
    for (const release of releases.splice(0)) release();
  });

  function holdOpen(): {
    promise: Promise<unknown>;
    reject(error: unknown): void;
    resolve(): void;
  } {
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = () => res({});
      reject = rej;
    });
    releases.push(resolve);
    return { promise, reject, resolve };
  }

  function holder(
    answers: Array<() => Promise<unknown>>,
    oldSession: "idle" | "working" | "asking" = "idle",
  ) {
    const attempts: Array<{ replaces: string; session: string }> = [];
    const sent: string[] = [];
    const logged: string[] = [];
    let wiring: ReturnType<typeof createNativeActivityWiring> | undefined;
    const fixture = claudeFixture(
      false,
      undefined,
      undefined,
      (sessionId, previousSessionId) =>
        wiring?.onSessionAdopted(sessionId, previousSessionId),
      false,
    );
    const reporter = createNativeActivityReporter({
      currentCredential: () => "current",
      send: async (args) => {
        sent.push(args.state);
      },
      threadId: "thr_rotation",
    });
    wiring = createNativeActivityWiring({
      currentCredential: () => "current",
      log: (event) => logged.push(event),
      reader: () => fixture.reader,
      recordSession: async (args) => {
        attempts.push({
          replaces: args.replacesNativeSessionId,
          session: args.nativeSessionId,
        });
        const answer = answers[attempts.length - 1];
        return answer === undefined ? {} : answer();
      },
      report: reporter.report,
      retryReport: reporter.retry,
    });
    const active = wiring;
    if (oldSession === "idle") {
      fixture.hook([
        {
          hook_event_name: "Stop",
          prompt_id: "turn-1",
          stop_hook_active: false,
        },
      ]);
      fixture.append([
        {
          type: "system",
          subtype: "stop_hook_summary",
          isSidechain: false,
          hasOutput: false,
          uuid: "end-1",
          parentUuid: "answer-1",
        },
      ]);
      expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    }
    if (oldSession === "asking") {
      fixture.hook([
        {
          hook_event_name: "PermissionRequest",
          prompt_id: "turn-1",
          tool_name: "Edit",
        },
      ]);
      expect(fixture.reader.read().map((report) => report.state)).toEqual([
        "waiting",
      ]);
    }
    const file = path.join(fixture.dir, `${ROTATED}.jsonl`);
    writeFileSync(file, "");
    appendFileSync(
      fixture.transcript,
      jsonl([
        {
          type: "continued-in",
          continuedInSessionId: ROTATED,
          sessionId: SESSION_ID,
          timestamp: new Date().toISOString(),
        },
      ]),
    );
    const rotated = (record: Record<string, unknown>) =>
      fixture.hook([{ session_id: ROTATED, ...record }]);
    const forward = async (): Promise<string[]> => {
      for (const next of fixture.reader.read()) reporter.report(next);
      await reporter.settled();
      return [...sent];
    };
    return {
      attempts,
      fixture,
      forward,
      heartbeat: async () => {
        active.onHeartbeatTick();
        await reporter.settled();
        return [...sent];
      },
      logged,
      rotated,
      settled: () => active.settled(),
    };
  }

  const opening = {
    hook_event_name: "UserPromptSubmit",
    prompt: "second prompt",
    prompt_id: "turn-rotated",
  };
  const ask = {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "make" },
  };
  const answered = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_make",
    tool_input: { command: "make" },
  };

  it("publishes nothing for the new session while the rebind is pending, then replays once after it is recorded", async () => {
    const binding = holdOpen();
    const h = holder([() => binding.promise]);
    try {
      h.rotated(opening);
      h.rotated(ask);
      expect(await h.forward()).toEqual([]);
      expect(h.attempts).toEqual([{ replaces: SESSION_ID, session: ROTATED }]);
      h.rotated(answered);
      expect(await h.forward()).toEqual([]);
      expect(await h.heartbeat()).toEqual([]);

      binding.resolve();
      await h.settled();
      expect(await h.forward()).toEqual(["working", "waiting", "working"]);
      expect(await h.forward()).toEqual(["working", "waiting", "working"]);
      expect(h.attempts).toHaveLength(1);
    } finally {
      binding.resolve();
    }
  });

  it("publishes nothing, drops the held records and shows unconfirmed activity after a permanent refusal", async () => {
    const binding = holdOpen();
    const h = holder([() => binding.promise]);
    try {
      h.rotated(opening);
      h.rotated(ask);
      expect(await h.forward()).toEqual([]);

      binding.reject(
        new BbHttpError({
          body: null,
          code: "native_session_claimed",
          message: "claimed",
          status: 409,
        }),
      );
      await h.settled();
      expect(h.logged).toContain("activity-session-rebind-refused");
      expect(await h.forward()).toEqual([]);
      h.rotated(answered);
      expect(await h.forward()).toEqual([]);
      expect(await h.heartbeat()).toEqual([]);
      expect(h.fixture.reader.heartbeat()).toBeNull();
    } finally {
      binding.resolve();
    }
  });

  it("keeps holding through a retryable failure and replays once when the retry is recorded", async () => {
    const h = holder([
      async () => {
        throw new BbHttpError({
          body: null,
          code: "unavailable",
          message: "unavailable",
          status: 503,
        });
      },
    ]);
    h.rotated(opening);
    h.rotated(ask);
    expect(await h.forward()).toEqual([]);
    await h.settled();
    expect(h.attempts).toHaveLength(1);
    expect(await h.forward()).toEqual([]);

    expect(await h.heartbeat()).toEqual([]);
    await h.settled();
    expect(h.attempts).toHaveLength(2);
    expect(await h.forward()).toEqual(["working", "waiting"]);
    expect(await h.forward()).toEqual(["working", "waiting"]);
    expect(h.logged).not.toContain("activity-session-rebind-refused");
  });

  it.each([
    ["working", "working"],
    ["asking", "waiting"],
  ] as const)(
    "does not heartbeat the old session while the rebind is pending when it was %s mid-turn, and replays once after it is recorded",
    async (oldSession, oldState) => {
      const binding = holdOpen();
      const h = holder([() => binding.promise], oldSession);
      try {
        expect(h.fixture.reader.heartbeat()?.state).toBe(oldState);
        h.rotated(opening);
        h.rotated(ask);
        expect(await h.forward()).toEqual([]);
        expect(h.fixture.reader.heartbeat()).toBeNull();
        expect(await h.heartbeat()).toEqual([]);
        expect(await h.heartbeat()).toEqual([]);

        binding.resolve();
        await h.settled();
        expect(await h.forward()).toEqual(["working", "waiting"]);
        expect(await h.forward()).toEqual(["working", "waiting"]);
        expect(h.attempts).toHaveLength(1);
      } finally {
        binding.resolve();
      }
    },
  );
});

describe("NativeActivityReader without any hook capture", () => {
  function transcriptOnlyReader(source: string | { unavailable: true }) {
    const host = createFakePluginHost({ pluginId: "provider-claude-code" });
    claudeCodePlugin(host.bb);
    const cli = host.harness.registrations.providerRegistrations.find(
      (entry) => entry.id === "claude-code",
    )?.experimental_nativeTerminal;
    if (cli === undefined) throw new Error("Claude native declaration missing");
    const home = tempHome();
    const dir = path.join(home, ".claude", "projects", "work");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${SESSION_ID}.jsonl`),
      jsonl([
        {
          type: "user",
          uuid: "user-1",
          parentUuid: null,
          promptId: "turn-1",
          origin: { kind: "human" },
          message: { content: "first prompt" },
          timestamp: "2026-10-11T10:00:01.000Z",
        },
        {
          type: "assistant",
          isSidechain: false,
          uuid: "answer-1",
          parentUuid: "user-1",
          message: {
            id: "message-1",
            content: [{ type: "text", text: "first answer" }],
          },
          timestamp: "2026-10-11T10:00:02.000Z",
        },
      ]),
    );
    if (typeof source === "string") mkdirSync(source, { recursive: true });
    return new NativeActivityReader(cli, { HOME: home }, source, {
      kind: "start",
      id: SESSION_ID,
    });
  }

  it("control: with a working capture the same transcript shows Working", () => {
    const reader = transcriptOnlyReader(path.join(tempHome(), "spool"));
    expect(reader.read().some((report) => report.state === "working")).toBe(
      true,
    );
  });

  it("never shows Working or heartbeats when hook history is permanently unavailable, so the thread shows Activity not reported", () => {
    const reader = transcriptOnlyReader({ unavailable: true });
    expect(reader.read().some((report) => report.state === "working")).toBe(
      false,
    );
    expect(reader.heartbeat()).toBeNull();
    expect(reader.read().some((report) => report.state === "working")).toBe(
      false,
    );
  });
});
