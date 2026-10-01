import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  type PromptInput,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

let threadCounter = 0;
let threadId = "";
const OPTIONS = { ...FULL_ACCESS_SESSION_OPTIONS, model: "gpt-5.5" };

function question(overrides: Record<string, unknown>) {
  return {
    id: "color",
    header: "Color",
    question: "Which color should the button use?",
    isOther: false,
    isSecret: false,
    options: [
      { label: "Blue", description: "" },
      { label: "Green", description: "" },
    ],
    ...overrides,
  };
}

function askingTurn(
  turnId: string,
  asked: Record<string, unknown>,
  isBlocking = true,
) {
  return [
    {
      method: "turn/started",
      params: { threadId: "x", turn: { id: turnId, status: "inProgress" } },
    },
    {
      kind: "request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "x",
        turnId,
        itemId: `${turnId}-ask`,
        questions: [asked],
        isBlocking,
        autoResolutionMs: null,
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "x",
        turn: { id: turnId, status: "completed", items: [], error: null },
      },
    },
  ];
}

const PLAN_INPUT: PromptInput[] = [
  {
    type: "text",
    text: "/plan outline the migration",
    mentions: [
      {
        start: 0,
        end: 5,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "builtin",
          label: "plan",
          argumentHint: null,
        },
      },
    ],
  },
];

let workspaceDir: string;
let requestLogPath: string;
let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
const asked: unknown[] = [];
let answered = 0;

const askedQuestionSchema = z.object({
  payload: z.object({
    questions: z.tuple([z.object({ id: z.string() })]),
  }),
});

beforeEach(() => {
  threadCounter += 1;
  threadId = `thr_user_question_${threadCounter}`;
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-user-question-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      requestLogPath,
      turns: [
        askingTurn("turn-q1", question({})),
        askingTurn("turn-q2", question({ id: "token", isSecret: true })),
        [],
      ],
    }),
  );
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
  asked.length = 0;
  answered = 0;
});

afterEach(async () => {
  harness.sendRequest(991_002, "thread/stop", {
    threadId,
    providerThreadId: "user-question-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(991_002).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function settle(id: number): Promise<void> {
  await answerUntil(() => harness.hasResponse(id));
}

async function answerUntil(done: () => boolean): Promise<void> {
  while (!done()) {
    for (const message of harness.messages.slice(answered)) {
      if (
        message.method !== BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest ||
        message.id === undefined
      ) {
        continue;
      }
      asked.push(message.params);
      const [first] = askedQuestionSchema.parse(message.params).payload
        .questions;
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            kind: "user_answer",
            answers: {
              [first.id]: { selected: [`${first.id}:option-2`] },
            },
          },
        }),
      );
    }
    answered = harness.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function recorded() {
  return readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({ method: z.string(), params: z.looseObject({}) })
        .parse(JSON.parse(line)),
    );
}

function turnStarts() {
  return recorded().filter((entry) => entry.method === "turn/start");
}

function userInputResponses() {
  return recorded()
    .filter((entry) => entry.method === "response:item/tool/requestUserInput")
    .map((entry) => entry.params);
}

it("asks Codex's plan-mode questions in a bb question card and returns the answer", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: OPTIONS,
  });
  await settle(1);
  expect((await harness.waitForResponse(1)).error).toBeUndefined();
  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse((await harness.waitForResponse(1)).result);

  harness.sendRequest(2, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_234567892a",
    input: PLAN_INPUT,
    options: { ...OPTIONS, promptMode: "plan" },
  });
  await settle(2);
  expect((await harness.waitForResponse(2)).error).toBeUndefined();

  expect(turnStarts()[0]?.params).toMatchObject({
    input: [{ type: "text", text: "outline the migration" }],
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "gpt-5.5",
        reasoning_effort: null,
        developer_instructions: null,
      },
    },
  });
  expect(asked).toEqual([
    expect.objectContaining({
      payload: {
        kind: "user_question",
        questions: [
          expect.objectContaining({
            id: "question-1",
            prompt: "Which color should the button use?",
          }),
        ],
      },
    }),
  ]);
  await answerUntil(() => userInputResponses().length > 0);
  expect(userInputResponses()[0]).toMatchObject({
    result: { answers: { color: { answers: ["Green"] } } },
  });

  harness.sendRequest(3, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_234567892b",
    input: PLAN_INPUT,
    options: { ...OPTIONS, promptMode: "plan" },
  });
  await settle(3);
  expect((await harness.waitForResponse(3)).error).toBeUndefined();

  expect(turnStarts()[1]?.params).not.toHaveProperty("collaborationMode");
  expect(asked).toHaveLength(1);
  await answerUntil(() => userInputResponses().length > 1);
  expect(userInputResponses()[1]).toMatchObject({
    error: { message: expect.stringContaining("secret") },
  });

  harness.sendRequest(4, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_234567892c",
    input: [{ type: "text", text: "go ahead", mentions: [] }],
    options: OPTIONS,
  });
  await settle(4);
  expect((await harness.waitForResponse(4)).error).toBeUndefined();

  expect(turnStarts()[2]?.params).toMatchObject({
    input: [{ type: "text", text: "go ahead" }],
    collaborationMode: { mode: "default" },
  });
}, 30_000);

it("answers a non-blocking Codex question without waiting for a question card", async () => {
  writeFileSync(
    join(workspaceDir, "script.json"),
    JSON.stringify({
      requestLogPath,
      turns: [askingTurn("turn-nonblocking", question({}), false)],
    }),
  );
  harness.sendRequest(1, "thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: OPTIONS,
  });
  await settle(1);
  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse((await harness.waitForResponse(1)).result);

  harness.sendRequest(2, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_234567892d",
    input: [{ type: "text", text: "Continue without waiting", mentions: [] }],
    options: OPTIONS,
  });
  await answerUntil(
    () =>
      harness.hasResponse(2) ||
      harness.messages.some(
        (message) =>
          message.method === BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
      ),
  );
  expect(
    harness.messages.some(
      (message) =>
        message.method === BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
    ),
  ).toBe(false);
  await harness.waitForResponse(2);

  expect(asked).toHaveLength(0);
  expect(userInputResponses()[0]).toMatchObject({
    result: {
      answers: {
        color: {
          answers: [
            "This question was non-blocking, so no answer was collected.",
          ],
        },
      },
    },
  });
}, 30_000);

it.each([
  ["start", undefined],
  ["resume", { mode: "default" }],
] as const)(
  "on a %s session, sends collaborationMode %o with the first ordinary turn",
  async (kind, expected) => {
    writeFileSync(
      join(workspaceDir, "script.json"),
      JSON.stringify({ requestLogPath, turns: [[]] }),
    );
    harness.sendRequest(1, `thread/${kind}`, {
      threadId,
      ...(kind === "resume" ? { providerThreadId: "provider-resumed" } : {}),
      cwd: workspaceDir,
      instructionMode: "append",
      options: OPTIONS,
    });
    await settle(1);
    const { providerThreadId } = z
      .object({ providerThreadId: z.string() })
      .parse((await harness.waitForResponse(1)).result);

    harness.sendRequest(2, "turn/start", {
      threadId,
      providerThreadId,
      clientRequestId: "creq_234567892d",
      input: [{ type: "text", text: "go ahead", mentions: [] }],
      options: OPTIONS,
    });
    await settle(2);
    expect((await harness.waitForResponse(2)).error).toBeUndefined();

    const params = turnStarts()[0]?.params;
    if (expected === undefined) {
      expect(params).not.toHaveProperty("collaborationMode");
    } else {
      expect(params).toMatchObject({ collaborationMode: expected });
    }
  },
  30_000,
);

it("switches modes with the model Codex reported when turns name no model", async () => {
  writeFileSync(
    join(workspaceDir, "script.json"),
    JSON.stringify({ requestLogPath, turns: [[], []] }),
  );
  harness.sendRequest(1, "thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  await settle(1);
  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse((await harness.waitForResponse(1)).result);

  harness.sendRequest(2, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_234567892e",
    input: PLAN_INPUT,
    options: { ...FULL_ACCESS_SESSION_OPTIONS, promptMode: "plan" },
  });
  await settle(2);
  expect((await harness.waitForResponse(2)).error).toBeUndefined();

  harness.sendRequest(3, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_234567892f",
    input: [{ type: "text", text: "go ahead", mentions: [] }],
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  await settle(3);
  expect((await harness.waitForResponse(3)).error).toBeUndefined();

  expect(turnStarts().map((entry) => entry.params)).toEqual([
    expect.objectContaining({
      input: [expect.objectContaining({ text: "outline the migration" })],
      collaborationMode: expect.objectContaining({
        mode: "plan",
        settings: expect.objectContaining({ model: "fake-codex-model" }),
      }),
    }),
    expect.objectContaining({
      collaborationMode: expect.objectContaining({
        mode: "default",
        settings: expect.objectContaining({ model: "fake-codex-model" }),
      }),
    }),
  ]);
}, 30_000);

it("returns the answer to a question whose id is __proto__", async () => {
  writeFileSync(
    join(workspaceDir, "script.json"),
    JSON.stringify({
      requestLogPath,
      turns: [askingTurn("turn-proto", question({ id: "__proto__" }))],
    }),
  );
  harness.sendRequest(1, "thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: OPTIONS,
  });
  await settle(1);
  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse((await harness.waitForResponse(1)).result);

  harness.sendRequest(2, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_234567892g",
    input: PLAN_INPUT,
    options: { ...OPTIONS, promptMode: "plan" },
  });
  await settle(2);
  expect((await harness.waitForResponse(2)).error).toBeUndefined();
  await answerUntil(() => userInputResponses().length > 0);

  const responseLine = readFileSync(requestLogPath, "utf8")
    .split("\n")
    .find((line) => line.includes("response:item/tool/requestUserInput"));
  expect(responseLine).toContain(
    '"result":{"answers":{"__proto__":{"answers":["Green"]}}}',
  );
}, 30_000);
