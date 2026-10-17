import { operationEnvironment } from "../operation-environment.js";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn as spawnPty } from "node-pty";
import type { HostDaemonTerminalCloseReason } from "@bb/domain";
import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";
import { HOST_DAEMON_TERMINAL_EXIT_RETENTION_MS } from "@bb/host-daemon-contract/protocol";
import {
  killProcessGroup,
  sanitizeInheritedChildProcessEnv,
} from "@bb/process-utils";
import { displayWidth, truncateToWidth } from "@bb/text-utils";
import type { HostDaemonServerTerminalMessage } from "../server-connection-support.js";
import type { HostDaemonLogger } from "../logger.js";
import { RuntimeManager } from "../runtime-manager.js";
import { runtimeErrorLogFields } from "../error-utils.js";
import { requireResolvedWorkspaceForCommand } from "../workspace-resolution.js";
import { ExpectedCommandDispatchError } from "../command-dispatch-support.js";
import {
  consumeTerminalAttention,
  INITIAL_TERMINAL_ATTENTION_PARSER_STATE,
  type TerminalAttentionParserState,
} from "./terminal-attention-parser.js";
import {
  resolveWindowsTerminalShell,
  terminalShellArgs,
  terminalShellTitle,
} from "./terminal-shell.js";
import { prepareTerminalShellIntegration } from "./terminal-shell-integration.js";

const DEFAULT_SCROLLBACK_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_SCROLLBACK_MAX_CHUNKS = 10_000;
const MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_BATCH_DELAY_MS = 4;
const TERMINAL_ATTENTION_COALESCE_MS = 2_000;
const OUTPUT_FLOW_PAUSE_BYTES = 1024 * 1024;
const OUTPUT_FLOW_RESUME_BYTES = 512 * 1024;
const PAUSED_PROCESS_EXIT_POLL_MS = 50;
const DEFAULT_TERMINAL_CLOSE_GRACE_PERIOD_MS = 2_000;
const DEFAULT_MAX_EXITED_TERMINALS = 32;
const DEFAULT_MAX_EXITED_SCROLLBACK_BYTES = 16 * 1024 * 1024;
const PRIMARY_DEVICE_ATTRIBUTES_QUERY_PATTERN = /\u001b\[(?:0)?c/g;
const PRIMARY_DEVICE_ATTRIBUTES_RESPONSE = "\u001b[?1;2c";
const MAX_PRIMARY_DEVICE_ATTRIBUTES_REPLIES_PER_CHUNK = 8;
const MAX_TERMINAL_REPLAY_CSI_PARAMETER_BYTES = 1024;
const MAX_RETAINED_REPLAY_PARSER_STATE_BYTES = 4 * 1024 * 1024;
const REPLAY_PARSER_STATE_FIXED_BYTES = 64;
const EMPTY_CSI_REPLAY_PARSER_STATES = new Map<
  string,
  Readonly<TerminalReplayParserState>
>();
const INITIAL_TERMINAL_REPLAY_PARSER_STATE: TerminalReplayParserState = {
  alternateScreen: false,
  controlString: null,
  csiParameters: "",
  escape: "none",
  utf8Remaining: 0,
};
const NODE_PTY_NATIVE_DIRS: readonly string[] = [
  path.join("build", "Release"),
  path.join("build", "Debug"),
  path.join("prebuilds", `${process.platform}-${process.arch}`),
];
const NODE_PTY_NATIVE_RELATIVE_ROOTS: readonly string[] = ["..", "."];
const NODE_PTY_SPAWN_HELPER_MISSING_MESSAGE =
  "no node-pty spawn-helper found at known paths";
const requireForNodePty = createRequire(import.meta.url);
let nodePtySpawnHelperChecked = false;

async function cleanupTerminalShellIntegration(args: {
  cleanup: (() => Promise<void>) | null | undefined;
  logger: HostDaemonLogger;
  terminalId: string;
}): Promise<void> {
  if (args.cleanup === null || args.cleanup === undefined) return;
  try {
    await args.cleanup();
  } catch (error) {
    args.logger.warn(
      { terminalId: args.terminalId, ...runtimeErrorLogFields(error) },
      "Failed to remove terminal shell integration files",
    );
  }
}

export interface TerminalPtyDisposable {
  dispose(): void;
}

export interface TerminalPtyExit {
  exitCode: number;
}

export interface TerminalPtyProcess {
  dispose(): void;
  hasExited(): boolean;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (data: string) => void): TerminalPtyDisposable;
  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable;
  pause(): void;
  resize(cols: number, rows: number): void;
  resume(): void;
  write(data: Buffer | string): void;
}

export interface SpawnTerminalPtyArgs {
  args: string[];
  cols: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  file: string;
  logger: HostDaemonLogger;
  rows: number;
}

export interface TerminalPtyAdapter {
  spawn(args: SpawnTerminalPtyArgs): TerminalPtyProcess;
}

export type ResolveTerminalShell = () => Promise<string>;
type TerminalOpenMessage = Extract<
  HostDaemonServerTerminalMessage,
  { type: "terminal.open" }
>;
type TerminalAttachMessage = Extract<
  HostDaemonServerTerminalMessage,
  { type: "terminal.attach" }
>;

export interface TerminalManagerOptions {
  closeGracePeriodMs?: number;
  exitedRetentionMs?: number;
  logger: HostDaemonLogger;
  maxExitedScrollbackBytes?: number;
  maxExitedTerminals?: number;
  ptyAdapter?: TerminalPtyAdapter;
  resolveShell?: ResolveTerminalShell;
  runtimeManager: RuntimeManager;
  sendMessage: (message: HostDaemonDaemonWsMessage) => boolean;
}

interface ScrollbackEntry {
  byteLength: number;
  chunk: Extract<
    HostDaemonDaemonWsMessage,
    { type: "terminal.output" }
  >["chunk"];
  parserStateBefore: Readonly<TerminalReplayParserState>;
  retentionSeq: number;
}

interface TerminalReplayParserState {
  alternateScreen: boolean;
  controlString: "osc" | "string" | null;
  csiParameters: string;
  escape: "none" | "escape" | "intermediate" | "csi" | "csi-ignore";
  utf8Remaining: number;
}

interface ExitedTerminalSession {
  expiryTimeout: ReturnType<typeof setTimeout> | null;
  nextSeq: number;
  scrollback: ScrollbackEntry[];
  scrollbackBytes: number;
  scrollbackParserStateBytes: number;
  terminalId: string;
}

interface UnacknowledgedOutputChunk {
  byteLength: number;
  seq: number;
}

interface TerminalOutputFlow {
  acknowledgedNextSeq: number;
  pausedExitPoll: ReturnType<typeof setInterval> | null;
  unacknowledgedBytes: number;
  unacknowledgedChunks: UnacknowledgedOutputChunk[];
}

interface TerminalSession {
  chargedScrollbackEntries: ScrollbackEntry[];
  closeReason: HostDaemonTerminalCloseReason | null;
  closeTimeout: ReturnType<typeof setTimeout> | null;
  cols: number;
  disposables: TerminalPtyDisposable[];
  shellIntegrationCleanup: (() => Promise<void>) | null;
  environmentId: string | null;
  lastOutputFlushAt: number;
  lastAttentionAt: number;
  nextSeq: number;
  outputBuffers: Buffer[];
  outputBytes: number;
  outputFlow: TerminalOutputFlow | null;
  attentionParserState: TerminalAttentionParserState;
  outputFlushCancel: (() => void) | null;
  pendingPrimaryDeviceAttributesQuery: PendingPrimaryDeviceAttributesQuery;
  pty: TerminalPtyProcess;
  rows: number;
  scrollbackParserState: TerminalReplayParserState;
  scrollback: ScrollbackEntry[];
  scrollbackBytes: number;
  scrollbackParserStateBytes: number;
  terminalId: string;
}

type PendingPrimaryDeviceAttributesQuery =
  | ""
  | "\u001b"
  | "\u001b["
  | "\u001b[0";

interface PrimaryDeviceAttributesQueryResult {
  output: string;
  pendingQuery: PendingPrimaryDeviceAttributesQuery;
  queryCount: number;
}

interface SendTerminalErrorArgs {
  code: string;
  message: string;
  requestId: string;
  terminalId: string;
}

interface CloseTerminalArgs {
  reason: HostDaemonTerminalCloseReason;
  terminalId: string;
}

interface ShutdownTerminalArgs {
  reason: HostDaemonTerminalCloseReason;
  terminalId: string;
}

interface BuildTerminalEnvArgs {
  shellEnv: NodeJS.ProcessEnv;
  threadId?: string;
  terminalId: string;
}

interface ResizeTerminalArgs {
  cols: number;
  rows: number;
  terminalId: string;
}

interface ResolvedTerminalOpenTarget {
  cwd: string;
  environmentId: string | null;
}

interface FinishTerminalSessionArgs {
  closeReason: HostDaemonTerminalCloseReason;
  exitCode: number | null;
  session: TerminalSession;
}

interface SendTerminalReplayArgs {
  message: TerminalAttachMessage;
  nextSeq: number;
  scrollback: readonly ScrollbackEntry[];
}

type TerminalOperation = () => Promise<void> | void;

interface RunTerminalOperationArgs {
  operation: TerminalOperation;
  terminalId: string;
}

interface RunTerminalOperationAfterPreviousArgs {
  operation: TerminalOperation;
  previousOperation: Promise<void> | undefined;
}

interface TerminalOperationCompletion {
  promise: Promise<void>;
  resolve: () => void;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function disposeNodePty(pty: ReturnType<typeof spawnPty>): void {
  const destroy = "destroy" in pty ? pty.destroy : undefined;
  if (typeof destroy !== "function") {
    throw new Error("node-pty terminal does not expose resource disposal");
  }
  Reflect.apply(destroy, pty, []);
}

const nodePtyAdapter: TerminalPtyAdapter = {
  spawn(args) {
    ensureNodePtySpawnHelperExecutable(args.logger);
    const pty = spawnPty(args.file, args.args, {
      cols: args.cols,
      cwd: args.cwd,
      env: args.env,
      name: "xterm-256color",
      rows: args.rows,
    });
    return {
      dispose: () => disposeNodePty(pty),
      kill: (signal) => {
        if (process.platform === "win32") {
          pty.kill();
          return;
        }
        killProcessGroup({
          child: { pid: pty.pid, kill: (groupSignal) => pty.kill(groupSignal) },
          signal: signal ?? "SIGHUP",
        });
      },
      hasExited: () => !processIsRunning(pty.pid),
      onData: (listener) => pty.onData(listener),
      onExit: (listener) =>
        pty.onExit((event) =>
          listener({
            exitCode: event.exitCode,
          }),
        ),
      pause: () => pty.pause(),
      resize: (cols, rows) => pty.resize(cols, rows),
      resume: () => pty.resume(),
      write: (data) => pty.write(data),
    };
  },
};

interface ResolveNodePtySpawnHelperPathArgs {
  packageDirectory: string;
}

interface EnsureNodePtySpawnHelperExecutableInPackageArgs {
  logger: HostDaemonLogger;
  packageDirectory: string;
}

type NodePtySpawnHelperPathList = string[];

function resolveNodePtySpawnHelperCandidatePaths(
  args: ResolveNodePtySpawnHelperPathArgs,
): NodePtySpawnHelperPathList {
  const helperPaths: string[] = [];
  for (const nativeDir of NODE_PTY_NATIVE_DIRS) {
    for (const relativeRoot of NODE_PTY_NATIVE_RELATIVE_ROOTS) {
      const nativeModuleDir = path.resolve(
        args.packageDirectory,
        "lib",
        relativeRoot,
        nativeDir,
      );
      helperPaths.push(path.join(nativeModuleDir, "spawn-helper"));
    }
  }

  return helperPaths;
}

export function resolveNodePtySpawnHelperPaths(
  args: ResolveNodePtySpawnHelperPathArgs,
): NodePtySpawnHelperPathList {
  return resolveNodePtySpawnHelperCandidatePaths(args).filter((helperPath) =>
    existsSync(helperPath),
  );
}

function pathIsExecutableSync(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function ensureNodePtySpawnHelpersExecutableInPackage(
  args: EnsureNodePtySpawnHelperExecutableInPackageArgs,
): void {
  const helperPaths = resolveNodePtySpawnHelperPaths({
    packageDirectory: args.packageDirectory,
  });
  if (helperPaths.length === 0) {
    args.logger.warn({
      component: "terminal-manager",
      msg: NODE_PTY_SPAWN_HELPER_MISSING_MESSAGE,
      searched: resolveNodePtySpawnHelperCandidatePaths({
        packageDirectory: args.packageDirectory,
      }),
    });
    return;
  }

  for (const helperPath of helperPaths) {
    if (!pathIsExecutableSync(helperPath)) {
      chmodSync(helperPath, 0o755);
    }
    if (!pathIsExecutableSync(helperPath)) {
      throw new Error(`node-pty spawn-helper is not executable: ${helperPath}`);
    }
  }
}

export function ensureNodePtySpawnHelperExecutable(
  logger: HostDaemonLogger,
): void {
  if (nodePtySpawnHelperChecked || process.platform !== "darwin") {
    return;
  }
  nodePtySpawnHelperChecked = true;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  ensureNodePtySpawnHelpersExecutableInPackage({
    logger,
    packageDirectory: path.dirname(packageJsonPath),
  });
}

async function pathIsExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

async function resolveDefaultTerminalShell(): Promise<string> {
  if (process.platform === "win32") {
    return resolveWindowsTerminalShell({
      env: process.env,
      fileExists: pathIsExecutable,
    });
  }
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ].filter(isNonEmptyString);

  for (const candidate of candidates) {
    if (await pathIsExecutable(candidate)) {
      return candidate;
    }
  }

  return "/bin/sh";
}

function buildTerminalEnv(args: BuildTerminalEnvArgs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...sanitizeInheritedChildProcessEnv({ env: process.env }),
    ...args.shellEnv,
    BB_TERMINAL_SESSION_ID: args.terminalId,
    COLORTERM: "truecolor",
    DISABLE_AUTO_TITLE: "true",
    FORCE_HYPERLINK: "1",
    PROMPT_EOL_MARK: "",
    TERM: "xterm-256color",
  };
  if (args.threadId !== undefined) env.BB_THREAD_ID = args.threadId;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function terminalTitleFromCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (displayWidth(normalized) <= 80) {
    return normalized;
  }
  return `${truncateToWidth(normalized, 77)}...`;
}

function terminalTitleForStart(
  message: TerminalOpenMessage,
  shell: string,
): string {
  switch (message.start.mode) {
    case "shell":
      return terminalShellTitle(shell);
    case "command":
      return terminalTitleFromCommand(message.start.command);
    case "argv":
      return terminalTitleFromCommand(message.start.argv.join(" "));
  }
}

async function requireTerminalCwd(cwd: string | null): Promise<string> {
  const resolvedCwd = cwd ?? os.homedir();
  if (!path.isAbsolute(resolvedCwd)) {
    throw new Error("Terminal cwd must be an absolute path");
  }
  const normalizedCwd = path.normalize(resolvedCwd);
  const info = await stat(normalizedCwd);
  if (!info.isDirectory()) {
    throw new Error(`Terminal cwd is not a directory: ${resolvedCwd}`);
  }
  return normalizedCwd;
}

export async function resolveTerminalCwdOverride(args: {
  cwd: string | undefined;
  defaultCwd: string;
}, dependencies: {
  pathApi: Pick<typeof path, "isAbsolute" | "normalize" | "sep">;
  statPath: (cwd: string) => Promise<{ isDirectory: () => boolean }>;
} = { pathApi: path, statPath: stat }): Promise<string> {
  if (args.cwd === undefined || args.cwd.length > 4096) return args.defaultCwd;
  try {
    if (
      !dependencies.pathApi.isAbsolute(args.cwd) ||
      args.cwd.split(/[\\/]/).includes("..")
    ) {
      return args.defaultCwd;
    }
    const cwd = dependencies.pathApi.normalize(args.cwd);
    if (!(await dependencies.statPath(cwd)).isDirectory()) return args.defaultCwd;
    return cwd;
  } catch {
    return args.defaultCwd;
  }
}

function createTerminalOperationCompletion(): TerminalOperationCompletion {
  let resolveCompletion: () => void = () => {
    throw new Error("Terminal operation completion resolver was not set");
  };
  const promise = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  return { promise, resolve: resolveCompletion };
}

function consumePrimaryDeviceAttributesQueries(
  pendingQuery: PendingPrimaryDeviceAttributesQuery,
  data: string,
): PrimaryDeviceAttributesQueryResult {
  const input = pendingQuery + data;
  const nextPendingQuery: PendingPrimaryDeviceAttributesQuery = input.endsWith(
    "\u001b[0",
  )
    ? "\u001b[0"
    : input.endsWith("\u001b[")
      ? "\u001b["
      : input.endsWith("\u001b")
        ? "\u001b"
        : "";
  const completeInput = input.slice(0, input.length - nextPendingQuery.length);
  let queryCount = 0;
  const output = completeInput.replace(
    PRIMARY_DEVICE_ATTRIBUTES_QUERY_PATTERN,
    () => {
      queryCount += 1;
      return "";
    },
  );
  return {
    output,
    pendingQuery: nextPendingQuery,
    queryCount,
  };
}

function advanceTerminalReplayParserState(
  bytes: Buffer,
  previousState: TerminalReplayParserState,
): TerminalReplayParserState {
  const state = { ...previousState };
  for (const byte of bytes) {
    advanceTerminalReplayParserByte(state, byte);
  }
  return state;
}

function findTerminalReplaySafePosition(
  entries: readonly ScrollbackEntry[],
): { alternateScreen: boolean; chunkIndex: number; offset: number } | null {
  const firstEntry = entries[0];
  if (!firstEntry) {
    return null;
  }
  const state = { ...firstEntry.parserStateBefore };
  if (isTerminalReplaySafeBoundary(state)) {
    return {
      alternateScreen: state.alternateScreen,
      chunkIndex: 0,
      offset: 0,
    };
  }
  for (let chunkIndex = 0; chunkIndex < entries.length; chunkIndex += 1) {
    const entry = entries[chunkIndex];
    if (!entry) {
      continue;
    }
    const bytes = Buffer.from(entry.chunk.dataBase64, "base64");
    for (let offset = 0; offset < bytes.byteLength; offset += 1) {
      advanceTerminalReplayParserByte(state, bytes[offset] ?? 0);
      if (isTerminalReplaySafeBoundary(state)) {
        return {
          alternateScreen: state.alternateScreen,
          chunkIndex,
          offset: offset + 1,
        };
      }
    }
  }
  return null;
}

function isTerminalReplaySafeBoundary(
  state: TerminalReplayParserState,
): boolean {
  return (
    state.controlString === null &&
    state.escape === "none" &&
    state.utf8Remaining === 0
  );
}

function advanceTerminalReplayParserByte(
  state: TerminalReplayParserState,
  byte: number,
): void {
  if (byte === 0x18 || byte === 0x1a) {
    state.controlString = null;
    state.csiParameters = "";
    state.escape = "none";
    state.utf8Remaining = 0;
    return;
  }
  if (state.utf8Remaining > 0) {
    if (byte >= 0x80 && byte <= 0xbf) {
      state.utf8Remaining -= 1;
      return;
    }
    state.utf8Remaining = 0;
  }
  if (state.controlString !== null) {
    if (byte === 0x9c || (state.escape === "escape" && byte === 0x5c)) {
      state.controlString = null;
      state.escape = "none";
    } else {
      state.escape =
        state.controlString === "osc" && byte === 0x07
          ? "none"
          : byte === 0x1b
            ? "escape"
            : "none";
      if (state.controlString === "osc" && byte === 0x07) {
        state.controlString = null;
      }
    }
    return;
  }
  if (state.escape === "csi" || state.escape === "csi-ignore") {
    if (byte === 0x1b) {
      state.escape = "escape";
      state.csiParameters = "";
    } else if (byte >= 0x40 && byte <= 0x7e) {
      if (
        state.escape === "csi" &&
        (byte === 0x68 || byte === 0x6c) &&
        /^\?(?:47|1047|1049)(?:;|$)/u.test(state.csiParameters)
      ) {
        state.alternateScreen = byte === 0x68;
      }
      state.escape = "none";
      state.csiParameters = "";
    } else if (state.escape === "csi" && byte >= 0x20 && byte <= 0x3f) {
      if (
        state.csiParameters.length < MAX_TERMINAL_REPLAY_CSI_PARAMETER_BYTES
      ) {
        state.csiParameters += String.fromCharCode(byte);
      } else {
        state.csiParameters = "";
        state.escape = "csi-ignore";
      }
    }
    return;
  }
  if (state.escape === "intermediate") {
    if (byte === 0x1b) {
      state.escape = "escape";
    } else if (byte < 0x20 || byte > 0x2f) {
      state.escape = "none";
    }
    return;
  }
  if (state.escape === "escape") {
    if (byte === 0x1b) {
      state.escape = "escape";
    } else if (byte === 0x5b) {
      state.escape = "csi";
      state.csiParameters = "";
    } else if (byte === 0x5d) {
      state.controlString = "osc";
      state.escape = "none";
    } else if (
      byte === 0x50 ||
      byte === 0x58 ||
      byte === 0x5e ||
      byte === 0x5f
    ) {
      state.controlString = "string";
      state.escape = "none";
    } else if (byte >= 0x20 && byte <= 0x2f) {
      state.escape = "intermediate";
    } else {
      state.escape = "none";
    }
    return;
  }
  if (byte === 0x1b) {
    state.escape = "escape";
  } else if (byte === 0x9b) {
    state.escape = "csi";
  } else if (byte === 0x9d) {
    state.controlString = "osc";
  } else if (byte === 0x90 || byte === 0x98 || byte === 0x9e || byte === 0x9f) {
    state.controlString = "string";
  } else if (byte >= 0xc2 && byte <= 0xdf) {
    state.utf8Remaining = 1;
  } else if (byte >= 0xe0 && byte <= 0xef) {
    state.utf8Remaining = 2;
  } else if (byte >= 0xf0 && byte <= 0xf4) {
    state.utf8Remaining = 3;
  }
}

export class TerminalManager {
  private readonly closeGracePeriodMs: number;
  private readonly exitedRetentionMs: number;
  private readonly maxExitedScrollbackBytes: number;
  private readonly maxExitedTerminals: number;
  private readonly ptyAdapter: TerminalPtyAdapter;
  private readonly resolveShell: ResolveTerminalShell;
  private readonly terminalOperations = new Map<string, Promise<void>>();
  private readonly openingTerminalIds = new Set<string>();
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly exitedSessions = new Map<string, ExitedTerminalSession>();
  private exitedScrollbackBytes = 0;
  private nextScrollbackRetentionSeq = 0;
  private retainedReplayParserStateBytes = 0;

  constructor(private readonly options: TerminalManagerOptions) {
    this.closeGracePeriodMs =
      options.closeGracePeriodMs ?? DEFAULT_TERMINAL_CLOSE_GRACE_PERIOD_MS;
    this.exitedRetentionMs =
      options.exitedRetentionMs ?? HOST_DAEMON_TERMINAL_EXIT_RETENTION_MS;
    this.maxExitedScrollbackBytes =
      options.maxExitedScrollbackBytes ?? DEFAULT_MAX_EXITED_SCROLLBACK_BYTES;
    this.maxExitedTerminals =
      options.maxExitedTerminals ?? DEFAULT_MAX_EXITED_TERMINALS;
    this.ptyAdapter = options.ptyAdapter ?? nodePtyAdapter;
    this.resolveShell = options.resolveShell ?? resolveDefaultTerminalShell;
  }

  dispose(): void {
    this.releaseOutputFlowControl();
    for (const session of this.sessions.values()) {
      this.retainedReplayParserStateBytes -= session.scrollbackParserStateBytes;
      session.scrollback.length = 0;
      session.chargedScrollbackEntries.length = 0;
      session.scrollbackBytes = 0;
      session.scrollbackParserStateBytes = 0;
    }
    for (const terminalId of [...this.exitedSessions.keys()]) {
      this.forgetExitedSession(terminalId);
    }
  }

  releaseOutputFlowControl(): void {
    for (const session of this.sessions.values()) {
      this.disableOutputFlow(session);
    }
  }

  async handleMessage(message: HostDaemonServerTerminalMessage): Promise<void> {
    await this.runTerminalOperation({
      operation: () => this.handleSerializedMessage(message),
      terminalId: message.terminalId,
    });
  }

  private async handleSerializedMessage(
    message: HostDaemonServerTerminalMessage,
  ): Promise<void> {
    switch (message.type) {
      case "terminal.open":
        await this.openTerminal(message);
        return;
      case "terminal.attach":
        this.attachTerminal(message);
        return;
      case "terminal.input":
        this.writeTerminalInput(message.terminalId, message.dataBase64);
        return;
      case "terminal.resize":
        this.resizeTerminal({
          cols: message.cols,
          rows: message.rows,
          terminalId: message.terminalId,
        });
        return;
      case "terminal.close":
        this.closeTerminal({
          reason: message.reason,
          terminalId: message.terminalId,
        });
        return;
      case "terminal.flow-control":
        this.setOutputFlowControl(message.terminalId, message.enabled);
        return;
      case "terminal.ack":
        this.acknowledgeOutput(message.terminalId, message.nextSeq);
        return;
    }
  }

  async shutdownAll(
    reason: HostDaemonTerminalCloseReason = "daemon-disconnect",
  ): Promise<void> {
    const terminalIds = new Set([
      ...this.sessions.keys(),
      ...this.openingTerminalIds,
    ]);
    await Promise.all(
      [...terminalIds].map((terminalId) =>
        this.runTerminalOperation({
          operation: () => this.shutdownTerminal({ reason, terminalId }),
          terminalId,
        }),
      ),
    );
  }

  private async openTerminal(message: TerminalOpenMessage): Promise<void> {
    if (this.sessions.has(message.terminalId)) {
      this.sendTerminalError({
        code: "terminal_exists",
        message: "Terminal session is already open",
        requestId: message.requestId,
        terminalId: message.terminalId,
      });
      return;
    }

    this.openingTerminalIds.add(message.terminalId);
    try {
      const target = await this.resolveTerminalOpenTarget(message);
      const shell = await this.resolveShell();
      const baseEnv = operationEnvironment(
        message.contributedEnv,
        buildTerminalEnv({
          shellEnv: this.options.runtimeManager.getShellEnv(),
          threadId: message.threadId,
          terminalId: message.terminalId,
        }),
      );
      const integration =
        message.start.mode === "shell"
          ? await prepareTerminalShellIntegration({ env: baseEnv, shell })
          : null;
      let pty: TerminalPtyProcess;
      try {
        pty = this.ptyAdapter.spawn({
          args:
            integration?.args ??
            terminalShellArgs({ shell, start: message.start }),
          cols: message.cols,
          cwd: target.cwd,
          env: integration?.env ?? baseEnv,
          file: shell,
          logger: this.options.logger,
          rows: message.rows,
        });
      } catch (error) {
        await cleanupTerminalShellIntegration({
          cleanup: integration?.cleanup,
          logger: this.options.logger,
          terminalId: message.terminalId,
        });
        throw error;
      }
      const session: TerminalSession = {
        chargedScrollbackEntries: [],
        closeReason: null,
        closeTimeout: null,
        cols: message.cols,
        disposables: [],
        shellIntegrationCleanup: integration?.cleanup ?? null,
        environmentId: target.environmentId,
        lastOutputFlushAt: 0,
        lastAttentionAt: Number.NEGATIVE_INFINITY,
        nextSeq: 0,
        outputBuffers: [],
        outputBytes: 0,
        outputFlow: null,
        attentionParserState: { ...INITIAL_TERMINAL_ATTENTION_PARSER_STATE },
        outputFlushCancel: null,
        pendingPrimaryDeviceAttributesQuery: "",
        pty,
        rows: message.rows,
        scrollbackParserState: { ...INITIAL_TERMINAL_REPLAY_PARSER_STATE },
        scrollback: [],
        scrollbackBytes: 0,
        scrollbackParserStateBytes: 0,
        terminalId: message.terminalId,
      };
      this.sessions.set(message.terminalId, session);
      if (target.environmentId !== null) {
        this.options.runtimeManager.markTerminalActive(
          target.environmentId,
          message.terminalId,
        );
      }
      session.disposables.push(
        pty.onData((data) => this.handleTerminalOutput(session, data)),
        pty.onExit((event) => {
          void this.runTerminalOperation({
            operation: () =>
              this.finishTerminalSession({
                closeReason: session.closeReason ?? "process-exit",
                exitCode: event.exitCode,
                session,
              }),
            terminalId: session.terminalId,
          }).catch((error) => {
            this.options.logger.warn(
              {
                terminalId: session.terminalId,
                ...runtimeErrorLogFields(error),
              },
              "Terminal exit handler failed",
            );
          });
        }),
      );
      this.options.sendMessage({
        type: "terminal.opened",
        requestId: message.requestId,
        terminalId: message.terminalId,
        shell,
        title: terminalTitleForStart(message, shell),
        initialCwd: target.cwd,
        cols: message.cols,
        rows: message.rows,
      });
    } catch (error) {
      const code =
        error instanceof ExpectedCommandDispatchError &&
        error.code === "workspace_type_mismatch"
          ? error.code
          : "terminal_open_failed";
      this.sendTerminalError({
        code,
        message: error instanceof Error ? error.message : String(error),
        requestId: message.requestId,
        terminalId: message.terminalId,
      });
    } finally {
      this.openingTerminalIds.delete(message.terminalId);
    }
  }

  private async resolveTerminalOpenTarget(
    message: TerminalOpenMessage,
  ): Promise<ResolvedTerminalOpenTarget> {
    const cwdOverride = (defaultCwd: string) =>
      resolveTerminalCwdOverride({ cwd: message.cwd, defaultCwd });
    switch (message.target.kind) {
      case "workspace": {
        const entry = await requireResolvedWorkspaceForCommand({
          environmentId: message.target.environmentId,
          runtimeManager: this.options.runtimeManager,
          workspaceContext: message.target.workspaceContext,
        });
        return {
          cwd: await cwdOverride(entry.path),
          environmentId: message.target.environmentId,
        };
      }
      case "host_path":
        return {
          cwd: await cwdOverride(await requireTerminalCwd(message.target.cwd)),
          environmentId: null,
        };
    }
  }

  private attachTerminal(message: TerminalAttachMessage): void {
    const session = this.sessions.get(message.terminalId);
    if (session) {
      this.flushTerminalOutput(session);
      this.sendTerminalReplay({
        message,
        nextSeq: session.nextSeq,
        scrollback: session.scrollback,
      });
      return;
    }

    const exited = this.exitedSessions.get(message.terminalId);
    if (exited) {
      this.sendTerminalReplay({
        message,
        nextSeq: exited.nextSeq,
        scrollback: exited.scrollback,
      });
      return;
    }

    this.sendTerminalError({
      code: "terminal_not_found",
      message: "Terminal session is not open",
      requestId: message.requestId,
      terminalId: message.terminalId,
    });
  }

  private sendTerminalReplay(args: SendTerminalReplayArgs): void {
    const replayEntries = args.scrollback.filter(
      (entry) => entry.chunk.seq >= args.message.sinceSeq,
    );
    let replayBytes = replayEntries.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    while (replayEntries.length > 1 && replayBytes > args.message.tailBytes) {
      const removed = replayEntries.shift();
      if (removed) {
        replayBytes -= removed.byteLength;
      }
    }
    const continuesCallerStream =
      replayEntries[0]?.chunk.seq === args.message.sinceSeq;
    const safePosition = continuesCallerStream
      ? { alternateScreen: false, chunkIndex: 0, offset: 0 }
      : findTerminalReplaySafePosition(replayEntries);
    const chunks = safePosition
      ? replayEntries.slice(safePosition.chunkIndex).map((entry) => entry.chunk)
      : [];
    if (safePosition && safePosition.offset > 0) {
      const firstEntry = replayEntries[safePosition.chunkIndex];
      if (firstEntry) {
        const safeBytes = Buffer.from(
          firstEntry.chunk.dataBase64,
          "base64",
        ).subarray(safePosition.offset);
        if (safeBytes.byteLength === 0) {
          chunks.shift();
        } else {
          chunks[0] = {
            ...firstEntry.chunk,
            dataBase64: safeBytes.toString("base64"),
          };
        }
      }
    }
    if (safePosition?.alternateScreen && chunks.length > 0) {
      const firstChunk = chunks[0];
      if (firstChunk) {
        chunks[0] = {
          ...firstChunk,
          dataBase64: Buffer.concat([
            Buffer.from("\u001b[?1049h", "utf8"),
            Buffer.from(firstChunk.dataBase64, "base64"),
          ]).toString("base64"),
        };
      }
    }
    this.options.sendMessage({
      type: "terminal.replay",
      requestId: args.message.requestId,
      terminalId: args.message.terminalId,
      chunks,
      replayStartSeq: chunks[0]?.seq ?? args.nextSeq,
      nextSeq: args.nextSeq,
    });
  }

  private writeTerminalInput(terminalId: string, dataBase64: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      return;
    }
    session.pty.write(Buffer.from(dataBase64, "base64"));
  }

  private resizeTerminal(args: ResizeTerminalArgs): void {
    const session = this.sessions.get(args.terminalId);
    if (!session) {
      return;
    }
    if (session.cols === args.cols && session.rows === args.rows) {
      return;
    }
    session.cols = args.cols;
    session.rows = args.rows;
    session.pty.resize(args.cols, args.rows);
  }

  private closeTerminal(args: CloseTerminalArgs): void {
    const session = this.sessions.get(args.terminalId);
    if (!session) {
      this.options.sendMessage({
        type: "terminal.exited",
        terminalId: args.terminalId,
        exitCode: null,
        closeReason: args.reason,
      });
      return;
    }
    if (session.closeReason !== null) {
      return;
    }
    session.closeReason = args.reason;
    this.disableOutputFlow(session);
    session.closeTimeout = setTimeout(() => {
      session.closeTimeout = null;
      void this.runTerminalOperation({
        operation: () => this.forceCloseTerminal(session),
        terminalId: session.terminalId,
      });
    }, this.closeGracePeriodMs);
    try {
      session.pty.kill();
    } catch (error) {
      this.options.logger.warn(
        {
          terminalId: args.terminalId,
          ...runtimeErrorLogFields(error),
        },
        "Failed to kill terminal",
      );
      this.finishTerminalSession({
        closeReason: args.reason,
        exitCode: null,
        session,
      });
    }
  }

  private forceCloseTerminal(session: TerminalSession): void {
    if (this.sessions.get(session.terminalId) !== session) {
      return;
    }
    this.options.logger.warn(
      { terminalId: session.terminalId },
      "Terminal did not exit after close; forcing cleanup",
    );
    try {
      session.pty.kill("SIGKILL");
    } catch (error) {
      this.options.logger.warn(
        {
          terminalId: session.terminalId,
          ...runtimeErrorLogFields(error),
        },
        "Failed to force kill terminal",
      );
    }
    this.finishTerminalSession({
      closeReason: session.closeReason ?? "user",
      exitCode: null,
      session,
    });
  }

  private shutdownTerminal(args: ShutdownTerminalArgs): void {
    const session = this.sessions.get(args.terminalId);
    if (!session) {
      return;
    }
    this.disableOutputFlow(session);
    try {
      session.pty.kill();
    } catch (error) {
      this.options.logger.warn(
        {
          terminalId: session.terminalId,
          ...runtimeErrorLogFields(error),
        },
        "Failed to kill terminal during shutdown",
      );
    }
    this.finishTerminalSession({
      closeReason: args.reason,
      exitCode: null,
      session,
    });
  }

  private handleTerminalOutput(session: TerminalSession, data: string): void {
    if (this.sessions.get(session.terminalId) !== session) {
      return;
    }

    const result = consumePrimaryDeviceAttributesQueries(
      session.pendingPrimaryDeviceAttributesQuery,
      data,
    );
    session.pendingPrimaryDeviceAttributesQuery = result.pendingQuery;
    if (result.queryCount > 0) {
      const replyCount = Math.min(
        result.queryCount,
        MAX_PRIMARY_DEVICE_ATTRIBUTES_REPLIES_PER_CHUNK,
      );
      session.pty.write(PRIMARY_DEVICE_ATTRIBUTES_RESPONSE.repeat(replyCount));
    }
    this.bufferTerminalOutput(session, result.output);
  }

  private bufferTerminalOutput(session: TerminalSession, data: string): void {
    const buffer = Buffer.from(data, "utf8");
    if (buffer.byteLength === 0) {
      return;
    }

    session.outputBuffers.push(buffer);
    session.outputBytes += buffer.byteLength;
    if (session.outputBytes >= MAX_OUTPUT_CHUNK_BYTES) {
      this.flushTerminalOutput(session);
      return;
    }
    if (session.outputFlushCancel !== null) {
      return;
    }
    const flush = () => {
      session.outputFlushCancel = null;
      this.flushTerminalOutput(session);
    };
    if (
      performance.now() - session.lastOutputFlushAt >=
      DEFAULT_OUTPUT_BATCH_DELAY_MS
    ) {
      const immediate = setImmediate(flush);
      session.outputFlushCancel = () => clearImmediate(immediate);
      return;
    }
    const timeout = setTimeout(flush, DEFAULT_OUTPUT_BATCH_DELAY_MS);
    session.outputFlushCancel = () => clearTimeout(timeout);
  }

  private flushTerminalOutput(session: TerminalSession): void {
    if (session.outputFlushCancel !== null) {
      session.outputFlushCancel();
      session.outputFlushCancel = null;
    }
    if (
      this.sessions.get(session.terminalId) !== session ||
      session.outputBytes === 0
    ) {
      session.outputBuffers = [];
      session.outputBytes = 0;
      return;
    }

    const buffer = Buffer.concat(session.outputBuffers, session.outputBytes);
    session.outputBuffers = [];
    session.outputBytes = 0;
    session.lastOutputFlushAt = performance.now();
    for (
      let offset = 0;
      offset < buffer.byteLength;
      offset += MAX_OUTPUT_CHUNK_BYTES
    ) {
      const dataBuffer = buffer.subarray(
        offset,
        Math.min(offset + MAX_OUTPUT_CHUNK_BYTES, buffer.byteLength),
      );
      const chunk = {
        seq: session.nextSeq,
        dataBase64: dataBuffer.toString("base64"),
      };
      const attention = consumeTerminalAttention(
        session.attentionParserState,
        dataBuffer,
      );
      const now = Date.now();
      if (
        attention.length > 0 &&
        now - session.lastAttentionAt >= TERMINAL_ATTENTION_COALESCE_MS
      ) {
        session.lastAttentionAt = now;
        const detection = attention[0];
        if (detection) {
          this.options.sendMessage({
            type: "terminal.attention",
            terminalId: session.terminalId,
            seq: chunk.seq,
            kind: detection.kind,
            ...(detection.title === undefined ? {} : { title: detection.title }),
            ...(detection.body === undefined ? {} : { body: detection.body }),
          });
        }
      }
      const parserStateBefore = this.replayParserStateSnapshot(
        session.scrollbackParserState,
      );
      session.scrollbackParserState = advanceTerminalReplayParserState(
        dataBuffer,
        session.scrollbackParserState,
      );
      session.nextSeq += 1;
      const entry: ScrollbackEntry = {
        byteLength: dataBuffer.byteLength,
        chunk,
        parserStateBefore,
        retentionSeq: this.nextScrollbackRetentionSeq++,
      };
      const parserStateBytes = this.replayParserStateBytes(entry);
      this.reserveReplayParserState(parserStateBytes);
      session.scrollback.push(entry);
      if (parserStateBytes > 0) {
        session.chargedScrollbackEntries.push(entry);
      }
      session.scrollbackBytes += entry.byteLength;
      session.scrollbackParserStateBytes += parserStateBytes;
      this.retainedReplayParserStateBytes += parserStateBytes;
      this.pruneScrollback(session);
      this.recordUnacknowledgedOutput(session, entry);
      this.options.sendMessage({
        type: "terminal.output",
        terminalId: session.terminalId,
        chunk,
      });
    }
  }

  private setOutputFlowControl(terminalId: string, enabled: boolean): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      return;
    }
    if (!enabled) {
      this.disableOutputFlow(session);
      return;
    }
    if (session.outputFlow !== null || session.closeReason !== null) {
      return;
    }
    session.outputFlow = {
      acknowledgedNextSeq: session.nextSeq,
      pausedExitPoll: null,
      unacknowledgedBytes: 0,
      unacknowledgedChunks: [],
    };
  }

  private acknowledgeOutput(terminalId: string, nextSeq: number): void {
    const session = this.sessions.get(terminalId);
    const flow = session?.outputFlow;
    if (!session || !flow || nextSeq <= flow.acknowledgedNextSeq) {
      return;
    }
    flow.acknowledgedNextSeq = nextSeq;
    let acknowledgedChunks = 0;
    for (const chunk of flow.unacknowledgedChunks) {
      if (chunk.seq >= nextSeq) {
        break;
      }
      flow.unacknowledgedBytes -= chunk.byteLength;
      acknowledgedChunks += 1;
    }
    flow.unacknowledgedChunks.splice(0, acknowledgedChunks);
    if (
      flow.pausedExitPoll !== null &&
      flow.unacknowledgedBytes <= OUTPUT_FLOW_RESUME_BYTES
    ) {
      this.resumeOutput(session, flow);
    }
  }

  private recordUnacknowledgedOutput(
    session: TerminalSession,
    entry: ScrollbackEntry,
  ): void {
    const flow = session.outputFlow;
    if (flow === null) {
      return;
    }
    flow.unacknowledgedChunks.push({
      byteLength: entry.byteLength,
      seq: entry.chunk.seq,
    });
    flow.unacknowledgedBytes += entry.byteLength;
    if (
      flow.pausedExitPoll !== null ||
      flow.unacknowledgedBytes <= OUTPUT_FLOW_PAUSE_BYTES
    ) {
      return;
    }
    session.pty.pause();
    flow.pausedExitPoll = setInterval(() => {
      if (session.pty.hasExited()) {
        this.disableOutputFlow(session);
      }
    }, PAUSED_PROCESS_EXIT_POLL_MS);
  }

  private resumeOutput(
    session: TerminalSession,
    flow: TerminalOutputFlow,
  ): void {
    if (flow.pausedExitPoll === null) {
      return;
    }
    clearInterval(flow.pausedExitPoll);
    flow.pausedExitPoll = null;
    session.pty.resume();
  }

  private disableOutputFlow(session: TerminalSession): void {
    const flow = session.outputFlow;
    if (flow === null) {
      return;
    }
    session.outputFlow = null;
    this.resumeOutput(session, flow);
  }

  private pruneScrollback(session: TerminalSession): void {
    while (
      session.scrollbackBytes > DEFAULT_SCROLLBACK_MAX_BYTES ||
      session.scrollback.length > DEFAULT_SCROLLBACK_MAX_CHUNKS
    ) {
      this.removeOldestScrollbackEntry(session);
    }
  }

  private replayParserStateBytes(entry: ScrollbackEntry): number {
    const length = entry.parserStateBefore.csiParameters.length;
    return length === 0 ? 0 : REPLAY_PARSER_STATE_FIXED_BYTES + 2 * length;
  }

  private replayParserStateSnapshot(
    state: TerminalReplayParserState,
  ): Readonly<TerminalReplayParserState> {
    if (state.csiParameters.length > 0) {
      return { ...state };
    }
    const key = `${state.alternateScreen}:${state.controlString}:${state.escape}:${state.utf8Remaining}`;
    const existing = EMPTY_CSI_REPLAY_PARSER_STATES.get(key);
    if (existing) {
      return existing;
    }
    const snapshot = Object.freeze({ ...state });
    EMPTY_CSI_REPLAY_PARSER_STATES.set(key, snapshot);
    return snapshot;
  }

  private removeOldestScrollbackEntry(session: TerminalSession): void {
    const removed = session.scrollback.shift();
    if (!removed) {
      return;
    }
    const parserStateBytes = this.replayParserStateBytes(removed);
    if (parserStateBytes > 0) {
      session.chargedScrollbackEntries.shift();
    }
    session.scrollbackBytes -= removed.byteLength;
    session.scrollbackParserStateBytes -= parserStateBytes;
    this.retainedReplayParserStateBytes -= parserStateBytes;
  }

  private reserveReplayParserState(bytes: number): void {
    while (
      this.retainedReplayParserStateBytes + bytes >
      MAX_RETAINED_REPLAY_PARSER_STATE_BYTES
    ) {
      const oldestExited = [...this.exitedSessions.values()].find(
        (session) => session.scrollbackParserStateBytes > 0,
      );
      if (oldestExited) {
        this.forgetExitedSession(oldestExited.terminalId);
        continue;
      }
      let oldestSession: TerminalSession | undefined;
      let oldestSeq = Infinity;
      for (const session of this.sessions.values()) {
        const entry = session.chargedScrollbackEntries[0];
        if (entry && entry.retentionSeq < oldestSeq) {
          oldestSession = session;
          oldestSeq = entry.retentionSeq;
        }
      }
      if (!oldestSession) {
        throw new Error(
          "Terminal replay snapshot budget accounting is inconsistent",
        );
      }
      while (
        oldestSession.scrollback[0] &&
        this.replayParserStateBytes(oldestSession.scrollback[0]) === 0
      ) {
        this.removeOldestScrollbackEntry(oldestSession);
      }
      this.removeOldestScrollbackEntry(oldestSession);
    }
  }

  private finishTerminalSession(args: FinishTerminalSessionArgs): void {
    if (this.sessions.get(args.session.terminalId) !== args.session) {
      return;
    }
    if (args.session.pendingPrimaryDeviceAttributesQuery.length > 0) {
      this.bufferTerminalOutput(
        args.session,
        args.session.pendingPrimaryDeviceAttributesQuery,
      );
      args.session.pendingPrimaryDeviceAttributesQuery = "";
    }
    this.flushTerminalOutput(args.session);
    this.disableOutputFlow(args.session);
    if (args.session.closeTimeout !== null) {
      clearTimeout(args.session.closeTimeout);
      args.session.closeTimeout = null;
    }
    this.sessions.delete(args.session.terminalId);
    this.retainExitedSession(args.session);
    if (args.session.environmentId !== null) {
      this.options.runtimeManager.markTerminalInactive(
        args.session.environmentId,
        args.session.terminalId,
      );
    }
    for (const disposable of args.session.disposables) {
      disposable.dispose();
    }
    if (args.session.shellIntegrationCleanup !== null) {
      void cleanupTerminalShellIntegration({
        cleanup: args.session.shellIntegrationCleanup,
        logger: this.options.logger,
        terminalId: args.session.terminalId,
      });
    }
    try {
      args.session.pty.dispose();
    } catch (error) {
      this.options.logger.warn(
        {
          terminalId: args.session.terminalId,
          ...runtimeErrorLogFields(error),
        },
        "Failed to dispose terminal PTY",
      );
    }
    this.options.sendMessage({
      type: "terminal.exited",
      terminalId: args.session.terminalId,
      exitCode: args.exitCode,
      closeReason: args.closeReason,
    });
  }

  private retainExitedSession(session: TerminalSession): void {
    if (this.maxExitedTerminals < 1 || this.exitedRetentionMs <= 0) {
      this.retainedReplayParserStateBytes -= session.scrollbackParserStateBytes;
      return;
    }
    this.forgetExitedSession(session.terminalId);
    const exited: ExitedTerminalSession = {
      expiryTimeout: null,
      nextSeq: session.nextSeq,
      scrollback: session.scrollback,
      scrollbackBytes: session.scrollbackBytes,
      scrollbackParserStateBytes: session.scrollbackParserStateBytes,
      terminalId: session.terminalId,
    };
    const expiryTimeout = setTimeout(() => {
      exited.expiryTimeout = null;
      this.forgetExitedSession(exited.terminalId);
    }, this.exitedRetentionMs);
    expiryTimeout.unref();
    exited.expiryTimeout = expiryTimeout;
    this.exitedSessions.set(exited.terminalId, exited);
    this.exitedScrollbackBytes += exited.scrollbackBytes;
    this.evictExitedSessions();
  }

  private evictExitedSessions(): void {
    while (
      this.exitedSessions.size > this.maxExitedTerminals ||
      (this.exitedSessions.size > 1 &&
        this.exitedScrollbackBytes > this.maxExitedScrollbackBytes)
    ) {
      const oldest = this.exitedSessions.keys().next();
      if (oldest.done) {
        return;
      }
      this.forgetExitedSession(oldest.value);
    }
  }

  private forgetExitedSession(terminalId: string): void {
    const exited = this.exitedSessions.get(terminalId);
    if (!exited) {
      return;
    }
    if (exited.expiryTimeout !== null) {
      clearTimeout(exited.expiryTimeout);
      exited.expiryTimeout = null;
    }
    this.exitedSessions.delete(terminalId);
    this.exitedScrollbackBytes -= exited.scrollbackBytes;
    this.retainedReplayParserStateBytes -= exited.scrollbackParserStateBytes;
  }

  private sendTerminalError(args: SendTerminalErrorArgs): void {
    this.options.sendMessage({
      type: "terminal.error",
      requestId: args.requestId,
      terminalId: args.terminalId,
      code: args.code,
      message: args.message,
    });
  }

  private runTerminalOperation(args: RunTerminalOperationArgs): Promise<void> {
    const previousOperation = this.terminalOperations.get(args.terminalId);
    const completion = createTerminalOperationCompletion();
    this.terminalOperations.set(args.terminalId, completion.promise);
    const operation = this.runTerminalOperationAfterPrevious({
      operation: args.operation,
      previousOperation,
    });

    void operation.then(
      () => {
        completion.resolve();
      },
      () => {
        completion.resolve();
      },
    );
    void completion.promise.then(() => {
      if (this.terminalOperations.get(args.terminalId) === completion.promise) {
        this.terminalOperations.delete(args.terminalId);
      }
    });

    return operation;
  }

  private async runTerminalOperationAfterPrevious(
    args: RunTerminalOperationAfterPreviousArgs,
  ): Promise<void> {
    if (args.previousOperation) {
      await args.previousOperation;
    }
    await args.operation();
  }
}
