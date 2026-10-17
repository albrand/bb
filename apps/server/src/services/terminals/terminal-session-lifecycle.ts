import { emitPluginTerminalInput } from "../plugins/plugin-thread-events.js";
import {
  mergeHostAndProviderEnvironment,
  resolveHostEnvironment,
} from "../hosts/host-environment.js";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  createTerminalSession,
  dismissRetainedTerminalOutput,
  appendRetainedTerminalOutputChunk,
  clearTerminalAttention,
  getTerminalAttention,
  listTerminalAttention,
  getSessionById,
  getTerminalSession,
  getRetainedTerminalOutput,
  listTerminalSessions,
  markRetainedTerminalOutputExited,
  upsertTerminalAttention,
  updateTerminalSession,
  updateTerminalSessions,
  updateThread,
  TERMINAL_OUTPUT_RETENTION_MS,
  type TerminalSessionMutation,
  type TerminalSessionRow,
} from "@bb/db";
import type {
  HostDaemonTerminalCloseReason,
  TerminalSessionCloseReason,
} from "@bb/domain";
import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import type {
  HostDaemonContributedEnvEntry,
  HostDaemonDaemonWsMessage,
  HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import type {
  CloseTerminalRequest,
  CreateTerminalRequest,
  TerminalClientMessage,
  TerminalInputRequest,
  TerminalCreateTarget,
  TerminalListQuery,
  TerminalOutputChunk,
  TerminalOutputQuery,
  TerminalOutputResponse,
  TerminalResizeRequest,
  TerminalSession,
  TerminalNotifyRequest,
  UpdateTerminalRequest,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps, ServerLogger } from "../../types.js";
import { assertUsableHostId } from "../hosts/primary-host.js";
import {
  requireConnectedHostSession,
  requireEnvironment,
  requirePublicThread,
  requireReadyEnvironment,
} from "../lib/entity-lookup.js";
import {
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import { requireWorkspaceCommandTarget } from "../environments/workspace-command-target.js";
import {
  isServerMoveSnapshotFenced,
  serverMovingError,
} from "../server-move/freeze-state.js";
import {
  type PendingRpcKey,
  PendingRpcRegistry,
} from "./pending-rpc-registry.js";
import { TerminalOutputFlowControl } from "./terminal-output-flow-control.js";

const DEFAULT_TERMINAL_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINAL_START: NonNullable<CreateTerminalRequest["start"]> = {
  mode: "shell",
};
const HOST_HOME_INITIAL_CWD = "~";
const TERMINAL_SCROLLBACK_MAX_BYTES = 4 * 1024 * 1024;
const TERMINAL_EXIT_RETENTION_MINUTES = Math.round(
  TERMINAL_OUTPUT_RETENTION_MS / 60_000,
);
const TERMINAL_OUTPUT_NOT_RUNNING_MESSAGE =
  "Terminal output is unavailable because the session is not running";
const TERMINAL_OUTPUT_DISCARDED_MESSAGE = `The server no longer has the retained output of this exited terminal. The server keeps terminal output for ${TERMINAL_EXIT_RETENTION_MINUTES} minutes after a terminal exits, so read it sooner or run the command again.`;
const TERMINAL_ATTACH_CANCELLED = new Error("Terminal attach cancelled");
const REOPEN_NATIVE_TERMINAL_REPAINT_DELAY_MS = 1_500;
const DAEMON_OWNED_TERMINAL_STATUSES = ["starting", "running"] as const;
const NON_TERMINAL_SESSION_STATUSES = [
  ...DAEMON_OWNED_TERMINAL_STATUSES,
  "disconnected",
] as const;

function splitTerminalInputFrames(dataBase64: string): string[] {
  const data = Buffer.from(dataBase64, "base64");
  if (data.byteLength <= TERMINAL_DATA_MAX_BYTES) return [dataBase64];
  const frames: string[] = [];
  for (
    let offset = 0;
    offset < data.byteLength;
    offset += TERMINAL_DATA_MAX_BYTES
  ) {
    frames.push(
      data
        .subarray(offset, offset + TERMINAL_DATA_MAX_BYTES)
        .toString("base64"),
    );
  }
  return frames;
}

type TerminalOpenedMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.opened" }
>;
type TerminalReplayMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.replay" }
>;
type TerminalOutputMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.output" }
>;
type TerminalApiErrorStatus = ConstructorParameters<typeof ApiError>[0];
type RunningBrowserTerminalSession = TerminalSessionRow & {
  daemonSessionId: string;
  status: "running";
};

interface TerminalClientSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface PendingTerminalRpcKey extends PendingRpcKey {
  daemonSessionId: string;
  requestId: string;
  terminalId: string;
}

interface PendingTerminalCloseKey extends PendingRpcKey {
  closeReason: TerminalSessionCloseReason;
  daemonSessionId: string;
  terminalId: string;
}

interface PendingTerminalAttachKey extends PendingTerminalRpcKey {
  socket: TerminalClientSocket;
}

interface RejectPendingOpenForTerminalArgs {
  code: string;
  daemonSessionId: string;
  message: string;
  status: TerminalApiErrorStatus;
  terminalId: string;
}

interface RequestTerminalClosesArgs {
  closeReason: HostDaemonTerminalCloseReason;
  sessions: readonly TerminalSessionRow[];
}

interface PublishLifecycleTerminalExitsArgs {
  code: string;
  message: string;
  previousSessionsById: ReadonlyMap<string, TerminalSessionRow>;
  sessions: readonly TerminalSessionRow[];
}

interface NotifyExitedTerminalSessionArgs {
  code: string;
  message: string;
  session: TerminalSessionRow;
}

interface TerminalDaemonCloseTarget {
  daemonSessionId: string;
  terminalId: string;
}

type TerminalDaemonOpenTarget = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>["target"];
type TerminalLaunchTarget = Exclude<TerminalCreateTarget, { kind: "thread" }>;

interface ResolvedTerminalLaunchTarget {
  daemonTarget: TerminalDaemonOpenTarget;
  environmentId: string | null;
  hostId: string;
  initialCwd: string;
}

interface AttachBrowserTerminalArgs {
  outputAcks: boolean;
  resizeAcks: boolean;
  socket: TerminalClientSocket;
  sinceSeq: number;
  terminalId: string;
}

interface DetachBrowserTerminalArgs {
  socket: TerminalClientSocket;
  terminalId: string;
}

interface HandleBrowserTerminalMessageArgs {
  message: TerminalClientMessage;
  socket: TerminalClientSocket;
  terminalId: string;
}

interface SendTerminalInputArgs {
  payload: TerminalInputRequest;
  terminalId: string;
}

interface ResizeTerminalArgs {
  payload: TerminalResizeRequest;
  terminalId: string;
}

interface ReadTerminalOutputArgs {
  query: TerminalOutputQuery;
  terminalId: string;
}

interface ReadRunningTerminalOutputArgs {
  query: TerminalOutputQuery;
  session: RunningBrowserTerminalSession;
}

interface ReadExitedTerminalOutputArgs {
  query: TerminalOutputQuery;
  session: TerminalSessionRow;
}

interface RequestTerminalOutputReplayArgs {
  daemonSessionId: string;
  query: TerminalOutputQuery;
  session: TerminalSessionRow;
}

interface GetRunningBrowserTerminalArgs {
  socket: TerminalClientSocket;
  terminalId: string;
}

interface GetBrowserTerminalSessionArgs {
  reportMissing?: boolean;
  socket: TerminalClientSocket;
  terminalId: string;
}

interface SendTerminalSocketErrorArgs {
  code: string;
  message: string;
  socket: TerminalClientSocket;
}

interface DisconnectDaemonSessionTerminalsArgs {
  daemonSessionId: string;
}

interface RejectPendingAttachesForTerminalArgs {
  code: string;
  message: string;
  terminalId: string;
}

interface CloseStaleOpenedTerminalArgs {
  daemonSessionId: string;
  terminalId: string;
}

interface PublishLifecycleTerminalExitsForSessionsArgs {
  currentSessions: TerminalSessionRow[];
  exitedSessions: TerminalSessionRow[];
  message: string;
}

interface CloseThreadTerminalsForLifecycleArgs {
  closeReason: HostDaemonTerminalCloseReason;
  message: string;
  threadId: string;
}

interface TerminalSessionLifecycleOptions {
  attachTimeoutMs?: number;
  closeTimeoutMs?: number;
  config: AppDeps["config"];
  db: AppDeps["db"];
  hub: AppDeps["hub"];
  logger: ServerLogger;
  openTimeoutMs?: number;
}

interface ListTerminalsArgs {
  query: TerminalListQuery;
}

interface CreateTerminalArgs {
  onTerminalStarted?: (terminalId: string) => void;
  payload: CreateTerminalRequest;
  extraContributedEnv?: HostDaemonContributedEnvEntry[];
}

interface GetTerminalArgs {
  terminalId: string;
}

interface TerminalCreatePayload {
  cols: number;
  rows: number;
  cwd?: string;
  start?: NonNullable<CreateTerminalRequest["start"]>;
  title?: string;
}

interface CreateTerminalForTargetArgs {
  extraContributedEnv: HostDaemonContributedEnvEntry[];
  onTerminalStarted?: (terminalId: string) => void;
  payload: TerminalCreatePayload;
  target: TerminalLaunchTarget;
  threadId: string | null;
  title: string;
}

interface RenameTerminalArgs {
  payload: UpdateTerminalRequest;
  terminalId: string;
}

interface CloseTerminalArgs {
  payload: CloseTerminalRequest;
  terminalId: string;
}

interface RestartTerminalArgs {
  terminalId: string;
}

interface CloseTerminalSessionArgs {
  current: TerminalSessionRow;
  payload: CloseTerminalRequest;
}

interface CloseDeletedThreadTerminalsArgs {
  threadId: string;
}

interface CloseArchivedThreadTerminalsArgs {
  threadId: string;
}

interface CloseDestroyedEnvironmentTerminalsArgs {
  environmentId: string;
}

interface CloseRemovedHostTerminalsArgs {
  hostId: string;
}

interface ReconcileDisconnectedHostTerminalsArgs {
  daemonSessionId: string;
  hostId: string;
}

interface HandleDaemonTerminalMessageArgs {
  hostId: string;
  message: HostDaemonDaemonWsMessage;
  sessionId: string;
}

interface RefuseDaemonTerminalOpenArgs {
  message: TerminalOpenedMessage;
  sessionId: string;
}

interface HandleDaemonSessionClosedArgs {
  sessionId: string;
}

function toTerminalOutputChunk(
  chunk: TerminalOutputMessage["chunk"],
): TerminalOutputChunk {
  return {
    seq: chunk.seq,
    dataBase64: chunk.dataBase64,
  };
}

function terminalRpcKey(
  daemonSessionId: string,
  terminalId: string,
  requestId: string,
): string {
  return `${daemonSessionId}\0${terminalId}\0${requestId}`;
}

function terminalResponseRpcKey(
  daemonSessionId: string,
  message: { requestId: string; terminalId: string },
): string {
  return terminalRpcKey(daemonSessionId, message.terminalId, message.requestId);
}

function terminalTimeoutError(code: string, message: string): () => ApiError {
  return () => new ApiError(504, code, message);
}

function titleFromCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77)}...`;
}

function initialTitleForTerminal(
  payload: TerminalCreatePayload,
  existingSessionCount: number,
): string {
  if (payload.title !== undefined) {
    return payload.title;
  }
  if (payload.start?.mode === "command") {
    return titleFromCommand(payload.start.command);
  }
  if (payload.start?.mode === "argv") {
    return titleFromCommand(payload.start.argv.join(" "));
  }
  return `Terminal ${existingSessionCount + 1}`;
}

interface BoundedTerminalOutput {
  chunks: TerminalOutputChunk[];
  truncated: boolean;
}

function applyTerminalOutputBounds(args: {
  chunks: readonly TerminalOutputChunk[];
  query: TerminalOutputQuery;
  replayNextSeq: number;
  requestedSinceSeq: number;
}): BoundedTerminalOutput {
  const { chunks, query, replayNextSeq, requestedSinceSeq } = args;
  const limitedByChunks =
    query.limitChunks === undefined ? chunks : chunks.slice(-query.limitChunks);
  let truncated =
    limitedByChunks.length < chunks.length ||
    (chunks[0]?.seq ?? replayNextSeq) > requestedSinceSeq;
  if (query.tailBytes === undefined) {
    return { chunks: [...limitedByChunks], truncated };
  }

  const bounded: TerminalOutputChunk[] = [];
  let byteLength = 0;
  for (let index = limitedByChunks.length - 1; index >= 0; index -= 1) {
    const chunk = limitedByChunks[index];
    const chunkByteLength = Buffer.byteLength(chunk.dataBase64, "base64");
    if (bounded.length > 0 && byteLength + chunkByteLength > query.tailBytes) {
      truncated = true;
      break;
    }
    bounded.unshift(chunk);
    byteLength += chunkByteLength;
    if (byteLength >= query.tailBytes) {
      truncated = truncated || index > 0;
      break;
    }
  }
  if (bounded.length < limitedByChunks.length) {
    truncated = true;
  }
  return { chunks: bounded, truncated };
}

function terminalOutputLastLines(
  output: { chunks: TerminalOutputChunk[]; truncated: boolean },
  lines: number,
): { chunks: TerminalOutputChunk[]; truncated: boolean } {
  const text = Buffer.concat(
    output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  ).toString("utf8");
  const trailingNewline = text.endsWith("\n");
  const split = text.split("\n");
  if (trailingNewline) split.pop();
  const selected = split.slice(-lines);
  const selectedText = `${selected.join("\n")}${trailingNewline ? "\n" : ""}`;
  const firstSeq = output.chunks[0]?.seq ?? 0;
  return {
    chunks:
      selectedText.length === 0
        ? []
        : [
            {
              seq: firstSeq,
              dataBase64: Buffer.from(selectedText).toString("base64"),
            },
          ],
    truncated: output.truncated || split.length > lines,
  };
}

function isRunningBrowserTerminalSession(
  row: TerminalSessionRow,
): row is RunningBrowserTerminalSession {
  return row.status === "running" && row.daemonSessionId !== null;
}

function terminalRestartTarget(row: TerminalSessionRow): TerminalCreateTarget {
  if (row.threadId !== null) {
    return { kind: "thread", threadId: row.threadId };
  }
  if (row.environmentId !== null) {
    return { kind: "environment", environmentId: row.environmentId };
  }
  return {
    kind: "host_path",
    hostId: row.hostId,
    cwd: row.initialCwd === HOST_HOME_INITIAL_CWD ? null : row.initialCwd,
  };
}

function getTerminalDaemonCloseTarget(
  row: TerminalSessionRow,
): TerminalDaemonCloseTarget | null {
  if (row.daemonSessionId === null) {
    return null;
  }
  if (row.status !== "starting" && row.status !== "running") {
    return null;
  }
  return {
    daemonSessionId: row.daemonSessionId,
    terminalId: row.id,
  };
}

const terminalAttentionStateSchema = z
  .object({
    at: z.number().int().nonnegative(),
    body: z.string().max(2048).optional(),
    kind: z.enum(["bell", "osc-9", "osc-99", "osc-777"]),
    seq: z.number().int().nonnegative(),
    title: z.string().max(256).optional(),
  })
  .strict();

type TerminalAttentionState = z.infer<typeof terminalAttentionStateSchema>;

const TERMINAL_THREAD_ATTENTION_DEBOUNCE_MS = 10_000;

function getTerminalById(
  db: AppDeps["db"],
  terminalId: string,
): TerminalSessionRow | null {
  return getTerminalSession(db, { kind: "terminal", terminalId });
}

function updateTerminalById(
  db: AppDeps["db"],
  terminalId: string,
  update: TerminalSessionMutation,
): TerminalSessionRow | null {
  return updateTerminalSession(db, {
    scope: { kind: "terminal", terminalId },
    update,
  });
}

export class TerminalSessionLifecycle {
  private readonly lastThreadAttentionAt = new Map<string, number>();
  private readonly nativeTerminalRepaintsOnAttach = new Set<string>();
  private readonly pendingAttaches: PendingRpcRegistry<
    PendingTerminalAttachKey,
    TerminalReplayMessage
  >;
  private readonly pendingCloses: PendingRpcRegistry<
    PendingTerminalCloseKey,
    TerminalSessionRow
  >;
  private readonly pendingOutputReads: PendingRpcRegistry<
    PendingTerminalRpcKey,
    TerminalReplayMessage
  >;
  private readonly pendingOpens: PendingRpcRegistry<
    PendingTerminalRpcKey,
    TerminalOpenedMessage
  >;
  private readonly pendingRestarts: PendingRpcRegistry<
    PendingRpcKey,
    TerminalSession
  >;
  private readonly pendingCatchUps: PendingRpcRegistry<
    PendingTerminalRpcKey,
    TerminalReplayMessage
  >;
  private readonly directOutputSessionIds = new Set<string>();
  private readonly directOutputSockets = new WeakSet<TerminalClientSocket>();
  private readonly catchingUpTerminalIds = new Set<string>();
  private readonly forwardedNextSeqByTerminalId = new Map<string, number>();
  private readonly exitListeners = new Set<
    (session: TerminalSessionRow) => void
  >();
  private readonly outputAckSocketVisibility = new WeakMap<
    TerminalClientSocket,
    boolean
  >();
  private readonly resizeAckSockets = new WeakSet<TerminalClientSocket>();
  private readonly outputFlow: TerminalOutputFlowControl;

  constructor(private readonly options: TerminalSessionLifecycleOptions) {
    this.outputFlow = new TerminalOutputFlowControl({
      sendDaemonMessage: (daemonSessionId, message) => {
        this.options.hub.sendDaemonSessionMessage(daemonSessionId, message);
      },
    });
    const attachTimeoutMs =
      options.attachTimeoutMs ?? DEFAULT_TERMINAL_OPEN_TIMEOUT_MS;
    const closeTimeoutMs =
      options.closeTimeoutMs ?? DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS;
    const openTimeoutMs =
      options.openTimeoutMs ?? DEFAULT_TERMINAL_OPEN_TIMEOUT_MS;
    this.pendingAttaches = new PendingRpcRegistry<
      PendingTerminalAttachKey,
      TerminalReplayMessage
    >({
      onFail: (key, error) => this.failTerminalAttach(key, error),
      onSettle: (key, message) => this.completePendingAttach(key, message),
      timeoutMs: attachTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_attach_timeout",
        "Timed out attaching terminal session",
      ),
    });
    this.pendingCloses = new PendingRpcRegistry<
      PendingTerminalCloseKey,
      TerminalSessionRow
    >({
      onFail: (pending, error) =>
        this.finalizeTimedOutTerminalClose(pending, error),
      timeoutMs: closeTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_close_timeout",
        "Timed out waiting for terminal process to exit",
      ),
    });
    this.pendingOutputReads = new PendingRpcRegistry({
      timeoutMs: attachTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_output_timeout",
        "Timed out reading terminal output",
      ),
    });
    this.pendingOpens = new PendingRpcRegistry({
      timeoutMs: openTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_open_timeout",
        "Timed out opening terminal session",
      ),
    });
    this.pendingRestarts = new PendingRpcRegistry({
      timeoutMs: null,
    });
    this.pendingCatchUps = new PendingRpcRegistry<
      PendingTerminalRpcKey,
      TerminalReplayMessage
    >({
      onFail: (key) => this.catchingUpTerminalIds.delete(key.terminalId),
      onSettle: (key, message) => this.completeTerminalCatchUp(key, message),
      timeoutMs: attachTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_catch_up_timeout",
        "Timed out replaying terminal output after the host reconnected",
      ),
    });
  }

  listTerminals(args: ListTerminalsArgs): TerminalSession[] {
    const { query } = args;
    if (query.threadId !== undefined) {
      requirePublicThread(this.options.db, query.threadId);
      return listTerminalSessions(this.options.db, {
        scope: { kind: "thread", threadId: query.threadId },
        visible: true,
      }).map((row) => this.toTerminalSession(row));
    }
    if (query.environmentId !== undefined) {
      requireEnvironment(this.options.db, query.environmentId);
      return listTerminalSessions(this.options.db, {
        scope: {
          environmentId: query.environmentId,
          kind: "threadless-environment",
        },
        visible: true,
      }).map((row) => this.toTerminalSession(row));
    }
    const hostId = query.hostId;
    if (hostId === undefined) {
      return [];
    }
    assertUsableHostId(
      {
        config: this.options.config,
        db: this.options.db,
        hub: this.options.hub,
      },
      { hostId },
    );
    return listTerminalSessions(this.options.db, {
      scope: { kind: "all" },
      visible: true,
    })
      .filter(
        (session) =>
          session.threadId === null &&
          session.environmentId === null &&
          session.hostId === hostId &&
          (query.cwd === undefined || session.initialCwd === query.cwd),
      )
      .map((row) => this.toTerminalSession(row));
  }

  listAttention(): TerminalSession[] {
    return listTerminalAttention(this.options.db).flatMap(
      ({ terminalSessionId }) => {
        const row = getTerminalById(this.options.db, terminalSessionId);
        return row === null ? [] : [this.toTerminalSession(row)];
      },
    );
  }

  clearAttention(terminalId: string): TerminalSession {
    const row = getTerminalById(this.options.db, terminalId);
    if (row === null) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    this.clearTerminalAttention(terminalId);
    const updated = getTerminalById(this.options.db, terminalId);
    if (updated === null) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    return this.toTerminalSession(updated);
  }

  getTerminal(args: GetTerminalArgs): TerminalSession {
    const session = getTerminalById(this.options.db, args.terminalId);
    if (!session) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    return this.toTerminalSession(session);
  }

  private toTerminalSession(row: TerminalSessionRow): TerminalSession {
    const attention = getTerminalAttention(this.options.db, row.id);
    return {
      id: row.id,
      threadId: row.threadId,
      environmentId: row.environmentId,
      hostId: row.hostId,
      title: row.title,
      initialCwd: row.initialCwd,
      cols: row.cols,
      rows: row.rows,
      status: row.status,
      exitCode: row.exitCode,
      closeReason: row.closeReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastUserInputAt: row.lastUserInputAt,
      attention:
        attention === null || attention.clearedAt !== null
          ? null
          : {
              at: attention.attentionAt,
              body: attention.body ?? undefined,
              kind: attention.kind,
              seq: attention.seq,
              title: attention.title ?? undefined,
            },
    };
  }

  notifyTerminal(args: {
    payload: TerminalNotifyRequest;
    terminalId: string;
  }): TerminalSession {
    const session = getTerminalById(this.options.db, args.terminalId);
    if (!session || session.status !== "running") {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Running terminal not found",
      );
    }
    this.recordTerminalAttention({
      source: "api",
      terminalId: session.id,
      kind: "osc-9",
      ...args.payload,
    });
    return this.toTerminalSession(session);
  }

  setDeviceHandoffAttention(terminalId: string, pending: boolean): void {
    const session = getTerminalById(this.options.db, terminalId);
    if (!session || session.status !== "running") return;
    if (pending) {
      this.recordTerminalAttention({
        source: "api",
        terminalId,
        kind: "osc-9",
        title: "Link waiting for this device",
        body: "",
      });
      return;
    }
    this.clearTerminalAttention(terminalId);
  }

  private recordTerminalAttention(
    attention:
      | (Omit<TerminalAttentionState, "at" | "seq"> & {
          at?: number;
          source: "api";
          terminalId: string;
        })
      | (Omit<TerminalAttentionState, "at"> & {
          at?: number;
          source: "daemon";
          terminalId: string;
        }),
  ): void {
    const session = getTerminalById(this.options.db, attention.terminalId);
    if (!session || session.status !== "running") return;
    const now = attention.at ?? Date.now();
    const source = attention.source;
    const alreadyVisible = this.options.hub.hasVisibleTerminalClient(
      attention.terminalId,
      now,
    );
    const daemonSeq = source === "daemon" ? attention.seq : null;
    const { terminalId, ...value } = attention;
    const previous = getTerminalAttention(this.options.db, terminalId);
    if (
      daemonSeq !== null &&
      previous?.daemonSeq !== null &&
      previous?.daemonSeq !== undefined &&
      daemonSeq <= previous.daemonSeq
    ) {
      return;
    }
    const seq =
      daemonSeq !== null
        ? Math.max((previous?.seq ?? -1) + 1, daemonSeq)
        : (previous?.seq ?? 0) + 1;
    upsertTerminalAttention(this.options.db, {
      terminalSessionId: terminalId,
      seq,
      daemonSeq: daemonSeq ?? previous?.daemonSeq ?? null,
      kind: value.kind,
      title: value.title ?? null,
      body: value.body ?? null,
      attentionAt: now,
    });
    if (alreadyVisible) {
      clearTerminalAttention(this.options.db, terminalId, now);
    }
    if (session.threadId !== null) {
      if (!alreadyVisible) {
        const previous = this.lastThreadAttentionAt.get(session.threadId) ?? 0;
        if (now - previous >= TERMINAL_THREAD_ATTENTION_DEBOUNCE_MS) {
          updateThread(this.options.db, this.options.hub, session.threadId, {
            latestAttentionAt: now,
          });
          this.lastThreadAttentionAt.set(session.threadId, now);
        }
      }
      this.options.hub.notifyThread(session.threadId, ["terminals-changed"]);
    }
  }

  private clearTerminalAttention(terminalId: string): void {
    const session = getTerminalById(this.options.db, terminalId);
    const attention = getTerminalAttention(this.options.db, terminalId);
    if (attention === null || attention.clearedAt !== null) return;
    clearTerminalAttention(this.options.db, terminalId, Date.now());
    const updatedSession = getTerminalById(this.options.db, terminalId);
    if (updatedSession !== null) {
      this.options.hub.sendTerminalClientMessage(terminalId, {
        type: "session-updated",
        session: this.toTerminalSession(updatedSession),
      });
    }
    if (session?.threadId !== null && session?.threadId !== undefined) {
      this.options.hub.notifyThread(session.threadId, ["terminals-changed"]);
    }
  }

  async createTerminal(args: CreateTerminalArgs): Promise<TerminalSession> {
    const { target } = args.payload;
    const existingSessionCount = this.countExistingSessionsForTarget(target);
    const launchTarget =
      target.kind === "thread"
        ? this.resolveThreadTerminalCreateTarget(target.threadId)
        : target;
    return this.createTerminalForTarget({
      extraContributedEnv: args.extraContributedEnv ?? [],
      ...(args.onTerminalStarted === undefined
        ? {}
        : { onTerminalStarted: args.onTerminalStarted }),
      payload: args.payload,
      target: launchTarget,
      threadId: target.kind === "thread" ? target.threadId : null,
      title: initialTitleForTerminal(args.payload, existingSessionCount),
    });
  }

  private countExistingSessionsForTarget(target: TerminalCreateTarget): number {
    switch (target.kind) {
      case "thread": {
        const thread = requirePublicThread(this.options.db, target.threadId);
        return listTerminalSessions(this.options.db, {
          scope: { kind: "thread", threadId: thread.id },
          visible: false,
        }).length;
      }
      case "environment":
        return listTerminalSessions(this.options.db, {
          scope: {
            environmentId: target.environmentId,
            kind: "threadless-environment",
          },
          visible: false,
        }).length;
      case "host_path":
        return listTerminalSessions(this.options.db, {
          scope: { kind: "all" },
          visible: true,
        }).filter(
          (session) =>
            session.threadId === null &&
            session.environmentId === null &&
            session.hostId === target.hostId &&
            (target.cwd === null || session.initialCwd === target.cwd),
        ).length;
    }
  }

  private resolveThreadTerminalCreateTarget(
    threadId: string,
  ): TerminalLaunchTarget {
    const thread = requirePublicThread(this.options.db, threadId);
    if (!thread.environmentId) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }
    return { kind: "environment", environmentId: thread.environmentId };
  }

  private async createTerminalForTarget(
    args: CreateTerminalForTargetArgs,
  ): Promise<TerminalSession> {
    const launchTarget = this.resolveTerminalLaunchTarget(args.target);
    const daemonSession = requireConnectedHostSession(
      this.options,
      launchTarget.hostId,
    );
    const start = args.payload.start ?? DEFAULT_TERMINAL_START;
    const startingSession = createTerminalSession(this.options.db, {
      cols: args.payload.cols,
      daemonSessionId: daemonSession.id,
      environmentId: launchTarget.environmentId,
      hostId: launchTarget.hostId,
      initialCwd: launchTarget.initialCwd,
      rows: args.payload.rows,
      status: "starting",
      threadId: args.threadId,
      title: args.title,
    });
    const requestId = randomUUID();
    const openMessage: HostDaemonServerWsMessage = {
      type: "terminal.open",
      contributedEnv: mergeHostAndProviderEnvironment(
        await resolveHostEnvironment(this.options, {
          hostId: launchTarget.hostId,
          projectId:
            launchTarget.environmentId === null
              ? null
              : requireEnvironment(this.options.db, launchTarget.environmentId)
                  .projectId,
        }),
        args.extraContributedEnv,
      ),
      requestId,
      terminalId: startingSession.id,
      ...(args.threadId !== null ? { threadId: args.threadId } : {}),
      target: launchTarget.daemonTarget,
      ...(args.payload.cwd !== undefined ? { cwd: args.payload.cwd } : {}),
      cols: args.payload.cols,
      rows: args.payload.rows,
      start,
    };

    const pendingOpenKey = terminalRpcKey(
      daemonSession.id,
      startingSession.id,
      requestId,
    );
    const pendingOpen = this.pendingOpens.claim({
      daemonSessionId: daemonSession.id,
      requestId,
      rpcKey: pendingOpenKey,
      terminalId: startingSession.id,
    }).promise;
    const sent = this.options.hub.sendDaemonSessionMessage(
      daemonSession.id,
      openMessage,
    );
    if (!sent) {
      this.pendingOpens.cancel(pendingOpenKey);
      const exited = updateTerminalById(this.options.db, startingSession.id, {
        closeReason: "daemon-disconnect",
        exitCode: null,
        kind: "exit",
      });
      if (exited) {
        this.notifyTerminalSessionChanged(exited);
      }
      throw new ApiError(
        502,
        "host_disconnected",
        `Host is not connected for terminal ${exited?.id ?? startingSession.id}`,
      );
    }

    let opened: TerminalOpenedMessage;
    try {
      opened = await pendingOpen;
    } catch (error) {
      const code = error instanceof ApiError ? error.body.code : null;
      const fenced = isServerMoveSnapshotFenced(this.options.db);
      if (code === "terminal_open_timeout" || code === "server_moving") {
        if (!fenced) {
          const exited = updateTerminalById(
            this.options.db,
            startingSession.id,
            {
              closeReason: "open-timeout",
              exitCode: null,
              kind: "exit",
            },
          );
          if (exited) {
            this.notifyTerminalSessionChanged(exited);
          }
        }
        this.options.hub.sendDaemonSessionMessage(daemonSession.id, {
          type: "terminal.close",
          terminalId: startingSession.id,
          reason: "open-timeout",
        });
      } else if (!fenced && code !== "host_disconnected") {
        const exited = updateTerminalById(this.options.db, startingSession.id, {
          closeReason: "process-exit",
          exitCode: null,
          kind: "exit",
        });
        if (exited) {
          this.notifyTerminalSessionChanged(exited);
        }
      }
      throw error;
    }

    const runningSession = updateTerminalSession(this.options.db, {
      scope: {
        daemonSessionId: daemonSession.id,
        kind: "daemon",
        statuses: ["starting"],
        terminalId: startingSession.id,
      },
      update: {
        cols: opened.cols,
        daemonSessionId: daemonSession.id,
        initialCwd: opened.initialCwd,
        kind: "running",
        rows: opened.rows,
        title: args.payload.title ?? opened.title,
      },
    });
    if (!runningSession) {
      this.closeStaleOpenedTerminal({
        daemonSessionId: daemonSession.id,
        terminalId: startingSession.id,
      });
      throw new ApiError(
        409,
        "terminal_open_cancelled",
        "Terminal session was cancelled before it opened",
      );
    }
    args.onTerminalStarted?.(runningSession.id);
    this.notifyTerminalSessionChanged(runningSession);
    return this.toTerminalSession(runningSession);
  }

  private resolveTerminalLaunchTarget(
    target: TerminalLaunchTarget,
  ): ResolvedTerminalLaunchTarget {
    switch (target.kind) {
      case "environment": {
        const environment = requireReadyEnvironment(
          this.options.db,
          target.environmentId,
        );
        const workspaceTarget = requireWorkspaceCommandTarget(environment);
        return {
          daemonTarget: {
            kind: "workspace",
            environmentId: workspaceTarget.environmentId,
            workspaceContext: workspaceTarget.workspaceContext,
          },
          environmentId: environment.id,
          hostId: workspaceTarget.hostId,
          initialCwd: workspaceTarget.workspaceContext.workspacePath,
        };
      }
      case "host_path":
        assertUsableHostId(
          {
            config: this.options.config,
            db: this.options.db,
            hub: this.options.hub,
          },
          { hostId: target.hostId },
        );
        return {
          daemonTarget: {
            kind: "host_path",
            cwd: target.cwd,
          },
          environmentId: null,
          hostId: target.hostId,
          initialCwd: target.cwd ?? HOST_HOME_INITIAL_CWD,
        };
    }
  }

  renameTerminal(args: RenameTerminalArgs): TerminalSession {
    const renamed = updateTerminalById(this.options.db, args.terminalId, {
      kind: "title",
      title: args.payload.title,
    });
    if (!renamed) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    this.notifyTerminalSessionChanged(renamed);
    const session = this.toTerminalSession(renamed);
    this.options.hub.sendTerminalClientMessage(renamed.id, {
      type: "session-updated",
      session,
    });
    return session;
  }

  async restartTerminal(args: RestartTerminalArgs): Promise<TerminalSession> {
    const pending = this.pendingRestarts.claim({ rpcKey: args.terminalId });
    if (pending.created) {
      void this.restartTerminalOnce(args.terminalId).then(
        (session) => this.pendingRestarts.settle(args.terminalId, session),
        (error) =>
          this.pendingRestarts.fail(
            args.terminalId,
            error instanceof Error ? error : new Error(String(error)),
          ),
      );
    }
    return pending.promise;
  }

  private async restartTerminalOnce(
    terminalId: string,
  ): Promise<TerminalSession> {
    const current = getTerminalById(this.options.db, terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }

    const replacement = await this.createTerminal({
      payload: {
        cols: current.cols,
        rows: current.rows,
        start: { mode: "shell" },
        target: terminalRestartTarget(current),
        title: current.title,
      },
    });
    if (current.status === "exited") {
      return replacement;
    }

    try {
      await this.closeTerminalSession({
        current,
        payload: { mode: "force", reason: "user" },
      });
    } catch (error) {
      const replacementRow = getTerminalById(this.options.db, replacement.id);
      if (replacementRow) {
        void this.closeTerminalSession({
          current: replacementRow,
          payload: { mode: "force", reason: "user" },
        }).catch((cleanupError) => {
          this.options.logger.warn(
            {
              err:
                cleanupError instanceof Error
                  ? cleanupError
                  : new Error(String(cleanupError)),
              terminalId: replacement.id,
            },
            "Failed to clean up replacement terminal after restart failure",
          );
        });
      }
      throw error;
    }
    return replacement;
  }

  async closeTerminal(args: CloseTerminalArgs): Promise<TerminalSession> {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    return this.closeTerminalSession({
      current,
      payload: args.payload,
    });
  }

  private async closeTerminalSession(
    args: CloseTerminalSessionArgs,
  ): Promise<TerminalSession> {
    const current = args.current;
    if (current.status === "exited") {
      if (args.payload.reason === "user") {
        dismissRetainedTerminalOutput(
          this.options.db,
          current.id,
          current.hostId,
          Date.now(),
        );
      }
      if (
        current.closeReason === "daemon-disconnect" &&
        args.payload.reason === "user"
      ) {
        return this.toTerminalSession(
          updateTerminalById(this.options.db, current.id, {
            closeReason: "user",
            exitCode: current.exitCode,
            kind: "exit",
          }) ?? current,
        );
      }
      return this.toTerminalSession(current);
    }
    if (args.payload.mode === "if-clean" && current.lastUserInputAt !== null) {
      return this.toTerminalSession(current);
    }
    if (
      current.daemonSessionId === null ||
      (current.status !== "starting" && current.status !== "running")
    ) {
      return this.finishTerminalCloseWithoutDaemon({
        current,
        reason: args.payload.reason,
      });
    }

    const pending = this.pendingCloses.claim({
      closeReason: args.payload.reason,
      daemonSessionId: current.daemonSessionId,
      rpcKey: terminalRpcKey(current.daemonSessionId, current.id, current.id),
      terminalId: current.id,
    });
    if (pending.created) {
      const sent = this.options.hub.sendDaemonSessionMessage(
        current.daemonSessionId,
        {
          type: "terminal.close",
          terminalId: current.id,
          reason: args.payload.reason,
        },
      );
      if (!sent) {
        this.disconnectDaemonSessionTerminals({
          daemonSessionId: current.daemonSessionId,
        });
        this.rejectPendingClose(
          current.id,
          new ApiError(502, "host_disconnected", "Host is not connected"),
        );
      }
    }
    try {
      return this.toTerminalSession(await pending.promise);
    } catch (error) {
      const finalized = getTerminalById(this.options.db, current.id);
      if (
        finalized?.status === "exited" &&
        finalized.closeReason === args.payload.reason
      ) {
        return this.toTerminalSession(finalized);
      }
      throw error;
    }
  }

  private finishTerminalCloseWithoutDaemon(args: {
    current: TerminalSessionRow;
    reason: TerminalSessionCloseReason;
  }): TerminalSession {
    const closed = updateTerminalById(this.options.db, args.current.id, {
      closeReason: args.reason,
      exitCode: args.current.exitCode,
      kind: "exit",
    });
    const session = closed ?? args.current;
    this.notifyExitedTerminalSession({
      session,
      code: "terminal_closed",
      message: "Terminal session closed",
    });
    return this.toTerminalSession(session);
  }

  sendTerminalInput(args: SendTerminalInputArgs): TerminalSession {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    if (!isRunningBrowserTerminalSession(current)) {
      throw new ApiError(
        409,
        "terminal_not_running",
        "Terminal session is not running",
      );
    }

    const markedInput =
      current.lastUserInputAt === null
        ? updateTerminalById(this.options.db, current.id, {
            kind: "user-input",
          })
        : null;
    const session = markedInput ?? current;
    if (markedInput) {
      this.notifyTerminalSessionChanged(markedInput);
      this.options.hub.sendTerminalClientMessage(markedInput.id, {
        type: "session-updated",
        session: this.toTerminalSession(markedInput),
      });
    }

    for (const dataBase64 of splitTerminalInputFrames(
      args.payload.dataBase64,
    )) {
      const sent = this.options.hub.sendDaemonSessionMessage(
        current.daemonSessionId,
        {
          type: "terminal.input",
          terminalId: current.id,
          dataBase64,
        },
      );
      if (!sent) {
        this.disconnectDaemonSessionTerminals({
          daemonSessionId: current.daemonSessionId,
        });
        throw new ApiError(502, "host_disconnected", "Host is not connected");
      }
    }
    if (args.payload.dataBase64.length > 0)
      emitPluginTerminalInput(this.toTerminalSession(session));
    return this.toTerminalSession(session);
  }

  resizeTerminal(args: ResizeTerminalArgs): TerminalSession {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    if (!isRunningBrowserTerminalSession(current)) {
      throw new ApiError(
        409,
        "terminal_not_running",
        "Terminal session is not running",
      );
    }

    const resized =
      current.cols === args.payload.cols && current.rows === args.payload.rows
        ? current
        : updateTerminalById(this.options.db, current.id, {
            cols: args.payload.cols,
            kind: "size",
            rows: args.payload.rows,
          });
    const session = resized ?? current;
    if (resized && resized !== current) {
      this.notifyTerminalSessionChanged(resized);
      this.options.hub.sendTerminalClientMessage(resized.id, {
        type: "session-updated",
        session: this.toTerminalSession(resized),
      });
    }

    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.resize",
        terminalId: current.id,
        cols: args.payload.cols,
        rows: args.payload.rows,
      },
    );
    if (!sent) {
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
      throw new ApiError(502, "host_disconnected", "Host is not connected");
    }
    return this.toTerminalSession(session);
  }

  async readTerminalOutput(
    args: ReadTerminalOutputArgs,
  ): Promise<TerminalOutputResponse> {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    if (isRunningBrowserTerminalSession(current)) {
      return this.readRunningTerminalOutput({
        query: args.query,
        session: current,
      });
    }
    if (current.status !== "exited") {
      throw new ApiError(
        409,
        "terminal_output_unavailable",
        TERMINAL_OUTPUT_NOT_RUNNING_MESSAGE,
      );
    }
    const retained = this.getRetainedOutput(current);
    if (retained === null) {
      throw new ApiError(
        409,
        "terminal_output_unavailable",
        TERMINAL_OUTPUT_DISCARDED_MESSAGE,
      );
    }
    return this.formatRetainedOutput({
      query: args.query,
      session: current,
      chunks: retained,
    });
  }

  private getRetainedOutput(
    session: TerminalSessionRow,
  ): TerminalOutputChunk[] | null {
    return getRetainedTerminalOutput(this.options.db, {
      hostId: session.hostId,
      terminalSessionId: session.id,
      now: Date.now(),
    });
  }

  private formatRetainedOutput(args: {
    chunks: TerminalOutputChunk[];
    query: TerminalOutputQuery;
    session: TerminalSessionRow;
  }): TerminalOutputResponse {
    const chunks = args.chunks;
    const nextSeq = (chunks.at(-1)?.seq ?? -1) + 1;
    const bounded = applyTerminalOutputBounds({
      chunks,
      query: args.query,
      replayNextSeq: nextSeq,
      requestedSinceSeq: args.query.sinceSeq ?? 0,
    });
    const lineBounded =
      args.query.lines === undefined
        ? bounded
        : terminalOutputLastLines(bounded, args.query.lines);
    return {
      chunks: lineBounded.chunks,
      nextSeq,
      truncated: bounded.truncated || lineBounded.truncated,
      status: args.session.status,
      exitCode: args.session.exitCode,
      closeReason: args.session.closeReason,
    };
  }

  private retainTerminalOutput(
    session: TerminalSessionRow,
    chunk: TerminalOutputChunk,
  ): void {
    appendRetainedTerminalOutputChunk(this.options.db, {
      hostId: session.hostId,
      terminalSessionId: session.id,
      chunk,
      now: Date.now(),
    });
  }

  private async readRunningTerminalOutput(
    args: ReadRunningTerminalOutputArgs,
  ): Promise<TerminalOutputResponse> {
    try {
      return await this.requestTerminalOutputReplay({
        daemonSessionId: args.session.daemonSessionId,
        query: args.query,
        session: args.session,
      });
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.body.code !== "terminal_exited"
      ) {
        throw error;
      }
      const exited = getTerminalById(this.options.db, args.session.id);
      if (exited?.status !== "exited") {
        throw error;
      }
      return this.readExitedTerminalOutput({
        query: args.query,
        session: exited,
      });
    }
  }

  private async readExitedTerminalOutput(
    args: ReadExitedTerminalOutputArgs,
  ): Promise<TerminalOutputResponse> {
    const retained = this.getRetainedOutput(args.session);
    if (retained === null) {
      throw new ApiError(
        409,
        "terminal_output_unavailable",
        TERMINAL_OUTPUT_DISCARDED_MESSAGE,
      );
    }
    return this.formatRetainedOutput({
      chunks: retained,
      query: args.query,
      session: args.session,
    });
  }

  private async requestTerminalOutputReplay(
    args: RequestTerminalOutputReplayArgs,
  ): Promise<TerminalOutputResponse> {
    const requestId = randomUUID();
    const pendingReplayKey = terminalRpcKey(
      args.daemonSessionId,
      args.session.id,
      requestId,
    );
    const pendingReplay = this.pendingOutputReads.claim({
      daemonSessionId: args.daemonSessionId,
      requestId,
      rpcKey: pendingReplayKey,
      terminalId: args.session.id,
    }).promise;
    const sent = this.options.hub.sendDaemonSessionMessage(
      args.daemonSessionId,
      {
        type: "terminal.attach",
        requestId,
        terminalId: args.session.id,
        sinceSeq: args.query.sinceSeq ?? 0,
        tailBytes: args.query.tailBytes ?? TERMINAL_SCROLLBACK_MAX_BYTES,
      },
    );
    if (!sent) {
      this.pendingOutputReads.cancel(pendingReplayKey);
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: args.daemonSessionId,
      });
      throw new ApiError(502, "host_disconnected", "Host is not connected");
    }

    const requestedSinceSeq = args.query.sinceSeq ?? 0;
    const replay = await pendingReplay;
    const bounded = applyTerminalOutputBounds({
      chunks: replay.chunks.map(toTerminalOutputChunk),
      query: args.query,
      replayNextSeq: replay.nextSeq,
      requestedSinceSeq,
    });
    const output = {
      chunks: bounded.chunks,
      nextSeq: replay.nextSeq,
      truncated: bounded.truncated,
      status: args.session.status,
      exitCode: args.session.exitCode,
      closeReason: args.session.closeReason,
    };
    if (args.query.lines === undefined) return output;
    const lineBounded = terminalOutputLastLines(output, args.query.lines);
    return {
      ...output,
      chunks: lineBounded.chunks,
      truncated: output.truncated || lineBounded.truncated,
    };
  }

  closeDeletedThreadTerminals(args: CloseDeletedThreadTerminalsArgs): void {
    this.closeThreadTerminalsForLifecycle({
      threadId: args.threadId,
      closeReason: "thread-deleted",
      message: "Terminal session closed because the thread was deleted",
    });
  }

  closeArchivedThreadTerminals(args: CloseArchivedThreadTerminalsArgs): void {
    this.closeThreadTerminalsForLifecycle({
      threadId: args.threadId,
      closeReason: "thread-archived",
      message: "Terminal session closed because the thread was archived",
    });
  }

  closeDestroyedEnvironmentTerminals(
    args: CloseDestroyedEnvironmentTerminalsArgs,
  ): void {
    const currentSessions = listTerminalSessions(this.options.db, {
      scope: { environmentId: args.environmentId, kind: "environment" },
      visible: false,
    });
    this.requestTerminalCloses({
      closeReason: "environment-destroyed",
      sessions: currentSessions,
    });
    const exitedSessions = updateTerminalSessions(this.options.db, {
      scope: {
        environmentId: args.environmentId,
        kind: "environment",
        statuses: NON_TERMINAL_SESSION_STATUSES,
      },
      update: { closeReason: "environment-destroyed", kind: "exit" },
    });
    this.publishLifecycleTerminalExitsForSessions({
      currentSessions,
      exitedSessions,
      message: "Terminal session closed because the environment was destroyed",
    });
  }

  closeRemovedHostTerminals(args: CloseRemovedHostTerminalsArgs): void {
    const currentSessions = listTerminalSessions(this.options.db, {
      scope: { hostId: args.hostId, kind: "host" },
      visible: false,
    });
    const exitedSessions = updateTerminalSessions(this.options.db, {
      scope: {
        hostId: args.hostId,
        kind: "host",
        statuses: NON_TERMINAL_SESSION_STATUSES,
      },
      update: { closeReason: "host-removed", kind: "exit" },
    });
    this.publishLifecycleTerminalExitsForSessions({
      currentSessions,
      exitedSessions,
      message: "Terminal session closed because the machine was removed",
    });
  }

  reconcileDisconnectedHostTerminals(
    args: ReconcileDisconnectedHostTerminalsArgs,
  ): void {
    const openedInstanceId =
      getSessionById(this.options.db, { sessionId: args.daemonSessionId })
        ?.instanceId ?? null;
    const disconnected = listTerminalSessions(this.options.db, {
      scope: { hostId: args.hostId, kind: "host", statuses: ["disconnected"] },
      visible: false,
    });
    for (const session of disconnected) {
      const ownerInstanceId =
        session.daemonSessionId === null
          ? null
          : (getSessionById(this.options.db, {
              sessionId: session.daemonSessionId,
            })?.instanceId ?? null);
      if (openedInstanceId === null || ownerInstanceId !== openedInstanceId) {
        continue;
      }
      const reconnected = updateTerminalSession(this.options.db, {
        scope: {
          kind: "terminal",
          statuses: ["disconnected"],
          terminalId: session.id,
        },
        update: { daemonSessionId: args.daemonSessionId, kind: "reconnect" },
      });
      if (!reconnected) {
        continue;
      }
      this.options.logger.info(
        { terminalId: reconnected.id, sessionId: args.daemonSessionId },
        "Terminal session reattached to reconnected daemon",
      );
      this.notifyTerminalSessionChanged(reconnected);
      this.options.hub.sendTerminalClientMessage(reconnected.id, {
        type: "session-updated",
        session: this.toTerminalSession(reconnected),
      });
      this.requestTerminalCatchUp({
        daemonSessionId: args.daemonSessionId,
        terminalId: reconnected.id,
      });
    }

    const exitedSessions = updateTerminalSessions(this.options.db, {
      scope: {
        hostId: args.hostId,
        kind: "host",
        statuses: ["disconnected"],
      },
      update: { closeReason: "daemon-disconnect", kind: "exit" },
    });
    for (const session of exitedSessions) {
      this.options.hub.sendDaemonSessionMessage(args.daemonSessionId, {
        type: "terminal.close",
        terminalId: session.id,
        reason: "daemon-disconnect",
      });
      this.notifyExitedTerminalSession({
        session,
        code: "host_disconnected",
        message: "Host disconnected from terminal session",
      });
    }
  }

  resolveRunningTerminalRoute(
    terminalId: string,
  ): { daemonSessionId: string; terminalId: string } | null {
    const current = getTerminalById(this.options.db, terminalId);
    if (
      !current ||
      current.status !== "running" ||
      current.daemonSessionId === null
    ) {
      return null;
    }
    return { daemonSessionId: current.daemonSessionId, terminalId: current.id };
  }

  markDirectOutputSocket(socket: TerminalClientSocket): void {
    this.directOutputSockets.add(socket);
  }

  setDaemonSessionDirectOutput(args: {
    daemonSessionId: string;
    enabled: boolean;
  }): void {
    const enabled = this.directOutputSessionIds.has(args.daemonSessionId);
    if (enabled === args.enabled) {
      return;
    }
    if (args.enabled) {
      this.directOutputSessionIds.add(args.daemonSessionId);
    } else {
      this.directOutputSessionIds.delete(args.daemonSessionId);
    }
    this.closeDaemonSessionBrowserTerminals({
      code: 1013,
      daemonSessionId: args.daemonSessionId,
      reason: "terminal-output-path-changed",
    });
  }

  recordDirectTerminalOutputBatch(args: {
    chunks: TerminalOutputChunk[];
    daemonSessionId: string;
    terminalId: string;
  }): void {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (
      !current ||
      (current.status !== "running" && current.status !== "exited") ||
      (current.status === "running" &&
        current.daemonSessionId !== args.daemonSessionId) ||
      (current.status === "exited" &&
        (current.daemonSessionId !== args.daemonSessionId ||
          !this.directOutputSessionIds.has(args.daemonSessionId)))
    ) {
      return;
    }
    for (const chunk of args.chunks) {
      if (current.status === "running") {
        this.outputFlow.recordOutput(
          args.terminalId,
          args.daemonSessionId,
          chunk.seq,
        );
      }
      this.retainTerminalOutput(current, chunk);
    }
    if (current.status === "exited") {
      markRetainedTerminalOutputExited(
        this.options.db,
        current.id,
        current.hostId,
        Date.now(),
      );
    }
  }

  private closeDaemonSessionBrowserTerminals(args: {
    code: number;
    daemonSessionId: string;
    reason: string;
  }): void {
    const sessions = listTerminalSessions(this.options.db, {
      scope: { daemonSessionId: args.daemonSessionId, kind: "daemon" },
      visible: true,
    });
    for (const session of sessions) {
      const closed = this.options.hub.closeTerminalClients(
        session.id,
        args.code,
        args.reason,
      );
      for (const socket of closed) {
        this.outputFlow.removeClient(session.id, socket);
      }
    }
  }

  recordDirectTerminalInput(terminalId: string): void {
    const current = getTerminalById(this.options.db, terminalId);
    if (current?.status !== "running") {
      return;
    }
    const markedInput =
      current.lastUserInputAt === null
        ? updateTerminalById(this.options.db, current.id, {
            kind: "user-input",
          })
        : null;
    if (markedInput) {
      this.notifyTerminalSessionChanged(markedInput);
      this.options.hub.sendTerminalClientMessage(markedInput.id, {
        type: "session-updated",
        session: this.toTerminalSession(markedInput),
      });
    }
    emitPluginTerminalInput(this.toTerminalSession(markedInput ?? current));
  }

  attachBrowserTerminal(args: AttachBrowserTerminalArgs): void {
    if (args.outputAcks) {
      this.outputAckSocketVisibility.set(args.socket, true);
    }
    if (args.resizeAcks) {
      this.resizeAckSockets.add(args.socket);
      this.options.hub.sendTerminalSocketMessage(args.socket, {
        type: "features",
        resizeAcks: true,
      });
    }
    const current = this.getBrowserTerminalSession({
      ...args,
      reportMissing: false,
    });
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }

    const session = this.toTerminalSession(current);
    if (current.status === "disconnected") {
      this.holdBrowserTerminalForReattach({
        session,
        sinceSeq: args.sinceSeq,
        socket: args.socket,
      });
      return;
    }
    if (current.status !== "running" || current.daemonSessionId === null) {
      this.options.hub.sendTerminalSocketMessage(args.socket, {
        type: "attached",
        session,
        replayStartSeq: 0,
        nextSeq: 0,
      });
      if (current.status === "exited") {
        this.options.hub.sendTerminalSocketMessage(args.socket, {
          type: "exited",
          session,
        });
      } else {
        this.sendTerminalSocketError({
          socket: args.socket,
          code: "terminal_not_running",
          message: "Terminal session is not running",
        });
      }
      return;
    }

    const requestId = randomUUID();
    const pendingAttach: PendingTerminalAttachKey = {
      daemonSessionId: current.daemonSessionId,
      requestId,
      rpcKey: terminalRpcKey(current.daemonSessionId, current.id, requestId),
      socket: args.socket,
      terminalId: current.id,
    };
    void this.pendingAttaches
      .claim(pendingAttach)
      .promise.catch(() => undefined);
    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.attach",
        requestId,
        terminalId: current.id,
        sinceSeq: args.sinceSeq,
        tailBytes: TERMINAL_SCROLLBACK_MAX_BYTES,
      },
    );
    if (!sent) {
      this.pendingAttaches.cancel(pendingAttach.rpcKey);
      this.holdBrowserTerminalForReattach({
        session,
        sinceSeq: args.sinceSeq,
        socket: args.socket,
      });
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
    }
  }

  private holdBrowserTerminalForReattach(args: {
    session: TerminalSession;
    sinceSeq: number;
    socket: TerminalClientSocket;
  }): void {
    this.options.hub.registerTerminalClient(args.session.id, args.socket);
    this.addOutputFlowClient(args.session.id, args.socket, args.sinceSeq);
    this.forwardedNextSeqByTerminalId.set(
      args.session.id,
      Math.max(
        this.forwardedNextSeqByTerminalId.get(args.session.id) ?? 0,
        args.sinceSeq,
      ),
    );
    this.options.hub.sendTerminalSocketMessage(args.socket, {
      type: "attached",
      session: args.session,
      replayStartSeq: args.sinceSeq,
      nextSeq: args.sinceSeq,
    });
  }

  detachBrowserTerminal(args: DetachBrowserTerminalArgs): void {
    this.options.hub.unregisterTerminalClient(args.terminalId, args.socket);
    this.outputFlow.removeClient(args.terminalId, args.socket);
    this.pendingAttaches.failAllMatching(
      (pending) =>
        pending.terminalId === args.terminalId &&
        pending.socket === args.socket,
      TERMINAL_ATTACH_CANCELLED,
    );
    this.applySharedTerminalSize({
      socket: null,
      terminalId: args.terminalId,
    });
  }

  sharedBrowserTerminalSize(
    terminalId: string,
  ): { cols: number; rows: number } | null {
    return this.options.hub.terminalSharedSize(terminalId, Date.now());
  }

  handleBrowserTerminalMessage(args: HandleBrowserTerminalMessageArgs): void {
    switch (args.message.type) {
      case "ping":
        this.options.hub.sendTerminalSocketMessage(args.socket, {
          type: "pong",
        });
        this.options.hub.recordTerminalClientHeartbeat(
          args.terminalId,
          args.socket,
          Date.now(),
        );
        this.applySharedTerminalSize(args);
        return;
      case "input":
        this.forwardBrowserTerminalInput(args);
        return;
      case "resize":
        this.resizeBrowserTerminal(args);
        return;
      case "ack":
        this.outputFlow.acknowledge(
          args.terminalId,
          args.socket,
          args.message.nextSeq,
        );
        return;
      case "visibility":
        if (args.message.visible) {
          this.clearTerminalAttention(args.terminalId);
        }
        if (this.outputAckSocketVisibility.has(args.socket)) {
          this.outputAckSocketVisibility.set(args.socket, args.message.visible);
        }
        this.outputFlow.setVisible(
          args.terminalId,
          args.socket,
          args.message.visible,
        );
        this.options.hub.recordTerminalClientVisibility(
          args.terminalId,
          args.socket,
          args.message.visible,
          Date.now(),
        );
        this.applySharedTerminalSize(args);
        return;
    }
  }

  refuseDaemonTerminalOpen(args: RefuseDaemonTerminalOpenArgs): void {
    this.pendingOpens.fail(
      terminalResponseRpcKey(args.sessionId, args.message),
      serverMovingError(),
    );
  }

  handleDaemonTerminalMessage(args: HandleDaemonTerminalMessageArgs): void {
    switch (args.message.type) {
      case "heartbeat":
        return;
      case "terminal.attention": {
        const session = getTerminalById(
          this.options.db,
          args.message.terminalId,
        );
        if (
          session?.daemonSessionId !== args.sessionId ||
          session.status !== "running"
        ) {
          return;
        }
        this.recordTerminalAttention({
          source: "daemon",
          terminalId: session.id,
          seq: args.message.seq,
          kind: args.message.kind,
          ...(args.message.title === undefined
            ? {}
            : { title: args.message.title }),
          ...(args.message.body === undefined
            ? {}
            : { body: args.message.body }),
        });
        return;
      }
      case "terminal.opened":
        this.pendingOpens.settle(
          terminalResponseRpcKey(args.sessionId, args.message),
          args.message,
        );
        return;
      case "terminal.error":
        const rpcKey = terminalResponseRpcKey(args.sessionId, args.message);
        this.pendingOpens.fail(
          rpcKey,
          new ApiError(
            502,
            args.message.code,
            `Terminal failed to open: ${args.message.message}`,
          ),
        );
        this.pendingAttaches.fail(
          rpcKey,
          new ApiError(502, args.message.code, args.message.message),
        );
        this.pendingOutputReads.fail(
          rpcKey,
          new ApiError(
            502,
            args.message.code,
            `Terminal output read failed: ${args.message.message}`,
          ),
        );
        return;
      case "terminal.exited":
        this.nativeTerminalRepaintsOnAttach.delete(args.message.terminalId);
        const current = getTerminalById(
          this.options.db,
          args.message.terminalId,
        );
        if (
          !current ||
          current.hostId !== args.hostId ||
          current.daemonSessionId !== args.sessionId
        ) {
          if (current) {
            this.options.logger.warn(
              {
                hostId: args.hostId,
                ownerHostId: current.hostId,
                terminalId: current.id,
              },
              "Ignoring terminal exit from a non-owner host",
            );
          }
          return;
        }
        if (
          current.status === "running" &&
          this.directOutputSessionIds.has(args.sessionId)
        ) {
          void this.requestTerminalOutputReplay({
            daemonSessionId: args.sessionId,
            query: { sinceSeq: 0, tailBytes: TERMINAL_SCROLLBACK_MAX_BYTES },
            session: current,
          })
            .catch((error: unknown) => {
              this.options.logger.warn(
                { err: error, terminalId: current.id },
                "Final terminal output replay failed after exit",
          );
            })
            .finally(() => this.finalizeTerminalExit(args));
          return;
        }
        this.finalizeTerminalExit(args);
        return;
      case "terminal.output": {
        const current = getTerminalById(
          this.options.db,
          args.message.terminalId,
        );
        if (
          !current ||
          current.hostId !== args.hostId ||
          current.daemonSessionId !== args.sessionId
        ) {
          if (current) {
            this.options.logger.warn(
              {
                hostId: args.hostId,
                ownerHostId: current.hostId,
                terminalId: current.id,
              },
              "Ignoring terminal output from a non-owner host",
            );
          }
          return;
        }
        this.outputFlow.recordOutput(
          args.message.terminalId,
          args.sessionId,
          args.message.chunk.seq,
        );
        if (
          current.status !== "running" ||
          this.catchingUpTerminalIds.has(current.id)
        ) {
          return;
        }
        this.retainTerminalOutput(
          current,
          toTerminalOutputChunk(args.message.chunk),
        );
        this.forwardTerminalOutput(current.id, args.message.chunk);
        return;
      }
      case "terminal.replay":
        {
          const current = getTerminalById(
            this.options.db,
            args.message.terminalId,
          );
          if (
            current &&
            (current.hostId !== args.hostId ||
              current.daemonSessionId !== args.sessionId)
          ) {
            this.options.logger.warn(
              {
                hostId: args.hostId,
                ownerHostId: current.hostId,
                terminalId: current.id,
              },
              "Ignoring terminal replay from a non-owner host",
            );
            return;
          }
          if (current) {
            for (const chunk of args.message.chunks) {
              this.retainTerminalOutput(current, toTerminalOutputChunk(chunk));
            }
            if (current.status === "exited") {
              markRetainedTerminalOutputExited(
                this.options.db,
                current.id,
                current.hostId,
                Date.now(),
              );
            }
          }
        }
        this.pendingAttaches.settle(
          terminalResponseRpcKey(args.sessionId, args.message),
          args.message,
        );
        this.pendingOutputReads.settle(
          terminalResponseRpcKey(args.sessionId, args.message),
          args.message,
        );
        this.pendingCatchUps.settle(
          terminalResponseRpcKey(args.sessionId, args.message),
          args.message,
        );
        return;
    }
  }

  private finalizeTerminalExit(args: HandleDaemonTerminalMessageArgs): void {
    if (args.message.type !== "terminal.exited") {
      return;
    }
    const exited = updateTerminalSession(this.options.db, {
      scope: {
        daemonSessionId: args.sessionId,
        kind: "daemon",
        terminalId: args.message.terminalId,
      },
      update: {
        closeReason: args.message.closeReason,
        exitCode: args.message.exitCode,
        kind: "exit",
        retainDaemonSession: this.directOutputSessionIds.has(args.sessionId),
      },
    });
    if (!exited) {
      return;
    }
    this.forwardedNextSeqByTerminalId.delete(exited.id);
    this.outputFlow.forgetTerminal(exited.id);
    markRetainedTerminalOutputExited(
      this.options.db,
      exited.id,
      exited.hostId,
      Date.now(),
    );
    this.pendingCloses.settle(
      terminalRpcKey(args.sessionId, exited.id, exited.id),
      exited,
    );
    this.notifyTerminalSessionChanged(exited);
    const session = this.toTerminalSession(exited);
    this.options.hub.sendTerminalClientMessage(exited.id, {
      type: "exited",
      session,
    });
    this.rejectPendingAttachesForTerminal({
      terminalId: exited.id,
      code: "terminal_exited",
      message: "Terminal session exited",
    });
    this.rejectPendingOutputReadsForTerminal({
      terminalId: exited.id,
      code: "terminal_exited",
      message: "Terminal session exited",
    });
  }

  handleDaemonSessionClosed(args: HandleDaemonSessionClosedArgs): void {
    this.disconnectDaemonSessionTerminals({ daemonSessionId: args.sessionId });
  }

  private closeThreadTerminalsForLifecycle(
    args: CloseThreadTerminalsForLifecycleArgs,
  ): void {
    const currentSessions = listTerminalSessions(this.options.db, {
      scope: { kind: "thread", threadId: args.threadId },
      visible: false,
    });
    this.requestTerminalCloses({
      closeReason: args.closeReason,
      sessions: currentSessions,
    });
    const exitedSessions = updateTerminalSessions(this.options.db, {
      scope: {
        kind: "thread",
        statuses: NON_TERMINAL_SESSION_STATUSES,
        threadId: args.threadId,
      },
      update: { closeReason: args.closeReason, kind: "exit" },
    });
    this.publishLifecycleTerminalExitsForSessions({
      currentSessions,
      exitedSessions,
      message: args.message,
    });
  }

  private publishLifecycleTerminalExitsForSessions(
    args: PublishLifecycleTerminalExitsForSessionsArgs,
  ): void {
    this.publishLifecycleTerminalExits({
      code: "terminal_closed",
      message: args.message,
      previousSessionsById: new Map(
        args.currentSessions.map((session) => [session.id, session]),
      ),
      sessions: args.exitedSessions,
    });
  }

  private requestTerminalCloses(args: RequestTerminalClosesArgs): void {
    for (const session of args.sessions) {
      const target = getTerminalDaemonCloseTarget(session);
      if (!target) {
        continue;
      }
      this.options.hub.sendDaemonSessionMessage(target.daemonSessionId, {
        type: "terminal.close",
        terminalId: target.terminalId,
        reason: args.closeReason,
      });
    }
  }

  private closeStaleOpenedTerminal(args: CloseStaleOpenedTerminalArgs): void {
    const current = getTerminalById(this.options.db, args.terminalId);
    this.options.hub.sendDaemonSessionMessage(args.daemonSessionId, {
      type: "terminal.close",
      terminalId: args.terminalId,
      reason:
        current?.closeReason === undefined ||
        current.closeReason === null ||
        current.closeReason === "host-removed"
          ? "daemon-disconnect"
          : current.closeReason,
    });
  }

  private publishLifecycleTerminalExits(
    args: PublishLifecycleTerminalExitsArgs,
  ): void {
    for (const session of args.sessions) {
      const previousSession = args.previousSessionsById.get(session.id);
      if (previousSession?.daemonSessionId) {
        this.rejectPendingOpenForTerminal({
          daemonSessionId: previousSession.daemonSessionId,
          terminalId: session.id,
          status: 409,
          code: args.code,
          message: args.message,
        });
      }
      this.notifyExitedTerminalSession({
        session,
        code: args.code,
        message: args.message,
      });
    }
  }

  private notifyExitedTerminalSession(
    args: NotifyExitedTerminalSessionArgs,
  ): void {
    markRetainedTerminalOutputExited(
      this.options.db,
      args.session.id,
      args.session.hostId,
      Date.now(),
    );
    this.forwardedNextSeqByTerminalId.delete(args.session.id);
    this.outputFlow.forgetTerminal(args.session.id);
    this.notifyTerminalSessionChanged(args.session);
    this.options.hub.sendTerminalClientMessage(args.session.id, {
      type: "exited",
      session: this.toTerminalSession(args.session),
    });
    this.rejectPendingAttachesForTerminal({
      terminalId: args.session.id,
      code: args.code,
      message: args.message,
    });
    this.rejectPendingOutputReadsForTerminal({
      terminalId: args.session.id,
      code: args.code,
      message: args.message,
    });
  }

  private forwardBrowserTerminalInput(
    args: HandleBrowserTerminalMessageArgs,
  ): void {
    if (args.message.type !== "input") {
      return;
    }
    const current = this.getRunningBrowserTerminal(args);
    if (!current) {
      return;
    }
    this.options.hub.recordTerminalClientSeen(
      current.id,
      args.socket,
      Date.now(),
    );
    this.applySharedTerminalSize(args);
    const markedInput =
      current.lastUserInputAt === null
        ? updateTerminalById(this.options.db, current.id, {
            kind: "user-input",
          })
        : null;
    if (markedInput) {
      const session = this.toTerminalSession(markedInput);
      this.notifyTerminalSessionChanged(markedInput);
      this.options.hub.sendTerminalClientMessage(markedInput.id, {
        type: "session-updated",
        session,
      });
    }
    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.input",
        terminalId: current.id,
        dataBase64: args.message.dataBase64,
      },
    );
    if (!sent) {
      this.sendTerminalSocketError({
        socket: args.socket,
        code: "host_disconnected",
        message: "Host is not connected",
      });
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
    } else if (args.message.dataBase64.length > 0) {
      emitPluginTerminalInput(this.toTerminalSession(markedInput ?? current));
    }
  }

  private resizeBrowserTerminal(args: HandleBrowserTerminalMessageArgs): void {
    if (args.message.type !== "resize") {
      return;
    }
    this.options.hub.recordTerminalClientSize(
      args.terminalId,
      args.socket,
      { cols: args.message.cols, rows: args.message.rows },
      Date.now(),
    );
    this.applySharedTerminalSize(args);
    if (
      args.message.seq !== undefined &&
      this.resizeAckSockets.has(args.socket)
    ) {
      this.options.hub.sendTerminalSocketMessage(args.socket, {
        type: "resize-applied",
        seq: args.message.seq,
      });
    }
  }

  private applySharedTerminalSize(args: {
    socket: TerminalClientSocket | null;
    terminalId: string;
  }): void {
    const size = this.options.hub.terminalSharedSize(
      args.terminalId,
      Date.now(),
    );
    if (size === null) {
      return;
    }
    const current = getTerminalById(this.options.db, args.terminalId);
    if (
      !current ||
      !isRunningBrowserTerminalSession(current) ||
      (current.cols === size.cols && current.rows === size.rows)
    ) {
      return;
    }
    this.resizeRunningBrowserTerminal(args.socket, current, size);
  }

  private resizeRunningBrowserTerminal(
    socket: TerminalClientSocket | null,
    current: RunningBrowserTerminalSession,
    size: { cols: number; rows: number },
  ): void {
    if (current.cols !== size.cols || current.rows !== size.rows) {
      const resized = updateTerminalById(this.options.db, current.id, {
        cols: size.cols,
        kind: "size",
        rows: size.rows,
      });
      if (resized) {
        const session = this.toTerminalSession(resized);
        this.notifyTerminalSessionChanged(resized);
        this.options.hub.sendTerminalClientMessage(resized.id, {
          type: "session-updated",
          session,
        });
      }
    }
    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.resize",
        terminalId: current.id,
        cols: size.cols,
        rows: size.rows,
      },
    );
    if (!sent) {
      if (socket !== null) {
        this.sendTerminalSocketError({
          socket,
          code: "host_disconnected",
          message: "Host is not connected",
        });
      }
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
    }
  }

  private getRunningBrowserTerminal(
    args: GetRunningBrowserTerminalArgs,
  ): RunningBrowserTerminalSession | null {
    const current = this.getBrowserTerminalSession(args);
    if (!current) {
      return null;
    }
    if (!isRunningBrowserTerminalSession(current)) {
      if (current.status !== "disconnected") {
        this.sendTerminalSocketError({
          socket: args.socket,
          code: "terminal_not_running",
          message: "Terminal session is not running",
        });
      }
      return null;
    }
    return current;
  }

  private getBrowserTerminalSession(
    args: GetBrowserTerminalSessionArgs,
  ): TerminalSessionRow | null {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      if (args.reportMissing !== false) {
        this.sendTerminalSocketError({
          socket: args.socket,
          code: "terminal_not_found",
          message: "Terminal session not found",
        });
      }
      return null;
    }
    return current;
  }

  private disconnectDaemonSessionTerminals(
    args: DisconnectDaemonSessionTerminalsArgs,
  ): void {
    const disconnected = [
      ...updateTerminalSessions(this.options.db, {
        scope: {
          daemonSessionId: args.daemonSessionId,
          kind: "daemon",
          statuses: ["running"],
        },
        update: { kind: "disconnect", retainDaemonSession: true },
      }),
      ...updateTerminalSessions(this.options.db, {
        scope: {
          daemonSessionId: args.daemonSessionId,
          kind: "daemon",
          statuses: ["starting"],
        },
        update: { kind: "disconnect", retainDaemonSession: false },
      }),
    ];
    this.pendingCatchUps.failAllMatching(
      (pending) => pending.daemonSessionId === args.daemonSessionId,
      new ApiError(502, "host_disconnected", "Host is not connected"),
    );
    for (const session of disconnected) {
      this.rejectPendingClose(
        session.id,
        new ApiError(
          502,
          "host_disconnected",
          "Host disconnected while closing terminal session",
        ),
      );
      this.rejectPendingOpenForTerminal({
        daemonSessionId: args.daemonSessionId,
        terminalId: session.id,
        status: 502,
        code: "host_disconnected",
        message: "Host disconnected while opening terminal session",
      });
      this.rejectPendingAttachesForTerminal({
        terminalId: session.id,
        code: "host_disconnected",
        message: "Host disconnected from terminal session",
      });
      this.rejectPendingOutputReadsForTerminal({
        terminalId: session.id,
        code: "host_disconnected",
        message: "Host disconnected from terminal session",
      });
      this.options.logger.info(
        { terminalId: session.id, sessionId: args.daemonSessionId },
        "Terminal session disconnected with daemon session",
      );
      this.notifyTerminalSessionChanged(session);
      this.options.hub.sendTerminalClientMessage(session.id, {
        type: "session-updated",
        session: this.toTerminalSession(session),
      });
    }
  }

  private finalizeTimedOutTerminalClose(
    pending: PendingTerminalCloseKey,
    error: Error,
  ): void {
    if (
      !(error instanceof ApiError) ||
      error.body.code !== "terminal_close_timeout"
    ) {
      return;
    }
    const exited = updateTerminalSession(this.options.db, {
      scope: {
        daemonSessionId: pending.daemonSessionId,
        kind: "daemon",
        statuses: DAEMON_OWNED_TERMINAL_STATUSES,
        terminalId: pending.terminalId,
      },
      update: {
        closeReason: pending.closeReason,
        exitCode: null,
        kind: "exit",
      },
    });
    if (!exited) {
      return;
    }

    this.options.logger.warn(
      {
        err: error,
        sessionId: pending.daemonSessionId,
        terminalId: pending.terminalId,
      },
      "Finalized terminal after close acknowledgement timed out",
    );
    this.notifyExitedTerminalSession({
      code: error.body.code,
      message: error.body.message,
      session: exited,
    });
  }

  private rejectPendingClose(terminalId: string, error: Error): void {
    this.pendingCloses.failAllMatching(
      (pending) => pending.terminalId === terminalId,
      error,
    );
  }

  private requestTerminalCatchUp(args: {
    daemonSessionId: string;
    terminalId: string;
  }): void {
    const sinceSeq = this.forwardedNextSeqByTerminalId.get(args.terminalId);
    if (
      sinceSeq === undefined ||
      !this.options.hub.hasTerminalClients(args.terminalId)
    ) {
      return;
    }
    const requestId = randomUUID();
    const pending: PendingTerminalRpcKey = {
      daemonSessionId: args.daemonSessionId,
      requestId,
      rpcKey: terminalRpcKey(args.daemonSessionId, args.terminalId, requestId),
      terminalId: args.terminalId,
    };
    this.catchingUpTerminalIds.add(args.terminalId);
    void this.pendingCatchUps.claim(pending).promise.catch(() => undefined);
    const sent = this.options.hub.sendDaemonSessionMessage(
      args.daemonSessionId,
      {
        type: "terminal.attach",
        requestId,
        terminalId: args.terminalId,
        sinceSeq,
        tailBytes: TERMINAL_SCROLLBACK_MAX_BYTES,
      },
    );
    if (!sent) {
      this.pendingCatchUps.fail(
        pending.rpcKey,
        new ApiError(502, "host_disconnected", "Host is not connected"),
      );
    }
  }

  private completeTerminalCatchUp(
    pending: PendingTerminalRpcKey,
    message: TerminalReplayMessage,
  ): void {
    this.catchingUpTerminalIds.delete(pending.terminalId);
    for (const chunk of message.chunks) {
      this.forwardTerminalOutput(pending.terminalId, chunk);
    }
  }

  private forwardTerminalOutput(
    terminalId: string,
    chunk: TerminalOutputMessage["chunk"],
  ): void {
    const nextSeq = this.forwardedNextSeqByTerminalId.get(terminalId) ?? 0;
    if (chunk.seq < nextSeq) {
      return;
    }
    this.forwardedNextSeqByTerminalId.set(terminalId, chunk.seq + 1);
    this.options.hub.sendTerminalClientMessage(terminalId, {
      type: "output",
      chunk: toTerminalOutputChunk(chunk),
    });
  }

  private completePendingAttach(
    pending: PendingTerminalAttachKey,
    message: TerminalReplayMessage,
  ): void {
    const current = getTerminalById(this.options.db, pending.terminalId);
    if (!current) {
      this.options.hub.unregisterTerminalClient(
        pending.terminalId,
        pending.socket,
      );
      this.sendTerminalSocketError({
        socket: pending.socket,
        code: "terminal_not_found",
        message: "Terminal session not found",
      });
      return;
    }

    if (
      this.directOutputSessionIds.has(pending.daemonSessionId) !==
      this.directOutputSockets.has(pending.socket)
    ) {
      pending.socket.close(1013, "terminal-output-path-changed");
      return;
    }
    this.options.hub.registerTerminalClient(current.id, pending.socket);
    this.addOutputFlowClient(current.id, pending.socket, message.nextSeq);
    this.forwardedNextSeqByTerminalId.set(
      current.id,
      Math.max(
        this.forwardedNextSeqByTerminalId.get(current.id) ?? 0,
        message.nextSeq,
      ),
    );
    this.options.hub.sendTerminalSocketMessage(pending.socket, {
      type: "attached",
      session: this.toTerminalSession(current),
      replayStartSeq: message.replayStartSeq,
      nextSeq: message.nextSeq,
    });
    for (const chunk of message.chunks) {
      this.options.hub.sendTerminalSocketMessage(pending.socket, {
        type: "output",
        chunk: toTerminalOutputChunk(chunk),
      });
    }
    this.repaintReopenedNativeTerminal(current);
  }

  requestNativeTerminalRepaintOnNextAttach(terminalId: string): void {
    this.nativeTerminalRepaintsOnAttach.add(terminalId);
  }

  private repaintReopenedNativeTerminal(current: TerminalSessionRow): void {
    if (!this.nativeTerminalRepaintsOnAttach.delete(current.id)) {
      return;
    }
    if (current.status !== "running" || current.daemonSessionId === null) {
      return;
    }
    const daemonSessionId = current.daemonSessionId;
    setTimeout(() => {
      const latest = getTerminalById(this.options.db, current.id);
      if (
        !latest ||
        latest.status !== "running" ||
        latest.daemonSessionId !== daemonSessionId
      ) {
        return;
      }
      const nudgeRows = latest.rows === 1 ? latest.rows + 1 : latest.rows - 1;
      this.options.hub.sendDaemonSessionMessage(daemonSessionId, {
        type: "terminal.resize",
        terminalId: latest.id,
        cols: latest.cols,
        rows: nudgeRows,
      });
      this.options.hub.sendDaemonSessionMessage(daemonSessionId, {
        type: "terminal.resize",
        terminalId: latest.id,
        cols: latest.cols,
        rows: latest.rows,
      });
    }, REOPEN_NATIVE_TERMINAL_REPAINT_DELAY_MS);
  }

  private addOutputFlowClient(
    terminalId: string,
    socket: TerminalClientSocket,
    nextSeq: number,
  ): void {
    const visible = this.outputAckSocketVisibility.get(socket);
    if (visible !== undefined && !this.directOutputSockets.has(socket)) {
      this.outputFlow.addClient(terminalId, socket, nextSeq, visible);
    }
  }

  private rejectPendingOpenForTerminal(
    args: RejectPendingOpenForTerminalArgs,
  ): void {
    this.pendingOpens.failAllMatching(
      (pending) =>
        pending.daemonSessionId === args.daemonSessionId &&
        pending.terminalId === args.terminalId,
      new ApiError(args.status, args.code, args.message),
    );
  }

  private rejectPendingAttachesForTerminal(
    args: RejectPendingAttachesForTerminalArgs,
  ): void {
    this.pendingAttaches.failAllMatching(
      (pending) => pending.terminalId === args.terminalId,
      new ApiError(409, args.code, args.message),
    );
  }

  private rejectPendingOutputReadsForTerminal(
    args: RejectPendingAttachesForTerminalArgs,
  ): void {
    this.pendingOutputReads.failAllMatching(
      (pending) => pending.terminalId === args.terminalId,
      new ApiError(409, args.code, args.message),
    );
  }

  private failTerminalAttach(
    pending: PendingTerminalAttachKey,
    error: Error,
  ): void {
    if (error === TERMINAL_ATTACH_CANCELLED) {
      return;
    }
    this.options.hub.unregisterTerminalClient(
      pending.terminalId,
      pending.socket,
    );
    this.applySharedTerminalSize({
      socket: null,
      terminalId: pending.terminalId,
    });
    this.sendTerminalSocketError({
      socket: pending.socket,
      code:
        error instanceof ApiError ? error.body.code : "terminal_attach_failed",
      message: error instanceof ApiError ? error.body.message : error.message,
    });
  }

  private sendTerminalSocketError(args: SendTerminalSocketErrorArgs): void {
    this.options.hub.sendTerminalSocketMessage(args.socket, {
      type: "error",
      code: args.code,
      message: args.message,
    });
  }

  onTerminalExited(listener: (session: TerminalSessionRow) => void): void {
    this.exitListeners.add(listener);
  }

  private notifyTerminalSessionChanged(session: TerminalSessionRow): void {
    if (session.threadId !== null) {
      this.options.hub.notifyThread(session.threadId, ["terminals-changed"]);
    }
    if (session.status !== "exited") return;
    for (const listener of this.exitListeners) {
      try {
        listener(session);
      } catch (error) {
        this.options.logger.warn(
          { err: error, terminalId: session.id },
          "Terminal exit listener failed",
        );
      }
    }
  }
}
