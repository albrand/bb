import { emitPluginThreadEvents } from "../services/plugins/plugin-thread-events.js";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  realtimeSubscriptionTargetKey as subscriptionKey,
  type RealtimeSubscriptionTarget,
  type ChangedMessage,
  type EnvironmentChangeKind,
  type HostChangeKind,
  type ProjectChangeKind,
  type SystemChangeKind,
  type ThreadChangeKind,
  type ThreadChangeMetadata,
  type ThreadEventType,
  type ThreadTimelineSubscriptionTarget,
} from "@bb/domain";
import type { DbNotifier } from "@bb/db";
import type {
  HostPlatform,
  HostDaemonOnlineRpcRequestMessage,
  HostDaemonOnlineRpcResponseMessage,
  HostDaemonServerWsMessage,
  HostDaemonSessionCloseReason,
} from "@bb/host-daemon-contract";
import {
  pluginSignalSchema,
  serverMessageSchema,
  terminalServerMessageSchema,
  threadOpenSignalSchema,
  threadPaneActionSignalSchema,
  deviceHandoffSignalSchema,
  deviceHandoffExpiredSignalSchema,
  type DeviceHandoffRequest,
  type ThreadTimelineSignal,
  type ThreadPaneAction,
  type ThreadOpenFile,
  type ThreadOpenSplit,
  type TerminalServerMessage,
} from "@bb/server-contract";

const TERMINAL_SOCKET_HIGH_WATER_BYTES = 1024 * 1024;
const TERMINAL_SOCKET_MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const TERMINAL_SOCKET_DRAIN_POLL_MS = 10;
const THREAD_LIST_EVENTS_APPENDED_COALESCE_MS = 1_000;
const DEVICE_HANDOFF_TTL_MS = 10 * 60 * 1000;
const DEVICE_HANDOFF_PENDING_LIMIT = 100;
const LIST_RELEVANT_THREAD_EVENT_TYPES: ReadonlySet<ThreadEventType> =
  new Set<ThreadEventType>(["client/turn/requested", "turn/completed"]);

interface HubSocket {
  close(code?: number, reason?: string): void;
  raw?: { bufferedAmount: number };
  send(data: string): void;
}

type DaemonSessionChange =
  | { kind: "opened"; hostId: string; sessionId: string }
  | { kind: "closed"; sessionId: string };

type DaemonSessionListener = (change: DaemonSessionChange) => void;
type DeviceHandoffAttentionListener = (
  threadId: string,
  terminalSessionId: string | null,
  pending: boolean,
) => void;

interface TerminalSize {
  cols: number;
  rows: number;
}

interface TerminalClientState {
  heartbeats: boolean;
  lastSeenAt: number;
  size: TerminalSize | null;
  visible: boolean;
}

export const TERMINAL_CLIENT_STALE_MS = 45_000;

interface TerminalSocketSendQueue {
  bytes: number;
  payloads: string[];
  timeout: ReturnType<typeof setTimeout> | null;
}

export type ServerChangedMessage =
  | (Extract<
      ChangedMessage,
      { entity: "thread" | "project" | "environment" | "host" }
    > & { id: string })
  | Extract<ChangedMessage, { entity: "system" }>;

type ChangedMessageListener = (message: ServerChangedMessage) => void;

interface PendingThreadListEventsAppended {
  timelineSequence: number | undefined;
  eventTypes: Set<ThreadEventType>;
  merged: boolean;
  timeout: ReturnType<typeof setTimeout>;
}

type ThreadChangedMessage = Extract<ServerChangedMessage, { entity: "thread" }>;

function isThreadDetailOnlyChange(
  message: Pick<ThreadChangedMessage, "changes">,
): boolean {
  return (
    message.changes.length > 0 &&
    message.changes.every((change) => change === "history-compacted")
  );
}

function isThreadListRelevantChange(
  message: Pick<ThreadChangedMessage, "changes" | "metadata">,
): boolean {
  if (
    message.changes.some(
      (change) =>
        change !== "events-appended" && change !== "history-compacted",
    )
  ) {
    return true;
  }
  const metadata = message.metadata;
  if (metadata === undefined) {
    return false;
  }
  return (
    metadata.backgroundActivityChanged === true ||
    metadata.hasPendingInteraction !== undefined ||
    metadata.projectId !== undefined ||
    (metadata.eventTypes?.some((eventType) =>
      LIST_RELEVANT_THREAD_EVENT_TYPES.has(eventType),
    ) ??
      false)
  );
}

function subscriptionKeysForMessage(message: ServerChangedMessage): string[] {
  switch (message.entity) {
    case "thread":
      return [
        subscriptionKey({ kind: "thread-list" }),
        subscriptionKey({ kind: "thread-detail", threadId: message.id }),
      ];
    case "project":
      return [
        subscriptionKey({ kind: "project-list" }),
        subscriptionKey({ kind: "project-detail", projectId: message.id }),
      ];
    case "environment":
      return [
        subscriptionKey({ kind: "environment-list" }),
        subscriptionKey({
          kind: "environment-detail",
          environmentId: message.id,
        }),
      ];
    case "host":
      return [
        subscriptionKey({ kind: "host-list" }),
        subscriptionKey({ kind: "host-detail", hostId: message.id }),
      ];
    case "system":
      return [subscriptionKey({ kind: "system" })];
  }
}

function serializeServerMessage(message: ServerChangedMessage): string | null {
  const parseResult = serverMessageSchema.safeParse(message);
  if (!parseResult.success) {
    console.error("Skipping invalid realtime broadcast", parseResult.error);
    return null;
  }
  return JSON.stringify(parseResult.data);
}

type SessionTimers = Map<string, ReturnType<typeof setTimeout>>;

function cancelTimer(timers: SessionTimers, sessionId: string): void {
  const timeout = timers.get(sessionId);
  if (!timeout) {
    return;
  }
  clearTimeout(timeout);
  timers.delete(sessionId);
}

function scheduleTimer(
  timers: SessionTimers,
  sessionId: string,
  delayMs: number,
  callback: () => void,
): void {
  cancelTimer(timers, sessionId);
  const timeout = setTimeout(() => {
    timers.delete(sessionId);
    callback();
  }, delayMs);
  timers.set(sessionId, timeout);
}

interface ThreadEventWaiter {
  resolve: (notified: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface DaemonRegistrationWaiter {
  resolve: (registered: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface DaemonSessionCloseWaiter {
  resolve: (closed: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface HostOnlineRpcWaiter {
  detachAbortListener: () => void;
  reject: (reason?: Error) => void;
  resolve: (message: HostDaemonOnlineRpcResponseMessage) => void;
  sessionId: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface RecordHostOnlineRpcResponseArgs {
  message: HostDaemonOnlineRpcResponseMessage;
  sessionId: string;
}

type HostOnlineRpcResponseDisposition =
  | { handled: true }
  | { handled: false; reason: "stale" }
  | {
      expectedSessionId: string;
      handled: false;
      reason: "session_mismatch";
    };

export class HostOnlineRpcTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for host RPC response");
    this.name = "HostOnlineRpcTimeoutError";
  }
}

export class HostOnlineRpcCancelledError extends Error {
  constructor() {
    super("Host RPC request was cancelled");
    this.name = "HostOnlineRpcCancelledError";
  }
}

export class HostOnlineRpcUnavailableError extends Error {
  constructor() {
    super("Host daemon is not connected");
    this.name = "HostOnlineRpcUnavailableError";
  }
}

export class NotificationHub implements DbNotifier {
  private readonly clientKeysBySocket = new Map<HubSocket, Set<string>>();
  private readonly clientSocketsByKey = new Map<string, Set<HubSocket>>();
  private readonly threadTimelineTargetsByKey = new Map<
    string,
    ThreadTimelineSubscriptionTarget
  >();
  private readonly daemonSessions = new Map<
    string,
    {
      heardSinceLivenessCheck: boolean;
      hostId: string;
      localApiPort: number | null;
      platform: HostPlatform;
      quietLivenessChecks: number;
      socket: HubSocket;
    }
  >();
  private readonly daemonSessionLocalApiPortsBySessionId = new Map<
    string,
    number | null
  >();
  private readonly daemonSessionPlatformsBySessionId = new Map<
    string,
    HostPlatform
  >();
  private readonly daemonRegistrationWaiters = new Map<
    string,
    Set<DaemonRegistrationWaiter>
  >();
  private readonly daemonSessionCloseWaiters = new Map<
    string,
    Set<DaemonSessionCloseWaiter>
  >();
  private readonly daemonSessionIdsByHost = new Map<string, string>();
  private readonly hostOnlineRpcWaiters = new Map<
    string,
    HostOnlineRpcWaiter
  >();
  private readonly hostProtocolUpdateRetryRequests = new Set<string>();
  private readonly restartingHostIds = new Set<string>();
  private readonly changedMessageListeners = new Set<ChangedMessageListener>();
  private readonly pendingDaemonDisconnects = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly daemonSessionListeners = new Set<DaemonSessionListener>();
  private readonly deviceHandoffAttentionListeners =
    new Set<DeviceHandoffAttentionListener>();
  private readonly pendingDeviceHandoffCountsByThread = new Map<
    string,
    number
  >();
  private readonly pendingDeviceHandoffCountsByTerminal = new Map<
    string,
    number
  >();
  private readonly expiredDeviceHandoffThreads = new Set<string>();
  private readonly terminalClientSocketsById = new Map<
    string,
    Set<HubSocket>
  >();
  private readonly terminalSocketSendQueues = new Map<
    HubSocket,
    TerminalSocketSendQueue
  >();
  private readonly terminalIdsByClientSocket = new Map<
    HubSocket,
    Set<string>
  >();
  private readonly terminalClientStateById = new Map<
    string,
    Map<HubSocket, TerminalClientState>
  >();
  private readonly threadEventWaiters = new Map<
    string,
    Set<ThreadEventWaiter>
  >();
  private readonly pendingThreadListEventsAppendedByThread = new Map<
    string,
    PendingThreadListEventsAppended
  >();
  private readonly pendingDeviceHandoffsByOrigin = new Map<
    string,
    Array<{
      id: string;
      expiresAt: number;
      origin: DeviceHandoffRequest["origin"];
      payload: string;
      attentionThreadId: string | null;
      sentTo: Set<HubSocket>;
      ackableBy: Set<HubSocket>;
      timeout: ReturnType<typeof setTimeout>;
    }>
  >();
  private readonly activeThreadByClientSocket = new Map<
    HubSocket,
    string | null
  >();

  registerClient(socket: HubSocket): void {
    if (this.clientKeysBySocket.has(socket)) return;
    this.clientKeysBySocket.set(socket, new Set());
  }

  unregisterClient(socket: HubSocket): void {
    this.unregisterTerminalClientSocket(socket);
    this.activeThreadByClientSocket.delete(socket);
    for (const handoffs of this.pendingDeviceHandoffsByOrigin.values()) {
      for (const handoff of handoffs) {
        handoff.sentTo.delete(socket);
        handoff.ackableBy.delete(socket);
      }
    }
    const keys = this.clientKeysBySocket.get(socket);
    if (!keys) {
      return;
    }

    for (const key of keys) {
      const sockets = this.clientSocketsByKey.get(key);
      if (!sockets) {
        continue;
      }
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.clientSocketsByKey.delete(key);
        this.threadTimelineTargetsByKey.delete(key);
      }
    }

    this.clientKeysBySocket.delete(socket);
  }

  onChangedMessage(listener: ChangedMessageListener): () => void {
    this.changedMessageListeners.add(listener);
    return () => {
      this.changedMessageListeners.delete(listener);
    };
  }

  onDeviceHandoffAttentionChange(
    listener: DeviceHandoffAttentionListener,
  ): () => void {
    this.deviceHandoffAttentionListeners.add(listener);
    return () => this.deviceHandoffAttentionListeners.delete(listener);
  }

  registerTerminalClient(terminalId: string, socket: HubSocket): void {
    const sockets =
      this.terminalClientSocketsById.get(terminalId) ?? new Set<HubSocket>();
    sockets.add(socket);
    this.terminalClientSocketsById.set(terminalId, sockets);

    const terminalIds =
      this.terminalIdsByClientSocket.get(socket) ?? new Set<string>();
    terminalIds.add(terminalId);
    this.terminalIdsByClientSocket.set(socket, terminalIds);
  }

  recordTerminalClientSize(
    terminalId: string,
    socket: HubSocket,
    size: TerminalSize,
    now: number,
  ): void {
    const state = this.terminalClientState(terminalId, socket, now);
    state.size = size;
    state.lastSeenAt = now;
  }

  recordTerminalClientVisibility(
    terminalId: string,
    socket: HubSocket,
    visible: boolean,
    now: number,
  ): void {
    const state = this.terminalClientState(terminalId, socket, now);
    state.visible = visible;
    state.lastSeenAt = now;
    if (visible) {
      this.deliverPendingDeviceHandoffs({ terminalSessionId: terminalId }, now);
    }
  }

  hasVisibleTerminalClient(terminalId: string, now: number): boolean {
    for (const state of this.terminalClientStateById
      .get(terminalId)
      ?.values() ?? []) {
      if (
        state.visible &&
        (!state.heartbeats ||
          now - state.lastSeenAt <= TERMINAL_CLIENT_STALE_MS)
      ) {
        return true;
      }
    }
    return false;
  }

  recordTerminalClientSeen(
    terminalId: string,
    socket: HubSocket,
    now: number,
  ): void {
    this.terminalClientState(terminalId, socket, now).lastSeenAt = now;
  }

  recordTerminalClientHeartbeat(
    terminalId: string,
    socket: HubSocket,
    now: number,
  ): void {
    const state = this.terminalClientState(terminalId, socket, now);
    state.heartbeats = true;
    state.lastSeenAt = now;
  }

  terminalSharedSize(terminalId: string, now: number): TerminalSize | null {
    let shared: TerminalSize | null = null;
    for (const state of this.terminalClientStateById
      .get(terminalId)
      ?.values() ?? []) {
      if (
        state.size === null ||
        !state.visible ||
        (state.heartbeats && now - state.lastSeenAt > TERMINAL_CLIENT_STALE_MS)
      ) {
        continue;
      }
      shared =
        shared === null
          ? { ...state.size }
          : {
              cols: Math.min(shared.cols, state.size.cols),
              rows: Math.min(shared.rows, state.size.rows),
            };
    }
    return shared;
  }

  private terminalClientState(
    terminalId: string,
    socket: HubSocket,
    now: number,
  ): TerminalClientState {
    const states =
      this.terminalClientStateById.get(terminalId) ??
      new Map<HubSocket, TerminalClientState>();
    this.terminalClientStateById.set(terminalId, states);
    const existing = states.get(socket);
    if (existing) {
      return existing;
    }
    const created: TerminalClientState = {
      heartbeats: false,
      lastSeenAt: now,
      size: null,
      visible: true,
    };
    states.set(socket, created);
    return created;
  }

  private forgetTerminalClientState(
    terminalId: string,
    socket: HubSocket,
  ): void {
    const states = this.terminalClientStateById.get(terminalId);
    if (!states) {
      return;
    }
    states.delete(socket);
    if (states.size === 0) {
      this.terminalClientStateById.delete(terminalId);
    }
  }

  unregisterTerminalClient(terminalId: string, socket: HubSocket): void {
    const sockets = this.terminalClientSocketsById.get(terminalId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.terminalClientSocketsById.delete(terminalId);
      }
    }
    this.forgetTerminalClientState(terminalId, socket);

    const terminalIds = this.terminalIdsByClientSocket.get(socket);
    if (!terminalIds) {
      return;
    }
    terminalIds.delete(terminalId);
    if (terminalIds.size === 0) {
      this.terminalIdsByClientSocket.delete(socket);
      this.clearTerminalSocketSendQueue(socket);
    }
  }

  unregisterTerminalClientSocket(socket: HubSocket): void {
    const terminalIds = this.terminalIdsByClientSocket.get(socket);
    if (!terminalIds) {
      return;
    }

    for (const terminalId of terminalIds) {
      const sockets = this.terminalClientSocketsById.get(terminalId);
      if (!sockets) {
        continue;
      }
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.terminalClientSocketsById.delete(terminalId);
      }
      this.forgetTerminalClientState(terminalId, socket);
    }

    this.terminalIdsByClientSocket.delete(socket);
    this.clearTerminalSocketSendQueue(socket);
  }

  sendTerminalSocketMessage(
    socket: HubSocket,
    message: TerminalServerMessage,
  ): void {
    this.sendOrQueueTerminalPayload(
      socket,
      JSON.stringify(terminalServerMessageSchema.parse(message)),
    );
  }

  closeTerminalClients(
    terminalId: string,
    code: number,
    reason: string,
  ): HubSocket[] {
    const sockets = [...(this.terminalClientSocketsById.get(terminalId) ?? [])];
    for (const socket of sockets) {
      try {
        socket.close(code, reason);
      } catch {}
    }
    return sockets;
  }

  subscribeDaemonSessions(listener: DaemonSessionListener): () => void {
    this.daemonSessionListeners.add(listener);
    for (const [sessionId, session] of this.daemonSessions) {
      listener({ kind: "opened", hostId: session.hostId, sessionId });
    }
    return () => {
      this.daemonSessionListeners.delete(listener);
    };
  }

  hasTerminalClients(terminalId: string): boolean {
    return (this.terminalClientSocketsById.get(terminalId)?.size ?? 0) > 0;
  }

  sendTerminalClientMessage(
    terminalId: string,
    message: TerminalServerMessage,
  ): void {
    const sockets = this.terminalClientSocketsById.get(terminalId);
    if (!sockets) {
      return;
    }

    const payload = JSON.stringify(terminalServerMessageSchema.parse(message));
    for (const socket of [...sockets]) {
      this.sendOrQueueTerminalPayload(socket, payload);
    }
  }

  private sendOrQueueTerminalPayload(socket: HubSocket, payload: string): void {
    const existingQueue = this.terminalSocketSendQueues.get(socket);
    if (
      !existingQueue &&
      (socket.raw?.bufferedAmount ?? 0) <= TERMINAL_SOCKET_HIGH_WATER_BYTES
    ) {
      try {
        socket.send(payload);
        return;
      } catch {
        this.dropTerminalSocket(socket, "terminal-send-failed");
        return;
      }
    }

    const queue = existingQueue ?? {
      bytes: 0,
      payloads: [],
      timeout: null,
    };
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (queue.bytes + payloadBytes > TERMINAL_SOCKET_MAX_QUEUE_BYTES) {
      this.dropTerminalSocket(socket, "terminal-backpressure");
      return;
    }
    queue.payloads.push(payload);
    queue.bytes += payloadBytes;
    this.terminalSocketSendQueues.set(socket, queue);
    this.scheduleTerminalSocketDrain(socket, queue);
  }

  private scheduleTerminalSocketDrain(
    socket: HubSocket,
    queue: TerminalSocketSendQueue,
  ): void {
    if (queue.timeout !== null) {
      return;
    }
    queue.timeout = setTimeout(() => {
      queue.timeout = null;
      this.flushTerminalSocketQueue(socket, queue);
    }, TERMINAL_SOCKET_DRAIN_POLL_MS);
  }

  private flushTerminalSocketQueue(
    socket: HubSocket,
    queue: TerminalSocketSendQueue,
  ): void {
    if (this.terminalSocketSendQueues.get(socket) !== queue) {
      return;
    }
    while (
      queue.payloads.length > 0 &&
      (socket.raw?.bufferedAmount ?? 0) <= TERMINAL_SOCKET_HIGH_WATER_BYTES
    ) {
      const payload = queue.payloads[0];
      if (payload === undefined) {
        break;
      }
      try {
        socket.send(payload);
      } catch {
        this.dropTerminalSocket(socket, "terminal-send-failed");
        return;
      }
      queue.payloads.shift();
      queue.bytes -= Buffer.byteLength(payload, "utf8");
    }
    if (queue.payloads.length === 0) {
      this.clearTerminalSocketSendQueue(socket);
      return;
    }
    this.scheduleTerminalSocketDrain(socket, queue);
  }

  private dropTerminalSocket(socket: HubSocket, reason: string): void {
    this.unregisterTerminalClientSocket(socket);
    try {
      socket.close(1013, reason);
    } catch {}
  }

  private clearTerminalSocketSendQueue(socket: HubSocket): void {
    const queue = this.terminalSocketSendQueues.get(socket);
    if (!queue) {
      return;
    }
    if (queue.timeout !== null) {
      clearTimeout(queue.timeout);
    }
    this.terminalSocketSendQueues.delete(socket);
  }

  subscribe(socket: HubSocket, target: RealtimeSubscriptionTarget): void {
    this.registerClient(socket);
    const key = subscriptionKey(target);
    this.clientKeysBySocket.get(socket)?.add(key);

    const sockets = this.clientSocketsByKey.get(key) ?? new Set<HubSocket>();
    sockets.add(socket);
    this.clientSocketsByKey.set(key, sockets);
    if (
      target.kind === "thread-timeline" &&
      !this.threadTimelineTargetsByKey.has(key)
    ) {
      this.threadTimelineTargetsByKey.set(key, { ...target });
    }
    if (target.kind === "thread-detail") {
      this.deliverPendingDeviceHandoffs(
        { threadId: target.threadId },
        Date.now(),
      );
      if (this.activeThreadByClientSocket.get(socket) === target.threadId) {
        this.deliverExpiredDeviceHandoffNotice(socket, target.threadId);
      }
    }
  }

  setDeviceHandoffView(socket: HubSocket, threadId: string | null): void {
    this.registerClient(socket);
    const previousThreadId = this.activeThreadByClientSocket.get(socket);
    if (previousThreadId !== threadId) {
      for (const handoffs of this.pendingDeviceHandoffsByOrigin.values()) {
        for (const handoff of handoffs) handoff.sentTo.delete(socket);
      }
    }
    this.activeThreadByClientSocket.set(socket, threadId);
    if (threadId !== null) {
      this.deliverPendingDeviceHandoffs({ threadId }, Date.now());
      const key = subscriptionKey({ kind: "thread-detail", threadId });
      if (this.clientSocketsByKey.get(key)?.has(socket)) {
        this.deliverExpiredDeviceHandoffNotice(socket, threadId);
      }
    }
  }

  acknowledgeDeviceHandoff(socket: HubSocket, id: string): void {
    for (const [originKey, handoffs] of this.pendingDeviceHandoffsByOrigin) {
      const pending = handoffs.find((handoff) => {
        return handoff.id === id && handoff.ackableBy.has(socket);
      });
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.removePendingDeviceHandoff(originKey, pending.payload, false);
      const acknowledged = JSON.stringify({
        type: "device-handoff-acknowledged",
        id,
      });
      for (const recipient of pending.sentTo) {
        if (recipient !== socket) recipient.send(acknowledged);
      }
      return;
    }
  }

  unsubscribe(socket: HubSocket, target: RealtimeSubscriptionTarget): void {
    const key = subscriptionKey(target);
    this.clientKeysBySocket.get(socket)?.delete(key);

    const sockets = this.clientSocketsByKey.get(key);
    if (!sockets) {
      return;
    }
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.clientSocketsByKey.delete(key);
      this.threadTimelineTargetsByKey.delete(key);
    }
  }

  listThreadTimelineTargets(
    threadId: string,
  ): ThreadTimelineSubscriptionTarget[] {
    const targets: ThreadTimelineSubscriptionTarget[] = [];
    for (const target of this.threadTimelineTargetsByKey.values()) {
      if (target.threadId === threadId) {
        targets.push(target);
      }
    }
    return targets;
  }

  sendThreadTimelineSignal(signal: ThreadTimelineSignal): number {
    const sockets = this.clientSocketsByKey.get(subscriptionKey(signal.target));
    if (!sockets) {
      return 0;
    }
    const payload = JSON.stringify(signal);
    this.notifyClientsByKeySet(sockets, payload);
    return payload.length;
  }

  recordDaemonSessionPlatform(sessionId: string, platform: HostPlatform): void {
    this.daemonSessionPlatformsBySessionId.set(sessionId, platform);
  }

  recordDaemonSessionLocalApiPort(
    sessionId: string,
    localApiPort: number | null,
  ): void {
    this.daemonSessionLocalApiPortsBySessionId.set(sessionId, localApiPort);
  }

  registerDaemon(sessionId: string, hostId: string, socket: HubSocket): void {
    this.restartingHostIds.delete(hostId);
    this.cancelPendingDaemonDisconnect(sessionId);
    const existingSessionId = this.daemonSessionIdsByHost.get(hostId);
    if (existingSessionId && existingSessionId !== sessionId) {
      this.cancelPendingDaemonDisconnect(existingSessionId);
      this.unregisterDaemon(existingSessionId);
    }
    this.daemonSessions.set(sessionId, {
      heardSinceLivenessCheck: true,
      hostId,
      localApiPort:
        this.daemonSessionLocalApiPortsBySessionId.get(sessionId) ?? null,
      platform:
        this.daemonSessionPlatformsBySessionId.get(sessionId) ?? "unknown",
      quietLivenessChecks: 0,
      socket,
    });
    this.daemonSessionIdsByHost.set(hostId, sessionId);
    for (const listener of this.daemonSessionListeners) {
      listener({ kind: "opened", hostId, sessionId });
    }
    this.resolveDaemonRegistrationWaiters(hostId);
    this.notifyHost(hostId, ["host-connected"]);
  }

  unregisterDaemon(sessionId: string): void {
    const entry = this.daemonSessions.get(sessionId);
    if (!entry) {
      return;
    }
    this.daemonSessions.delete(sessionId);
    this.daemonSessionLocalApiPortsBySessionId.delete(sessionId);
    this.daemonSessionPlatformsBySessionId.delete(sessionId);
    this.rejectHostOnlineRpcWaitersForSession(sessionId);
    if (this.daemonSessionIdsByHost.get(entry.hostId) === sessionId) {
      this.daemonSessionIdsByHost.delete(entry.hostId);
    }
    for (const listener of this.daemonSessionListeners) {
      listener({ kind: "closed", sessionId });
    }
    const waiters = this.daemonSessionCloseWaiters.get(sessionId);
    if (waiters !== undefined) {
      this.daemonSessionCloseWaiters.delete(sessionId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(true);
      }
    }
  }

  recordDaemonActivity(sessionId: string): void {
    const entry = this.daemonSessions.get(sessionId);
    if (entry) {
      entry.heardSinceLivenessCheck = true;
    }
  }

  takeSilentDaemonSessionIds(maxQuietChecks: number): string[] {
    const silentSessionIds: string[] = [];
    for (const [sessionId, entry] of this.daemonSessions) {
      if (entry.heardSinceLivenessCheck) {
        entry.heardSinceLivenessCheck = false;
        entry.quietLivenessChecks = 0;
        continue;
      }
      entry.quietLivenessChecks += 1;
      if (entry.quietLivenessChecks >= maxQuietChecks) {
        silentSessionIds.push(sessionId);
      }
    }
    return silentSessionIds;
  }

  hasDaemonForHost(hostId: string): boolean {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    return sessionId !== undefined && this.daemonSessions.has(sessionId);
  }

  markHostRestarting(hostId: string): void {
    this.restartingHostIds.add(hostId);
    this.notifyHost(hostId, ["host-disconnected"]);
  }

  isHostRestarting(hostId: string): boolean {
    return this.restartingHostIds.has(hostId);
  }

  clearHostRestarting(hostId: string): void {
    this.restartingHostIds.delete(hostId);
  }

  getDaemonSessionIdForHost(hostId: string): string | null {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    if (!sessionId || !this.daemonSessions.has(sessionId)) {
      return null;
    }
    return sessionId;
  }

  getDaemonPlatformForHost(hostId: string): HostPlatform | null {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    if (!sessionId) {
      return null;
    }
    return this.daemonSessions.get(sessionId)?.platform ?? null;
  }

  listDaemonLocalApiPorts(): number[] {
    const ports = new Set<number>();
    for (const session of this.daemonSessions.values()) {
      if (session.localApiPort !== null) {
        ports.add(session.localApiPort);
      }
    }
    return [...ports].sort((left, right) => left - right);
  }

  listConnectedHostIds(): string[] {
    return [...this.daemonSessionIdsByHost.keys()];
  }

  async waitForDaemonForHost(
    hostId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.hasDaemonForHost(hostId)) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const waiter: DaemonRegistrationWaiter = {
        resolve,
        timeout: setTimeout(() => {
          this.deleteDaemonRegistrationWaiter(hostId, waiter);
          resolve(false);
        }, timeoutMs),
      };
      const waiters =
        this.daemonRegistrationWaiters.get(hostId) ??
        new Set<DaemonRegistrationWaiter>();
      waiters.add(waiter);
      this.daemonRegistrationWaiters.set(hostId, waiters);
    });
  }

  async waitForDaemonSessionClose(
    sessionId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!this.daemonSessions.has(sessionId)) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const waiter: DaemonSessionCloseWaiter = {
        resolve,
        timeout: setTimeout(() => {
          const waiters = this.daemonSessionCloseWaiters.get(sessionId);
          waiters?.delete(waiter);
          if (waiters?.size === 0) {
            this.daemonSessionCloseWaiters.delete(sessionId);
          }
          resolve(false);
        }, timeoutMs),
      };
      const waiters =
        this.daemonSessionCloseWaiters.get(sessionId) ??
        new Set<DaemonSessionCloseWaiter>();
      waiters.add(waiter);
      this.daemonSessionCloseWaiters.set(sessionId, waiters);
    });
  }

  requestDaemonShutdown(sessionId: string): boolean {
    const entry = this.daemonSessions.get(sessionId);
    if (entry === undefined) {
      return false;
    }
    entry.socket.send(JSON.stringify({ type: "machine.shutdown" }));
    return true;
  }

  closeDaemonSession(
    sessionId: string,
    reason: HostDaemonSessionCloseReason,
  ): void {
    const entry = this.daemonSessions.get(sessionId);
    if (entry) {
      entry.socket.send(JSON.stringify({ type: "session-close", reason }));
    }
    this.closeDaemonSessionSocket(sessionId, reason);
  }

  closeDaemonSessionSocket(
    sessionId: string,
    reason: HostDaemonSessionCloseReason,
  ): void {
    this.cancelPendingDaemonDisconnect(sessionId);
    const entry = this.daemonSessions.get(sessionId);
    if (!entry) {
      return;
    }
    entry.socket.close(1000, reason);
    this.unregisterDaemon(sessionId);
  }

  scheduleDaemonDisconnect(
    sessionId: string,
    delayMs: number,
    callback: () => void,
  ): void {
    scheduleTimer(this.pendingDaemonDisconnects, sessionId, delayMs, callback);
  }

  cancelPendingDaemonDisconnect(sessionId: string): void {
    cancelTimer(this.pendingDaemonDisconnects, sessionId);
  }

  requestHostOnlineRpc(args: {
    hostId: string;
    message: HostDaemonOnlineRpcRequestMessage;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<HostDaemonOnlineRpcResponseMessage> {
    const sessionId = this.daemonSessionIdsByHost.get(args.hostId);
    if (!sessionId) {
      return Promise.reject(new HostOnlineRpcUnavailableError());
    }
    const session = this.daemonSessions.get(sessionId);
    if (!session) {
      return Promise.reject(new HostOnlineRpcUnavailableError());
    }
    const signal = args.signal;
    if (signal?.aborted) {
      return Promise.reject(new HostOnlineRpcCancelledError());
    }
    const requestId = args.message.requestId;

    return new Promise<HostDaemonOnlineRpcResponseMessage>(
      (resolve, reject) => {
        const abandon = (error: Error): void => {
          this.deleteHostOnlineRpcWaiter(requestId, waiter);
          this.sendHostOnlineRpcCancel(sessionId, requestId);
          reject(error);
        };
        const onAbort = (): void => {
          abandon(new HostOnlineRpcCancelledError());
        };
        const waiter: HostOnlineRpcWaiter = {
          detachAbortListener: () => {
            signal?.removeEventListener("abort", onAbort);
          },
          reject,
          resolve,
          sessionId,
          timeout: setTimeout(() => {
            abandon(new HostOnlineRpcTimeoutError());
          }, args.timeoutMs),
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.hostOnlineRpcWaiters.set(requestId, waiter);
        try {
          session.socket.send(JSON.stringify(args.message));
        } catch (error) {
          this.deleteHostOnlineRpcWaiter(requestId, waiter);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  }

  recordHostOnlineRpcResponse(
    args: RecordHostOnlineRpcResponseArgs,
  ): HostOnlineRpcResponseDisposition {
    const waiter = this.hostOnlineRpcWaiters.get(args.message.requestId);
    if (!waiter) {
      return { handled: false, reason: "stale" };
    }
    if (waiter.sessionId !== args.sessionId) {
      return {
        expectedSessionId: waiter.sessionId,
        handled: false,
        reason: "session_mismatch",
      };
    }
    this.deleteHostOnlineRpcWaiter(args.message.requestId, waiter);
    waiter.resolve(args.message);
    return { handled: true };
  }

  registerThreadEventWaiter(
    threadId: string,
    timeoutMs: number,
  ): { promise: Promise<boolean>; cancel: () => void } {
    let waiter: ThreadEventWaiter;
    const promise = new Promise<boolean>((resolve) => {
      waiter = {
        resolve: (notified) => resolve(notified),
        timeout: setTimeout(() => {
          this.deleteThreadEventWaiter(threadId, waiter);
          resolve(false);
        }, timeoutMs),
      };
      const waiters =
        this.threadEventWaiters.get(threadId) ?? new Set<ThreadEventWaiter>();
      waiters.add(waiter);
      this.threadEventWaiters.set(threadId, waiters);
    });
    const cancel = () => {
      this.deleteThreadEventWaiter(threadId, waiter!);
    };
    return { promise, cancel };
  }

  notifyThread(
    threadId: string,
    changes: ThreadChangeKind[],
    metadata?: ThreadChangeMetadata,
  ): void {
    if (changes.includes("events-appended")) emitPluginThreadEvents(threadId);
    const message: ThreadChangedMessage = {
      type: "changed",
      entity: "thread",
      id: threadId,
      ...(metadata ? { metadata } : {}),
      changes,
    };
    if (isThreadDetailOnlyChange(message)) {
      this.notifyThreadDetailSubscribers(threadId, message);
    } else if (isThreadListRelevantChange(message)) {
      this.notifyClients(message);
    } else {
      this.notifyThreadEventsAppendedCoalesced(threadId, message);
    }

    const threadEventWaiters = this.threadEventWaiters.get(threadId);
    if (threadEventWaiters) {
      for (const waiter of threadEventWaiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(true);
      }
      this.threadEventWaiters.delete(threadId);
    }
  }

  notifyThreadOpen(
    thread: { projectId: string; threadId: string },
    request: { split: ThreadOpenSplit; file: ThreadOpenFile | null },
  ): number {
    return this.broadcastToAllClients(
      JSON.stringify(
        threadOpenSignalSchema.parse({
          type: "thread-open",
          projectId: thread.projectId,
          threadId: thread.threadId,
          split: request.split,
          file: request.file,
        }),
      ),
    );
  }

  notifyThreadPaneAction(
    thread: { projectId: string; threadId: string },
    action: ThreadPaneAction,
  ): number {
    return this.broadcastToAllClients(
      JSON.stringify(
        threadPaneActionSignalSchema.parse({
          type: "thread-pane-action",
          projectId: thread.projectId,
          threadId: thread.threadId,
          action,
        }),
      ),
    );
  }

  notifyPluginSignal(
    pluginId: string,
    channel: string,
    payload: unknown,
  ): number {
    return this.broadcastToAllClients(
      JSON.stringify(
        pluginSignalSchema.parse({
          type: "plugin-signal",
          pluginId,
          channel,
          payload,
        }),
      ),
    );
  }

  notifyDeviceHandoff(
    request: DeviceHandoffRequest,
    originLabel: string,
    attentionThreadId?: string | null,
  ): number {
    const createdAt = Date.now();
    const signal = deviceHandoffSignalSchema.parse({
      type: "device-handoff",
      id: randomUUID(),
      createdAt,
      expiresAt: createdAt + DEVICE_HANDOFF_TTL_MS,
      request,
      originLabel,
    });
    const payload = JSON.stringify(signal);
    this.prunePendingDeviceHandoffs(createdAt);
    const originKey = this.deviceHandoffOriginKey(request.origin);
    const scopedAttentionThreadId = attentionThreadId ?? null;
    if (scopedAttentionThreadId !== null) {
      const previousCount =
        this.pendingDeviceHandoffCountsByThread.get(scopedAttentionThreadId) ??
        0;
      this.pendingDeviceHandoffCountsByThread.set(
        scopedAttentionThreadId,
        previousCount + 1,
      );
      if (previousCount === 0) {
        this.emitDeviceHandoffAttentionChange(
          scopedAttentionThreadId,
          null,
          true,
        );
      }
    }
    const terminalId = request.origin.terminalSessionId;
    if (terminalId !== undefined) {
      const previousCount =
        this.pendingDeviceHandoffCountsByTerminal.get(terminalId) ?? 0;
      this.pendingDeviceHandoffCountsByTerminal.set(
        terminalId,
        previousCount + 1,
      );
      if (previousCount === 0) {
        for (const listener of this.deviceHandoffAttentionListeners) {
          listener(scopedAttentionThreadId ?? "", terminalId, true);
        }
      }
    }
    const pending = this.pendingDeviceHandoffsByOrigin.get(originKey) ?? [];
    const handoff = {
      id: signal.id,
      expiresAt: signal.expiresAt,
      origin: request.origin,
      payload,
      attentionThreadId: scopedAttentionThreadId,
      sentTo: new Set<HubSocket>(),
      ackableBy: new Set<HubSocket>(),
      timeout: setTimeout(
        () => this.removePendingDeviceHandoff(originKey, payload),
        Math.max(0, signal.expiresAt - Date.now()),
      ),
    };
    handoff.timeout.unref?.();
    pending.push(handoff);
    this.pendingDeviceHandoffsByOrigin.set(originKey, pending);
    this.enforcePendingDeviceHandoffLimit();
    return this.deliverPendingDeviceHandoffs(request.origin, createdAt);
  }

  private prunePendingDeviceHandoffs(now: number): void {
    for (const [originKey, handoffs] of this.pendingDeviceHandoffsByOrigin) {
      const live = handoffs.filter((handoff) => handoff.expiresAt > now);
      for (const handoff of handoffs) {
        if (handoff.expiresAt <= now) {
          clearTimeout(handoff.timeout);
          this.markDeviceHandoffExpired(handoff.attentionThreadId);
          this.decrementDeviceHandoffAttention(
            handoff.attentionThreadId,
            handoff.origin.terminalSessionId ?? null,
          );
        }
      }
      if (live.length === 0) {
        this.pendingDeviceHandoffsByOrigin.delete(originKey);
      } else if (live.length !== handoffs.length) {
        this.pendingDeviceHandoffsByOrigin.set(originKey, live);
      }
    }
  }

  private deviceHandoffOriginKey(
    origin: DeviceHandoffRequest["origin"],
  ): string {
    return `${origin.threadId ?? ""}\u0000${origin.terminalSessionId ?? ""}`;
  }

  private deviceHandoffRecipients(
    origin: DeviceHandoffRequest["origin"],
    now: number,
  ): Set<HubSocket> {
    const recipients = new Set<HubSocket>();
    if (origin.threadId !== undefined) {
      for (const [socket, activeThreadId] of this.activeThreadByClientSocket) {
        if (activeThreadId !== origin.threadId) continue;
        const key = subscriptionKey({
          kind: "thread-detail",
          threadId: origin.threadId,
        });
        if (this.clientSocketsByKey.get(key)?.has(socket)) {
          recipients.add(socket);
        }
      }
    }
    if (origin.terminalSessionId !== undefined) {
      for (const [socket, state] of this.terminalClientStateById.get(
        origin.terminalSessionId,
      ) ?? []) {
        if (
          state.visible &&
          (!state.heartbeats ||
            now - state.lastSeenAt <= TERMINAL_CLIENT_STALE_MS)
        ) {
          recipients.add(socket);
        }
      }
    }
    return recipients;
  }

  private deliverPendingDeviceHandoffs(
    openedOrigin: DeviceHandoffRequest["origin"],
    now: number,
  ): number {
    this.prunePendingDeviceHandoffs(now);
    let delivered = 0;
    const matchingOrigin = (origin: DeviceHandoffRequest["origin"]) =>
      (openedOrigin.threadId !== undefined &&
        origin.threadId === openedOrigin.threadId) ||
      (openedOrigin.terminalSessionId !== undefined &&
        origin.terminalSessionId === openedOrigin.terminalSessionId);
    for (const handoffs of this.pendingDeviceHandoffsByOrigin.values()) {
      const ready = handoffs.filter((handoff) =>
        matchingOrigin(handoff.origin),
      );
      if (ready.length === 0) continue;
      for (const handoff of ready) {
        const recipients = this.deviceHandoffRecipients(handoff.origin, now);
        if (recipients.size === 0) continue;
        for (const socket of recipients) {
          if (handoff.sentTo.has(socket)) continue;
          socket.send(handoff.payload);
          handoff.sentTo.add(socket);
          handoff.ackableBy.add(socket);
          delivered += 1;
        }
      }
    }
    return delivered;
  }

  private deliverExpiredDeviceHandoffNotice(
    socket: HubSocket,
    threadId: string,
  ): void {
    if (!this.expiredDeviceHandoffThreads.delete(threadId)) return;
    socket.send(
      JSON.stringify(
        deviceHandoffExpiredSignalSchema.parse({
          type: "device-handoff-expired",
          id: randomUUID(),
          threadId,
        }),
      ),
    );
  }

  private enforcePendingDeviceHandoffLimit(): void {
    const entries: Array<{
      originKey: string;
      payload: string;
      expiresAt: number;
      attentionThreadId: string | null;
    }> = [];
    for (const [originKey, handoffs] of this.pendingDeviceHandoffsByOrigin) {
      handoffs.forEach((handoff) => {
        entries.push({
          originKey,
          payload: handoff.payload,
          expiresAt: handoff.expiresAt,
          attentionThreadId: handoff.attentionThreadId,
        });
      });
    }
    if (entries.length <= DEVICE_HANDOFF_PENDING_LIMIT) return;
    entries
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .slice(0, entries.length - DEVICE_HANDOFF_PENDING_LIMIT)
      .forEach(({ originKey, payload }) => {
        const handoffs = this.pendingDeviceHandoffsByOrigin.get(originKey);
        if (!handoffs) return;
        const index = handoffs.findIndex(
          (handoff) => handoff.payload === payload,
        );
        if (index !== -1) {
          clearTimeout(handoffs[index]?.timeout);
          this.markDeviceHandoffExpired(
            handoffs[index]?.attentionThreadId ?? null,
          );
          this.decrementDeviceHandoffAttention(
            handoffs[index]?.attentionThreadId ?? null,
            handoffs[index]?.origin.terminalSessionId ?? null,
          );
          handoffs.splice(index, 1);
        }
        if (handoffs.length === 0) {
          this.pendingDeviceHandoffsByOrigin.delete(originKey);
        }
      });
  }

  private broadcastToAllClients(payload: string): number {
    let delivered = 0;
    for (const socket of this.clientKeysBySocket.keys()) {
      socket.send(payload);
      delivered += 1;
    }
    return delivered;
  }

  notifyProject(projectId: string, changes: ProjectChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "project",
      id: projectId,
      changes,
    });
  }

  private removePendingDeviceHandoff(
    originKey: string,
    payload: string,
    expired = true,
  ): void {
    const handoffs = this.pendingDeviceHandoffsByOrigin.get(originKey);
    if (!handoffs) return;
    const remaining = handoffs.filter((handoff) => handoff.payload !== payload);
    if (remaining.length === handoffs.length) return;
    const removed = handoffs.find((handoff) => handoff.payload === payload);
    this.decrementDeviceHandoffAttention(
      removed?.attentionThreadId ?? null,
      removed?.origin.terminalSessionId ?? null,
    );
    if (expired && removed?.attentionThreadId) {
      this.markDeviceHandoffExpired(removed.attentionThreadId);
    }
    if (remaining.length === 0) {
      this.pendingDeviceHandoffsByOrigin.delete(originKey);
    } else {
      this.pendingDeviceHandoffsByOrigin.set(originKey, remaining);
    }
  }

  private decrementDeviceHandoffAttention(
    threadId: string | null,
    terminalId: string | null,
  ): void {
    if (terminalId !== null) {
      const terminalRemaining =
        (this.pendingDeviceHandoffCountsByTerminal.get(terminalId) ?? 1) - 1;
      if (terminalRemaining > 0) {
        this.pendingDeviceHandoffCountsByTerminal.set(
          terminalId,
          terminalRemaining,
        );
      } else {
        this.pendingDeviceHandoffCountsByTerminal.delete(terminalId);
        for (const listener of this.deviceHandoffAttentionListeners) {
          listener(threadId ?? "", terminalId, false);
        }
      }
    }
    if (threadId === null) return;
    const remaining =
      (this.pendingDeviceHandoffCountsByThread.get(threadId) ?? 1) - 1;
    if (remaining > 0) {
      this.pendingDeviceHandoffCountsByThread.set(threadId, remaining);
      return;
    }
    this.pendingDeviceHandoffCountsByThread.delete(threadId);
    this.emitDeviceHandoffAttentionChange(threadId, null, false);
  }

  private markDeviceHandoffExpired(threadId: string | null): void {
    if (threadId === null) return;
    this.expiredDeviceHandoffThreads.delete(threadId);
    this.expiredDeviceHandoffThreads.add(threadId);
    while (
      this.expiredDeviceHandoffThreads.size > DEVICE_HANDOFF_PENDING_LIMIT
    ) {
      const oldest = this.expiredDeviceHandoffThreads.values().next().value;
      if (oldest === undefined) break;
      this.expiredDeviceHandoffThreads.delete(oldest);
    }
  }

  private emitDeviceHandoffAttentionChange(
    threadId: string,
    terminalId: string | null,
    pending: boolean,
  ): void {
    for (const listener of this.deviceHandoffAttentionListeners) {
      listener(threadId, terminalId, pending);
    }
  }

  notifyEnvironment(
    environmentId: string,
    changes: EnvironmentChangeKind[],
  ): void {
    this.notifyClients({
      type: "changed",
      entity: "environment",
      id: environmentId,
      changes,
    });
  }

  notifyHost(hostId: string, changes: HostChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "host",
      id: hostId,
      changes,
    });
  }

  requestHostProtocolUpdateRetry(hostId: string): void {
    this.hostProtocolUpdateRetryRequests.add(hostId);
  }

  takeHostProtocolUpdateRetry(hostId: string): boolean {
    if (!this.hostProtocolUpdateRetryRequests.has(hostId)) {
      return false;
    }
    this.hostProtocolUpdateRetryRequests.delete(hostId);
    return true;
  }

  notifySystem(changes: SystemChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "system",
      changes,
    });
  }

  private deleteThreadEventWaiter(
    threadId: string,
    waiter: ThreadEventWaiter,
  ): void {
    const waiters = this.threadEventWaiters.get(threadId);
    if (!waiters) {
      return;
    }
    clearTimeout(waiter.timeout);
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.threadEventWaiters.delete(threadId);
    }
  }

  private deleteHostOnlineRpcWaiter(
    requestId: string,
    waiter: HostOnlineRpcWaiter,
  ): void {
    clearTimeout(waiter.timeout);
    waiter.detachAbortListener();
    if (this.hostOnlineRpcWaiters.get(requestId) === waiter) {
      this.hostOnlineRpcWaiters.delete(requestId);
    }
  }

  private sendHostOnlineRpcCancel(sessionId: string, requestId: string): void {
    try {
      this.sendDaemonSessionMessage(sessionId, {
        type: "host-rpc.cancel",
        requestId,
      });
    } catch {
      return;
    }
  }

  private rejectHostOnlineRpcWaitersForSession(sessionId: string): void {
    for (const [requestId, waiter] of this.hostOnlineRpcWaiters) {
      if (waiter.sessionId !== sessionId) {
        continue;
      }
      this.deleteHostOnlineRpcWaiter(requestId, waiter);
      waiter.reject(new HostOnlineRpcUnavailableError());
    }
  }

  private deleteDaemonRegistrationWaiter(
    hostId: string,
    waiter: DaemonRegistrationWaiter,
  ): void {
    clearTimeout(waiter.timeout);
    const waiters = this.daemonRegistrationWaiters.get(hostId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.daemonRegistrationWaiters.delete(hostId);
    }
  }

  private resolveDaemonRegistrationWaiters(hostId: string): void {
    const waiters = this.daemonRegistrationWaiters.get(hostId);
    if (!waiters) {
      return;
    }
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(true);
    }
    this.daemonRegistrationWaiters.delete(hostId);
  }

  private notifyThreadDetailSubscribers(
    threadId: string,
    message: ThreadChangedMessage,
  ): string | null {
    const payload = serializeServerMessage(message);
    if (payload === null) {
      return null;
    }
    const detailSockets = this.clientSocketsByKey.get(
      subscriptionKey({ kind: "thread-detail", threadId }),
    );
    if (detailSockets) {
      this.notifyClientsByKeySet(detailSockets, payload);
    }
    this.notifyChangedMessageListeners(message);
    return payload;
  }

  private notifyThreadEventsAppendedCoalesced(
    threadId: string,
    message: ThreadChangedMessage,
  ): void {
    const payload = this.notifyThreadDetailSubscribers(threadId, message);
    if (payload === null) {
      return;
    }

    const eventTypes = message.metadata?.eventTypes ?? [];
    const pending = this.pendingThreadListEventsAppendedByThread.get(threadId);
    if (pending) {
      for (const eventType of eventTypes) {
        pending.eventTypes.add(eventType);
      }
      if (message.metadata?.timelineSequence !== undefined) {
        pending.timelineSequence = Math.max(
          pending.timelineSequence ?? 0,
          message.metadata.timelineSequence,
        );
      }
      pending.merged = true;
      return;
    }

    this.notifyThreadListOnlySockets(threadId, payload);
    const timeout = setTimeout(() => {
      this.flushPendingThreadListEventsAppended(threadId);
    }, THREAD_LIST_EVENTS_APPENDED_COALESCE_MS);
    timeout.unref?.();
    this.pendingThreadListEventsAppendedByThread.set(threadId, {
      eventTypes: new Set(eventTypes),
      timelineSequence: message.metadata?.timelineSequence,
      merged: false,
      timeout,
    });
  }

  private flushPendingThreadListEventsAppended(threadId: string): void {
    const pending = this.pendingThreadListEventsAppendedByThread.get(threadId);
    if (!pending) {
      return;
    }
    this.pendingThreadListEventsAppendedByThread.delete(threadId);
    if (!pending.merged) {
      return;
    }
    const message: ThreadChangedMessage = {
      type: "changed",
      entity: "thread",
      id: threadId,
      ...(pending.eventTypes.size > 0 || pending.timelineSequence !== undefined
        ? {
            metadata: {
              ...(pending.eventTypes.size > 0
                ? { eventTypes: [...pending.eventTypes] }
                : {}),
              ...(pending.timelineSequence !== undefined
                ? { timelineSequence: pending.timelineSequence }
                : {}),
            },
          }
        : {}),
      changes: ["events-appended"],
    };
    const payload = serializeServerMessage(message);
    if (payload === null) {
      return;
    }
    this.notifyThreadListOnlySockets(threadId, payload);
  }

  private notifyThreadListOnlySockets(threadId: string, payload: string): void {
    const listSockets = this.clientSocketsByKey.get(
      subscriptionKey({ kind: "thread-list" }),
    );
    if (!listSockets) {
      return;
    }
    const detailKey = subscriptionKey({ kind: "thread-detail", threadId });
    for (const socket of listSockets) {
      if (this.clientKeysBySocket.get(socket)?.has(detailKey)) {
        continue;
      }
      socket.send(payload);
    }
  }

  private notifyClients(message: ServerChangedMessage): void {
    const sockets = new Set<HubSocket>();
    for (const key of subscriptionKeysForMessage(message)) {
      const specificSockets = this.clientSocketsByKey.get(key);
      if (!specificSockets) {
        continue;
      }
      for (const socket of specificSockets) {
        sockets.add(socket);
      }
    }

    const payload = serializeServerMessage(message);
    if (payload === null) {
      return;
    }
    this.notifyClientsByKeySet(sockets, payload);
    this.notifyChangedMessageListeners(message);
  }

  private notifyClientsByKeySet(
    sockets: Iterable<HubSocket>,
    payload: string,
  ): void {
    for (const socket of sockets) {
      socket.send(payload);
    }
  }

  private notifyChangedMessageListeners(message: ServerChangedMessage): void {
    for (const listener of this.changedMessageListeners) {
      listener(message);
    }
  }

  sendDaemonMessage(
    hostId: string,
    message: HostDaemonServerWsMessage,
  ): boolean {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    if (!sessionId) {
      return false;
    }
    return this.sendDaemonSessionMessage(sessionId, message);
  }

  sendDaemonSessionMessage(
    sessionId: string,
    message: HostDaemonServerWsMessage,
  ): boolean {
    const session = this.daemonSessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.socket.send(JSON.stringify(message));
    return true;
  }
}
