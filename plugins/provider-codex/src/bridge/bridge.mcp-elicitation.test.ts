import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { BRIDGE_INBOUND_REQUEST_METHODS } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const SHIPPING_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", title: "Recipient", minLength: 2 },
    quantity: { type: "integer", title: "Quantity", minimum: 1, maximum: 10 },
    gift: { type: "boolean", title: "Gift wrap" },
  },
  required: ["name", "quantity", "gift"],
};

function elicitingTurn(turnId: string, params: Record<string, unknown>) {
  return [
    {
      method: "turn/started",
      params: { threadId: "x", turn: { id: turnId, status: "inProgress" } },
    },
    {
      kind: "request",
      method: "mcpServer/elicitation/request",
      params: { threadId: "x", turnId, serverName: "shop", ...params },
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

let threadCounter = 0;
let threadId = "";
let workspaceDir: string;
let requestLogPath: string;
let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let answered = 0;
const asked: unknown[] = [];
type Reply = { result: unknown } | { error: string };
let replies: Reply[] = [];

beforeEach(() => {
  threadCounter += 1;
  threadId = `thr_mcp_elicit_${threadCounter}`;
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-mcp-elicit-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  answered = 0;
  asked.length = 0;
  replies = [];
});

function startHarness(turns: unknown[]): void {
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath, turns }));
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
}

afterEach(async () => {
  harness.sendRequest(991_003, "thread/stop", {
    threadId,
    providerThreadId: "mcp-elicit-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(991_003).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

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
      const reply = replies.shift() ?? { error: "no scripted reply" };
      handleLine(
        JSON.stringify(
          "result" in reply
            ? { jsonrpc: "2.0", id: message.id, result: reply.result }
            : {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32000, message: reply.error },
              },
        ),
      );
    }
    answered = harness.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function elicitationResponses() {
  return readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({ method: z.string(), params: z.unknown() })
        .parse(JSON.parse(line)),
    )
    .filter(
      (entry) => entry.method === "response:mcpServer/elicitation/request",
    )
    .map(
      (entry) => z.object({ result: z.unknown() }).parse(entry.params).result,
    );
}

async function runOneTurn(): Promise<void> {
  harness.sendRequest(1, "thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  await answerUntil(() => harness.hasResponse(1));
  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse((await harness.waitForResponse(1)).result);
  harness.sendRequest(2, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_e2icitx2ab",
    input: [{ type: "text", text: "order it", mentions: [] }],
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  await answerUntil(() => elicitationResponses().length > 0);
}

it("asks an MCP form in a bb question card and returns typed content to Codex", async () => {
  startHarness([
    elicitingTurn("turn-e1", {
      mode: "form",
      _meta: null,
      message: "How should I ship it?",
      requestedSchema: SHIPPING_SCHEMA,
    }),
  ]);
  replies = [
    {
      result: {
        kind: "user_answer",
        answers: {
          "field-1": { selected: [], freeText: "Ada" },
          "field-2": { selected: [], freeText: "3" },
          "field-3": { selected: ["field-3:option-2"] },
        },
      },
    },
  ];

  await runOneTurn();

  expect(elicitationResponses()).toEqual([
    {
      action: "accept",
      content: { name: "Ada", quantity: 3, gift: false },
      _meta: null,
    },
  ]);
  expect(asked).toEqual([
    expect.objectContaining({
      threadId,
      turnId: "turn-e1",
      payload: expect.objectContaining({
        kind: "user_question",
        questions: [
          expect.objectContaining({
            id: "field-1",
            prompt:
              "The shop MCP server asks: How should I ship it? Recipient (at least 2 characters)",
          }),
          expect.objectContaining({ id: "field-2" }),
          expect.objectContaining({ id: "field-3" }),
        ],
      }),
    }),
  ]);
});

it("declines a URL elicitation without showing a card", async () => {
  startHarness([
    elicitingTurn("turn-e2", {
      mode: "url",
      _meta: null,
      message: "Sign in to the shop",
      url: "https://shop.example/login",
      elicitationId: "el-1",
    }),
  ]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await runOneTurn();

  expect(elicitationResponses()).toEqual([
    { action: "decline", content: null, _meta: null },
  ]);
  expect(asked).toEqual([]);
  stderr.mockRestore();
});

it.each([
  [
    "string limits on a choice field",
    { type: "string", enum: ["x", "long"], minLength: 2 },
  ],
  ["a pattern on a text field", { type: "string", pattern: "^[a-z]+$" }],
])("declines a form with %s without showing a card", async (_label, field) => {
  startHarness([
    elicitingTurn("turn-e5", {
      mode: "form",
      _meta: null,
      message: "Name the release",
      requestedSchema: {
        type: "object",
        properties: { field },
        required: ["field"],
      },
    }),
  ]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await runOneTurn();

  expect(elicitationResponses()).toEqual([
    { action: "decline", content: null, _meta: null },
  ]);
  expect(asked).toEqual([]);
  stderr.mockRestore();
});

it("cancels the elicitation when the question card is cancelled", async () => {
  startHarness([
    elicitingTurn("turn-e3", {
      mode: "form",
      _meta: null,
      message: "How should I ship it?",
      requestedSchema: SHIPPING_SCHEMA,
    }),
  ]);
  replies = [{ error: "Pending interaction was cancelled" }];
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await runOneTurn();

  expect(elicitationResponses()).toEqual([
    { action: "cancel", content: null, _meta: null },
  ]);
  expect(asked).toHaveLength(1);
  stderr.mockRestore();
});
