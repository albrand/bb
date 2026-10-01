import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type McpServerStatus,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  experimental_isProviderBridgeRecording,
  experimental_recordProviderChildIo,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ClaudePermissionMode } from "../interactive-contract.js";
import {
  isMissingClaudeCliMessage,
  missingClaudeCliGuidance,
  translateMissingClaudeCliError,
} from "./missing-cli-error.js";

export interface SdkSessionOptions {
  cwd: string;
  systemPrompt: Exclude<Options["systemPrompt"], undefined>;
  model?: string;
  additionalDirectories?: readonly string[];
  effort?: Options["effort"];
  sessionId?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: Options["sandbox"];
  hooks?: Options["hooks"];
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  onElicitation?: Options["onElicitation"];
  env?: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable?: Options["pathToClaudeCodeExecutable"];
  plugins?: Options["plugins"];
  thinking?: Options["thinking"];
  settings?: Options["settings"];
  extraArgs?: Options["extraArgs"];
  recordThreadId?: () => string;
}

export type ClaudeSdkReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ClaudeMutableFlagSettings = {
  autoMemoryEnabled: boolean;
  enableWorkflows: boolean;
  effortLevel?: ClaudeSdkReasoningEffort;
  ultracode: boolean;
  fastMode: boolean;
};

type SdkSessionMessageHandler = (message: SDKMessage) => void;
type SdkSessionDoneHandler = (error?: unknown) => void;

interface QueuedSdkInputMessage {
  message: SDKUserMessage;
  rejectConsumed: (error: Error) => void;
  resolveConsumed: () => void;
}

interface SdkPermissionOptions {
  allowDangerouslySkipPermissions?: true;
  permissionMode: ClaudePermissionMode;
}

interface BuildSdkPermissionOptionsArgs {
  permissionMode: ClaudePermissionMode | undefined;
}

interface AppendBoundedTextArgs {
  chunk: string;
  current: string;
}

interface BuildSdkDoneErrorMessageArgs {
  error: unknown;
  stderrTail: string;
}

const SDK_STDERR_TAIL_MAX_CHARS = 4_000;
const CLAUDE_CONFIG_MCP_SCOPES = new Set(["user", "project", "local"]);

export class McpServerConfigChangeError extends Error {
  constructor(name: string | undefined, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const server = name ? ` for server ${name}` : "";
    super(`Could not safely apply MCP configuration${server}: ${reason}`, {
      cause,
    });
    this.name = "McpServerConfigChangeError";
  }
}

function isClaudeConfigScope(scope: string | undefined): boolean {
  return scope !== undefined && CLAUDE_CONFIG_MCP_SCOPES.has(scope);
}

function isCurrentProcessRoot(): boolean {
  return process.getuid?.() === 0;
}

function appendBoundedText(args: AppendBoundedTextArgs): string {
  const next = `${args.current}${args.chunk}`;
  if (next.length <= SDK_STDERR_TAIL_MAX_CHARS) {
    return next;
  }
  return next.slice(next.length - SDK_STDERR_TAIL_MAX_CHARS);
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return isMissingClaudeCliMessage(message)
    ? missingClaudeCliGuidance()
    : message;
}

function buildSdkDoneErrorMessage(args: BuildSdkDoneErrorMessageArgs): string {
  const errorMessage = getErrorMessage(args.error);
  const stderrTail = args.stderrTail.trim();
  if (stderrTail.length === 0 || errorMessage.includes(stderrTail)) {
    return errorMessage;
  }
  return `${errorMessage}\n\nClaude Code stderr:\n${stderrTail}`;
}

function spawnRecordedClaudeProcess(args: {
  onStderr: (data: string) => void;
  spawnOptions: SpawnOptions;
  threadId: string | null;
}): SpawnedProcess {
  const child = spawn(args.spawnOptions.command, args.spawnOptions.args, {
    cwd: args.spawnOptions.cwd,
    env: args.spawnOptions.env,
    signal: args.spawnOptions.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr?.setEncoding("utf8").on("data", (data: string) => {
    args.onStderr(data);
  });
  experimental_recordProviderChildIo(child, { threadId: args.threadId });
  return child as SpawnedProcess;
}

function buildSdkPermissionOptions(
  args: BuildSdkPermissionOptionsArgs,
): SdkPermissionOptions {
  const permissionMode = args.permissionMode ?? "default";
  if (permissionMode !== "bypassPermissions") {
    return { permissionMode };
  }

  if (isCurrentProcessRoot()) {
    return { permissionMode: "default" };
  }

  return {
    permissionMode,
    allowDangerouslySkipPermissions: true,
  };
}

export class SdkSession {
  private query: Query | undefined;
  private sessionId: string | undefined;
  private inputResolve:
    | ((value: IteratorResult<SDKUserMessage>) => void)
    | null = null;
  private readonly inputQueue: QueuedSdkInputMessage[] = [];
  private inputDone = false;
  private readonly abortController = new AbortController();
  private readonly completion: Promise<void>;
  private readonly baseMcpServers: Record<string, McpServerConfig>;
  private readonly bridgeDisabledStaticServers = new Map<
    string,
    McpServerStatus["config"]
  >();
  private mcpReconciliationPending = false;
  private complete: (() => void) | null = null;
  private stderrTail = "";

  constructor(
    private readonly options: SdkSessionOptions,
    private readonly onMessage: SdkSessionMessageHandler,
    private readonly onDone: SdkSessionDoneHandler,
  ) {
    this.baseMcpServers = { ...options.mcpServers };
    this.completion = new Promise((resolve) => {
      this.complete = resolve;
    });
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  canPushInput(): boolean {
    return !this.inputDone;
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.options.permissionMode = mode;
    await this.query?.setPermissionMode(mode);
  }

  async getContextUsage(): Promise<unknown> {
    return this.query ? this.query.getContextUsage() : null;
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.query?.setModel(model);
    this.options.model = model;
  }

  needsMcpServerReconciliation(): boolean {
    return this.mcpReconciliationPending;
  }

  markMcpServerReconciliationPending(): void {
    this.mcpReconciliationPending = true;
  }

  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<void> {
    const query = this.query;
    if (!query) return;
    let statuses: McpServerStatus[];
    try {
      statuses = await query.mcpServerStatus();
    } catch (error) {
      throw new McpServerConfigChangeError(undefined, error);
    }
    const statusesByName = new Map(
      statuses.map((status: McpServerStatus) => [status.name, status]),
    );
    const dynamicServers = Object.create(null) as Record<
      string,
      McpServerConfig
    >;
    const restoreAfterFailedUpdate = new Set<string>();
    let nextServers: Record<string, McpServerConfig>;
    try {
      for (const status of statuses) {
        const configuredServer = servers[status.name];
        if (!isClaudeConfigScope(status.scope)) {
          if (configuredServer !== undefined) {
            dynamicServers[status.name] = configuredServer;
          }
          continue;
        }
        if (configuredServer === undefined) {
          if (status.status !== "disabled") {
            this.bridgeDisabledStaticServers.set(status.name, status.config);
            try {
              await query.toggleMcpServer(status.name, false);
            } catch (error) {
              throw new McpServerConfigChangeError(status.name, error);
            }
          }
          continue;
        }
        if (!isDeepStrictEqual(status.config, configuredServer)) {
          if (status.status !== "disabled") {
            this.bridgeDisabledStaticServers.set(status.name, status.config);
            restoreAfterFailedUpdate.add(status.name);
            try {
              await query.toggleMcpServer(status.name, false);
            } catch (error) {
              throw new McpServerConfigChangeError(status.name, error);
            }
          }
          if (this.bridgeDisabledStaticServers.has(status.name)) {
            restoreAfterFailedUpdate.add(status.name);
          }
          dynamicServers[status.name] = configuredServer;
          continue;
        }
        if (status.status === "disabled") {
          if (
            this.bridgeDisabledStaticServers.has(status.name) &&
            (this.bridgeDisabledStaticServers.get(status.name) === undefined ||
              isDeepStrictEqual(
                this.bridgeDisabledStaticServers.get(status.name),
                configuredServer,
              ))
          ) {
            await query.toggleMcpServer(status.name, true);
            this.bridgeDisabledStaticServers.delete(status.name);
          }
        }
      }
      for (const [name, config] of Object.entries(servers)) {
        if (!statusesByName.has(name)) dynamicServers[name] = config;
      }
      nextServers = { ...dynamicServers, ...this.baseMcpServers };
      const result = await query.setMcpServers(nextServers);
      if (Object.keys(result.errors).length > 0) {
        throw new Error(
          `MCP server connection failed: ${Object.entries(result.errors)
            .map(([name, message]) => `${name}: ${message}`)
            .join("; ")}`,
        );
      }
    } catch (error) {
      this.mcpReconciliationPending = true;
      for (const name of restoreAfterFailedUpdate) {
        try {
          await query.toggleMcpServer(name, true);
          this.bridgeDisabledStaticServers.delete(name);
        } catch {}
      }
      throw error;
    }
    this.mcpReconciliationPending = false;
    this.options.mcpServers = nextServers;
  }

  async reconnectMcpServersNeedingAuth(): Promise<void> {
    const query = this.query;
    if (!query) return;
    const statuses = await query.mcpServerStatus();
    for (const status of statuses) {
      if (status.status === "needs-auth" || status.status === "failed") {
        await query.reconnectMcpServer(status.name);
      }
    }
  }

  async applyMutableSettings(args: {
    effort: ClaudeSdkReasoningEffort | undefined;
    settings: ClaudeMutableFlagSettings;
  }): Promise<void> {
    await this.query?.applyFlagSettings(args.settings);
    this.options.effort = args.effort;
    const { effortLevel: _effortLevel, ...sessionSettings } = args.settings;
    const currentSettings =
      typeof this.options.settings === "object" ? this.options.settings : {};
    this.options.settings = {
      ...currentSettings,
      ...sessionSettings,
    };
  }

  start(resumeSessionId?: string): void {
    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
    } else if (this.options.sessionId) {
      this.sessionId = this.options.sessionId;
    }

    this.stderrTail = "";
    const permissionOptions = buildSdkPermissionOptions({
      permissionMode: this.options.permissionMode,
    });
    const onStderr = (data: string): void => {
      this.stderrTail = appendBoundedText({
        current: this.stderrTail,
        chunk: data,
      });
    };
    const recordThreadId = this.options.recordThreadId;
    const sdkOptions: Options = {
      abortController: this.abortController,
      cwd: this.options.cwd,
      systemPrompt: this.options.systemPrompt,
      ...permissionOptions,
      ...(experimental_isProviderBridgeRecording()
        ? {
            spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) =>
              spawnRecordedClaudeProcess({
                onStderr,
                spawnOptions,
                threadId: recordThreadId?.() ?? null,
              }),
          }
        : {}),
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      persistSession: true,
      env: this.options.env ?? process.env,
      stderr: onStderr,
      ...(this.options.mcpServers
        ? { mcpServers: this.options.mcpServers }
        : {}),
      ...(this.options.allowedTools
        ? { allowedTools: this.options.allowedTools }
        : {}),
      ...(this.options.disallowedTools
        ? { disallowedTools: this.options.disallowedTools }
        : {}),
      ...(this.options.canUseTool
        ? { canUseTool: this.options.canUseTool }
        : {}),
      ...(this.options.onElicitation
        ? { onElicitation: this.options.onElicitation }
        : {}),
      ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(!resumeSessionId && this.options.sessionId
        ? { sessionId: this.options.sessionId }
        : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.additionalDirectories
        ? { additionalDirectories: [...this.options.additionalDirectories] }
        : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(this.options.pathToClaudeCodeExecutable
        ? {
            pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
          }
        : {}),
      ...(this.options.plugins ? { plugins: this.options.plugins } : {}),
      ...(this.options.thinking ? { thinking: this.options.thinking } : {}),
      ...(this.options.settings ? { settings: this.options.settings } : {}),
      extraArgs: {
        ...this.options.extraArgs,
        "replay-user-messages": null,
      },
    };

    try {
      this.query = query({
        prompt: this.createInputIterable(),
        options: sdkOptions,
      });
    } catch (error) {
      throw translateMissingClaudeCliError(error);
    }

    void this.consumeStream();
  }

  pushInput(
    text: string,
    promptId?: NonNullable<SDKUserMessage["uuid"]>,
  ): Promise<void> {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
      ...(promptId !== undefined ? { uuid: promptId } : {}),
    };

    if (this.inputDone) {
      return Promise.reject(new Error("Claude SDK input stream is closed"));
    }

    let resolveConsumed = (): void => {};
    let rejectConsumed = (_error: Error): void => {};
    const consumed = new Promise<void>((resolve, reject) => {
      resolveConsumed = resolve;
      rejectConsumed = reject;
    });

    if (this.inputResolve) {
      const resolve = this.inputResolve;
      this.inputResolve = null;
      resolve({ value: message, done: false });
      resolveConsumed();
      return consumed;
    }

    this.inputQueue.push({
      message,
      rejectConsumed,
      resolveConsumed,
    });
    return consumed;
  }

  stop(): void {
    this.inputDone = true;
    this.rejectQueuedInputs("Claude SDK session stopped before input consumed");
    this.resolveInputDone();
    this.abortController.abort();
    this.query?.close();
    this.query = undefined;
  }

  async closeGracefully(timeoutMs: number): Promise<void> {
    this.inputDone = true;
    this.rejectQueuedInputs("Claude SDK session closed before input consumed");
    this.resolveInputDone();

    if (!this.query) {
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.completion,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Claude SDK session did not close within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } catch {
      this.stop();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private createInputIterable(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.inputQueue.length > 0) {
              const queued = self.inputQueue.shift();
              if (!queued) {
                return { value: undefined, done: true };
              }
              queued.resolveConsumed();
              return { value: queued.message, done: false };
            }
            if (self.inputDone) {
              return { value: undefined, done: true };
            }
            return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              self.inputResolve = resolve;
            });
          },
          async return(): Promise<IteratorResult<SDKUserMessage>> {
            self.inputDone = true;
            self.rejectQueuedInputs(
              "Claude SDK input iterator closed before input consumed",
            );
            self.resolveInputDone();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  private resolveInputDone(): void {
    if (!this.inputResolve) return;
    const resolve = this.inputResolve;
    this.inputResolve = null;
    resolve({ value: undefined, done: true });
  }

  private rejectQueuedInputs(message: string): void {
    const error = new Error(message);
    while (this.inputQueue.length > 0) {
      const queued = this.inputQueue.shift();
      if (!queued) {
        return;
      }
      queued.rejectConsumed(error);
    }
  }

  private async consumeStream(): Promise<void> {
    const q = this.query;
    if (!q) return;

    try {
      for await (const message of q) {
        this.captureSessionId(message);
        this.onMessage(message);
      }
      this.onDone();
    } catch (error) {
      this.onDone(
        new Error(
          buildSdkDoneErrorMessage({
            error,
            stderrTail: this.stderrTail,
          }),
        ),
      );
    } finally {
      this.inputDone = true;
      this.rejectQueuedInputs("Claude SDK stream ended before input consumed");
      this.resolveInputDone();
      this.query = undefined;
      if (this.complete) {
        this.complete();
        this.complete = null;
      }
    }
  }

  private captureSessionId(message: SDKMessage): void {
    const { session_id } = message;
    const providerThreadId = session_id?.trim() ?? "";
    if (providerThreadId.length > 0) {
      this.sessionId = providerThreadId;
    }
  }
}
