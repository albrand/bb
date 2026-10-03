import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CanUseTool,
  McpServerConfig,
  OnElicitation,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  type JsonValue,
  type RuntimePermissionPolicy,
  type RuntimePermissionScope,
} from "@get-bb/plugin-sdk/provider-bridge";

const { forkSessionMock, queryMock, openMock, nativeOpenRef } = vi.hoisted(
  () => ({
    forkSessionMock: vi.fn(),
    queryMock: vi.fn(),
    openMock: vi.fn(),
    nativeOpenRef: {
      current: null as null | typeof import("node:fs/promises").open,
    },
  }),
);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  forkSession: forkSessionMock,
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  nativeOpenRef.current = actual.open;
  openMock.mockImplementation(actual.open);
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => openMock(...args),
  };
});

import { handleLine } from "../bridge.js";
import { buildSessionOptions } from "../session-options.js";
import {
  type ClaudePermissionMode,
  type ClaudeUserQuestionInput,
} from "../../interactive-contract.js";
import { listClaudeCodeBridgeModels } from "../model-list.js";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeJsonRpcOutputMessage,
  ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

type BridgeSessionOptions = ReturnType<typeof buildSessionOptions>;
type BridgeSessionHooks = NonNullable<BridgeSessionOptions["hooks"]>;
type BridgePreToolUseHooks = NonNullable<BridgeSessionHooks["PreToolUse"]>;
type BridgePreToolUseHook = BridgePreToolUseHooks[number]["hooks"][number];
type BridgeJsonRpcTestHarness = ReturnType<
  typeof createBridgeJsonRpcTestHarness
>;
type SdkResultUsage = Extract<SDKMessage, { type: "result" }>["usage"];

interface AssistantToolUseMessageArgs {
  parentToolUseId: string | null;
  toolInput: Record<string, unknown>;
  toolName: string;
  toolUseId: string;
}

interface CanUseToolPolicyAllowExpectation {
  behavior: "allow";
  updatedInput: Record<string, unknown>;
}

interface CanUseToolPolicyDenyExpectation {
  behavior: "deny";
  messageIncludes: string;
}

type CanUseToolPolicyExpectation =
  | CanUseToolPolicyAllowExpectation
  | CanUseToolPolicyDenyExpectation;

interface CanUseToolPolicyCase {
  blockedPath?: string;
  decisionReason?: string;
  expected: CanUseToolPolicyExpectation;
  id: string;
  input: Record<string, unknown>;
  name: string;
  policy: RuntimePermissionPolicy;
  toolName: string;
}

interface ControlledClaudeQuery {
  getContextUsage: ReturnType<typeof vi.fn>;
  applyFlagSettings: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emit(message: SDKMessage): void;
  fail(error: Error): void;
  finish(): void;
  initializationResult: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setMcpServers: ReturnType<typeof vi.fn>;
  mcpServerStatus: ReturnType<typeof vi.fn>;
  reconnectMcpServer: ReturnType<typeof vi.fn>;
  toggleMcpServer: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
}

interface ClaudeQueryCallOptions {
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: CanUseTool;
  onElicitation?: OnElicitation;
  env?: Record<string, string | undefined>;
  extraArgs?: Record<string, string | null>;
  hooks?: BridgeSessionHooks;
  model?: string;
  permissionMode?: ClaudePermissionMode;
  resume?: string;
  sandbox?: BridgeSessionOptions["sandbox"];
  sessionId?: string;
  settingSources?: string[];
  stderr?: (data: string) => void;
}

interface ClaudeQueryCall {
  options: ClaudeQueryCallOptions;
  prompt: AsyncIterable<SDKUserMessage>;
}

interface StaleResumeErrorMessageArgs {
  missingSessionId: string;
  sessionId: string;
}

interface TempClaudeExecutable {
  binDir: string;
  executablePath: string;
}

interface ControlledClaudeQueryMessageResult {
  result: IteratorResult<SDKMessage>;
  type: "result";
}

interface ControlledClaudeQueryErrorResult {
  error: Error;
  type: "error";
}

type ControlledClaudeQueryResult =
  | ControlledClaudeQueryMessageResult
  | ControlledClaudeQueryErrorResult;

const tempDirs: string[] = [];
let previousHome: string | undefined;
let previousClaudeConfigDir: string | undefined;
const CLAUDE_EXECUTABLE_NAME =
  process.platform === "win32" ? "claude.exe" : "claude";

interface StartBridgeThreadArgs {
  bridge: BridgeJsonRpcTestHarness;
  cwd?: string;
  threadId: string;
}

interface ResumeBridgeThreadArgs {
  bridge: BridgeJsonRpcTestHarness;
  permissionEscalation?: "ask" | "deny";
  providerThreadId: string | null;
  requestId: number;
  threadId: string;
}

interface StopBridgeThreadArgs {
  bridge: BridgeJsonRpcTestHarness;
  queries: ControlledClaudeQuery[];
  threadId: string;
}

interface ForwardAskUserQuestionArgs {
  bridge: BridgeJsonRpcTestHarness;
  input?: ClaudeUserQuestionInput;
  toolUseID: string;
}

interface ForwardedAskUserQuestion {
  questionRequest: BridgeJsonRpcOutputMessage;
  resultPromise: ReturnType<CanUseTool>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isClaudeQueryCall(value: unknown): value is ClaudeQueryCall {
  if (!isRecord(value) || !isRecord(value.options)) {
    return false;
  }
  const { prompt } = value;
  if (
    prompt === null ||
    typeof prompt !== "object" ||
    !(Symbol.asyncIterator in prompt)
  ) {
    return false;
  }
  return (
    value.options.canUseTool === undefined ||
    typeof value.options.canUseTool === "function"
  );
}

function getProviderThreadIdFromResult(
  message: BridgeJsonRpcOutputMessage,
): string {
  if (
    !isRecord(message.result) ||
    typeof message.result.providerThreadId !== "string"
  ) {
    throw new Error("Expected response result with providerThreadId");
  }
  return message.result.providerThreadId;
}

function getLatestQueryOptions(): ClaudeQueryCallOptions {
  return getLatestQueryCall().options;
}

function getLatestQueryCall(): ClaudeQueryCall {
  const latestCall = queryMock.mock.calls.at(-1)?.[0];
  if (!isClaudeQueryCall(latestCall)) {
    throw new Error("Expected Claude SDK query options");
  }
  return latestCall;
}

function getFailedTurns(messages: BridgeJsonRpcOutputMessage[]) {
  return assembleCapturedThreadEvents(messages, "claude-code").filter(
    (event) => event.type === "turn/completed" && event.status === "failed",
  );
}

function getBridgeErrorMessages(
  messages: BridgeJsonRpcOutputMessage[],
): string[] {
  return messages.flatMap((message) => {
    if (message.method !== "error" || !isRecord(message.params)) {
      return [];
    }
    return typeof message.params.message === "string"
      ? [message.params.message]
      : [];
  });
}

function getLastCanUseTool(): CanUseTool {
  const latestCall = queryMock.mock.calls.at(-1)?.[0];
  if (!isClaudeQueryCall(latestCall) || !latestCall.options.canUseTool) {
    throw new Error("Expected Claude SDK query to receive canUseTool");
  }
  return latestCall.options.canUseTool;
}

function getLastOnElicitation(): OnElicitation {
  const onElicitation = getLatestQueryOptions().onElicitation;
  if (!onElicitation) {
    throw new Error("Expected Claude SDK query to receive onElicitation");
  }
  return onElicitation;
}

const COLOR_ELICITATION = {
  serverName: "design",
  message: "Pick a banner color.",
  mode: "form" as const,
  requestedSchema: {
    type: "object",
    properties: {
      color: { type: "string", title: "Color", enum: ["red", "green"] },
    },
    required: ["color"],
  },
};

function createControlledClaudeQuery(): ControlledClaudeQuery {
  let finishNext: ((result: IteratorResult<SDKMessage>) => void) | undefined;
  let failNext: ((error: Error) => void) | undefined;
  const pendingResults: ControlledClaudeQueryResult[] = [];
  function pushResult(result: IteratorResult<SDKMessage>): void {
    if (finishNext) {
      const resolve = finishNext;
      finishNext = undefined;
      failNext = undefined;
      resolve(result);
      return;
    }
    pendingResults.push({ type: "result", result });
  }
  function pushError(error: Error): void {
    if (failNext) {
      const reject = failNext;
      finishNext = undefined;
      failNext = undefined;
      reject(error);
      return;
    }
    pendingResults.push({ type: "error", error });
  }
  const iterator: AsyncIterator<SDKMessage> = {
    next: () => {
      const pending = pendingResults.shift();
      if (pending?.type === "result") return Promise.resolve(pending.result);
      if (pending?.type === "error") return Promise.reject(pending.error);
      return new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
        finishNext = resolve;
        failNext = reject;
      });
    },
    return: async () => {
      finishNext = undefined;
      failNext = undefined;
      return { value: undefined, done: true };
    },
  };
  return {
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(() => {
      pushResult({ value: undefined, done: true });
    }),
    emit(message: SDKMessage): void {
      pushResult({ value: message, done: false });
    },
    fail(error: Error): void {
      pushError(error);
    },
    finish() {
      pushResult({ value: undefined, done: true });
    },
    getContextUsage: vi.fn().mockResolvedValue(null),
    initializationResult: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi
      .fn()
      .mockResolvedValue({ added: [], removed: [], errors: {} }),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
    toggleMcpServer: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

async function readNextPrompt(call: ClaudeQueryCall): Promise<SDKUserMessage> {
  const result = await call.prompt[Symbol.asyncIterator]().next();
  if (result.done) {
    throw new Error("Expected Claude prompt input");
  }
  return result.value;
}

async function readNextPromptText(call: ClaudeQueryCall): Promise<string> {
  const content = (await readNextPrompt(call)).message.content;
  if (typeof content !== "string") {
    throw new Error("Expected Claude prompt text content");
  }
  return content;
}

async function readNextPromptTextWithin(
  call: ClaudeQueryCall,
  timeoutMs: number,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readNextPromptText(call),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Claude prompt did not arrive before deadline")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectTurnAcceptedBeforePrompt(args: {
  bridge: BridgeJsonRpcTestHarness;
  call: ClaudeQueryCall;
  input: string;
  requestId: number;
}): Promise<void> {
  expect(await readNextPromptTextWithin(args.call, 1_000)).toBe(args.input);
  await args.bridge.waitForResponse(args.requestId);
}

async function invokeBridgeHooks(
  matchers:
    | readonly {
        hooks: readonly BridgePreToolUseHook[];
      }[]
    | undefined,
  input: Parameters<BridgePreToolUseHook>[0],
  toolUseId?: string,
): Promise<Awaited<ReturnType<BridgePreToolUseHook>>[]> {
  const outputs: Awaited<ReturnType<BridgePreToolUseHook>>[] = [];
  for (const matcher of matchers ?? []) {
    for (const hook of matcher.hooks) {
      outputs.push(
        await hook(input, toolUseId, {
          signal: new AbortController().signal,
        }),
      );
    }
  }
  return outputs;
}

async function expectExternalMcpToolsBlocked(
  call: ClaudeQueryCall,
): Promise<void> {
  const outputs = await invokeBridgeHooks(call.options.hooks?.PreToolUse, {
    hook_event_name: "PreToolUse",
    tool_name: "mcp__fixture__search",
    tool_input: {},
    tool_use_id: "tool-revoked-mcp",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp/worktree",
  });
  expect(outputs).toContainEqual(
    expect.objectContaining({
      hookSpecificOutput: expect.objectContaining({
        permissionDecision: "deny",
      }),
    }),
  );
  const allowedOutputs = await invokeBridgeHooks(
    call.options.hooks?.PreToolUse,
    {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: {},
      tool_use_id: "tool-allowed-read",
      session_id: "session-1",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp/worktree",
    },
  );
  expect(allowedOutputs).not.toContainEqual(
    expect.objectContaining({
      hookSpecificOutput: expect.objectContaining({
        permissionDecision: "deny",
      }),
    }),
  );
}

function createResultUsage(): SdkResultUsage {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: "",
    input_tokens: 0,
    iterations: [],
    output_tokens: 0,
    server_tool_use: {
      web_fetch_requests: 0,
      web_search_requests: 0,
    },
    service_tier: "standard",
    speed: "standard",
  };
}

function createStaleResumeErrorMessage(
  args: StaleResumeErrorMessageArgs,
): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: createResultUsage(),
    modelUsage: {},
    permission_denials: [],
    errors: [`No conversation found with session ID: ${args.missingSessionId}`],
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: args.sessionId,
  };
}

function createAuthenticationErrorMessage(sessionId: string): SDKMessage {
  return {
    type: "assistant",
    error: "authentication_failed",
    message: {
      id: "authentication-error-message",
      type: "message",
      role: "assistant",
      container: null,
      content: [
        {
          type: "text",
          text: "Failed to authenticate: OAuth session expired and could not be refreshed",
          citations: null,
        },
      ],
      context_management: null,
      model: "<synthetic>",
      stop_details: null,
      stop_reason: "stop_sequence",
      stop_sequence: "",
      usage: createResultUsage(),
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: sessionId,
  };
}

function createSuccessfulResultMessage(sessionId: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: createResultUsage(),
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000004",
    session_id: sessionId,
  };
}

function createAssistantToolUseMessage(
  args: AssistantToolUseMessageArgs,
): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: `message-${args.toolUseId}`,
      type: "message",
      role: "assistant",
      container: null,
      content: [
        {
          type: "tool_use",
          id: args.toolUseId,
          name: args.toolName,
          input: args.toolInput,
        },
      ],
      context_management: null,
      model: "claude-sonnet-5",
      stop_details: null,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: createResultUsage(),
    },
    parent_tool_use_id: args.parentToolUseId,
    uuid: `00000000-0000-4000-8000-${args.toolUseId}`,
    session_id: "session-1",
  };
}

function createTempClaudeExecutable(): TempClaudeExecutable {
  const binDir = mkdtempSync(join(tmpdir(), "bb-claude-path-"));
  tempDirs.push(binDir);
  const executablePath = join(binDir, CLAUDE_EXECUTABLE_NAME);
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  chmodSync(executablePath, 0o755);
  return { binDir, executablePath };
}

function approveProjectMcpJson(cwd: string): void {
  const settingsDirectory = join(cwd, ".claude");
  mkdirSync(settingsDirectory, { recursive: true });
  writeFileSync(
    join(settingsDirectory, "settings.local.json"),
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
}

function createBridgeUserQuestionInput(): ClaudeUserQuestionInput {
  return {
    questions: [
      {
        question: "Which deployment target should I use?",
        header: "Target",
        options: [
          {
            label: "Staging",
            description: "Deploy to staging.",
          },
          {
            label: "Production",
            description: "Deploy to production.",
          },
        ],
        multiSelect: false,
      },
    ],
  };
}

function canonicalOptions(args?: {
  permissionEscalation?: "ask" | "deny";
  providerOptions?: Record<string, JsonValue>;
}): Record<string, JsonValue> {
  return {
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: args?.permissionEscalation ?? "ask",
    instructions: "test",
    providerOptions: {
      workflowsEnabled: false,
      ...args?.providerOptions,
    },
  };
}

function canonicalTurnParams(args: {
  threadId: string;
  providerThreadId?: string;
  expectedTurnId?: string;
  input: JsonValue[];
  permissionEscalation?: "ask" | "deny";
  providerOptions?: Record<string, JsonValue>;
}): Record<string, JsonValue> {
  return {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId ?? args.threadId,
    ...(args.expectedTurnId !== undefined
      ? { expectedTurnId: args.expectedTurnId }
      : {}),
    clientRequestId: "creq_abcdefghjk",
    input: args.input,
    options: canonicalOptions(args),
  };
}

function planCommandInput(text: string): JsonValue[] {
  return [
    {
      type: "text",
      text: `/plan ${text}`,
      mentions: [
        {
          start: 0,
          end: "/plan".length,
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
}

async function startBridgeThread(args: StartBridgeThreadArgs): Promise<void> {
  args.bridge.sendRequest(1, "thread/start", {
    cwd: args.cwd ?? "/tmp/worktree",
    instructionMode: "append",
    options: canonicalOptions({}),
    threadId: args.threadId,
  });
  await args.bridge.waitForResponse(1);
}

function sendResumeThread(args: ResumeBridgeThreadArgs): void {
  args.bridge.sendRequest(args.requestId, "thread/resume", {
    cwd: "/tmp/worktree",
    instructionMode: "append",
    options: canonicalOptions({
      ...(args.permissionEscalation
        ? { permissionEscalation: args.permissionEscalation }
        : {}),
    }),
    providerThreadId: args.providerThreadId,
    threadId: args.threadId,
  });
}

async function stopBridgeThread(args: StopBridgeThreadArgs): Promise<void> {
  args.bridge.sendRequest(2, "thread/stop", {
    threadId: args.threadId,
    providerThreadId: args.threadId,
    intent: "interrupt",
    activeTurnId: null,
  });
  await args.bridge.flushWork();
  args.queries[0]?.finish();
  await args.bridge.waitForResponse(2);
}

function interactionPayload(
  message: BridgeJsonRpcOutputMessage,
): Record<string, unknown> | undefined {
  if (message.method !== BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest) {
    return undefined;
  }
  const params = message.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const payload = params.payload;
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function isApprovalInteraction(message: BridgeJsonRpcOutputMessage): boolean {
  return interactionPayload(message)?.kind === "approval";
}

function isUserQuestionInteraction(
  message: BridgeJsonRpcOutputMessage,
): boolean {
  return interactionPayload(message)?.kind === "user_question";
}

async function forwardAskUserQuestion({
  bridge,
  input = createBridgeUserQuestionInput(),
  toolUseID,
}: ForwardAskUserQuestionArgs): Promise<ForwardedAskUserQuestion> {
  const canUseTool = getLastCanUseTool();
  const resultPromise = canUseTool("AskUserQuestion", input, {
    requestId: "control-request",
    signal: new AbortController().signal,
    toolUseID,
  });
  await bridge.flushWork();

  const questionRequest = bridge.messages.find((message) =>
    isUserQuestionInteraction(message),
  );
  if (questionRequest?.id === undefined) {
    throw new Error("Expected AskUserQuestion JSON-RPC request id");
  }
  return {
    questionRequest,
    resultPromise,
  };
}

describe("bridge", () => {
  beforeEach(() => {
    previousHome = process.env.HOME;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    vi.clearAllMocks();
    if (nativeOpenRef.current) {
      openMock.mockImplementation(nativeOpenRef.current);
    }
    forkSessionMock.mockResolvedValue({ sessionId: "forked-session-1" });
    queryMock.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({
        account: {},
        models: [
          {
            value: "default",
            displayName: "Default (recommended)",
            description:
              "Opus 4.8 with 1M context [NEW] · Most capable for complex work",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            value: "claude-haiku-4-5",
            displayName: "Haiku",
            description: "Haiku 4.5",
          },
          {
            value: "claude-sonnet-4-6",
            displayName: "Sonnet",
            description: "Sonnet 4.6 · Best for everyday tasks",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
          {
            value: "claude-sonnet-4-6[1m]",
            displayName: "Sonnet (1M context)",
            description: "Sonnet 4.6 with 1M context · Billed as extra usage",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
        ],
      }),
      close: vi.fn(),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
      setMcpServers: vi.fn().mockResolvedValue({
        added: [],
        removed: [],
        errors: {},
      }),
      toggleMcpServer: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies a new project MCP server on the next turn without restarting the session", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-add";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "First turn" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("First turn");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            fixture: {
              type: "stdio",
              command: "fixture-mcp",
              args: ["--ready"],
            },
          },
        }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Second turn" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Second turn");
      await bridge.waitForResponse(3);
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(query.setMcpServers.mock.calls[1]?.[0]).toMatchObject({
        fixture: { type: "stdio", command: "fixture-mcp", args: ["--ready"] },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);

      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            fixture: {
              type: "stdio",
              command: "fixture-mcp",
              args: ["--edited"],
            },
          },
        }),
      );
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Third turn" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Third turn");
      await bridge.waitForResponse(4);
      expect(query.setMcpServers.mock.calls[2]?.[0]).toMatchObject({
        fixture: { type: "stdio", command: "fixture-mcp", args: ["--edited"] },
      });

      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
      bridge.sendRequest(
        5,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Fourth turn" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Fourth turn");
      await bridge.waitForResponse(5);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({});
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it.each([
    {
      name: "when absent",
      envValue: undefined,
      expectedUrl: "https://fixture.invalid/fallback",
    },
    {
      name: "when present",
      envValue: "https://fixture.invalid/from-env",
      expectedUrl: "https://fixture.invalid/from-env",
    },
  ])(
    "expands MCP URL fallback variables $name",
    async ({ envValue, expectedUrl, name }) => {
      const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
      tempDirs.push(home);
      const cwd = join(home, "project");
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      process.env.HOME = home;
      process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
      const previousMcpUrl = process.env.CLAUDE_MCP_FALLBACK_URL;
      if (envValue === undefined) delete process.env.CLAUDE_MCP_FALLBACK_URL;
      else process.env.CLAUDE_MCP_FALLBACK_URL = envValue;
      const mcpConfig = join(cwd, ".mcp.json");
      const settingsPath = join(cwd, ".claude", "settings.local.json");
      const mcpUrl = (url: string) => ({
        mcpServers: { fixture: { type: "http", url } },
      });
      writeFileSync(
        mcpConfig,
        JSON.stringify(mcpUrl("https://fixture.invalid/initial")),
      );
      writeFileSync(
        settingsPath,
        JSON.stringify({ enableAllProjectMcpServers: true }),
      );
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const query = createControlledClaudeQuery();
      query.mcpServerStatus.mockResolvedValue([]);
      queryMock.mockReturnValue(query);
      const threadId = `thread-live-mcp-url-fallback-${name.replaceAll(" ", "-")}`;

      try {
        await startBridgeThread({ bridge, cwd, threadId });
        const call = queryMock.mock.calls[0]?.[0];
        if (!isClaudeQueryCall(call))
          throw new Error("Expected Claude SDK query");

        const turn = async (requestId: number, input: string) => {
          bridge.sendRequest(
            requestId,
            "turn/start",
            canonicalTurnParams({
              threadId,
              input: [{ type: "text", text: input }],
            }),
          );
          expect(await readNextPromptText(call)).toBe(input);
          await bridge.waitForResponse(requestId);
        };

        await turn(2, "Start initial MCP server");
        expect(query.setMcpServers).toHaveBeenLastCalledWith({
          fixture: { type: "http", url: "https://fixture.invalid/initial" },
        });

        writeFileSync(
          mcpConfig,
          JSON.stringify(
            mcpUrl(
              "${CLAUDE_MCP_FALLBACK_URL:-https://fixture.invalid/fallback}",
            ),
          ),
        );
        await turn(3, "Use fallback MCP URL");
        expect(query.setMcpServers).toHaveBeenLastCalledWith({
          fixture: { type: "http", url: expectedUrl },
        });
        expect(queryMock).toHaveBeenCalledTimes(1);
      } finally {
        if (previousMcpUrl === undefined) {
          delete process.env.CLAUDE_MCP_FALLBACK_URL;
        } else {
          process.env.CLAUDE_MCP_FALLBACK_URL = previousMcpUrl;
        }
        query.finish();
        await stopBridgeThread({ bridge, queries: [query], threadId });
        bridge.restore();
      }
    },
  );

  it("passes only approved project MCP servers to the SDK", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          approved: { command: "approved-mcp" },
          unapproved: { command: "unapproved-mcp" },
        },
      }),
    );
    writeFileSync(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({
        enableAllProjectMcpServers: false,
        enabledMcpjsonServers: ["approved"],
      }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-approved-only";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Use approved server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Use approved server");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenCalledWith({
        approved: { type: "stdio", command: "approved-mcp" },
      });
      expect(query.setMcpServers).not.toHaveBeenCalledWith(
        expect.objectContaining({ unapproved: expect.anything() }),
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("does not pass checked-in settings MCP servers after project rejection", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { fixture: { command: "rejected-project-command" } },
      }),
    );
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        disabledMcpjsonServers: ["fixture"],
        mcpServers: { fixture: { command: "checked-in-command" } },
      }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-rejected-settings-command";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Keep rejected command out" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Keep rejected command out");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenCalledWith({});
      expect(query.setMcpServers).not.toHaveBeenCalledWith(
        expect.objectContaining({ fixture: expect.anything() }),
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("keeps a rejected static server disabled when the SDK update fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
    const mcpConfig = join(cwd, ".mcp.json");
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { fixture: serverConfig } }),
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    let serverEnabled = true;
    let updateCount = 0;
    query.mcpServerStatus.mockImplementation(async () => [
      {
        name: "fixture",
        status: serverEnabled ? "connected" : "disabled",
        scope: "project",
        config: serverConfig,
      },
    ]);
    query.toggleMcpServer.mockImplementation(async (_name, enabled) => {
      serverEnabled = enabled;
    });
    query.setMcpServers.mockImplementation(async () => {
      updateCount += 1;
      if (updateCount === 2) throw new Error("unrelated update failure");
      return { added: [], removed: [], errors: {} };
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-revoked-update-failure";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Start approved server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Start approved server");
      await bridge.waitForResponse(2);
      expect(serverEnabled).toBe(true);

      writeFileSync(
        settingsPath,
        JSON.stringify({ enableAllProjectMcpServers: false }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Keep revoked server disabled" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Keep revoked server disabled",
        requestId: 3,
      });
      expect(serverEnabled).toBe(false);
      expect(query.toggleMcpServer).not.toHaveBeenCalledWith("fixture", true);

      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry revoked server removal" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Retry revoked server removal",
      );
      await bridge.waitForResponse(4);
      expect(serverEnabled).toBe(false);
      expect(query.setMcpServers).toHaveBeenCalledTimes(3);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({});
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("sends a turn when disabling a revoked static server fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
    const mcpConfig = join(cwd, ".mcp.json");
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { fixture: serverConfig } }),
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    let serverEnabled = true;
    let rejectNextDisable = false;
    query.mcpServerStatus.mockImplementation(async () => [
      {
        name: "fixture",
        status: serverEnabled ? "connected" : "disabled",
        scope: "project",
        config: serverConfig,
      },
    ]);
    query.toggleMcpServer.mockImplementation(async (_name, enabled) => {
      if (!enabled && rejectNextDisable) {
        rejectNextDisable = false;
        throw new Error("transient disable failure");
      }
      serverEnabled = enabled;
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-revoked-disable-failure";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Start approved server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Start approved server");
      await bridge.waitForResponse(2);

      writeFileSync(
        settingsPath,
        JSON.stringify({ enableAllProjectMcpServers: false }),
      );
      rejectNextDisable = true;
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Do not use revoked server" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Do not use revoked server",
        requestId: 3,
      });
      expect(serverEnabled).toBe(true);
      await expectExternalMcpToolsBlocked(call);

      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry revoked server removal" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Retry revoked server removal",
      );
      await bridge.waitForResponse(4);
      expect(serverEnabled).toBe(false);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("sends a turn when server status cannot be read after revocation", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
    const mcpConfig = join(cwd, ".mcp.json");
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { fixture: serverConfig } }),
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    let serverEnabled = true;
    query.mcpServerStatus.mockImplementation(async () => [
      {
        name: "fixture",
        status: serverEnabled ? "connected" : "disabled",
        scope: "project",
        config: serverConfig,
      },
    ]);
    query.toggleMcpServer.mockImplementation(async (_name, enabled) => {
      serverEnabled = enabled;
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-revoked-status-failure";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Start approved server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Start approved server");
      await bridge.waitForResponse(2);

      writeFileSync(
        settingsPath,
        JSON.stringify({ enableAllProjectMcpServers: false }),
      );
      query.mcpServerStatus.mockRejectedValueOnce(
        new Error("transient status failure"),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Do not use revoked server" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Do not use revoked server",
        requestId: 3,
      });
      expect(serverEnabled).toBe(true);
      await expectExternalMcpToolsBlocked(call);

      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry revoked server removal" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Retry revoked server removal",
      );
      await bridge.waitForResponse(4);
      expect(serverEnabled).toBe(false);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("sends a turn and retries after server status cannot be read", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
    const mcpConfig = join(cwd, ".mcp.json");
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
    writeFileSync(
      settingsPath,
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-add-status-failure";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Start without MCP servers" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Start without MCP servers");
      await bridge.waitForResponse(2);

      writeFileSync(
        mcpConfig,
        JSON.stringify({ mcpServers: { fixture: serverConfig } }),
      );
      query.mcpServerStatus.mockRejectedValueOnce(
        new Error("transient status failure"),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Wait for added server" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Wait for added server",
        requestId: 3,
      });

      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry with added server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Retry with added server");
      await bridge.waitForResponse(4);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: serverConfig,
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("sends turns while a needs-auth server reconnect fails after an MCP config change", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
    const mcpConfig = join(cwd, ".mcp.json");
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    const needsAuth = {
      name: "authServer",
      status: "needs-auth",
      scope: "dynamic",
      config: { type: "http", url: "https://fixture.invalid/auth" },
    } as const;
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
    writeFileSync(
      settingsPath,
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([needsAuth]);
    query.reconnectMcpServer.mockRejectedValue(
      new Error("auth server still unavailable"),
    );
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-auth-reconnect-failure-nonblocking";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      const turn = async (requestId: number, input: string) => {
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({
            threadId,
            input: [{ type: "text", text: input }],
          }),
        );
        expect(await readNextPromptTextWithin(call, 1_000)).toBe(input);
        await bridge.waitForResponse(requestId);
      };

      await turn(2, "Begin before server is added");
      await vi.waitFor(() =>
        expect(query.reconnectMcpServer).toHaveBeenCalledTimes(1),
      );
      writeFileSync(
        mcpConfig,
        JSON.stringify({ mcpServers: { fixture: serverConfig } }),
      );
      await turn(3, "Apply config with auth server still failing");
      await vi.waitFor(() =>
        expect(query.reconnectMcpServer).toHaveBeenCalledTimes(2),
      );
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: serverConfig,
      });

      await turn(4, "Continue after first reconnect failure");
      await turn(5, "Continue after second reconnect failure");
      await turn(6, "Continue after third reconnect failure");
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(query.reconnectMcpServer).toHaveBeenCalledTimes(2);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("sends a turn while the MCP reconnect promise remains pending", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const config = { type: "http", url: "https://fixture.invalid/mcp" };
    const userConfig = join(home, ".claude.json");
    writeFileSync(userConfig, JSON.stringify({ mcpServers: {} }));
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    const needsAuth = {
      name: "fixture",
      status: "needs-auth",
      scope: "user",
      config,
    } as const;
    query.mcpServerStatus
      .mockResolvedValueOnce([needsAuth])
      .mockResolvedValueOnce([needsAuth]);
    let releaseReconnect = (): void => {};
    query.reconnectMcpServer.mockImplementation(
      () =>
        new Promise<void>((resolveReconnect) => {
          releaseReconnect = resolveReconnect;
        }),
    );
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-reconnect-pending";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Start before MCP config change" }],
        }),
      );
      expect(await readNextPromptTextWithin(call, 1_000)).toBe(
        "Start before MCP config change",
      );
      await bridge.waitForResponse(2);
      writeFileSync(
        userConfig,
        JSON.stringify({ mcpServers: { fixture: config } }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Proceed during pending reconnect" }],
        }),
      );
      expect(await readNextPromptTextWithin(call, 1_000)).toBe(
        "Proceed during pending reconnect",
      );
      await bridge.waitForResponse(3);
      await vi.waitFor(() =>
        expect(query.reconnectMcpServer).toHaveBeenCalledWith("fixture"),
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseReconnect();
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("does not reconnect a healthy unchanged MCP server", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const config = { type: "http", url: "https://fixture.invalid/mcp" };
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { fixture: config } }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    const healthy = {
      name: "fixture",
      status: "connected",
      scope: "user",
      config,
    } as const;
    query.mcpServerStatus.mockResolvedValue([healthy]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-healthy-no-reconnect";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      for (const [requestId, input] of [
        [2, "Initial MCP config"],
        [3, "Unchanged MCP config"],
      ] as const) {
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({
            threadId,
            input: [{ type: "text", text: input }],
          }),
        );
        expect(await readNextPromptTextWithin(call, 1_000)).toBe(input);
        await bridge.waitForResponse(requestId);
      }
      await vi.waitFor(() =>
        expect(query.mcpServerStatus).toHaveBeenCalledTimes(2),
      );
      expect(query.reconnectMcpServer).not.toHaveBeenCalled();
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("sends a turn and retries config after MCP server status cannot be read", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude-config");
    const mcpConfig = join(cwd, ".mcp.json");
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    const needsAuth = {
      name: "fixture",
      status: "needs-auth",
      scope: "dynamic",
      config: serverConfig,
    } as const;
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
    writeFileSync(
      settingsPath,
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-reconnect-status-failure";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Start without MCP servers" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Start without MCP servers");
      await bridge.waitForResponse(2);

      writeFileSync(
        mcpConfig,
        JSON.stringify({ mcpServers: { fixture: serverConfig } }),
      );
      query.mcpServerStatus
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("transient reconnect status failure"));
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Wait for reconnect status" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Wait for reconnect status",
        requestId: 3,
      });
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: serverConfig,
      });

      query.mcpServerStatus
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([needsAuth]);
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry after reconnect status" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Retry after reconnect status",
      );
      await bridge.waitForResponse(4);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: serverConfig,
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("applies the MCP config snapshot whose signature it accepts", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { fixture: { command: "initial-mcp" } } }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-snapshot-consistency";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load initial server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load initial server");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "initial-mcp" },
      });

      const snapshotB = JSON.stringify({
        mcpServers: { fixture: { command: "snapshot-b" } },
      });
      const interveningSnapshotA = JSON.stringify({
        mcpServers: { fixture: { command: "snapshot-a" } },
      });
      writeFileSync(mcpConfig, snapshotB);
      const nativeOpen = nativeOpenRef.current;
      if (!nativeOpen) throw new Error("Expected native config file reader");
      let targetOpenCount = 0;
      openMock.mockImplementation(
        (path: string, flags: number, mode?: number) => {
          if (String(path) !== mcpConfig) {
            return nativeOpen(path, flags, mode);
          }
          targetOpenCount += 1;
          if (targetOpenCount !== 2) {
            return nativeOpen(path, flags, mode);
          }
          return Promise.resolve({
            close: async () => {},
            read: async (buffer: Buffer, offset: number) => ({
              bytesRead: buffer.write(interveningSnapshotA, offset),
            }),
            stat: async () => ({
              isFile: () => true,
              mode: 0,
              ino: 1,
              mtimeMs: 1,
              size: Buffer.byteLength(interveningSnapshotA),
            }),
          } as unknown);
        },
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Apply snapshot B" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Apply snapshot B");
      await bridge.waitForResponse(3);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "snapshot-b" },
      });

      openMock.mockImplementation(nativeOpen);
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Keep snapshot B" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Keep snapshot B");
      await bridge.waitForResponse(4);
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("applies local MCP scope precedence and local edits before the next turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const projectConfig = join(cwd, ".mcp.json");
    const writeUserConfig = (localCommand: string): void => {
      writeFileSync(
        userConfig,
        JSON.stringify({
          mcpServers: { shared: { command: "user-mcp" } },
          projects: {
            [cwd]: { mcpServers: { shared: { command: localCommand } } },
          },
        }),
      );
    };
    writeUserConfig("local-mcp-v1");
    writeFileSync(
      projectConfig,
      JSON.stringify({ mcpServers: { shared: { command: "project-mcp" } } }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    let resolveLocalUpdateStarted = (): void => {};
    let releaseLocalUpdate = (): void => {};
    let localUpdateSettled = false;
    const localUpdateStarted = new Promise<void>((resolveStarted) => {
      resolveLocalUpdateStarted = resolveStarted;
    });
    const localUpdateGate = new Promise<void>((resolveUpdate) => {
      releaseLocalUpdate = resolveUpdate;
    });
    const threadId = "thread-live-mcp-scope-precedence";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Use local server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Use local server");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        shared: { type: "stdio", command: "local-mcp-v1" },
      });

      query.setMcpServers.mockImplementation(
        async (servers: Record<string, McpServerConfig>) => {
          const server = servers.shared;
          if (server?.type === "stdio" && server.command === "local-mcp-v2") {
            resolveLocalUpdateStarted();
            await localUpdateGate;
            localUpdateSettled = true;
          }
          return { added: [], removed: [], errors: {} };
        },
      );
      writeUserConfig("local-mcp-v2");
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Apply local edit" }],
        }),
      );
      let promptBeforeUpdateSettled = false;
      const localEditPrompt = readNextPromptText(call).then((text) => {
        if (!localUpdateSettled) promptBeforeUpdateSettled = true;
        return text;
      });
      await localUpdateStarted;
      await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 0));
      expect(promptBeforeUpdateSettled).toBe(false);
      releaseLocalUpdate();
      expect(await localEditPrompt).toBe("Apply local edit");
      await bridge.waitForResponse(3);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        shared: { type: "stdio", command: "local-mcp-v2" },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseLocalUpdate();
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("does not call the live MCP API when config files are unchanged", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-unchanged";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      for (const [requestId, text] of [
        [2, "One"],
        [3, "Two"],
      ] as const) {
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({
            threadId,
            input: [{ type: "text", text }],
          }),
        );
        expect(await readNextPromptText(call)).toBe(text);
        await bridge.waitForResponse(requestId);
      }
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("preserves a disabled server until its project config is explicitly edited", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: { deliberatelyDisabled: { command: "fixture-mcp" } },
      }),
    );
    const initialServerConfig = {
      type: "stdio",
      command: "fixture-mcp",
    };
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([
      {
        name: "deliberatelyDisabled",
        status: "disabled",
        scope: "project",
        config: initialServerConfig,
      },
    ]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-disabled";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Keep disabled" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Keep disabled");
      await bridge.waitForResponse(2);
      expect(query.toggleMcpServer).not.toHaveBeenCalledWith(
        "deliberatelyDisabled",
        true,
      );

      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            deliberatelyDisabled: { command: "explicitly-edited-mcp" },
          },
        }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Apply explicit edit" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Apply explicit edit");
      await bridge.waitForResponse(3);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        deliberatelyDisabled: {
          type: "stdio",
          command: "explicitly-edited-mcp",
        },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("re-enables a removed static server when its identical config returns", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { fixture: { command: "fixture-mcp" } } }),
    );
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    let serverEnabled = true;
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockImplementation(async () => [
      {
        name: "fixture",
        status: serverEnabled ? "connected" : "disabled",
        scope: "project",
        config: serverConfig,
      },
    ]);
    query.toggleMcpServer.mockImplementation(async (_name, enabled) => {
      serverEnabled = enabled;
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-restore-static";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      for (const [requestId, text] of [
        [2, "Server connected"],
        [3, "Remove server"],
        [4, "Restore server"],
      ] as const) {
        if (requestId === 3) {
          writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
        }
        if (requestId === 4) {
          writeFileSync(
            mcpConfig,
            JSON.stringify({
              mcpServers: { fixture: { command: "fixture-mcp" } },
            }),
          );
        }
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({
            threadId,
            input: [{ type: "text", text }],
          }),
        );
        expect(await readNextPromptText(call)).toBe(text);
        await bridge.waitForResponse(requestId);
        if (requestId === 2) expect(serverEnabled).toBe(true);
        if (requestId === 3) expect(serverEnabled).toBe(false);
        if (requestId === 4) expect(serverEnabled).toBe(true);
      }
      expect(query.toggleMcpServer.mock.calls).toEqual([
        ["fixture", false],
        ["fixture", true],
      ]);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("keeps a restored server disabled when project settings still disable it", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    const writeProjectConfig = (args: {
      includeServer: boolean;
      disabled?: boolean;
    }): void => {
      const projectConfig: Record<string, unknown> = {};
      if (args.includeServer)
        projectConfig.mcpServers = { fixture: serverConfig };
      if (args.disabled) projectConfig.disabledMcpServers = ["fixture"];
      writeFileSync(
        userConfig,
        JSON.stringify({ projects: { [cwd]: projectConfig } }),
      );
    };
    let serverEnabled = true;
    writeProjectConfig({ includeServer: true });
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockImplementation(async () => [
      {
        name: "fixture",
        status: serverEnabled ? "connected" : "disabled",
        scope: "local",
        config: serverConfig,
      },
    ]);
    query.toggleMcpServer.mockImplementation(async (_name, enabled) => {
      serverEnabled = enabled;
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-explicit-disable";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      for (const [requestId, text] of [
        [2, "Start connected"],
        [3, "Remove config"],
        [4, "Restore while disabled"],
        [5, "Remove disable setting"],
      ] as const) {
        if (requestId === 3) writeProjectConfig({ includeServer: false });
        if (requestId === 4) {
          writeProjectConfig({ includeServer: true, disabled: true });
        }
        if (requestId === 5) writeProjectConfig({ includeServer: true });
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({ threadId, input: [{ type: "text", text }] }),
        );
        expect(await readNextPromptText(call)).toBe(text);
        await bridge.waitForResponse(requestId);
        if (requestId === 2) expect(serverEnabled).toBe(true);
        if (requestId === 3) expect(serverEnabled).toBe(false);
        if (requestId === 4) expect(serverEnabled).toBe(false);
        if (requestId === 5) expect(serverEnabled).toBe(true);
      }

      expect(query.toggleMcpServer.mock.calls).toEqual([
        ["fixture", false],
        ["fixture", true],
      ]);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("coalesces concurrent turns that detect the same MCP config change", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-concurrent";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Initial turn" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Initial turn");
      await bridge.waitForResponse(2);

      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: { concurrent: { command: "fixture-mcp" } },
        }),
      );
      let releaseMcpUpdate = (): void => {};
      const heldMcpUpdate = new Promise<void>((resolveUpdate) => {
        releaseMcpUpdate = resolveUpdate;
      });
      query.setMcpServers.mockImplementation(async () => {
        await heldMcpUpdate;
        return { added: ["concurrent"], removed: [], errors: {} };
      });
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Concurrent turn one" }],
        }),
      );
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Concurrent turn two" }],
        }),
      );
      await vi.waitFor(() => {
        expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      });
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Concurrent turn one",
        requestId: 3,
      });
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Concurrent turn two",
        requestId: 4,
      });
      await expectExternalMcpToolsBlocked(call);
      releaseMcpUpdate();
      await vi.waitFor(async () => {
        const outputs = await invokeBridgeHooks(
          call.options.hooks?.PreToolUse,
          {
            hook_event_name: "PreToolUse",
            tool_name: "mcp__fixture__search",
            tool_input: {},
            tool_use_id: "tool-restored-mcp",
            session_id: "session-1",
            transcript_path: "/tmp/transcript.jsonl",
            cwd: "/tmp/worktree",
          },
        );
        expect(outputs).not.toContainEqual(
          expect.objectContaining({
            hookSpecificOutput: expect.objectContaining({
              permissionDecision: "deny",
            }),
          }),
        );
      });
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  }, 10_000);

  it("does not reload MCP servers when user config changes only non-MCP state", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfigPath = join(home, ".claude.json");
    writeFileSync(
      userConfigPath,
      JSON.stringify({ numStartups: 1, mcpServers: {} }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-non-mcp-state";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Before metadata update" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Before metadata update");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      writeFileSync(
        userConfigPath,
        JSON.stringify({ numStartups: 2, mcpServers: {} }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "After metadata update" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("After metadata update");
      await bridge.waitForResponse(3);
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);
      expect(query.reconnectMcpServer).not.toHaveBeenCalled();
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("preserves current MCP servers when a config file becomes a FIFO", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: { fixture: { command: "fixture-mcp" } },
      }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-fifo-replacement";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load configured server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load configured server");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "fixture-mcp" },
      });

      rmSync(mcpConfig);
      execFileSync("mkfifo", [mcpConfig]);
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Preserve server after FIFO" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Preserve server after FIFO");
      await bridge.waitForResponse(3);
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      rmSync(mcpConfig);
      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            fixture: { command: "restored-fixture-mcp" },
          },
        }),
      );
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry restored config" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Retry restored config");
      await bridge.waitForResponse(4);
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "restored-fixture-mcp" },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("preserves current MCP servers when a config contains invalid MCP data", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { fixture: { command: "fixture-mcp" } } }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-invalid-config";
    const invalidConfigs: Array<[string, unknown]> = [
      ["null root", null],
      ["non-object server list", { mcpServers: [] }],
      ["invalid server command", { mcpServers: { fixture: { command: 7 } } }],
    ];

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load configured server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load configured server");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "fixture-mcp" },
      });

      let requestId = 3;
      for (const [description, config] of invalidConfigs) {
        writeFileSync(mcpConfig, JSON.stringify(config));
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({
            threadId,
            input: [{ type: "text", text: `Preserve after ${description}` }],
          }),
        );
        expect(await readNextPromptText(call)).toBe(
          `Preserve after ${description}`,
        );
        await bridge.waitForResponse(requestId);
        expect(query.setMcpServers).toHaveBeenCalledTimes(1);
        requestId += 1;
      }

      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: { fixture: { command: "restored-fixture-mcp" } },
        }),
      );
      bridge.sendRequest(
        requestId,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry valid config" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Retry valid config");
      await bridge.waitForResponse(requestId);
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "restored-fixture-mcp" },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("preserves local MCP servers when the project config map is malformed", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const validConfig = JSON.stringify({
      projects: {
        [cwd]: { mcpServers: { fixture: { command: "fixture-mcp" } } },
      },
    });
    writeFileSync(userConfig, validConfig);
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([
      {
        name: "fixture",
        status: "connected",
        scope: "local",
        config: { type: "stdio", command: "fixture-mcp" },
      },
    ]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-malformed-project-map";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load local server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load local server");
      await bridge.waitForResponse(2);
      expect(query.toggleMcpServer).not.toHaveBeenCalled();
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      writeFileSync(userConfig, JSON.stringify({ projects: [] }));
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Preserve local server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Preserve local server");
      await bridge.waitForResponse(3);
      expect(query.toggleMcpServer).not.toHaveBeenCalled();
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      writeFileSync(
        userConfig,
        JSON.stringify({
          projects: {
            [cwd]: {
              mcpServers: {
                fixture: { command: "restored-fixture-mcp" },
              },
            },
          },
        }),
      );
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry local config" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Retry local config");
      await bridge.waitForResponse(4);
      expect(query.toggleMcpServer).toHaveBeenCalledExactlyOnceWith(
        "fixture",
        false,
      );
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "restored-fixture-mcp" },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("preserves a static MCP server when its configured URL is malformed", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const originalUrl = "https://fixture.invalid/mcp";
    const validConfig = JSON.stringify({
      projects: {
        [cwd]: {
          mcpServers: { fixture: { type: "http", url: originalUrl } },
        },
      },
    });
    writeFileSync(userConfig, validConfig);
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([
      {
        name: "fixture",
        status: "connected",
        scope: "local",
        config: { type: "http", url: originalUrl },
      },
    ]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-malformed-url";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load static server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load static server");
      await bridge.waitForResponse(2);
      expect(query.toggleMcpServer).not.toHaveBeenCalled();
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      writeFileSync(
        userConfig,
        JSON.stringify({
          projects: {
            [cwd]: {
              mcpServers: { fixture: { type: "http", url: "not a URL" } },
            },
          },
        }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Preserve after invalid URL" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Preserve after invalid URL");
      await bridge.waitForResponse(3);
      expect(query.toggleMcpServer).not.toHaveBeenCalled();
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      writeFileSync(userConfig, validConfig);
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Restore original server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Restore original server");
      await bridge.waitForResponse(4);
      expect(query.toggleMcpServer).not.toHaveBeenCalled();
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({});
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("restores a static MCP server when its valid replacement fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const originalUrl = "https://fixture.invalid/mcp";
    const validConfig = JSON.stringify({
      projects: {
        [cwd]: {
          mcpServers: { fixture: { type: "http", url: originalUrl } },
        },
      },
    });
    writeFileSync(userConfig, validConfig);
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([
      {
        name: "fixture",
        status: "connected",
        scope: "local",
        config: { type: "http", url: originalUrl },
      },
    ]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-replacement-error";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load static server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load static server");
      await bridge.waitForResponse(2);

      query.setMcpServers.mockRejectedValueOnce(
        new Error("fixture connection failed"),
      );
      writeFileSync(
        userConfig,
        JSON.stringify({
          projects: {
            [cwd]: {
              mcpServers: {
                fixture: {
                  type: "http",
                  url: "https://fixture.invalid/unavailable",
                },
              },
            },
          },
        }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Handle failed replacement" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Handle failed replacement",
        requestId: 3,
      });
      expect(query.toggleMcpServer).toHaveBeenCalledTimes(2);
      expect(query.toggleMcpServer).toHaveBeenNthCalledWith(
        1,
        "fixture",
        false,
      );
      expect(query.toggleMcpServer).toHaveBeenNthCalledWith(2, "fixture", true);

      writeFileSync(userConfig, validConfig);
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Restore original server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Restore original server");
      await bridge.waitForResponse(4);
      expect(query.toggleMcpServer).toHaveBeenCalledTimes(2);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("keeps healthy MCP tools available when one added server fails to connect", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    writeFileSync(
      userConfig,
      JSON.stringify({
        projects: {
          [cwd]: {
            mcpServers: { healthy: { command: "healthy-mcp" } },
          },
        },
      }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([
      {
        name: "healthy",
        status: "connected",
        scope: "local",
        config: { type: "stdio", command: "healthy-mcp" },
      },
    ]);
    queryMock.mockReturnValue(query);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const threadId = "thread-live-mcp-isolated-server-failure";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Start with healthy MCP" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Start with healthy MCP");
      await bridge.waitForResponse(2);

      query.setMcpServers.mockResolvedValueOnce({
        added: [],
        removed: [],
        errors: { broken: "invalid command" },
      });
      writeFileSync(
        userConfig,
        JSON.stringify({
          projects: {
            [cwd]: {
              mcpServers: {
                healthy: { command: "healthy-mcp" },
                broken: { command: "missing-mcp" },
              },
            },
          },
        }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Continue with one failed MCP" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Continue with one failed MCP",
        requestId: 3,
      });
      const healthyToolOutputs = await invokeBridgeHooks(
        call.options.hooks?.PreToolUse,
        {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__healthy__search",
          tool_input: {},
          tool_use_id: "tool-healthy-mcp-after-add",
          session_id: "session-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd,
        },
      );
      expect(healthyToolOutputs).not.toContainEqual(
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
          }),
        }),
      );

      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Continue on the next turn" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Continue on the next turn",
        requestId: 4,
      });
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      const nextHealthyToolOutputs = await invokeBridgeHooks(
        call.options.hooks?.PreToolUse,
        {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__healthy__search",
          tool_input: {},
          tool_use_id: "tool-healthy-mcp-next-turn",
          session_id: "session-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd,
        },
      );
      expect(nextHealthyToolOutputs).not.toContainEqual(
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
          }),
        }),
      );
      expect(stderrWrite.mock.calls.flat().join(" ")).toContain(
        "MCP server broken failed to connect: invalid command",
      );
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
      stderrWrite.mockRestore();
    }
  });

  it("restores earlier static servers when an MCP update fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const validConfig = JSON.stringify({
      projects: {
        [cwd]: {
          mcpServers: {
            first: { command: "first-mcp" },
            second: { command: "second-mcp" },
          },
        },
      },
    });
    writeFileSync(userConfig, validConfig);
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([
      {
        name: "first",
        status: "connected",
        scope: "local",
        config: { type: "stdio", command: "first-mcp" },
      },
      {
        name: "second",
        status: "connected",
        scope: "local",
        config: { type: "stdio", command: "second-mcp" },
      },
    ]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-reconnect-error";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load both static servers" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load both static servers");
      await bridge.waitForResponse(2);

      query.setMcpServers.mockRejectedValueOnce(
        new Error("server update failed"),
      );
      writeFileSync(
        userConfig,
        JSON.stringify({
          projects: {
            [cwd]: {
              mcpServers: {
                first: { command: "first-mcp-updated" },
                second: { command: "second-mcp" },
              },
            },
          },
        }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Roll back partial refresh" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Roll back partial refresh",
        requestId: 3,
      });
      expect(query.toggleMcpServer).toHaveBeenNthCalledWith(1, "first", false);
      expect(query.toggleMcpServer).toHaveBeenNthCalledWith(2, "first", true);
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);

      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry partial refresh" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Retry partial refresh");
      await bridge.waitForResponse(4);
      expect(query.toggleMcpServer).toHaveBeenNthCalledWith(3, "first", false);
      expect(query.setMcpServers).toHaveBeenCalledTimes(3);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        first: { type: "stdio", command: "first-mcp-updated" },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("retries static server restoration after a transient toggle failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const originalUrl = "https://fixture.invalid/mcp";
    const originalConfig = JSON.stringify({
      projects: {
        [cwd]: {
          mcpServers: { fixture: { type: "http", url: originalUrl } },
        },
      },
    });
    writeFileSync(userConfig, originalConfig);
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    let serverEnabled = true;
    let toggleCount = 0;
    query.mcpServerStatus.mockImplementation(async () => [
      {
        name: "fixture",
        status: serverEnabled ? "connected" : "disabled",
        scope: "local",
        config: { type: "http", url: originalUrl },
      },
    ]);
    query.toggleMcpServer.mockImplementation(async (_name, enabled) => {
      toggleCount += 1;
      if (toggleCount === 2 && enabled) {
        throw new Error("transient restore failure");
      }
      serverEnabled = enabled;
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-retry-static-restore";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load original static server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Load original static server",
      );
      await bridge.waitForResponse(2);

      query.setMcpServers.mockRejectedValueOnce(
        new Error("fixture connection failed"),
      );
      writeFileSync(
        userConfig,
        JSON.stringify({
          projects: {
            [cwd]: {
              mcpServers: {
                fixture: {
                  type: "http",
                  url: "https://fixture.invalid/unavailable",
                },
              },
            },
          },
        }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Encounter transient failures" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Encounter transient failures",
        requestId: 3,
      });
      expect(serverEnabled).toBe(false);
      expect(toggleCount).toBe(2);

      writeFileSync(userConfig, originalConfig);
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry unchanged config recovery" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Retry unchanged config recovery",
      );
      await bridge.waitForResponse(4);
      expect(serverEnabled).toBe(true);
      expect(toggleCount).toBe(3);
      expect(query.toggleMcpServer).toHaveBeenLastCalledWith("fixture", true);
      expect(query.setMcpServers).toHaveBeenCalledTimes(3);

      bridge.sendRequest(
        5,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Unchanged after restoration" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Unchanged after restoration",
      );
      await bridge.waitForResponse(5);
      expect(query.setMcpServers).toHaveBeenCalledTimes(3);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("reconciles dynamic servers after a failed partial replacement", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    const originalConfig = JSON.stringify({
      mcpServers: { fixture: { command: "fixture-mcp" } },
    });
    writeFileSync(mcpConfig, originalConfig);
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    let dynamicServers: Record<string, { type: "stdio"; command: string }> = {};
    let failNextUpdate = false;
    query.mcpServerStatus.mockImplementation(async () =>
      Object.entries(dynamicServers).map(([name, config]) => ({
        name,
        status: "connected",
        scope: "dynamic",
        config,
      })),
    );
    query.setMcpServers.mockImplementation(async (servers) => {
      if (failNextUpdate) {
        failNextUpdate = false;
        dynamicServers = {};
        return {
          added: [],
          removed: ["fixture"],
          errors: { fixture: "replacement failed after removal" },
        };
      }
      dynamicServers = servers as typeof dynamicServers;
      return { added: Object.keys(servers), removed: [], errors: {} };
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-dynamic-reconciliation";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load dynamic server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load dynamic server");
      await bridge.waitForResponse(2);
      expect(dynamicServers).toEqual({
        fixture: { type: "stdio", command: "fixture-mcp" },
      });

      failNextUpdate = true;
      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: { fixture: { command: "replacement-mcp" } },
        }),
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Handle partial replacement" }],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Handle partial replacement",
        requestId: 3,
      });
      expect(dynamicServers).toEqual({});
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);

      writeFileSync(mcpConfig, originalConfig);
      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Restore original dynamic server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Restore original dynamic server",
      );
      await bridge.waitForResponse(4);
      expect(dynamicServers).toEqual({
        fixture: { type: "stdio", command: "fixture-mcp" },
      });
      expect(query.setMcpServers).toHaveBeenCalledTimes(3);

      bridge.sendRequest(
        5,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Unchanged after dynamic recovery" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe(
        "Unchanged after dynamic recovery",
      );
      await bridge.waitForResponse(5);
      expect(query.setMcpServers).toHaveBeenCalledTimes(3);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("preserves current MCP servers when a config read hits premature EOF", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: { fixture: { command: "fixture-mcp" } },
      }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-premature-eof";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Load configured server" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Load configured server");
      await bridge.waitForResponse(2);
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      const updatedConfig = JSON.stringify({
        mcpServers: { fixture: { command: "restored-fixture-mcp" } },
      });
      writeFileSync(mcpConfig, updatedConfig);
      const nativeOpen = nativeOpenRef.current;
      if (!nativeOpen) throw new Error("Expected native config file reader");
      let targetOpenCount = 0;
      let readCount = 0;
      openMock.mockImplementation(
        (path: string, flags: number, mode?: number) => {
          if (String(path) !== mcpConfig) {
            return nativeOpen(path, flags, mode);
          }
          targetOpenCount += 1;
          if (targetOpenCount !== 1) {
            return nativeOpen(path, flags, mode);
          }
          return Promise.resolve({
            close: async () => {},
            read: async (buffer: Buffer, offset: number) => {
              readCount += 1;
              if (readCount === 1) {
                return { bytesRead: buffer.write("{}", offset) };
              }
              return { bytesRead: 0 };
            },
            stat: async () => ({
              isFile: () => true,
              mode: 0,
              ino: 1,
              mtimeMs: 1,
              size: Buffer.byteLength(updatedConfig),
            }),
          } as unknown);
        },
      );
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Preserve server on truncation" }],
        }),
      );
      try {
        expect(await readNextPromptText(call)).toBe(
          "Preserve server on truncation",
        );
        await bridge.waitForResponse(3);
        expect(query.setMcpServers).toHaveBeenCalledTimes(1);
      } finally {
        openMock.mockImplementation(nativeOpen);
      }

      bridge.sendRequest(
        4,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry restored config" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Retry restored config");
      await bridge.waitForResponse(4);
      expect(query.setMcpServers).toHaveBeenCalledTimes(2);
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "restored-fixture-mcp" },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("does not block a turn when a watched MCP config is a stalled FIFO", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    execFileSync("mkfifo", [mcpConfig]);
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-stall";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      const startedAt = performance.now();
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Continue despite stalled config" }],
        }),
      );
      expect(performance.now() - startedAt).toBeLessThan(1_500);
      expect(await readNextPromptText(call)).toBe(
        "Continue despite stalled config",
      );
      await bridge.waitForResponse(2);
      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Retry the stalled config" }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("Retry the stalled config");
      await bridge.waitForResponse(3);
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("fails closed on external MCP tools when a revoked config read stalls", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const serverConfig = { type: "stdio", command: "fixture-mcp" };
    const writeUserConfig = (includeServer: boolean) => {
      writeFileSync(
        userConfig,
        JSON.stringify({
          projects: {
            [cwd]: {
              ...(includeServer
                ? { mcpServers: { fixture: serverConfig } }
                : {}),
            },
          },
        }),
      );
    };
    writeUserConfig(true);
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    let serverEnabled = true;
    query.mcpServerStatus.mockImplementation(async () => [
      {
        name: "fixture",
        status: serverEnabled ? "connected" : "disabled",
        scope: "local",
        config: serverConfig,
      },
    ]);
    query.toggleMcpServer.mockImplementation(async (_name, enabled) => {
      serverEnabled = enabled;
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-revoked-config-read-stall";
    const nativeOpen = nativeOpenRef.current;
    if (!nativeOpen) throw new Error("Expected native config file reader");
    let releaseOpen = (): void => {};
    const openGate = new Promise<void>((resolveOpen) => {
      releaseOpen = resolveOpen;
    });
    let closedDelayedHandle = false;
    const close = vi.fn(async () => {
      closedDelayedHandle = true;
    });

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      const turn = async (requestId: number, input: string) => {
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({
            threadId,
            input: [{ type: "text", text: input }],
          }),
        );
        expect(await readNextPromptText(call)).toBe(input);
        await bridge.waitForResponse(requestId);
      };

      await turn(2, "Start with approved MCP server");
      expect(serverEnabled).toBe(true);
      writeUserConfig(false);
      openMock.mockImplementation(
        (path: string, flags: number, mode?: number) => {
          if (String(path) !== userConfig) return nativeOpen(path, flags, mode);
          return openGate.then(() =>
            Promise.resolve({
              close,
              stat: async () => ({ isFile: () => true, size: 0 }),
              read: async () => ({ bytesRead: 0 }),
            } as unknown),
          );
        },
      );

      await turn(3, "Continue while revoked config read times out");
      expect(serverEnabled).toBe(true);
      await expectExternalMcpToolsBlocked(call);

      releaseOpen();
      await vi.waitFor(() => expect(closedDelayedHandle).toBe(true));
      openMock.mockImplementation(nativeOpen);
      await turn(4, "Apply revoked config after read recovers");
      expect(serverEnabled).toBe(false);
      const recoveredOutputs = await invokeBridgeHooks(
        call.options.hooks?.PreToolUse,
        {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__fixture__search",
          tool_input: {},
          tool_use_id: "tool-restored-mcp",
          session_id: "session-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: "/tmp/worktree",
        },
      );
      expect(recoveredOutputs).not.toContainEqual(
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
          }),
        }),
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseOpen();
      openMock.mockImplementation(nativeOpen);
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  }, 10_000);

  it("bounds a stalled native config open across turns and recovers on the same Query", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    const config = (command: string) =>
      JSON.stringify({ mcpServers: { fixture: { command } } });
    writeFileSync(mcpConfig, config("initial-fixture-mcp"));
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    query.mcpServerStatus.mockResolvedValue([]);
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-stalled-open-recovery";
    const nativeOpen = nativeOpenRef.current;
    if (!nativeOpen) throw new Error("Expected native config file reader");
    let releaseOpen = (): void => {};
    const openGate = new Promise<void>((resolveOpen) => {
      releaseOpen = resolveOpen;
    });
    let targetOpenCount = 0;
    let closedDelayedHandle = false;
    const close = vi.fn(async () => {
      closedDelayedHandle = true;
    });

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");

      const turn = async (requestId: number, input: string) => {
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({
            threadId,
            input: [{ type: "text", text: input }],
          }),
        );
        expect(await readNextPromptText(call)).toBe(input);
        await bridge.waitForResponse(requestId);
      };

      await turn(2, "Load initial server");
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "initial-fixture-mcp" },
      });
      writeFileSync(mcpConfig, config("updated-fixture-mcp"));
      openMock.mockImplementation(
        (path: string, flags: number, mode?: number) => {
          if (String(path) !== mcpConfig) return nativeOpen(path, flags, mode);
          targetOpenCount += 1;
          if (targetOpenCount > 1) return nativeOpen(path, flags, mode);
          return openGate.then(() =>
            Promise.resolve({
              close,
              stat: async () => ({ isFile: () => true, size: 0 }),
              read: async () => ({ bytesRead: 0 }),
            } as unknown),
          );
        },
      );

      await turn(3, "Continue while config open is stalled");
      await turn(4, "Retry while config open is stalled");
      expect(targetOpenCount).toBe(1);
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);

      releaseOpen();
      await vi.waitFor(() => expect(closedDelayedHandle).toBe(true));
      openMock.mockImplementation(nativeOpen);
      await turn(5, "Apply recovered MCP config");
      expect(query.setMcpServers).toHaveBeenLastCalledWith({
        fixture: { type: "stdio", command: "updated-fixture-mcp" },
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseOpen();
      openMock.mockImplementation(nativeOpen);
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("delivers turns while SDK MCP status and update calls are pending", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    approveProjectMcpJson(cwd);
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const mcpConfig = join(cwd, ".mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-sdk-operations-pending";
    let releaseStatus = (): void => {};
    let releaseUpdate = (): void => {};
    let pendingStatus = false;
    let pendingUpdate = false;
    query.mcpServerStatus.mockImplementation(async () => {
      if (pendingStatus) {
        await new Promise<void>((resolve) => {
          releaseStatus = resolve;
        });
        pendingStatus = false;
      }
      return [];
    });
    query.setMcpServers.mockImplementation(async () => {
      if (pendingUpdate) {
        await new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        });
        pendingUpdate = false;
      }
      return { added: [], removed: [], errors: {} };
    });

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      const turn = async (requestId: number, input: string) => {
        bridge.sendRequest(
          requestId,
          "turn/start",
          canonicalTurnParams({
            threadId,
            input: [{ type: "text", text: input }],
          }),
        );
        await expectTurnAcceptedBeforePrompt({
          bridge,
          call,
          input,
          requestId,
        });
      };

      pendingStatus = true;
      writeFileSync(
        mcpConfig,
        JSON.stringify({ mcpServers: { fixture: { command: "fixture-mcp" } } }),
      );
      await turn(2, "Continue while MCP status is pending");
      await expectExternalMcpToolsBlocked(call);
      await vi.waitFor(() => expect(query.mcpServerStatus).toHaveBeenCalled());
      releaseStatus();
      await vi.waitFor(() =>
        expect(query.setMcpServers).toHaveBeenCalledTimes(1),
      );

      pendingUpdate = true;
      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: { fixture: { command: "replacement-mcp" } },
        }),
      );
      await turn(3, "Continue while MCP update is pending");
      await expectExternalMcpToolsBlocked(call);
      await vi.waitFor(() =>
        expect(query.setMcpServers).toHaveBeenCalledTimes(2),
      );
      releaseUpdate();
      await vi.waitFor(() =>
        expect(query.setMcpServers).toHaveBeenCalledTimes(2),
      );

      await turn(4, "Continue after MCP update settles");
      await vi.waitFor(async () => {
        const outputs = await invokeBridgeHooks(
          call.options.hooks?.PreToolUse,
          {
            hook_event_name: "PreToolUse",
            tool_name: "mcp__fixture__search",
            tool_input: {},
            tool_use_id: "tool-restored-mcp",
            session_id: "session-1",
            transcript_path: "/tmp/transcript.jsonl",
            cwd: "/tmp/worktree",
          },
        );
        expect(outputs).not.toContainEqual(
          expect.objectContaining({
            hookSpecificOutput: expect.objectContaining({
              permissionDecision: "deny",
            }),
          }),
        );
      });
    } finally {
      releaseStatus();
      releaseUpdate();
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it("delivers turns while disabling a revoked static MCP server is pending", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-claude-mcp-home-"));
    tempDirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const userConfig = join(home, ".claude.json");
    const serverConfig = { command: "fixture-mcp" };
    writeFileSync(
      userConfig,
      JSON.stringify({ mcpServers: { fixture: serverConfig } }),
    );
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const query = createControlledClaudeQuery();
    let releaseDisable = (): void => {};
    let serverEnabled = true;
    query.mcpServerStatus.mockImplementation(async () => [
      {
        name: "fixture",
        status: serverEnabled ? "connected" : "disabled",
        scope: "user",
        config: serverConfig,
      },
    ]);
    query.toggleMcpServer.mockImplementation(async (_name, enabled) => {
      if (!enabled) {
        await new Promise<void>((resolve) => {
          releaseDisable = resolve;
        });
      }
      serverEnabled = enabled;
    });
    queryMock.mockReturnValue(query);
    const threadId = "thread-live-mcp-static-disable-pending";

    try {
      await startBridgeThread({ bridge, cwd, threadId });
      const call = queryMock.mock.calls[0]?.[0];
      if (!isClaudeQueryCall(call))
        throw new Error("Expected Claude SDK query");
      writeFileSync(userConfig, JSON.stringify({ mcpServers: {} }));
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [
            {
              type: "text",
              text: "Continue while static server disable is pending",
            },
          ],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Continue while static server disable is pending",
        requestId: 2,
      });
      await expectExternalMcpToolsBlocked(call);
      await vi.waitFor(() =>
        expect(query.toggleMcpServer).toHaveBeenCalledWith("fixture", false),
      );
      releaseDisable();
      await vi.waitFor(() => expect(serverEnabled).toBe(false));

      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [
            {
              type: "text",
              text: "Continue after static server disable settles",
            },
          ],
        }),
      );
      await expectTurnAcceptedBeforePrompt({
        bridge,
        call,
        input: "Continue after static server disable settles",
        requestId: 3,
      });
    } finally {
      releaseDisable();
      query.finish();
      await stopBridgeThread({ bridge, queries: [query], threadId });
      bridge.restore();
    }
  });

  it.each([
    [200_000, false],
    [1_000_000, false],
    [200_000, true],
    [1_000_000, true],
  ])(
    "uses the reported %i capacity from initialization through assistant messages and compaction (delayed: %s)",
    async (capacity, delayed) => {
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const queries: ControlledClaudeQuery[] = [];
      queryMock.mockImplementation(() => {
        const query = createControlledClaudeQuery();
        query.getContextUsage.mockResolvedValue({
          categories: [{ name: "Provider category", tokens: 450 }],
          totalTokens: 450,
          rawMaxTokens: capacity,
          model: "claude-test",
          isAutoCompactEnabled: false,
        });
        queries.push(query);
        return query;
      });
      let resolveReport!: (report: unknown) => void;
      const pending = new Promise<unknown>((resolve) => {
        resolveReport = resolve;
      });
      const threadId = "thread-context-snapshot";
      try {
        bridge.sendRequest(1, "thread/start", {
          threadId,
          cwd: "/tmp/worktree",
          instructionMode: "append",
          options: {
            permissionMode: "accept-edits",
            permissionScope: "workspace",
            approvalReviewer: "user",
            permissionEscalation: "ask",
            instructions: "test",
            providerOptions: { workflowsEnabled: false },
          },
        });
        await bridge.waitForResponse(1);
        bridge.sendRequest(
          2,
          "turn/start",
          canonicalTurnParams({
            threadId,
            providerThreadId: threadId,
            input: [{ type: "text", text: "hello" }],
          }),
        );
        await readNextPrompt(getLatestQueryCall());
        await bridge.waitForResponse(2);
        if (delayed) queries[0].getContextUsage.mockReturnValueOnce(pending);
        queries[0].emit({
          type: "system",
          subtype: "init",
          apiKeySource: "none",
          claude_code_version: "2.1.285",
          cwd: "/tmp/worktree",
          tools: [],
          mcp_servers: [],
          model: "claude-opus-5-5",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          uuid: "00000000-0000-4000-8000-000000000001",
          session_id: threadId,
        });
        if (delayed) {
          await vi.waitFor(() =>
            expect(queries[0].getContextUsage).toHaveBeenCalledTimes(1),
          );
          queries[0].emit(
            createAssistantToolUseMessage({
              parentToolUseId: null,
              toolInput: { command: "pwd" },
              toolName: "Bash",
              toolUseId: "before-capacity",
            }),
          );
          await vi.waitFor(() => {
            const events = assembleCapturedThreadEvents(
              bridge.messages,
              "claude-code",
            );
            expect(
              events
                .filter(
                  (event) => event.type === "thread/contextWindowUsage/updated",
                )
                .at(-1)?.contextWindowUsage.usedTokens,
            ).toBe(0);
          });
          resolveReport({
            categories: [{ name: "Provider category", tokens: 450 }],
            totalTokens: 450,
            rawMaxTokens: capacity,
            model: "claude-opus-5-5",
            isAutoCompactEnabled: false,
          });
        }
        await vi.waitFor(() => {
          const events = assembleCapturedThreadEvents(
            bridge.messages,
            "claude-code",
          );
          if (delayed) {
            const usage = events
              .filter(
                (event) => event.type === "thread/contextWindowUsage/updated",
              )
              .at(-1)?.contextWindowUsage;
            expect(usage?.modelContextWindow).toBe(capacity);
            expect(usage?.usedTokens).not.toBe(450);
            expect(usage?.snapshot).toBeUndefined();
            return;
          }
          const snapshots = events.filter(
            (event) =>
              event.type === "thread/contextWindowUsage/updated" &&
              event.contextWindowUsage.snapshot,
          );
          expect(snapshots).toMatchObject([
            {
              contextWindowUsage: {
                usedTokens: 450,
                modelContextWindow: capacity,
                estimated: true,
                snapshot: {
                  providerSessionId: threadId,
                  providerTurnId: null,
                  usedTokens: 450,
                  categories: [
                    {
                      label: "Provider category",
                      kind: "used",
                      tokens: 450,
                      entries: [],
                    },
                  ],
                },
              },
            },
          ]);
        });
        expect(queries[0].getContextUsage).toHaveBeenCalledTimes(1);
        queries[0].emit(
          createAssistantToolUseMessage({
            parentToolUseId: null,
            toolInput: { command: "pwd" },
            toolName: "Bash",
            toolUseId: "context-usage",
          }),
        );
        await vi.waitFor(() => {
          const events = assembleCapturedThreadEvents(
            bridge.messages,
            "claude-code",
          );
          const usage = events
            .filter(
              (event) => event.type === "thread/contextWindowUsage/updated",
            )
            .at(-1)?.contextWindowUsage;
          expect(usage).toMatchObject({ modelContextWindow: capacity });
          expect(usage?.snapshot).toBeUndefined();
        });
        queries[0].emit(createSuccessfulResultMessage(threadId));
        await vi.waitFor(() =>
          expect(queries[0].getContextUsage).toHaveBeenCalledTimes(2),
        );
        queries[0].getContextUsage.mockResolvedValue(null);
        queries[0].emit({
          type: "system",
          subtype: "compact_boundary",
          uuid: "00000000-0000-4000-8000-000000000001",
          session_id: threadId,
          compact_metadata: {
            trigger: "manual",
            pre_tokens: 450,
            post_tokens: 100,
          },
        });
        await vi.waitFor(() => {
          const usageEvents = assembleCapturedThreadEvents(
            bridge.messages,
            "claude-code",
          ).filter(
            (event) => event.type === "thread/contextWindowUsage/updated",
          );
          expect(usageEvents.at(-1)?.contextWindowUsage).toEqual({
            usedTokens: null,
            modelContextWindow: null,
            estimated: true,
          });
          expect(queries[0].getContextUsage).toHaveBeenCalledTimes(3);
        });
      } finally {
        await stopBridgeThread({ bridge, queries, threadId });
        bridge.restore();
      }
    },
  );

  it("answers model/list with the missing-executable code when the Claude CLI is absent", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    queryMock.mockReturnValue({
      initializationResult: vi
        .fn()
        .mockRejectedValue(
          new Error("Native CLI binary for darwin-arm64 not found at /tmp/cli"),
        ),
      close: vi.fn(),
    });

    try {
      bridge.sendRequest(1, "model/list", {});
      const missing = await bridge.waitForResponse(1);

      expect(missing.error?.code).toBe(
        BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE,
      );
      expect(missing.error?.message).toContain(
        "could not find the Claude Code CLI",
      );

      queryMock.mockReturnValue({
        initializationResult: vi
          .fn()
          .mockRejectedValue(new Error("Claude SDK stream closed")),
        close: vi.fn(),
      });
      bridge.sendRequest(2, "model/list", {});
      const other = await bridge.waitForResponse(2);

      expect(other.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
      expect(other.error?.message).toBe("Claude SDK stream closed");
    } finally {
      bridge.restore();
    }
  });

  it("forks a Claude session through the requested provider checkpoint", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/fork", {
        threadId: "forked-thread-1",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        sourceProviderThreadId: "source-session-1",
        sourceProviderCheckpointId: "assistant-message-42",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });

      await expect(bridge.waitForResponse(1)).resolves.toMatchObject({
        result: {
          providerThreadId: "forked-session-1",
          sessionRestorable: true,
        },
      });
      expect(forkSessionMock).toHaveBeenCalledWith("source-session-1", {
        upToMessageId: "assistant-message-42",
      });
    } finally {
      await stopBridgeThread({
        bridge,
        queries,
        threadId: "forked-thread-1",
      });
      bridge.restore();
    }
  });

  it("keeps manager sessions on a plain string system prompt", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        baseInstructions: "You are a manager.",
        cwd: "/tmp/worktree",
        instructionMode: "replace",
        permissionMode: "default",
        permissionScope: "workspace",
      },
      {},
    );

    expect(options.cwd).toBe("/tmp/worktree");
    expect(options.systemPrompt).toBe("You are a manager.");
  });

  it("decomposes ultracode into xhigh effort plus the ultracode settings flag", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        reasoningLevel: "ultracode",
        workflowsEnabled: true,
        permissionMode: "default",
        permissionScope: "workspace",
      },
      {},
    );

    expect(options.effort).toBe("xhigh");
    expect(options.settings).toEqual({
      autoMemoryEnabled: true,
      enableWorkflows: true,
      ultracode: true,
      fastMode: false,
    });
  });

  it("enables workflows without the ultracode flag at lower efforts", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        reasoningLevel: "high",
        workflowsEnabled: true,
        permissionMode: "default",
        permissionScope: "workspace",
      },
      {},
    );

    expect(options.effort).toBe("high");
    expect(options.settings).toEqual({
      autoMemoryEnabled: true,
      enableWorkflows: true,
      ultracode: false,
      fastMode: false,
    });
  });

  it("sets fast mode only for the fast service tier at session start", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        workflowsEnabled: false,
        serviceTier: "fast",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "default",
        permissionScope: "workspace",
        model: "claude-opus-5",
      },
      {},
    );

    expect(options.settings).toMatchObject({ fastMode: true });
  });

  it("passes the memory setting when workflows are not enabled", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        reasoningLevel: "xhigh",
        permissionMode: "default",
        permissionScope: "workspace",
      },
      {},
    );

    expect(options.settings).toEqual({
      autoMemoryEnabled: true,
      enableWorkflows: false,
      ultracode: false,
      fastMode: false,
    });
  });

  it("disables Claude auto-memory reads and writes", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        memoryEnabled: false,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "default",
        permissionScope: "workspace",
      },
      {},
    );

    expect(options.settings).toEqual({
      autoMemoryEnabled: false,
      enableWorkflows: false,
      ultracode: false,
      fastMode: false,
    });
  });

  it("leaves standard sessions on the default Claude tool preset", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        reasoningLevel: "xhigh",
        permissionMode: "default",
        permissionScope: "workspace",
      },
      {},
    );

    expect(options.cwd).toBe("/tmp/worktree");
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are a coder.",
    });
    expect(options.effort).toBe("xhigh");
    expect(options.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("allows bypass mode only for full access sessions, including ones starting in plan mode", () => {
    const sessionOptions = (
      permissionMode: ClaudePermissionMode,
      permissionScope: RuntimePermissionScope,
    ) =>
      buildSessionOptions(
        {
          chromeEnabled: false,
          disable1MContext: false,
          sandboxEnabled: true,
          workflowsEnabled: false,
          cwd: "/tmp/worktree",
          instructionMode: "append",
          permissionMode,
          permissionScope,
          serviceTier: "default",
        },
        {},
      );

    expect(sessionOptions("plan", "full").allowBypassPermissions).toBe(true);
    expect(
      sessionOptions("bypassPermissions", "full").allowBypassPermissions,
    ).toBe(true);
    expect(sessionOptions("plan", "workspace").allowBypassPermissions).toBe(
      false,
    );
    expect(
      sessionOptions("acceptEdits", "workspace").allowBypassPermissions,
    ).toBe(false);
  });

  it("uses a Claude executable discovered from PATH for SDK sessions", () => {
    const { binDir, executablePath } = createTempClaudeExecutable();
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "default",
        permissionScope: "workspace",
      },
      { PATH: binDir },
    );

    expect(options.pathToClaudeCodeExecutable).toBe(executablePath);
  });

  it("falls back to well-known install locations when PATH discovery fails", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "bb-claude-home-"));
    tempDirs.push(homeDir);
    const localBinDir = join(homeDir, ".local", "bin");
    mkdirSync(localBinDir, { recursive: true });
    const executablePath = join(localBinDir, CLAUDE_EXECUTABLE_NAME);
    writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
    chmodSync(executablePath, 0o755);

    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "default",
        permissionScope: "workspace",
      },
      { HOME: homeDir, USERPROFILE: homeDir, PATH: "/nonexistent-bb-test-dir" },
    );

    expect(options.pathToClaudeCodeExecutable).toBe(executablePath);
  });

  it("trims explicit Claude executable overrides before forwarding", () => {
    const { executablePath } = createTempClaudeExecutable();
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "default",
        permissionScope: "workspace",
      },
      {
        BB_CLAUDE_CODE_EXECUTABLE: `  ${executablePath}  `,
        PATH: "/usr/bin",
      },
    );

    expect(options.pathToClaudeCodeExecutable).toBe(executablePath);
  });

  it("rejects explicit Claude executable overrides that are not executable", () => {
    const binDir = mkdtempSync(join(tmpdir(), "bb-claude-path-"));
    tempDirs.push(binDir);
    const executablePath = join(binDir, "claude");

    expect(() =>
      buildSessionOptions(
        {
          chromeEnabled: false,
          disable1MContext: false,
          sandboxEnabled: true,
          serviceTier: "default",
          workflowsEnabled: false,
          baseInstructions: "You are a coder.",
          cwd: "/tmp/worktree",
          instructionMode: "append",
          permissionMode: "default",
          permissionScope: "workspace",
        },
        {
          BB_CLAUDE_CODE_EXECUTABLE: executablePath,
          PATH: "/usr/bin",
        },
      ),
    ).toThrow("BB_CLAUDE_CODE_EXECUTABLE must point to an executable");
  });

  it("configures acceptEdits and auto sessions with the same Claude sandbox", () => {
    const acceptEditsOptions = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "acceptEdits",
        permissionScope: "workspace",
      },
      {},
    );
    const autoOptions = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "auto",
        permissionScope: "workspace",
      },
      {},
    );

    expect(acceptEditsOptions.permissionMode).toBe("acceptEdits");
    expect(acceptEditsOptions.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: false,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      network: { allowLocalBinding: true },
    });
    expect(autoOptions.permissionMode).toBe("auto");
    expect(autoOptions.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: false,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      network: { allowLocalBinding: true },
    });
  });

  it("keeps plan sessions on native gating without the workspace sandbox", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: true,
        serviceTier: "default",
        workflowsEnabled: false,
        additionalWorkspaceWriteRoots: ["/repo/.git/worktrees/bb13"],
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "plan",
        permissionScope: "workspace",
      },
      {},
    );

    expect(options.permissionMode).toBe("plan");
    expect(options.sandbox).toBeUndefined();
    expect(options.additionalDirectories).toBeUndefined();
  });

  it("leaves the Claude sandbox off when the sandbox setting is disabled", () => {
    const options = buildSessionOptions(
      {
        chromeEnabled: false,
        disable1MContext: false,
        sandboxEnabled: false,
        serviceTier: "default",
        workflowsEnabled: false,
        additionalWorkspaceWriteRoots: ["/repo/.git/worktrees/bb13"],
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionMode: "acceptEdits",
        permissionScope: "workspace",
      },
      {},
    );

    expect(options.permissionMode).toBe("acceptEdits");
    expect(options).not.toHaveProperty("sandbox");
    expect(options.additionalDirectories).toEqual([
      "/repo/.git/worktrees/bb13",
    ]);
  });

  describe("Bash canUseTool policy", () => {
    const WORKSPACE_AUTO_DENY_POLICY = {
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: "deny",
    } satisfies RuntimePermissionPolicy;
    const FULL_POLICY = {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    } satisfies RuntimePermissionPolicy;

    const policyCases = [
      {
        id: "workspace-sandbox-deny",
        name: "auto workspace sandbox denies out-of-workspace Bash",
        policy: WORKSPACE_AUTO_DENY_POLICY,
        toolName: "Bash",
        blockedPath: "/tmp/project",
        input: {
          command: "git status --short",
          description: "Permission boundary test",
        },
        expected: {
          behavior: "deny",
          messageIncludes: "bb's workspace sandbox allows work inside",
        },
      },
      {
        id: "escalation-deny-unsandboxed-bash",
        name: "escalation deny blocks unsandboxed Bash retry",
        policy: WORKSPACE_AUTO_DENY_POLICY,
        toolName: "Bash",
        decisionReason: "dangerouslyDisableSandbox",
        input: {
          command: "echo hi",
          dangerouslyDisableSandbox: true,
          description: "Permission boundary test",
        },
        expected: {
          behavior: "deny",
          messageIncludes: "bb's workspace sandbox allows work inside",
        },
      },
      {
        id: "full-bypass-allow",
        name: "full bypass allows Bash input unchanged",
        policy: FULL_POLICY,
        toolName: "Bash",
        decisionReason: "This command requires approval",
        input: {
          command: "git status --short",
          description: "Permission boundary test",
        },
        expected: {
          behavior: "allow",
          updatedInput: {
            command: "git status --short",
            description: "Permission boundary test",
          },
        },
      },
    ] satisfies CanUseToolPolicyCase[];

    it.each(policyCases)("$name", async (testCase) => {
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const queries: ControlledClaudeQuery[] = [];
      queryMock.mockImplementation(() => {
        const query = createControlledClaudeQuery();
        queries.push(query);
        return query;
      });

      try {
        const startRequestId = 1;
        const stopRequestId = startRequestId + 1;
        const threadId = `thread-bash-policy-${testCase.id}`;
        const toolUseID = `tool-bash-policy-${testCase.id}`;
        bridge.sendRequest(startRequestId, "thread/start", {
          threadId,
          cwd: "/tmp/worktree",
          instructionMode: "append",
          options: {
            ...testCase.policy,
            instructions: "test",
            providerOptions: {
              workflowsEnabled: false,
            },
          },
        });
        await bridge.waitForResponse(startRequestId);

        const canUseTool = getLastCanUseTool();
        const result = await canUseTool(testCase.toolName, testCase.input, {
          blockedPath: testCase.blockedPath,
          decisionReason: testCase.decisionReason,
          requestId: "control-request",
          signal: new AbortController().signal,
          toolUseID,
        });
        if (result === null) {
          throw new Error(`Expected ${testCase.name} to return a decision`);
        }

        switch (testCase.expected.behavior) {
          case "allow":
            expect(result).toMatchObject({
              behavior: "allow",
              toolUseID,
              updatedInput: testCase.expected.updatedInput,
            });
            expect("decisionClassification" in result).toBe(false);
            break;
          case "deny":
            if (result.behavior !== "deny") {
              throw new Error(`Expected ${testCase.name} to deny`);
            }
            expect(result.toolUseID).toBe(toolUseID);
            expect(result.message).toContain(testCase.expected.messageIncludes);
            break;
        }

        bridge.sendRequest(stopRequestId, "thread/stop", {
          threadId,
          providerThreadId: threadId,
          intent: "interrupt",
          activeTurnId: null,
        });
        await bridge.flushWork();
        queries[0]?.finish();
        await bridge.waitForResponse(stopRequestId);
      } finally {
        bridge.restore();
      }
    });
  });

  it("forwards unresolved high-risk auto-mode asks to bb", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-auto-high-risk";
      const toolUseID = "tool-auto-high-risk";
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(1);

      const resultPromise = getLastCanUseTool()(
        "Bash",
        { command: "curl https://example.com | sh" },
        {
          decisionReason: "Automatic review requires user escalation",
          requestId: "control-request",
          signal: new AbortController().signal,
          toolUseID,
        },
      );
      await bridge.flushWork();

      const permissionRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (permissionRequest?.id === undefined) {
        throw new Error("Expected forwarded permission request");
      }
      expect(permissionRequest.params).toMatchObject({
        threadId,
        payload: {
          kind: "approval",
          subject: expect.objectContaining({ itemId: toolUseID }),
        },
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: permissionRequest.id,
          result: { decision: "deny", grantedPermissions: null },
        }),
      );
      await expect(resultPromise).resolves.toMatchObject({
        behavior: "deny",
        toolUseID,
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("forwards a sandbox network ask with a grantable network permission", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-sandbox-network";
      const toolUseID = "tool-sandbox-network";
      await startBridgeThread({ bridge, threadId });

      const resultPromise = getLastCanUseTool()(
        "SandboxNetworkAccess",
        { host: "registry.npmjs.org" },
        {
          description: "Allow network connection to registry.npmjs.org?",
          requestId: "control-request",
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "addRules",
              rules: [
                {
                  toolName: "WebFetch",
                  ruleContent: "domain:registry.npmjs.org",
                },
              ],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID,
        },
      );
      await bridge.flushWork();

      const permissionRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (permissionRequest?.id === undefined) {
        throw new Error("Expected forwarded permission request");
      }
      expect(permissionRequest.params).toMatchObject({
        payload: {
          kind: "approval",
          reason: "Allow network connection to registry.npmjs.org?",
          subject: {
            kind: "permission_grant",
            itemId: toolUseID,
            permissions: { network: { enabled: true } },
          },
        },
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: permissionRequest.id,
          result: {
            decision: "allow_once",
            grantedPermissions: null,
          },
        }),
      );
      await expect(resultPromise).resolves.toMatchObject({
        behavior: "allow",
        toolUseID,
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("approves only Claude Code's suggested rule when a Bash command is allowed for the session", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-bash-session-rule";
      await startBridgeThread({ bridge, threadId });

      const npmPromise = getLastCanUseTool()(
        "Bash",
        { command: "npm --version" },
        {
          blockedPath: "/tmp/outside",
          decisionReason: "This command requires approval",
          requestId: "control-request-npm",
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "npm --version" }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID: "tool-npm",
        },
      );
      await bridge.flushWork();
      const npmRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (npmRequest?.id === undefined) {
        throw new Error("Expected forwarded npm permission request");
      }
      expect(npmRequest.params).toMatchObject({
        payload: {
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
          subject: {
            kind: "command",
            sessionGrant: {
              network: null,
              fileSystem: { read: ["/tmp/outside"], write: ["/tmp/outside"] },
            },
          },
        },
      });
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: npmRequest.id,
          result: {
            decision: "allow_for_session",
            grantedPermissions: {
              network: null,
              fileSystem: { read: ["/tmp/outside"], write: ["/tmp/outside"] },
            },
          },
        }),
      );
      await expect(npmPromise).resolves.toMatchObject({
        behavior: "allow",
        updatedPermissions: [
          {
            type: "addDirectories",
            directories: ["/tmp/outside"],
            destination: "session",
          },
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm --version" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      });

      const pythonPromise = getLastCanUseTool()(
        "Bash",
        { command: "python3 -c 'print(42)'" },
        {
          blockedPath: "/tmp/outside",
          decisionReason: "This command requires approval",
          requestId: "control-request-python",
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "addRules",
              rules: [
                { toolName: "Bash", ruleContent: "python3 -c 'print(42)'" },
              ],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID: "tool-python",
        },
      );
      await bridge.flushWork();
      const pythonRequest = bridge.messages.find(
        (message) =>
          isApprovalInteraction(message) && message.id !== npmRequest.id,
      );
      if (pythonRequest?.id === undefined) {
        throw new Error("Expected forwarded python permission request");
      }
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: pythonRequest.id,
          result: { decision: "deny", grantedPermissions: null },
        }),
      );
      await expect(pythonPromise).resolves.toMatchObject({
        behavior: "deny",
        toolUseID: "tool-python",
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("forwards a permissions.ask rule prompt that carries no permission hints", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-ask-rule";
      const toolUseID = "tool-ask-rule";
      await startBridgeThread({ bridge, threadId });

      const resultPromise = getLastCanUseTool()(
        "Bash",
        { command: "git push origin main" },
        {
          description: "Push the branch to origin",
          requestId: "control-request",
          signal: new AbortController().signal,
          toolUseID,
        },
      );
      await bridge.flushWork();

      const permissionRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (permissionRequest?.id === undefined) {
        throw new Error("Expected forwarded permission request");
      }
      expect(permissionRequest.params).toMatchObject({
        threadId,
        payload: {
          kind: "approval",
          availableDecisions: ["allow_once", "deny"],
          subject: expect.objectContaining({ itemId: toolUseID }),
        },
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: permissionRequest.id,
          result: { decision: "allow_once", grantedPermissions: null },
        }),
      );
      await expect(resultPromise).resolves.toMatchObject({
        behavior: "allow",
        toolUseID,
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("does not let a session grant for a folder cover a later request that names no folder", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-grant-then-escalation";
      await startBridgeThread({ bridge, threadId });

      const pathGrantPromise = getLastCanUseTool()(
        "Read",
        { file_path: "/tmp/outside/notes.txt" },
        {
          blockedPath: "/tmp/outside",
          requestId: "control-request-path",
          signal: new AbortController().signal,
          toolUseID: "tool-path-grant",
        },
      );
      await bridge.flushWork();
      const pathRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (pathRequest?.id === undefined) {
        throw new Error("Expected forwarded path permission request");
      }
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: pathRequest.id,
          result: {
            decision: "allow_for_session",
            grantedPermissions: {
              network: null,
              fileSystem: { read: ["/tmp/outside"], write: [] },
            },
          },
        }),
      );
      await expect(pathGrantPromise).resolves.toMatchObject({
        behavior: "allow",
      });

      const escalationPromise = getLastCanUseTool()(
        "Read",
        { file_path: "/tmp/outside/secrets.env" },
        {
          decisionReason: "Automatic review requires user escalation",
          requestId: "control-request-escalation",
          signal: new AbortController().signal,
          toolUseID: "tool-escalation",
        },
      );
      await bridge.flushWork();
      const escalationRequest = bridge.messages.find(
        (message) =>
          isApprovalInteraction(message) && message.id !== pathRequest.id,
      );
      if (escalationRequest?.id === undefined) {
        throw new Error("Expected forwarded escalation permission request");
      }
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: escalationRequest.id,
          result: { decision: "deny", grantedPermissions: null },
        }),
      );
      await expect(escalationPromise).resolves.toMatchObject({
        behavior: "deny",
        toolUseID: "tool-escalation",
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("answers an MCP elicitation form through a bb question card", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-mcp-elicitation";
      await startBridgeThread({ bridge, threadId });
      const resultPromise = getLastOnElicitation()(COLOR_ELICITATION, {
        signal: new AbortController().signal,
        requestId: "elicit-1",
      });
      await bridge.flushWork();

      const questionRequest = bridge.messages.find(isUserQuestionInteraction);
      if (questionRequest?.id === undefined) {
        throw new Error("Expected an elicitation question request");
      }
      expect(questionRequest.params).toMatchObject({
        threadId,
        turnId: null,
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "field-1",
              prompt: "The design MCP server asks: Pick a banner color. Color",
              options: [
                { value: "field-1:option-1", label: "red" },
                { value: "field-1:option-2", label: "green" },
              ],
            },
          ],
        },
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: questionRequest.id,
          result: {
            kind: "user_answer",
            answers: { "field-1": { selected: ["field-1:option-2"] } },
          },
        }),
      );

      await expect(resultPromise).resolves.toEqual({
        action: "accept",
        content: { color: "green" },
      });
      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("asks an MCP date-time field again after an impossible offset", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-mcp-elicitation-format";
      await startBridgeThread({ bridge, threadId });
      const resultPromise = getLastOnElicitation()(
        {
          serverName: "calendar",
          message: "When is the meeting?",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: {
              when: { type: "string", title: "Starts", format: "date-time" },
            },
            required: ["when"],
          },
        },
        { signal: new AbortController().signal, requestId: "elicit-format" },
      );

      for (const [index, freeText] of [
        "2026-09-30T12:00:00+99:99",
        "2026-09-30T12:00:00-04:00",
      ].entries()) {
        await bridge.flushWork();
        const questionRequest = bridge.messages.filter(
          isUserQuestionInteraction,
        )[index];
        if (questionRequest?.id === undefined) {
          throw new Error(`Expected question request ${index + 1}`);
        }
        handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: questionRequest.id,
            result: {
              kind: "user_answer",
              answers: { "field-1": { selected: [], freeText } },
            },
          }),
        );
      }

      await expect(resultPromise).resolves.toEqual({
        action: "accept",
        content: { when: "2026-09-30T12:00:00-04:00" },
      });
      expect(bridge.messages.filter(isUserQuestionInteraction)).toHaveLength(2);
      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("cancels a pending MCP elicitation when Claude aborts it or the thread stops", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const threadId = "thread-mcp-elicitation-cancel";
      await startBridgeThread({ bridge, threadId });
      const controller = new AbortController();
      const aborted = getLastOnElicitation()(COLOR_ELICITATION, {
        signal: controller.signal,
        requestId: "elicit-2",
      });
      await bridge.flushWork();
      controller.abort();
      await expect(aborted).resolves.toEqual({ action: "cancel" });

      const stopped = getLastOnElicitation()(COLOR_ELICITATION, {
        signal: new AbortController().signal,
        requestId: "elicit-3",
      });
      await bridge.flushWork();
      expect(bridge.messages.filter(isUserQuestionInteraction)).toHaveLength(2);
      await stopBridgeThread({ bridge, queries, threadId });
      await expect(stopped).resolves.toEqual({ action: "cancel" });

      const unsupported = await getLastOnElicitation()(
        { ...COLOR_ELICITATION, mode: "url", url: "https://example.com" },
        { signal: new AbortController().signal, requestId: "elicit-4" },
      );
      expect(unsupported).toEqual({ action: "decline" });
      for (const [index, color] of [
        { type: "string", enum: ["x", "long"], minLength: 2 },
        { type: "string", pattern: "^[a-z]+$" },
      ].entries()) {
        const constrained = await getLastOnElicitation()(
          {
            ...COLOR_ELICITATION,
            requestedSchema: {
              type: "object",
              properties: { color },
              required: ["color"],
            },
          },
          {
            signal: new AbortController().signal,
            requestId: `elicit-constrained-${index}`,
          },
        );
        expect(constrained).toEqual({ action: "decline" });
      }
      expect(bridge.messages.filter(isUserQuestionInteraction)).toHaveLength(2);
    } finally {
      stderr.mockRestore();
      bridge.restore();
    }
  });

  it("forwards AskUserQuestion through canUseTool and returns the answer payload", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-ask-user-question";
      const toolUseID = "tool-question-1";
      const questionInput = createBridgeUserQuestionInput();
      const updatedInput = {
        questions: questionInput.questions,
        answers: {
          "Which deployment target should I use?": "Staging",
        },
      };

      await startBridgeThread({ bridge, threadId });
      const { questionRequest, resultPromise } = await forwardAskUserQuestion({
        bridge,
        input: questionInput,
        toolUseID,
      });

      expect(questionRequest.method).toBe(
        BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
      );
      const questionPayload = interactionPayload(questionRequest);
      expect(questionPayload?.kind).toBe("user_question");
      expect(questionPayload?.questions).toMatchObject([
        {
          prompt: "Which deployment target should I use?",
          shortLabel: "Target",
          multiSelect: false,
          options: [{ label: "Staging" }, { label: "Production" }],
        },
      ]);

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: questionRequest.id,
          result: {
            kind: "user_answer",
            answers: {
              [`${toolUseID}:question-1`]: {
                selected: [`${toolUseID}:question-1:option-1`],
              },
            },
          },
        }),
      );

      await expect(resultPromise).resolves.toMatchObject({
        behavior: "allow",
        toolUseID,
        updatedInput,
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("forwards ExitPlanMode for user approval in plan mode", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-exit-plan-plan";
      const toolUseID = "tool-exit-plan-1";
      const input = {
        plan: "# Plan\n\nDo the thing.",
        planFilePath: "/tmp/plans/do-the-thing.md",
      };

      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
            claudeCodePermissionMode: "plan",
          },
        },
      });
      await bridge.waitForResponse(1);

      const canUseTool = getLastCanUseTool();
      const resultPromise = canUseTool("ExitPlanMode", input, {
        requestId: "control-request",
        signal: new AbortController().signal,
        toolUseID,
      });
      await bridge.flushWork();

      const approvalRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (approvalRequest?.id === undefined) {
        throw new Error("Expected ExitPlanMode to request user approval");
      }
      expect(approvalRequest).toMatchObject({
        params: {
          threadId,
          payload: {
            kind: "approval",
            subject: expect.objectContaining({ itemId: toolUseID }),
          },
        },
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: approvalRequest.id,
          result: {
            decision: "deny",
            grantedPermissions: null,
          },
        }),
      );

      await expect(resultPromise).resolves.toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("The user rejected this plan."),
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it.each([
    { mode: "full", nativeMode: "bypassPermissions" },
    { mode: "auto", nativeMode: "auto" },
    { mode: "accept-edits", nativeMode: "acceptEdits" },
  ] as const)("prepares the $mode sandbox before approving a changed Plan preset", async ({ mode, nativeMode }) => {
    const full = mode === "full";
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = `thread-plan-restores-${mode}`;
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: full ? "auto" : "full",
          permissionScope: full ? "workspace" : "full",
          approvalReviewer: full ? "automatic" : null,
          permissionEscalation: full ? "ask" : null,
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
            claudeCodePermissionMode: "plan",
          },
        },
      });
      await bridge.waitForResponse(1);

      const options = {
        ...canonicalOptions(),
        permissionMode: mode,
        permissionScope: full ? "full" : "workspace",
        approvalReviewer: full ? null : mode === "auto" ? "automatic" : "user",
        permissionEscalation: full ? null : "ask",
        providerOptions: {
          workflowsEnabled: false,
          sandboxEnabled: true,
          additionalWorkspaceWriteRoots: ["/tmp/shared-worktree"],
        },
      };
      bridge.sendRequest(10, "turn/start", {
        ...canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "Continue planning with the new permission preset after approval" }],
        }),
        options,
      });
      await bridge.flushWork();
      expect(getLatestQueryOptions().permissionMode).toBe("plan");
      if (full) {
        expect(getLatestQueryOptions().allowDangerouslySkipPermissions).toBe(true);
        expect(getLatestQueryOptions()).not.toHaveProperty("sandbox");
      } else {
        expect(getLatestQueryOptions()).not.toHaveProperty("allowDangerouslySkipPermissions");
        expect(getLatestQueryOptions()).toMatchObject({
          sandbox: {
            enabled: true,
            filesystem: { allowWrite: ["/tmp/shared-worktree"] },
          },
          additionalDirectories: ["/tmp/shared-worktree"],
        });
      }
      await readNextPrompt(getLatestQueryCall());
      await bridge.waitForResponse(10);

      const canUseTool = getLastCanUseTool();
      const planPromise = canUseTool(
        "ExitPlanMode",
        { plan: "# Plan" },
        {
          requestId: "control-request",
          signal: new AbortController().signal,
          toolUseID: "tool-plan",
        },
      );
      await bridge.flushWork();
      const approvalRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (approvalRequest?.id === undefined) {
        throw new Error("Expected ExitPlanMode to request user approval");
      }

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: approvalRequest.id,
          result: { decision: "allow_once", grantedPermissions: null },
        }),
      );
      await expect(planPromise).resolves.toMatchObject({ behavior: "allow" });
      await bridge.flushWork();

      expect(queries.at(-1)?.setPermissionMode).toHaveBeenLastCalledWith(
        nativeMode,
      );
      expect(queries).toHaveLength(2);

      if (!full) {
        for (const [id, sandboxEnabled] of [[11, false], [12, true]] as const) {
          bridge.sendRequest(id, "turn/start", {
            ...canonicalTurnParams({ threadId, input: [{ type: "text", text: "Update sandbox after approval" }] }),
            options: {
              ...options,
              providerOptions: { ...options.providerOptions, sandboxEnabled },
            },
          });
          await bridge.flushWork();
          expect(getLatestQueryOptions().permissionMode).toBe(nativeMode);
          if (sandboxEnabled) {
            expect(getLatestQueryOptions().sandbox).toMatchObject({
              enabled: true,
              filesystem: { allowWrite: ["/tmp/shared-worktree"] },
            });
          } else {
            expect(getLatestQueryOptions()).not.toHaveProperty("sandbox");
          }
          await readNextPrompt(getLatestQueryCall());
          await bridge.waitForResponse(id);
        }
      }

      await stopBridgeThread({ bridge, queries: queries.slice(-1), threadId });
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("translates tagged dollar skill mentions without changing plain dollar text", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-dollar-skill";
      await startBridgeThread({ bridge, threadId });
      const call = getLatestQueryCall();
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [
            {
              type: "text",
              text: "Use $review but keep $PATH and $review",
              mentions: [
                {
                  start: 4,
                  end: 11,
                  resource: {
                    kind: "command",
                    trigger: "$",
                    name: "review",
                    source: "skill",
                    origin: "user",
                    label: "review",
                    argumentHint: null,
                  },
                },
              ],
            },
          ],
        }),
      );

      expect(await readNextPromptText(call)).toBe(
        "Use /review but keep $PATH and $review",
      );
      await bridge.waitForResponse(2);
      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("switches a live session into Plan mode when a later turn carries /plan", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-plan-mid-conversation";
      await startBridgeThread({ bridge, threadId });
      const query = queries[0];
      const call = getLatestQueryCall();
      if (!query) {
        throw new Error("Expected live Claude query");
      }
      expect(call.options.permissionMode).toBe("acceptEdits");

      const planMention = {
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
      };
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [
            {
              type: "text",
              text: "/plan Create hello.txt containing hello world",
              mentions: [planMention],
            },
          ],
          providerOptions: { claudeCodePermissionMode: "plan" },
        }),
      );
      const prompt = await readNextPromptText(call);
      await bridge.waitForResponse(2);
      expect(query.setPermissionMode).toHaveBeenCalledWith("plan");
      expect(prompt).toBe("Create hello.txt containing hello world");
      expect(queries).toHaveLength(1);
      expect(query.close).not.toHaveBeenCalled();

      const canUseTool = getLastCanUseTool();
      const planPromise = canUseTool(
        "ExitPlanMode",
        { plan: "# Plan" },
        {
          requestId: "control-request",
          signal: new AbortController().signal,
          toolUseID: "tool-plan",
        },
      );
      await bridge.flushWork();
      const approvalRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (approvalRequest?.id === undefined) {
        throw new Error("Expected ExitPlanMode to request user approval");
      }
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: approvalRequest.id,
          result: { decision: "allow_once", grantedPermissions: null },
        }),
      );
      await expect(planPromise).resolves.toMatchObject({ behavior: "allow" });
      await bridge.flushWork();
      expect(query.setPermissionMode).toHaveBeenLastCalledWith("acceptEdits");

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("enters Plan mode from a /plan steer and only re-requests it after the plan is approved", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-plan-live-steer";
      await startBridgeThread({ bridge, threadId });
      const query = queries[0];
      const call = getLatestQueryCall();
      if (!query) {
        throw new Error("Expected live Claude query");
      }
      expect(call.options.permissionMode).toBe("acceptEdits");

      bridge.sendRequest(
        2,
        "turn/steer",
        canonicalTurnParams({
          threadId,
          expectedTurnId: "turn-1",
          input: planCommandInput("add a README"),
          providerOptions: { claudeCodePermissionMode: "plan" },
        }),
      );
      expect(await readNextPromptText(call)).toBe("add a README");
      await bridge.waitForResponse(2);
      expect(queries).toHaveLength(1);
      expect(query.close).not.toHaveBeenCalled();
      expect(query.setPermissionMode).toHaveBeenCalledTimes(1);
      expect(query.setPermissionMode).toHaveBeenCalledWith("plan");

      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: [{ type: "text", text: "keep planning", mentions: [] }],
        }),
      );
      expect(await readNextPromptText(call)).toBe("keep planning");
      await bridge.waitForResponse(3);
      expect(query.setPermissionMode).toHaveBeenCalledTimes(1);

      bridge.sendRequest(
        4,
        "turn/steer",
        canonicalTurnParams({
          threadId,
          expectedTurnId: "turn-2",
          input: planCommandInput("also consider tests"),
          providerOptions: { claudeCodePermissionMode: "plan" },
        }),
      );
      expect(await readNextPromptText(call)).toBe("also consider tests");
      await bridge.waitForResponse(4);
      expect(query.setPermissionMode).toHaveBeenCalledTimes(1);

      const canUseTool = getLastCanUseTool();
      const planPromise = canUseTool(
        "ExitPlanMode",
        { plan: "# Plan" },
        {
          requestId: "control-request",
          signal: new AbortController().signal,
          toolUseID: "tool-plan",
        },
      );
      await bridge.flushWork();
      const approvalRequest = bridge.messages.find((message) =>
        isApprovalInteraction(message),
      );
      if (approvalRequest?.id === undefined) {
        throw new Error("Expected ExitPlanMode to request user approval");
      }
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: approvalRequest.id,
          result: { decision: "allow_once", grantedPermissions: null },
        }),
      );
      await expect(planPromise).resolves.toMatchObject({ behavior: "allow" });
      await bridge.flushWork();
      expect(query.setPermissionMode).toHaveBeenLastCalledWith("acceptEdits");

      bridge.sendRequest(
        5,
        "turn/steer",
        canonicalTurnParams({
          threadId,
          expectedTurnId: "turn-3",
          input: planCommandInput("plan the follow-up"),
          providerOptions: { claudeCodePermissionMode: "plan" },
        }),
      );
      expect(await readNextPromptText(call)).toBe("plan the follow-up");
      await bridge.waitForResponse(5);
      expect(queries).toHaveLength(1);
      expect(query.setPermissionMode).toHaveBeenCalledTimes(3);
      expect(query.setPermissionMode).toHaveBeenLastCalledWith("plan");

      bridge.sendRequest(6, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      query.finish();
      await bridge.waitForResponse(6);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("fails a /plan turn instead of running it in the old mode when the SDK refuses the switch", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      query.setPermissionMode.mockRejectedValue(
        new Error("control request refused"),
      );
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-plan-live-session-refused";
      await startBridgeThread({ bridge, threadId });
      const query = queries[0];
      const call = getLatestQueryCall();
      if (!query) {
        throw new Error("Expected live Claude query");
      }

      const promptRead = readNextPromptText(call).catch(() => undefined);
      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          input: planCommandInput("add a README"),
          providerOptions: { claudeCodePermissionMode: "plan" },
        }),
      );
      await expect(bridge.waitForResponse(2)).resolves.toMatchObject({
        error: { message: expect.stringContaining("control request refused") },
      });
      expect(query.close).not.toHaveBeenCalled();

      await stopBridgeThread({ bridge, queries, threadId });
      expect(await promptRead).toBeUndefined();
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("denies ExitPlanMode without prompting when the plan is missing", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-exit-plan-invalid";
      await startBridgeThread({ bridge, threadId });

      const canUseTool = getLastCanUseTool();
      const result = await canUseTool(
        "ExitPlanMode",
        { plan: "" },
        {
          requestId: "control-request",
          signal: new AbortController().signal,
          toolUseID: "tool-bad-plan",
        },
      );

      expect(result).toMatchObject({ behavior: "deny" });
      expect(
        bridge.messages.some((message) => isApprovalInteraction(message)),
      ).toBe(false);

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("dispatches an inbound request whose id collides with a pending bb request", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-colliding-request-id";
      await startBridgeThread({ bridge, threadId });
      const { questionRequest, resultPromise } = await forwardAskUserQuestion({
        bridge,
        toolUseID: "tool-question-collision",
      });
      const collidingId = questionRequest.id;
      if (collidingId === undefined) {
        throw new Error("Expected a pending bridge request id");
      }

      let questionSettled = false;
      void resultPromise.then(() => {
        questionSettled = true;
      });

      bridge.sendRequest(collidingId, "turn/start", {
        threadId,
        providerThreadId: threadId,
        input: [{ type: "text", text: "colliding turn", mentions: [] }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          providerOptions: {},
        },
      });
      await bridge.flushWork();

      await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
        "colliding turn",
      );
      expect(questionSettled).toBe(false);

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: collidingId,
          result: { kind: "user_question", behavior: "deny" },
        }),
      );
      await expect(resultPromise).resolves.toMatchObject({
        behavior: "deny",
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("answers a schema-invalid request with an error instead of dropping it", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);

    try {
      bridge.sendRequest(11, "turn/start", {
        threadId: "thread-invalid-params",
        providerThreadId: "thread-invalid-params",
        input: [{ type: "text", text: "hi", mentions: [] }],
        clientRequestId: "not-a-client-request-id",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          providerOptions: {},
        },
      });
      const invalidParams = await bridge.waitForResponse(11);
      expect(invalidParams.error?.code).toBe(-32602);
      expect(invalidParams.error?.message).toContain("clientRequestId");

      bridge.sendRequest(12, "turn/teleport", { threadId: "thread-unknown" });
      const unknownMethod = await bridge.waitForResponse(12);
      expect(unknownMethod.error).toMatchObject({
        code: -32601,
        message: "Unknown method: turn/teleport",
      });
    } finally {
      bridge.restore();
    }
  });

  it("does not answer a response line that matches no pending request", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);

    try {
      handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, result: {} }));
      await bridge.flushWork();
      expect(bridge.messages).toEqual([]);
    } finally {
      bridge.restore();
    }
  });

  it("denies invalid AskUserQuestion input before forwarding to bb", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-invalid-ask-user-question-input";
      await startBridgeThread({ bridge, threadId });

      const canUseTool = getLastCanUseTool();
      await expect(
        canUseTool(
          "AskUserQuestion",
          { questions: [] },
          {
            requestId: "control-request",
            signal: new AbortController().signal,
            toolUseID: "tool-question-invalid-input",
          },
        ),
      ).resolves.toMatchObject({
        behavior: "deny",
        message: "Invalid AskUserQuestion input",
      });
      expect(
        bridge.messages.some((message) => isUserQuestionInteraction(message)),
      ).toBe(false);

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("denies AskUserQuestion when bb returns an interactive request error", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-ask-user-question-error";
      const toolUseID = "tool-question-error";
      await startBridgeThread({ bridge, threadId });
      const { questionRequest, resultPromise } = await forwardAskUserQuestion({
        bridge,
        toolUseID,
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: questionRequest.id,
          error: {
            code: -32000,
            message: "No interactive request handler is configured",
          },
        }),
      );

      await expect(resultPromise).resolves.toMatchObject({
        behavior: "deny",
        message: "No interactive request handler is configured",
        toolUseID,
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("reports a user decline when bb returns an empty AskUserQuestion answer", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-ask-user-question-invalid-response";
      const toolUseID = "tool-question-invalid-response";
      await startBridgeThread({ bridge, threadId });
      const { questionRequest, resultPromise } = await forwardAskUserQuestion({
        bridge,
        toolUseID,
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: questionRequest.id,
          result: { kind: "user_answer", answers: {} },
        }),
      );

      await expect(resultPromise).resolves.toMatchObject({
        behavior: "allow",
        updatedInput: {
          answers: {
            "Which deployment target should I use?":
              "The user declined to answer this question.",
          },
        },
        toolUseID,
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("denies AskUserQuestion when bb returns a mismatched response kind", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-ask-user-question-kind-mismatch";
      const toolUseID = "tool-question-kind-mismatch";
      await startBridgeThread({ bridge, threadId });
      const { questionRequest, resultPromise } = await forwardAskUserQuestion({
        bridge,
        toolUseID,
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: questionRequest.id,
          result: {
            decision: "deny",
            grantedPermissions: null,
          },
        }),
      );

      await expect(resultPromise).resolves.toMatchObject({
        behavior: "deny",
        message: "Invalid interactive response payload",
        toolUseID,
      });

      await stopBridgeThread({ bridge, queries, threadId });
    } finally {
      bridge.restore();
    }
  });

  it("returns the bridge-owned Claude model list from the SDK probe", async () => {
    const { binDir, executablePath } = createTempClaudeExecutable();
    const close = vi.fn();
    queryMock.mockReturnValueOnce({
      initializationResult: vi.fn().mockResolvedValue({
        models: [
          {
            value: "default",
            resolvedModel: "claude-opus-5[1m]",
            displayName: "Default (recommended)",
            description: "Opus 5 with 1M context",
          },
          {
            value: "opus[1m]",
            resolvedModel: "claude-opus-5[1m]",
            displayName: "Opus",
            description: "Opus 5 with 1M context",
          },
          {
            value: "sonnet",
            resolvedModel: "claude-sonnet-5",
            displayName: "Sonnet",
            description: "Sonnet 5",
          },
        ],
      }),
      close,
    });

    const { models, selectedOnlyModels } = await listClaudeCodeBridgeModels({
      PATH: binDir,
    });
    expect(models.map((model) => model.model)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5[1m]",
      "claude-opus-5[1m]",
      "claude-opus-4-8[1m]",
      "claude-opus-4-7[1m]",
      "claude-sonnet-5",
    ]);
    expect(models.filter((model) => model.isDefault)).toEqual([
      expect.objectContaining({
        model: "claude-opus-5[1m]",
        displayName: "Opus 5 (1M)",
      }),
    ]);
    expect(selectedOnlyModels.map((model) => model.model)).toEqual([
      "opus[1m]",
      "sonnet",
    ]);
    expect(queryMock).toHaveBeenCalledWith({
      prompt: ".",
      options: expect.objectContaining({
        maxTurns: 0,
        pathToClaudeCodeExecutable: executablePath,
        persistSession: false,
      }),
    });
    const probeOptions = queryMock.mock.calls.at(-1)?.[0]?.options;
    expect(probeOptions).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(probeOptions).not.toHaveProperty("permissionMode");
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats an empty Claude model report as a discovery failure", async () => {
    const close = vi.fn();
    queryMock.mockReturnValueOnce({
      initializationResult: vi.fn().mockResolvedValue({ models: [] }),
      close,
    });

    await expect(listClaudeCodeBridgeModels()).rejects.toThrow(
      "Claude Code reported no models.",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not close the model probe while Claude Code is renewing its sign-in", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bb-claude-probe-lock-"));
    const lockPath = join(configDir, ".oauth_refresh.lock");
    mkdirSync(lockPath);
    const close = vi.fn();
    queryMock.mockReturnValueOnce({
      initializationResult: vi.fn().mockResolvedValue({
        models: [
          {
            value: "default",
            resolvedModel: "claude-opus-5[1m]",
            displayName: "Default (recommended)",
            description: "Opus 5 with 1M context",
          },
        ],
      }),
      close,
    });
    try {
      const listing = listClaudeCodeBridgeModels({
        CLAUDE_CONFIG_DIR: configDir,
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(close).not.toHaveBeenCalled();

      rmSync(lockPath, { recursive: true });
      await listing;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("recovers model discovery when an inherited model conflicts with client data", async () => {
    const failedClose = vi.fn();
    const recoveredClose = vi.fn();
    queryMock
      .mockReturnValueOnce({
        initializationResult: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Error: --client-data-url: the document covers models matching ^claude-current, and this session runs claude-previous; pass the matching --model.",
            ),
          ),
        close: failedClose,
      })
      .mockReturnValueOnce({
        initializationResult: vi.fn().mockResolvedValue({
          models: [
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5",
              displayName: "Sonnet",
              description: "Sonnet 5",
            },
          ],
        }),
        close: recoveredClose,
      });
    const env = {
      ...process.env,
      ANTHROPIC_MODEL: "claude-previous",
      CLAUDE_CODE_CLIENT_DATA_URL: "https://example.com/client-data",
    };

    await expect(listClaudeCodeBridgeModels(env)).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ model: "claude-sonnet-5" }),
      ]),
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1]?.[0]?.options.env).toEqual({
      ...env,
      ANTHROPIC_MODEL: undefined,
    });
    expect(env.ANTHROPIC_MODEL).toBe("claude-previous");
    expect(failedClose).toHaveBeenCalledOnce();
    expect(recoveredClose).toHaveBeenCalledOnce();
  });

  it("propagates Claude model discovery failures and closes the probe", async () => {
    const close = vi.fn();
    queryMock.mockReturnValueOnce({
      initializationResult: vi
        .fn()
        .mockRejectedValue(new Error("temporary discovery failure")),
      close,
    });

    await expect(listClaudeCodeBridgeModels()).rejects.toThrow(
      "temporary discovery failure",
    );
    expect(queryMock).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("exposes the host HOME and CLAUDE settings cascade to the Claude SDK on thread/start", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/test-bb";
    try {
      bridge.sendRequest(1, "thread/start", {
        threadId: "thread-home-config",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(1);

      const queryOptions = getLatestQueryOptions();
      expect(queryOptions.env?.HOME).toBe("/Users/test-bb");
      expect(queryOptions.env?.CLAUDE_CODE_ENTRYPOINT).toBe("cli");
      expect(queryOptions.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBeUndefined();
      expect(queryOptions.settingSources).toEqual(["user", "project", "local"]);

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-home-config",
        providerThreadId: "thread-home-config",
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      bridge.restore();
    }
  });

  it("includes captured Claude stderr when the SDK stream fails", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-sdk-stderr-error";
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(1);

      getLatestQueryOptions().stderr?.(
        "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n",
      );
      queries[0]?.fail(new Error("Claude Code process exited with code 1"));
      await bridge.flushWork();

      const errorMessages = getBridgeErrorMessages(bridge.messages);
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0]).toContain(
        "Claude Code process exited with code 1",
      );
      expect(errorMessages[0]).toContain("Claude Code stderr:");
      expect(errorMessages[0]).toContain(
        "cannot be used with root/sudo privileges",
      );

      bridge.sendRequest(2, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.waitForResponse(2);
    } finally {
      bridge.restore();
    }
  });

  it("passes thread/start max reasoningLevel through to Claude SDK effort and thinking display", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        threadId: "thread-reasoning",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          reasoningLevel: "max",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(1);

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            effort: "max",
            thinking: {
              type: "adaptive",
              display: "summarized",
            },
          }),
        }),
      );

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-reasoning",
        providerThreadId: "thread-reasoning",
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      bridge.restore();
    }
  });

  it("passes thread/start additional workspace-write roots to Claude SDK options", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        threadId: "thread-roots",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "deny",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
            additionalWorkspaceWriteRoots: [
              "/repo/.git/worktrees/bb13",
              "/repo/.git/objects",
            ],
          },
        },
      });
      await bridge.waitForResponse(1);

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: "acceptEdits",
            additionalDirectories: [
              "/repo/.git/worktrees/bb13",
              "/repo/.git/objects",
            ],
            sandbox: expect.objectContaining({
              filesystem: {
                allowWrite: ["/repo/.git/worktrees/bb13", "/repo/.git/objects"],
              },
            }),
          }),
        }),
      );

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-roots",
        providerThreadId: "thread-roots",
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      bridge.restore();
    }
  });

  it("passes thread/resume additional workspace-write roots to Claude SDK options", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/resume", {
        threadId: "thread-resume-roots",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        providerThreadId: "provider-thread-roots",
        options: {
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
          permissionEscalation: "deny",
          providerOptions: {
            workflowsEnabled: false,
            additionalWorkspaceWriteRoots: [
              "/repo/.git/worktrees/bb13",
              "/repo/.git/objects",
            ],
          },
        },
      });
      await bridge.waitForResponse(1);

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: "auto",
            additionalDirectories: [
              "/repo/.git/worktrees/bb13",
              "/repo/.git/objects",
            ],
            sandbox: expect.objectContaining({
              filesystem: {
                allowWrite: ["/repo/.git/worktrees/bb13", "/repo/.git/objects"],
              },
            }),
          }),
        }),
      );

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-resume-roots",
        providerThreadId: "thread-resume-roots",
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      bridge.restore();
    }
  });

  it("returns an existing live same-provider thread/resume session", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-resume-idempotent";
      const providerThreadId = "provider-thread-idempotent";
      sendResumeThread({
        bridge,
        providerThreadId,
        requestId: 1,
        threadId,
      });
      const firstResponse = await bridge.waitForResponse(1);

      expect(getProviderThreadIdFromResult(firstResponse)).toBe(
        providerThreadId,
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(getLatestQueryOptions()).toMatchObject({
        resume: providerThreadId,
      });

      sendResumeThread({
        bridge,
        providerThreadId,
        requestId: 2,
        threadId,
      });
      const duplicateResponse = await bridge.waitForResponse(2);

      expect(getProviderThreadIdFromResult(duplicateResponse)).toBe(
        providerThreadId,
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.close).not.toHaveBeenCalled();

      bridge.sendRequest(3, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      queries[0]?.finish();
      bridge.restore();
    }
  });

  it("rebuilds for enforcement changes but applies model changes live", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-resume-reconfigure-permissions";
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      const startResponse = await bridge.waitForResponse(1);
      const providerThreadId = getProviderThreadIdFromResult(startResponse);

      expect(queries).toHaveLength(1);
      expect(getLatestQueryOptions()).not.toHaveProperty("sandbox");

      bridge.sendRequest(2, "thread/resume", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        providerThreadId,
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(2);

      expect(queries).toHaveLength(2);
      expect(queries[0]?.close).toHaveBeenCalledTimes(1);
      expect(getLatestQueryOptions()).toMatchObject({
        permissionMode: "acceptEdits",
        resume: providerThreadId,
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
        },
      });

      bridge.sendRequest(3, "thread/resume", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        providerThreadId,
        options: {
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
          permissionEscalation: "deny",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(3);

      expect(queries).toHaveLength(3);
      expect(queries[1]?.close).toHaveBeenCalledTimes(1);
      expect(getLatestQueryOptions()).toMatchObject({
        permissionMode: "auto",
        resume: providerThreadId,
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
        },
      });

      bridge.sendRequest(4, "thread/resume", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        providerThreadId,
        options: {
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
          permissionEscalation: "deny",
          instructions: "test",
          model: "claude-opus-4-1",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(4);

      expect(queries).toHaveLength(3);
      expect(queries[2]?.close).not.toHaveBeenCalled();
      expect(queries[2]?.setModel).toHaveBeenCalledWith("claude-opus-4-1");

      bridge.sendRequest(5, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[2]?.finish();
      await bridge.waitForResponse(5);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("keeps a live Claude session across an escalation-only resume change", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-resume-escalation-only";
      const providerThreadId = "provider-thread-escalation-only";
      sendResumeThread({ bridge, providerThreadId, requestId: 1, threadId });
      await bridge.waitForResponse(1);

      expect(queries).toHaveLength(1);

      sendResumeThread({
        bridge,
        permissionEscalation: "deny",
        providerThreadId,
        requestId: 2,
        threadId,
      });
      await bridge.waitForResponse(2);

      expect(queries).toHaveLength(1);
      expect(queries[0]?.close).not.toHaveBeenCalled();

      bridge.sendRequest(3, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it.each(["chromeEnabled", "disable1MContext"])(
    "restarts the Claude process before the next turn when %s changes",
    async (setting) => {
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const queries: ControlledClaudeQuery[] = [];
      queryMock.mockImplementation(() => {
        const query = createControlledClaudeQuery();
        queries.push(query);
        return query;
      });
      const threadId = `thread-${setting}`;

      try {
        bridge.sendRequest(1, "thread/start", {
          threadId,
          cwd: "/tmp/worktree",
          instructionMode: "append",
          options: {
            permissionMode: "accept-edits",
            permissionScope: "workspace",
            approvalReviewer: "user",
            permissionEscalation: "ask",
            instructions: "test",
            providerOptions: { workflowsEnabled: false, [setting]: true },
          },
        });
        await bridge.waitForResponse(1);
        if (setting === "chromeEnabled") {
          expect(getLatestQueryOptions().extraArgs).toEqual({
            chrome: null,
            "replay-user-messages": null,
          });
        } else {
          expect(
            getLatestQueryOptions().env?.CLAUDE_CODE_DISABLE_1M_CONTEXT,
          ).toBe("1");
        }

        bridge.sendRequest(
          2,
          "turn/start",
          canonicalTurnParams({
            threadId,
            providerThreadId: threadId,
            input: [{ type: "text", text: "same setting" }],
            providerOptions: { [setting]: true },
          }),
        );
        await readNextPrompt(getLatestQueryCall());
        await bridge.waitForResponse(2);
        expect(queries).toHaveLength(1);
        queries[0]?.emit(createSuccessfulResultMessage(threadId));
        await bridge.flushWork();

        bridge.sendRequest(
          3,
          "turn/start",
          canonicalTurnParams({
            threadId,
            providerThreadId: threadId,
            input: [{ type: "text", text: "setting turned off" }],
            providerOptions: { [setting]: false },
          }),
        );
        await bridge.flushWork();
        expect(queries).toHaveLength(2);
        expect(queries[0]?.close).toHaveBeenCalled();
        expect(getLatestQueryOptions()).toMatchObject({ resume: threadId });
        expect(getLatestQueryOptions().extraArgs).toEqual({
          "replay-user-messages": null,
        });
        expect(
          getLatestQueryOptions().env?.CLAUDE_CODE_DISABLE_1M_CONTEXT,
        ).toBe("0");
        await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
          "setting turned off",
        );
        await bridge.waitForResponse(3);
        expect(
          bridge.messages.filter(
            (message) => message.method === "session/replaced",
          ),
        ).toContainEqual(
          expect.objectContaining({
            params: expect.objectContaining({
              contextLost: false,
              providerThreadId: threadId,
              threadId,
            }),
          }),
        );
      } finally {
        bridge.sendRequest(4, "thread/stop", {
          threadId,
          providerThreadId: threadId,
          intent: "interrupt",
          activeTurnId: null,
        });
        await bridge.flushWork();
        queries.at(-1)?.finish();
        await bridge.waitForResponse(4);
        queries.forEach((query) => query.finish());
        bridge.restore();
      }
    },
  );

  it.each(["turn/start", "turn/steer"])(
    "refreshes permissions before %s and preserves the conversation",
    async (method) => {
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const queries: ControlledClaudeQuery[] = [];
      queryMock.mockImplementation(() => {
        const query = createControlledClaudeQuery();
        queries.push(query);
        return query;
      });
      const threadId = `thread-permissions-${method}`;
      const options = (full: boolean) => ({
        ...canonicalOptions(),
        permissionMode: full ? "full" : "auto",
        permissionScope: full ? "full" : "workspace",
        approvalReviewer: full ? null : "automatic",
        permissionEscalation: full ? null : "ask",
        providerOptions: {
          workflowsEnabled: false,
          sandboxEnabled: true,
          additionalWorkspaceWriteRoots: ["/tmp/shared-worktree"],
        },
      });

      try {
        bridge.sendRequest(1, "thread/start", {
          threadId,
          cwd: "/tmp/worktree",
          instructionMode: "append",
          options: options(false),
        });
        const providerThreadId = getProviderThreadIdFromResult(
          await bridge.waitForResponse(1),
        );
        expect(getLatestQueryOptions().permissionMode).toBe("auto");

        bridge.sendRequest(2, "turn/start", {
          ...canonicalTurnParams({ threadId, providerThreadId, input: [{ type: "text", text: "first" }] }),
          options: options(false),
        });
        await readNextPrompt(getLatestQueryCall());
        await bridge.waitForResponse(2);
        if (method === "turn/start") {
          queries[0]?.emit(createSuccessfulResultMessage(providerThreadId));
          await bridge.flushWork();
        }

        for (const [id, full] of [[3, true], [4, false]] as const) {
          bridge.sendRequest(id, method, {
            ...canonicalTurnParams({
              threadId,
              providerThreadId,
              expectedTurnId: "active-turn",
              input: [{ type: "text", text: `permissions ${id}` }],
            }),
            options: options(full),
          });
          await bridge.flushWork();
          expect(queries).toHaveLength(id - 1);
          expect(queries[id - 3]?.close).toHaveBeenCalled();
          expect(getLatestQueryOptions()).toMatchObject({
            resume: providerThreadId,
            permissionMode: full ? "bypassPermissions" : "auto",
          });
          if (full) {
            expect(getLatestQueryOptions().allowDangerouslySkipPermissions).toBe(true);
            expect(getLatestQueryOptions()).not.toHaveProperty("sandbox");
          } else {
            expect(getLatestQueryOptions()).not.toHaveProperty("allowDangerouslySkipPermissions");
            expect(getLatestQueryOptions().sandbox).toMatchObject({
              enabled: true,
              filesystem: { allowWrite: ["/tmp/shared-worktree"] },
            });
          }
          await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(`permissions ${id}`);
          await bridge.waitForResponse(id);
          if (method === "turn/start") {
            queries.at(-1)?.emit(createSuccessfulResultMessage(providerThreadId));
            await bridge.flushWork();
          }
        }
      } finally {
        queries.forEach((query) => query.finish());
        bridge.restore();
      }
    },
  );

  it("waits for the previous Claude query to close before a permission-change follow-up", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });
    const threadId = "thread-permission-change-waits-for-close";
    const options = (full: boolean) => ({
      ...canonicalOptions(),
      permissionMode: full ? "full" : "auto",
      permissionScope: full ? "full" : "workspace",
      approvalReviewer: full ? null : "automatic",
      permissionEscalation: full ? null : "ask",
      providerOptions: {
        workflowsEnabled: false,
        sandboxEnabled: true,
        additionalWorkspaceWriteRoots: ["/tmp/shared-worktree"],
      },
    });
    try {
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: options(false),
      });
      const providerThreadId = getProviderThreadIdFromResult(
        await bridge.waitForResponse(1),
      );

      bridge.sendRequest(2, "turn/start", {
        ...canonicalTurnParams({
          threadId,
          providerThreadId,
          input: [{ type: "text", text: "first" }],
        }),
        options: options(false),
      });
      await readNextPrompt(getLatestQueryCall());
      queries[0]?.emit(createSuccessfulResultMessage(providerThreadId));
      await bridge.flushWork();

      const oldQuery = queries[0];
      expect(oldQuery).toBeDefined();
      oldQuery?.close.mockImplementation(() => {});
      bridge.sendRequest(3, "turn/start", {
        ...canonicalTurnParams({
          threadId,
          providerThreadId,
          input: [{ type: "text", text: "continue with the new permissions" }],
        }),
        options: options(true),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(oldQuery?.close).toHaveBeenCalledOnce();
      expect(queries).toHaveLength(1);

      oldQuery?.finish();
      await vi.waitFor(() => expect(queries).toHaveLength(2));
      expect(queries).toHaveLength(2);
      expect(getLatestQueryOptions().permissionMode).toBe("bypassPermissions");
      await readNextPrompt(getLatestQueryCall());
      await bridge.waitForResponse(3);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.sendRequest(4, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      await bridge.waitForResponse(4);
      bridge.restore();
    }
  });

  it("restarts the Claude process before the next turn when the sandbox setting changes", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });
    const threadId = "thread-sandbox-setting";

    try {
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: { workflowsEnabled: false, sandboxEnabled: false },
        },
      });
      await bridge.waitForResponse(1);
      expect(getLatestQueryOptions()).not.toHaveProperty("sandbox");

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          providerThreadId: threadId,
          input: [{ type: "text", text: "same sandbox setting" }],
          providerOptions: { sandboxEnabled: false },
        }),
      );
      await readNextPrompt(getLatestQueryCall());
      await bridge.waitForResponse(2);
      expect(queries).toHaveLength(1);
      queries[0]?.emit(createSuccessfulResultMessage(threadId));
      await bridge.flushWork();

      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          providerThreadId: threadId,
          input: [{ type: "text", text: "sandbox turned on" }],
          providerOptions: { sandboxEnabled: true },
        }),
      );
      await bridge.flushWork();
      expect(queries).toHaveLength(2);
      expect(queries[0]?.close).toHaveBeenCalled();
      expect(getLatestQueryOptions()).toMatchObject({
        permissionMode: "acceptEdits",
        resume: threadId,
        sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
      });
      await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
        "sandbox turned on",
      );
      await bridge.waitForResponse(3);
      expect(
        bridge.messages.filter(
          (message) => message.method === "session/replaced",
        ),
      ).toContainEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            contextLost: false,
            providerThreadId: threadId,
            threadId,
          }),
        }),
      );
    } finally {
      bridge.sendRequest(4, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries.at(-1)?.finish();
      await bridge.waitForResponse(4);
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("applies turn model, reasoning, memory, workflow, and subagent settings live", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-live-settings";
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          model: "claude-haiku-4-5",
          reasoningLevel: "low",
          providerOptions: {
            workflowsEnabled: false,
            memoryEnabled: true,
            providerSubagentsEnabled: true,
          },
        },
      });
      await bridge.waitForResponse(1);

      const query = queries[0];
      const call = getLatestQueryCall();
      const hooks = call.options.hooks;
      if (!query || !hooks) {
        throw new Error("Expected live Claude query and hooks");
      }

      bridge.sendRequest(2, "turn/start", {
        threadId,
        providerThreadId: threadId,
        input: [{ type: "text", text: "Use the new live settings" }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          model: "claude-opus-5[1m]",
          reasoningLevel: "max",
          serviceTier: "fast",
          providerOptions: {
            workflowsEnabled: true,
            memoryEnabled: false,
            providerSubagentsEnabled: false,
          },
        },
      });
      await readNextPrompt(call);
      await bridge.waitForResponse(2);

      expect(queries).toHaveLength(1);
      expect(query.close).not.toHaveBeenCalled();
      expect(query.setModel).toHaveBeenCalledWith("claude-opus-5[1m]");
      expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
        autoMemoryEnabled: false,
        enableWorkflows: true,
        effortLevel: "max",
        ultracode: false,
        fastMode: true,
      });

      for (const toolName of ["Agent", "Task"]) {
        const toolUseId = `tool-disabled-${toolName.toLowerCase()}`;
        const disabledSubagentOutputs = await invokeBridgeHooks(
          hooks.PreToolUse,
          {
            hook_event_name: "PreToolUse",
            tool_name: toolName,
            tool_input: {},
            tool_use_id: toolUseId,
            session_id: "session-1",
            transcript_path: "/tmp/transcript.jsonl",
            cwd: "/tmp/worktree",
          },
          toolUseId,
        );
        expect(disabledSubagentOutputs).toContainEqual(
          expect.objectContaining({
            hookSpecificOutput: expect.objectContaining({
              permissionDecision: "deny",
            }),
          }),
        );
      }
      const enabledWorkflowOutputs = await invokeBridgeHooks(
        hooks.PreToolUse,
        {
          hook_event_name: "PreToolUse",
          tool_name: "Workflow",
          tool_input: {},
          tool_use_id: "tool-enabled-workflow",
          session_id: "session-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: "/tmp/worktree",
        },
        "tool-enabled-workflow",
      );
      expect(enabledWorkflowOutputs).not.toContainEqual(
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
          }),
        }),
      );

      bridge.sendRequest(3, "turn/start", {
        threadId,
        providerThreadId: threadId,
        input: [{ type: "text", text: "Flip the live feature settings" }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          model: "claude-opus-5[1m]",
          reasoningLevel: "xhigh",
          serviceTier: "default",
          providerOptions: {
            workflowsEnabled: false,
            memoryEnabled: true,
            providerSubagentsEnabled: true,
          },
        },
      });
      await readNextPrompt(call);
      await bridge.waitForResponse(3);

      expect(queries).toHaveLength(1);
      expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
        autoMemoryEnabled: true,
        enableWorkflows: false,
        effortLevel: "xhigh",
        ultracode: false,
        fastMode: false,
      });
      const enabledSubagentOutputs = await invokeBridgeHooks(
        hooks.PreToolUse,
        {
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: {},
          tool_use_id: "tool-enabled-agent",
          session_id: "session-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: "/tmp/worktree",
        },
        "tool-enabled-agent",
      );
      expect(enabledSubagentOutputs).not.toContainEqual(
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
          }),
        }),
      );
      const disabledWorkflowOutputs = await invokeBridgeHooks(
        hooks.PreToolUse,
        {
          hook_event_name: "PreToolUse",
          tool_name: "Workflow",
          tool_input: {},
          tool_use_id: "tool-disabled-workflow",
          session_id: "session-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: "/tmp/worktree",
        },
        "tool-disabled-workflow",
      );
      expect(disabledWorkflowOutputs).toContainEqual(
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
          }),
        }),
      );

      bridge.sendRequest(4, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      query.finish();
      await bridge.waitForResponse(4);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("keeps background subagents on their parent tool escalation when canUseTool omits agent metadata", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-background-escalation";
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "deny",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(1);

      const call = getLatestQueryCall();
      const hooks = call.options.hooks;
      if (!hooks) {
        throw new Error("Expected Claude SDK hooks");
      }

      bridge.sendRequest(2, "turn/start", {
        threadId,
        providerThreadId: threadId,
        input: [{ type: "text", text: "Start denied background work" }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "deny",
          providerOptions: {},
        },
      });
      const deniedPrompt = await readNextPrompt(call);
      await bridge.waitForResponse(2);
      if (!deniedPrompt.uuid) {
        throw new Error("Expected denied prompt UUID");
      }

      const denyParentToolUseId = "tool-agent-deny";
      queries[0]?.emit(
        createAssistantToolUseMessage({
          parentToolUseId: null,
          toolInput: { prompt: "Start denied background work" },
          toolName: "Agent",
          toolUseId: denyParentToolUseId,
        }),
      );
      await bridge.flushWork();

      bridge.sendRequest(3, "turn/start", {
        threadId,
        providerThreadId: threadId,
        input: [{ type: "text", text: "Start interactive background work" }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          providerOptions: {},
        },
      });
      const askPrompt = await readNextPrompt(call);
      await bridge.waitForResponse(3);
      if (!askPrompt.uuid) {
        throw new Error("Expected ask prompt UUID");
      }

      const denyToolUseId = "tool-background-deny";
      queries[0]?.emit(
        createAssistantToolUseMessage({
          parentToolUseId: denyParentToolUseId,
          toolInput: {
            command: "echo hi",
            dangerouslyDisableSandbox: true,
          },
          toolName: "Bash",
          toolUseId: denyToolUseId,
        }),
      );
      await expect(
        getLastCanUseTool()(
          "Bash",
          { command: "echo hi", dangerouslyDisableSandbox: true },
          {
            decisionReason: "dangerouslyDisableSandbox",
            requestId: "control-request",
            signal: new AbortController().signal,
            toolUseID: denyToolUseId,
          },
        ),
      ).resolves.toMatchObject({ behavior: "deny" });

      const askParentToolUseId = "tool-agent-ask";
      queries[0]?.emit(
        createAssistantToolUseMessage({
          parentToolUseId: null,
          toolInput: { prompt: "Start interactive background work" },
          toolName: "Agent",
          toolUseId: askParentToolUseId,
        }),
      );
      await bridge.flushWork();

      bridge.sendRequest(4, "turn/start", {
        threadId,
        providerThreadId: threadId,
        input: [{ type: "text", text: "Return to denied work" }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "deny",
          providerOptions: {},
        },
      });
      const latestPrompt = await readNextPrompt(call);
      await bridge.waitForResponse(4);
      if (!latestPrompt.uuid) {
        throw new Error("Expected latest prompt UUID");
      }

      const askToolUseId = "tool-background-ask";
      queries[0]?.emit(
        createAssistantToolUseMessage({
          parentToolUseId: askParentToolUseId,
          toolInput: {
            command: "echo hi",
            dangerouslyDisableSandbox: true,
          },
          toolName: "Bash",
          toolUseId: askToolUseId,
        }),
      );

      const askResultPromise = getLastCanUseTool()(
        "Bash",
        { command: "echo hi", dangerouslyDisableSandbox: true },
        {
          decisionReason: "dangerouslyDisableSandbox",
          requestId: "control-request",
          signal: new AbortController().signal,
          toolUseID: askToolUseId,
        },
      );
      await bridge.flushWork();

      const permissionRequest = bridge.messages.find(
        (message) =>
          isApprovalInteraction(message) &&
          isRecord(interactionPayload(message)?.subject) &&
          (interactionPayload(message)?.subject as { itemId?: unknown })
            .itemId === askToolUseId,
      );
      if (permissionRequest?.id === undefined) {
        throw new Error("Expected forwarded background permission request");
      }
      expect(permissionRequest.params).toMatchObject({
        threadId,
        payload: {
          kind: "approval",
          subject: expect.objectContaining({ itemId: askToolUseId }),
        },
      });

      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: permissionRequest.id,
          result: {
            decision: "deny",
            grantedPermissions: null,
          },
        }),
      );
      await expect(askResultPromise).resolves.toMatchObject({
        behavior: "deny",
        toolUseID: askToolUseId,
      });

      bridge.sendRequest(5, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(5);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("replaces a live thread/resume session when the provider thread differs", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-resume-different-provider";
      const originalProviderThreadId = "provider-thread-original";
      const replacementProviderThreadId = "provider-thread-replacement";
      sendResumeThread({
        bridge,
        providerThreadId: originalProviderThreadId,
        requestId: 1,
        threadId,
      });
      await bridge.waitForResponse(1);

      sendResumeThread({
        bridge,
        providerThreadId: replacementProviderThreadId,
        requestId: 2,
        threadId,
      });
      const replacementResponse = await bridge.waitForResponse(2);

      expect(getProviderThreadIdFromResult(replacementResponse)).toBe(
        replacementProviderThreadId,
      );
      expect(queries).toHaveLength(2);
      expect(queries[0]?.close).toHaveBeenCalledTimes(1);
      expect(getLatestQueryOptions()).toMatchObject({
        resume: replacementProviderThreadId,
      });

      bridge.sendRequest(3, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("refuses a thread/resume with no provider thread id", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    queryMock.mockImplementation(() => createControlledClaudeQuery());

    try {
      sendResumeThread({
        bridge,
        providerThreadId: null,
        requestId: 1,
        threadId: "thread-resume-no-provider",
      });
      await expect(bridge.waitForResponse(1)).resolves.toMatchObject({
        error: {
          code: -32602,
          message: expect.stringContaining("providerThreadId"),
        },
      });
    } finally {
      bridge.restore();
    }
  });

  it("replaces a stream-ended same-provider thread/resume session", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-resume-stream-ended";
      const providerThreadId = "provider-thread-stream-ended";
      sendResumeThread({
        bridge,
        providerThreadId,
        requestId: 1,
        threadId,
      });
      await bridge.waitForResponse(1);

      queries[0]?.finish();
      await bridge.flushWork();

      sendResumeThread({
        bridge,
        providerThreadId,
        requestId: 2,
        threadId,
      });
      const replacementResponse = await bridge.waitForResponse(2);

      expect(getProviderThreadIdFromResult(replacementResponse)).toBe(
        providerThreadId,
      );
      expect(queries).toHaveLength(2);
      expect(getLatestQueryOptions()).toMatchObject({
        resume: providerThreadId,
      });

      bridge.sendRequest(3, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("waits for a closing same-provider thread/resume session before replacing it", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-resume-closing";
      const providerThreadId = "provider-thread-closing";
      sendResumeThread({
        bridge,
        providerThreadId,
        requestId: 1,
        threadId,
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      sendResumeThread({
        bridge,
        providerThreadId,
        requestId: 3,
        threadId,
      });
      await bridge.flushWork();

      expect(bridge.hasResponse(3)).toBe(false);
      expect(queries).toHaveLength(1);

      queries[0]?.finish();
      await bridge.waitForResponse(2);
      const resumeResponse = await bridge.waitForResponse(3);

      expect(getProviderThreadIdFromResult(resumeResponse)).toBe(
        providerThreadId,
      );
      expect(queries).toHaveLength(2);
      expect(getLatestQueryOptions()).toMatchObject({
        resume: providerThreadId,
      });

      bridge.sendRequest(4, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(4);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("resumes a Claude session when follow-up arrives after an SDK stream error", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-sdk-error-follow-up";
      const inputText = "Continue after the provider error";
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      const startResponse = await bridge.waitForResponse(1);
      const providerThreadId = getProviderThreadIdFromResult(startResponse);

      queries[0]?.fail(new Error("Claude SDK exploded"));
      await bridge.flushWork();

      expect(
        bridge.messages.some(
          (message) =>
            message.method === "error" &&
            isRecord(message.params) &&
            message.params.threadId === threadId &&
            message.params.message === "Claude SDK exploded",
        ),
      ).toBe(true);

      bridge.sendRequest(2, "turn/start", {
        threadId,
        providerThreadId,
        input: [{ type: "text", text: inputText }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          providerOptions: {},
        },
      });
      await bridge.flushWork();

      expect(queries).toHaveLength(2);
      expect(getLatestQueryOptions()).toMatchObject({
        resume: providerThreadId,
      });
      await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
        inputText,
      );
      await bridge.waitForResponse(2);

      bridge.sendRequest(3, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      bridge.restore();
    }
  });

  it("restarts a Claude session before the next turn after an authentication failure", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-authentication-failure";
      const providerThreadId = "provider-thread-authentication-failure";
      sendResumeThread({
        bridge,
        providerThreadId,
        requestId: 1,
        threadId,
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(
        2,
        "turn/start",
        canonicalTurnParams({
          threadId,
          providerThreadId,
          input: [{ type: "text", text: "before reauthentication" }],
        }),
      );
      await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
        "before reauthentication",
      );
      await bridge.waitForResponse(2);

      queries[0]?.emit(createAuthenticationErrorMessage(providerThreadId));
      queries[0]?.emit({
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: null,
        total_cost_usd: 0,
        usage: createResultUsage(),
        modelUsage: {},
        permission_denials: [],
        errors: [
          "Failed to authenticate: OAuth session expired and could not be refreshed",
        ],
        uuid: "00000000-0000-4000-8000-000000000003",
        session_id: providerThreadId,
      });
      await bridge.flushWork();

      expect(getFailedTurns(bridge.messages)).toHaveLength(1);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.close).not.toHaveBeenCalled();
      expect(
        bridge.messages
          .filter((message) => message.method === "provider/recovery")
          .map((message) => message.params),
      ).toEqual([
        {
          threadId,
          kind: "authRequired",
          message: expect.stringContaining("authenticate"),
          retryable: false,
        },
      ]);

      bridge.sendRequest(
        3,
        "turn/start",
        canonicalTurnParams({
          threadId,
          providerThreadId,
          input: [{ type: "text", text: "after reauthentication" }],
        }),
      );
      await bridge.flushWork();

      expect(queries).toHaveLength(2);
      expect(queries[0]?.close).toHaveBeenCalledOnce();
      expect(getLatestQueryOptions()).toMatchObject({
        resume: providerThreadId,
      });
      await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
        "after reauthentication",
      );
      await bridge.waitForResponse(3);

      bridge.sendRequest(4, "thread/stop", {
        threadId,
        providerThreadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(4);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("does not resume an ended Claude session for invalid follow-up input", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-sdk-error-invalid-follow-up";
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      const startResponse = await bridge.waitForResponse(1);
      const providerThreadId = getProviderThreadIdFromResult(startResponse);

      queries[0]?.fail(new Error("Claude SDK exploded"));
      await bridge.flushWork();

      bridge.sendRequest(2, "turn/start", {
        threadId,
        providerThreadId,
        input: [{ type: "text", text: "" }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          providerOptions: {},
        },
      });
      const response = await bridge.waitForResponse(2);

      expect(response).toMatchObject({
        error: { code: -32602, message: "Missing input text" },
      });
      expect(queries).toHaveLength(1);

      bridge.sendRequest(3, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.waitForResponse(3);
    } finally {
      bridge.restore();
    }
  });

  it("forwards stale Claude resume errors without starting a fresh session", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-stale-resume-error";
      const staleProviderThreadId = "stale-provider-thread";
      const inputText = "Reply READY";
      bridge.sendRequest(1, "thread/resume", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        providerThreadId: staleProviderThreadId,
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      const resumeResponse = await bridge.waitForResponse(1);

      expect(getProviderThreadIdFromResult(resumeResponse)).toBe(
        staleProviderThreadId,
      );
      expect(getLatestQueryOptions()).toMatchObject({
        resume: staleProviderThreadId,
      });

      bridge.sendRequest(2, "turn/start", {
        threadId,
        providerThreadId: staleProviderThreadId,
        input: [{ type: "text", text: inputText }],
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          providerOptions: {},
        },
      });
      await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
        inputText,
      );
      await bridge.waitForResponse(2);

      queries[0]?.emit(
        createStaleResumeErrorMessage({
          missingSessionId: staleProviderThreadId,
          sessionId: staleProviderThreadId,
        }),
      );
      await bridge.flushWork();

      expect(queries).toHaveLength(1);
      expect(getFailedTurns(bridge.messages)).toHaveLength(1);
      expect(
        bridge.messages.some((message) => message.method === "error"),
      ).toBe(false);

      bridge.sendRequest(3, "thread/stop", {
        threadId,
        providerThreadId: threadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      bridge.restore();
    }
  });

  it("holds thread stop open until the Claude SDK stream closes", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        threadId: "thread-stop-waits",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-stop-waits",
        providerThreadId: "thread-stop-waits",
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();

      expect(bridge.hasResponse(2)).toBe(false);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.close).not.toHaveBeenCalled();

      queries[0]?.finish();
      await expect(bridge.waitForResponse(2)).resolves.toMatchObject({
        id: 2,
        result: { ok: true },
      });
      expect(queries[0]?.close).not.toHaveBeenCalled();
    } finally {
      bridge.restore();
    }
  });

  it("waits for an in-flight close before replacing the same thread", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(11, "thread/start", {
        threadId: "thread-overlap",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.waitForResponse(11);

      bridge.sendRequest(12, "thread/stop", {
        threadId: "thread-overlap",
        providerThreadId: "thread-overlap",
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      bridge.sendRequest(13, "thread/start", {
        threadId: "thread-overlap",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          instructions: "test",
          providerOptions: {
            workflowsEnabled: false,
          },
        },
      });
      await bridge.flushWork();

      expect(bridge.hasResponse(12)).toBe(false);
      expect(bridge.hasResponse(13)).toBe(false);
      expect(queries).toHaveLength(1);

      queries[0]?.finish();
      await expect(bridge.waitForResponse(12)).resolves.toMatchObject({
        id: 12,
        result: { ok: true },
      });
      await expect(bridge.waitForResponse(13)).resolves.toMatchObject({
        id: 13,
      });
      expect(queries).toHaveLength(2);

      bridge.sendRequest(14, "thread/stop", {
        threadId: "thread-overlap",
        providerThreadId: "thread-overlap",
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(14);
    } finally {
      bridge.restore();
    }
  });

  it.each([
    { method: "turn/start", name: "turn start" },
    { method: "turn/steer", name: "turn steer" },
  ] as const)(
    "opens $name when the SDK consumes input before producing output",
    async (testCase) => {
      const threadId = `thread-${testCase.method.replace("/", "-")}-consumed`;
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const queries: ControlledClaudeQuery[] = [];
      queryMock.mockImplementation(() => {
        const query = createControlledClaudeQuery();
        queries.push(query);
        return query;
      });

      try {
        await startBridgeThread({ bridge, threadId });

        bridge.sendRequest(2, testCase.method, {
          threadId,
          providerThreadId: threadId,
          ...(testCase.method === "turn/steer"
            ? { expectedTurnId: "turn-1" }
            : {}),
          input: [{ type: "text", text: "Please account for the restart" }],
          clientRequestId: "creq_abcdefghjk",
          options: {
            permissionMode: "accept-edits",
            permissionScope: "workspace",
            approvalReviewer: "user",
            permissionEscalation: "ask",
            providerOptions: {},
          },
        });
        await bridge.flushWork();

        expect(bridge.hasResponse(2)).toBe(false);
        expect(
          assembleCapturedThreadEvents(bridge.messages, "claude-code").some(
            (event) => event.type === "turn/started",
          ),
        ).toBe(false);
        await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
          "Please account for the restart",
        );
        await expect(bridge.waitForResponse(2)).resolves.toMatchObject({
          result: { threadId },
        });

        const events = assembleCapturedThreadEvents(
          bridge.messages,
          "claude-code",
        );
        const started = events.find((event) => event.type === "turn/started");
        expect(started).toBeDefined();
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "turn/input/accepted",
            clientRequestId: "creq_abcdefghjk",
            scope: started?.scope,
          }),
        );

        if (testCase.method === "turn/start") {
          if (started?.scope.kind !== "turn")
            throw new Error("Missing active turn");
          bridge.sendRequest(3, "turn/steer", {
            threadId,
            providerThreadId: threadId,
            expectedTurnId: started.scope.turnId,
            input: [{ type: "text", text: "Use the corrected approach" }],
            clientRequestId: "creq_abcdefghjm",
            options: {
              permissionMode: "accept-edits",
              permissionScope: "workspace",
              approvalReviewer: "user",
              permissionEscalation: "ask",
              providerOptions: {},
            },
          });
          await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
            "Use the corrected approach",
          );
          await bridge.waitForResponse(3);
          const steered = assembleCapturedThreadEvents(
            bridge.messages,
            "claude-code",
          );
          expect(
            steered.filter((event) => event.type === "turn/started"),
          ).toHaveLength(1);
          expect(steered).toContainEqual(
            expect.objectContaining({
              type: "turn/input/accepted",
              clientRequestId: "creq_abcdefghjm",
              scope: steered.find((event) => event.type === "turn/started")
                ?.scope,
            }),
          );
        }

        await stopBridgeThread({ bridge, queries, threadId });
        const stopped = assembleCapturedThreadEvents(
          bridge.messages,
          "claude-code",
        );
        expect(stopped).toContainEqual(
          expect.objectContaining({
            type: "turn/completed",
            status: "interrupted",
            scope: stopped.find((event) => event.type === "turn/started")
              ?.scope,
          }),
        );
      } finally {
        queries[0]?.finish();
        bridge.restore();
      }
    },
  );

  it.each([
    { method: "turn/start", name: "turn start" },
    { method: "turn/steer", name: "turn steer" },
  ] as const)(
    "keeps the prior escalation when a rejected $name cannot push input",
    async (testCase) => {
      const threadId = `thread-rejected-${testCase.name.replaceAll(" ", "-")}`;
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const queries: ControlledClaudeQuery[] = [];
      queryMock.mockImplementation(() => {
        const query = createControlledClaudeQuery();
        queries.push(query);
        return query;
      });

      try {
        bridge.sendRequest(1, "thread/start", {
          threadId,
          cwd: "/tmp/worktree",
          instructionMode: "append",
          options: {
            permissionMode: "auto",
            permissionScope: "workspace",
            approvalReviewer: "automatic",
            permissionEscalation: "deny",
            instructions: "test",
            providerOptions: {
              workflowsEnabled: false,
            },
          },
        });
        await bridge.waitForResponse(1);

        await getLatestQueryCall().prompt[Symbol.asyncIterator]().return?.();

        bridge.sendRequest(2, testCase.method, {
          ...canonicalTurnParams({
            threadId,
            input: [{ type: "text", text: "loosen permissions" }],
          }),
          options: {
            ...canonicalOptions(),
            permissionMode: "auto",
            approvalReviewer: "automatic",
          },
          ...(testCase.method === "turn/steer"
            ? { expectedTurnId: "turn-1" }
            : {}),
        });
        await expect(bridge.waitForResponse(2)).resolves.toMatchObject({
          error: { code: -32000 },
        });

        await expect(
          getLastCanUseTool()(
            "Bash",
            { command: "echo hi", dangerouslyDisableSandbox: true },
            {
              decisionReason: "dangerouslyDisableSandbox",
              requestId: "control-request",
              signal: new AbortController().signal,
              toolUseID: `tool-rejected-${testCase.method}`,
            },
          ),
        ).resolves.toMatchObject({ behavior: "deny" });

        bridge.sendRequest(3, "thread/stop", {
          threadId,
          providerThreadId: threadId,
          intent: "interrupt",
          activeTurnId: null,
        });
        await bridge.flushWork();
        queries[0]?.finish();
        await bridge.waitForResponse(3);
      } finally {
        queries.forEach((query) => query.finish());
        bridge.restore();
      }
    },
  );

  describe("prompt attachment text markers", () => {
    async function sendTurnAndReadPrompt(
      bridge: BridgeJsonRpcTestHarness,
      queries: ControlledClaudeQuery[],
      threadId: string,
      input: JsonValue[],
    ): Promise<string> {
      await startBridgeThread({ bridge, threadId });
      bridge.sendRequest(2, "turn/start", {
        threadId,
        providerThreadId: threadId,
        input,
        clientRequestId: "creq_abcdefghjk",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          providerOptions: {},
        },
      });
      const text = await readNextPromptText(getLatestQueryCall());
      await bridge.waitForResponse(2);
      await stopBridgeThread({ bridge, queries, threadId });
      return text;
    }

    function withBridgeHarness(): {
      bridge: BridgeJsonRpcTestHarness;
      queries: ControlledClaudeQuery[];
    } {
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const queries: ControlledClaudeQuery[] = [];
      queryMock.mockImplementation(() => {
        const query = createControlledClaudeQuery();
        queries.push(query);
        return query;
      });
      return { bridge, queries };
    }

    it("emits a path-bearing marker for a localImage attachment", async () => {
      const { bridge, queries } = withBridgeHarness();
      try {
        const text = await sendTurnAndReadPrompt(
          bridge,
          queries,
          "thread-marker-local-image",
          [
            { type: "text", text: "Describe this" },
            {
              type: "localImage",
              path: "/staged/runtime-attachments/req-1/000-screenshot.png",
            },
          ],
        );
        expect(text).toBe(
          "Describe this\n[Attached image. It is on disk at /staged/runtime-attachments/req-1/000-screenshot.png — use the Read tool to view it.]",
        );
      } finally {
        bridge.restore();
      }
    });

    it("emits a name+mime+size marker for a localFile with full metadata", async () => {
      const { bridge, queries } = withBridgeHarness();
      try {
        const text = await sendTurnAndReadPrompt(
          bridge,
          queries,
          "thread-marker-local-file-full",
          [
            { type: "text", text: "Summarize this" },
            {
              type: "localFile",
              path: "/staged/runtime-attachments/req-2/000-report.pdf",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 12345,
            },
          ],
        );
        expect(text).toBe(
          'Summarize this\n[Attached file "report.pdf" (application/pdf, 12345 bytes). It is on disk at /staged/runtime-attachments/req-2/000-report.pdf — use the Read tool to view it.]',
        );
      } finally {
        bridge.restore();
      }
    });

    it("omits missing fields from the localFile marker", async () => {
      const { bridge, queries } = withBridgeHarness();
      try {
        const text = await sendTurnAndReadPrompt(
          bridge,
          queries,
          "thread-marker-local-file-minimal",
          [
            {
              type: "localFile",
              path: "/staged/runtime-attachments/req-3/000-data.csv",
            },
          ],
        );
        expect(text).toBe(
          "[Attached file. It is on disk at /staged/runtime-attachments/req-3/000-data.csv — use the Read tool to view it.]",
        );
      } finally {
        bridge.restore();
      }
    });

    it("emits a URL marker for a remote image attachment", async () => {
      const { bridge, queries } = withBridgeHarness();
      try {
        const text = await sendTurnAndReadPrompt(
          bridge,
          queries,
          "thread-marker-image-url",
          [
            { type: "text", text: "Compare to:" },
            { type: "image", url: "https://example.com/cat.png" },
          ],
        );
        expect(text).toBe(
          "Compare to:\n[Attached image: https://example.com/cat.png]",
        );
      } finally {
        bridge.restore();
      }
    });

    it("accepts an attachment-only turn (no text fragments)", async () => {
      const { bridge, queries } = withBridgeHarness();
      try {
        const text = await sendTurnAndReadPrompt(
          bridge,
          queries,
          "thread-marker-attachment-only",
          [
            {
              type: "localImage",
              path: "/staged/runtime-attachments/req-4/000-only.png",
            },
          ],
        );
        expect(text).toBe(
          "[Attached image. It is on disk at /staged/runtime-attachments/req-4/000-only.png — use the Read tool to view it.]",
        );
      } finally {
        bridge.restore();
      }
    });
  });
});

describe("canonical skills/configure", () => {
  const canonicalOptions = {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  };

  it("assembles a local plugin per generic skill root and loads them on canonical sessions", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });
    const stagedRoot = mkdtempSync(join(tmpdir(), "bb-claude-skill-roots-"));
    const rootA = join(stagedRoot, "a", "skills");
    const rootB = join(stagedRoot, "b", "skills");
    for (const root of [rootA, rootB]) {
      mkdirSync(join(root, "demo"), { recursive: true });
      writeFileSync(join(root, "demo", "SKILL.md"), "---\nname: demo\n---\n");
    }

    try {
      bridge.sendRequest(1, "skills/configure", {
        roots: [
          {
            id: "root_a",
            path: rootA,
            skills: [{ name: "demo", description: "" }],
          },
          {
            id: "root_b",
            path: rootB,
            skills: [{ name: "demo", description: "" }],
          },
        ],
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "thread/start", {
        threadId: "thread-canonical-skills",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: canonicalOptions,
      });
      await bridge.waitForResponse(2);

      const options = getLatestQueryOptions() as {
        plugins?: { type: string; path: string }[];
      };
      expect(options.plugins).toHaveLength(2);
      expect(options).not.toHaveProperty("skills");
      const [pluginA, pluginB] = options.plugins ?? [];
      expect(pluginA?.type).toBe("local");
      expect(pluginB?.type).toBe("local");
      expect(pluginA?.path).not.toBe(pluginB?.path);
      for (const [plugin, root] of [
        [pluginA, rootA],
        [pluginB, rootB],
      ] as const) {
        if (plugin === undefined) throw new Error("expected a plugin");
        expect(
          JSON.parse(
            readFileSync(
              join(plugin.path, ".claude-plugin", "plugin.json"),
              "utf8",
            ),
          ),
        ).toMatchObject({ skills: "./skills" });
        expect(readlinkSync(join(plugin.path, "skills"))).toBe(root);
      }

      bridge.sendRequest(3, "thread/stop", {
        threadId: "thread-canonical-skills",
        providerThreadId: "thread-canonical-skills",
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      bridge.sendRequest(99, "skills/configure", { roots: [] });
      queries[0]?.finish();
      bridge.restore();
      rmSync(stagedRoot, { recursive: true, force: true });
    }
  });
});

describe("canonical model context-window hint", () => {
  const canonicalOptions = {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  };

  it("rebuilds with the same provider session when the turn environment changes", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-env-change";
      bridge.sendRequest(1, "thread/start", {
        threadId,
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          ...canonicalOptions,
          envVars: { PLUGIN_ACCESS_TOKEN: "first" },
          providerOptions: { disable1MContext: true },
        },
      });
      const startResponse = await bridge.waitForResponse(1);
      const providerThreadId = getProviderThreadIdFromResult(startResponse);

      bridge.sendRequest(2, "turn/start", {
        threadId,
        providerThreadId,
        clientRequestId: "creq_23456789ab",
        input: [{ type: "text", text: "continue", mentions: [] }],
        options: {
          ...canonicalOptions,
          envVars: { PLUGIN_ACCESS_TOKEN: "second" },
        },
      });
      await bridge.flushWork();

      expect(queries).toHaveLength(2);
      expect(queries[0]?.close).toHaveBeenCalledOnce();
      expect(getLatestQueryOptions()).toMatchObject({
        env: {
          PLUGIN_ACCESS_TOKEN: "second",
          CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
        },
        resume: providerThreadId,
      });
      await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
        "continue",
      );
      await bridge.waitForResponse(2);
      expect(
        bridge.messages.filter(
          (message) => message.method === "session/replaced",
        ),
      ).toContainEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            contextLost: false,
            providerThreadId,
            reason:
              "Execution settings changed; the Claude session was rebuilt to apply them.",
            showRuntimeNote: true,
            threadId,
          }),
        }),
      );

      bridge.sendRequest(3, "thread/stop", {
        threadId,
        providerThreadId,
        intent: "interrupt",
        activeTurnId: null,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      queries.forEach((query) => query.finish());
      bridge.restore();
    }
  });

  it("uses Fable's Claude Code capacity through a custom API endpoint", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        threadId: "thread-context-hint",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          ...canonicalOptions,
          model: "claude-fable-5",
          envVars: {
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
          },
        },
      });
      await bridge.waitForResponse(1);

      expect(getLatestQueryOptions().env?.ANTHROPIC_BASE_URL).toBe(
        "http://127.0.0.1:8317",
      );

      bridge.sendRequest(2, "turn/start", {
        threadId: "thread-context-hint",
        providerThreadId: "thread-context-hint",
        clientRequestId: "creq_23456789ab",
        input: [{ type: "text", text: "hello", mentions: [] }],
        options: { ...canonicalOptions, model: "claude-fable-5" },
      });
      await readNextPrompt(getLatestQueryCall());
      await bridge.waitForResponse(2);

      queries[0]?.emit({
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        modelUsage: {
          "claude-fable-5": {
            contextWindow: 200_000,
          },
        },
        session_id: "session-1",
      } as unknown as SDKMessage);
      await bridge.flushWork();

      const contextWindowEvents = assembleCapturedThreadEvents(
        bridge.messages,
        "claude-code",
      ).filter(
        (
          event,
        ): event is Extract<
          ThreadEvent,
          { type: "thread/contextWindowUsage/updated" }
        > => event.type === "thread/contextWindowUsage/updated",
      );

      expect(contextWindowEvents.at(-1)?.contextWindowUsage).toMatchObject({
        modelContextWindow: 1_000_000,
      });

      const tokenUsageEvents = assembleCapturedThreadEvents(
        bridge.messages,
        "claude-code",
      ).filter(
        (
          event,
        ): event is Extract<
          ThreadEvent,
          { type: "thread/tokenUsage/updated" }
        > => event.type === "thread/tokenUsage/updated",
      );
      expect(tokenUsageEvents.at(-1)?.tokenUsage).toMatchObject({
        modelContextWindow: 1_000_000,
      });
    } finally {
      queries[0]?.finish();
      bridge.restore();
    }
  });
});
