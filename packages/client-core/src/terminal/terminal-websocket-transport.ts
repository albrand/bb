import { getTerminalBase64DecodedByteLength } from "@bb/domain";
import {
  terminalServerMessageSchema,
  type TerminalServerMessage,
} from "@bb/server-contract";

const SOCKET_OPEN = 1;
const DEFAULT_INPUT_QUEUE_MAX_BYTES = 1024 * 1024;
const DEFAULT_SOCKET_HIGH_WATER_BYTES = 1024 * 1024;
const DEFAULT_DRAIN_POLL_MS = 10;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const REPAINT_RESTORE_DELAY_MS = 400;
const ATTACH_RESIZE_SETTLE_CEILING_MS = 5_000;
const DEFAULT_RECONNECT_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

export type TerminalSocketConnectionState =
  | "connecting"
  | "attached"
  | "reconnecting"
  | "closed";

export interface TerminalBrowserSocket {
  bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => void) | null;
  readonly readyState: number;
  send(data: string): void;
}

export type CreateTerminalBrowserSocket = (
  url: string,
) => TerminalBrowserSocket;

function repaintNudgeSize(size: {
  cols: number;
  rows: number;
}): { cols: number; rows: number } | null {
  if (size.cols > 1) {
    return { cols: size.cols - 1, rows: size.rows };
  }
  if (size.rows > 1) {
    return { cols: size.cols, rows: size.rows - 1 };
  }
  return null;
}

function socketBufferedAmount(socket: TerminalBrowserSocket): number {
  return socket.bufferedAmount ?? 0;
}

function terminalSocketUrl(url: string, sinceSeq: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set("sinceSeq", String(sinceSeq));
  parsed.searchParams.set("outputAcks", "1");
  parsed.searchParams.set("resizeAcks", "1");
  return parsed.toString();
}

interface RepaintNudgeInFlight {
  echoTaken: boolean;
  finalSeq: number | null;
  ignored: { cols: number; rows: number } | null;
  nudge: { cols: number; rows: number };
  nudgeSeq: number;
}

interface PendingTerminalInput {
  bytes: number;
  enqueuedAt: number;
  payload: string;
}

export interface TerminalWebSocketTransportOptions {
  terminalId?: string;
  createSocket?: CreateTerminalBrowserSocket;
  drainPollMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  inputQueueMaxBytes?: number;
  now?: () => number;
  onConnectionState?: (state: TerminalSocketConnectionState) => void;
  onInputOverflow?: (maxBytes: number) => void;
  onInputEnqueued?: (
    terminalId: string,
    timestamp: number,
    inputEventAt?: number,
  ) => void;
  onInputSent?: (
    terminalId: string,
    enqueuedAt: number,
    sentAt: number,
  ) => void;
  onOutputFrameReceived?: (terminalId: string, timestamp: number) => void;
  onInvalidMessage?: () => void;
  onMessage: (message: TerminalServerMessage) => void;
  onRepaintNudgeSizeReleased?: (size: { cols: number; rows: number }) => void;
  onSequenceGap?: (expectedSeq: number, receivedSeq: number) => void;
  reconnectDelaysMs?: readonly number[];
  shouldReconnect: () => boolean;
  socketHighWaterBytes?: number;
  url: string;
}

export class TerminalWebSocketTransport {
  private readonly createSocket: CreateTerminalBrowserSocket;
  private readonly drainPollMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly inputQueueMaxBytes: number;
  private readonly now: () => number;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly socketHighWaterBytes: number;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private lastResize: { cols: number; rows: number } | null = null;
  private nextOutputSeq = 0;
  private pendingOutputAckNextSeq: number | null = null;
  private pendingInputBytes = 0;
  private readonly pendingInputs: PendingTerminalInput[] = [];
  private reconnectAttempt = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private layoutSettled = false;
  private resizeReportedAfterLayoutSettle = false;
  private repaintRequestedWhileSettling = false;
  private ackedResizeSeq = 0;
  private nextResizeSeq = 0;
  private resizeAcksConfirmed = false;
  private repaintNudgeInFlight: RepaintNudgeInFlight | null = null;
  private repaintTimeout: ReturnType<typeof setTimeout> | null = null;
  private settleTimeout: ReturnType<typeof setTimeout> | null = null;
  private socket: TerminalBrowserSocket | null = null;
  private terminalEnded = false;
  private visible = true;
  private visibilityReported = false;

  constructor(private readonly options: TerminalWebSocketTransportOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.drainPollMs = options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.inputQueueMaxBytes =
      options.inputQueueMaxBytes ?? DEFAULT_INPUT_QUEUE_MAX_BYTES;
    this.now = options.now ?? Date.now;
    this.reconnectDelaysMs =
      options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.socketHighWaterBytes =
      options.socketHighWaterBytes ?? DEFAULT_SOCKET_HIGH_WATER_BYTES;
  }

  start(): void {
    if (this.disposed || this.socket !== null) {
      return;
    }
    this.connect("connecting");
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearReconnectTimeout();
    this.clearDrainTimeout();
    this.clearRepaintTimeout();
    this.clearSettleTimeout();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close();
    }
    this.options.onConnectionState?.("closed");
  }

  sendInput(dataBase64: string, inputEventAt?: number): boolean {
    const tracksInputTiming =
      this.options.onInputEnqueued !== undefined ||
      this.options.onInputSent !== undefined;
    const enqueuedAt = tracksInputTiming ? this.now() : 0;
    const pending = {
      bytes: getTerminalBase64DecodedByteLength(dataBase64),
      enqueuedAt,
      payload: JSON.stringify({
        type: "input",
        dataBase64,
      }),
    };
    const socket = this.socket;
    if (
      socket !== null &&
      socket.readyState === SOCKET_OPEN &&
      socketBufferedAmount(socket) <= this.socketHighWaterBytes &&
      this.pendingInputs.length === 0
    ) {
      this.options.onInputEnqueued?.(
        this.options.terminalId ?? "",
        enqueuedAt,
        inputEventAt,
      );
      const onSent = this.options.onInputSent
        ? (sentAt: number) =>
            this.options.onInputSent?.(
              this.options.terminalId ?? "",
              enqueuedAt,
              sentAt,
            )
        : undefined;
      if (this.trySend(socket, pending.payload, onSent)) {
        return true;
      }
      return this.enqueueInput(pending, inputEventAt, true);
    }
    return this.enqueueInput(pending, inputEventAt);
  }

  acknowledgeOutput(nextSeq: number): void {
    if (
      this.pendingOutputAckNextSeq !== null &&
      nextSeq <= this.pendingOutputAckNextSeq
    ) {
      return;
    }
    const scheduled = this.pendingOutputAckNextSeq !== null;
    this.pendingOutputAckNextSeq = nextSeq;
    if (scheduled) {
      return;
    }
    queueMicrotask(() => {
      const ackNextSeq = this.pendingOutputAckNextSeq;
      this.pendingOutputAckNextSeq = null;
      const socket = this.socket;
      if (
        ackNextSeq === null ||
        socket === null ||
        socket.readyState !== SOCKET_OPEN
      ) {
        return;
      }
      this.trySend(
        socket,
        JSON.stringify({ type: "ack", nextSeq: ackNextSeq }),
      );
    });
  }

  setVisible(visible: boolean): void {
    this.visibilityReported = true;
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    const socket = this.socket;
    if (socket !== null && socket.readyState === SOCKET_OPEN) {
      this.trySend(socket, JSON.stringify({ type: "visibility", visible }));
      if (visible && this.lastResize !== null && this.settleTimeout === null) {
        this.sendResizeMessage(socket, this.lastResize);
      }
    }
  }

  replayOutputFrom(nextSeq: number): void {
    if (this.disposed || this.terminalEnded || nextSeq < 0) {
      return;
    }
    this.nextOutputSeq = nextSeq;
    this.pendingOutputAckNextSeq = null;
    const socket = this.socket;
    if (socket === null) {
      this.connect("reconnecting");
      return;
    }
    this.socket = null;
    this.stopHeartbeat();
    this.clearDrainTimeout();
    this.clearRepaintTimeout();
    socket.close();
    this.connect("reconnecting");
  }

  sendResize(cols: number, rows: number): void {
    if (this.lastResize?.cols === cols && this.lastResize.rows === rows) {
      return;
    }
    this.lastResize = { cols, rows };
    this.cancelRepaintRestore();
    const socket = this.socket;
    if (
      this.settleTimeout !== null ||
      socket === null ||
      socket.readyState !== SOCKET_OPEN
    ) {
      this.repaintNudgeInFlight = null;
      return;
    }
    const sent = this.sendResizeMessage(socket, { cols, rows }, (seq) =>
      this.setRepaintFinalSeq(seq),
    );
    if (this.layoutSettled && sent) {
      this.resizeReportedAfterLayoutSettle = true;
    }
  }

  private setRepaintFinalSeq(seq: number | null): void {
    const inFlight = this.repaintNudgeInFlight;
    if (inFlight === null) {
      return;
    }
    if (seq === null) {
      this.repaintNudgeInFlight = null;
      return;
    }
    inFlight.finalSeq = seq;
  }

  private sendResizeMessage(
    socket: TerminalBrowserSocket,
    size: { cols: number; rows: number },
    onSeq: (seq: number | null) => void = () => undefined,
  ): boolean {
    if (!this.resizeAcksConfirmed) {
      onSeq(null);
      return this.trySend(socket, JSON.stringify({ type: "resize", ...size }));
    }
    const seq = this.nextResizeSeq + 1;
    this.nextResizeSeq = seq;
    onSeq(seq);
    return this.trySend(
      socket,
      JSON.stringify({ type: "resize", ...size, seq }),
    );
  }

  requestRepaint(): void {
    if (this.settleTimeout !== null) {
      this.repaintRequestedWhileSettling = true;
      return;
    }
    const socket = this.socket;
    if (
      this.lastResize === null ||
      socket === null ||
      socket.readyState !== SOCKET_OPEN
    ) {
      return;
    }
    this.clearRepaintTimeout();
    this.repaintTimeout = setTimeout(() => {
      this.repaintTimeout = null;
      const current = this.lastResize;
      if (
        this.disposed ||
        this.socket !== socket ||
        socket.readyState !== SOCKET_OPEN ||
        current === null
      ) {
        return;
      }
      const nudgeSize = repaintNudgeSize(current);
      if (nudgeSize === null) {
        return;
      }
      this.sendResizeMessage(socket, nudgeSize, (nudgeSeq) => {
        this.repaintNudgeInFlight =
          nudgeSeq === null
            ? null
            : {
                echoTaken: false,
                finalSeq: null,
                ignored: null,
                nudge: nudgeSize,
                nudgeSeq,
              };
      });
      this.repaintTimeout = setTimeout(() => {
        this.repaintTimeout = null;
        if (
          this.disposed ||
          this.socket !== socket ||
          socket.readyState !== SOCKET_OPEN ||
          this.lastResize !== current
        ) {
          this.repaintNudgeInFlight = null;
          return;
        }
        this.sendResizeMessage(socket, current, (restoreSeq) =>
          this.setRepaintFinalSeq(restoreSeq),
        );
      }, REPAINT_RESTORE_DELAY_MS);
    }, 0);
  }

  consumeRepaintNudgeEcho(size: { cols: number; rows: number }): boolean {
    const inFlight = this.repaintNudgeInFlight;
    if (inFlight === null) {
      return false;
    }
    if (
      !inFlight.echoTaken &&
      size.cols === inFlight.nudge.cols &&
      size.rows === inFlight.nudge.rows
    ) {
      inFlight.echoTaken = true;
      inFlight.ignored = size;
      return true;
    }
    inFlight.ignored = null;
    return false;
  }

  private handleResizeApplied(seq: number): void {
    this.ackedResizeSeq = Math.max(this.ackedResizeSeq, seq);
    const inFlight = this.repaintNudgeInFlight;
    if (inFlight === null) {
      return;
    }
    if (this.ackedResizeSeq >= inFlight.nudgeSeq) {
      inFlight.echoTaken = true;
    }
    if (inFlight.finalSeq === null || this.ackedResizeSeq < inFlight.finalSeq) {
      return;
    }
    this.repaintNudgeInFlight = null;
    if (inFlight.ignored !== null) {
      this.options.onRepaintNudgeSizeReleased?.(inFlight.ignored);
    }
  }

  private connect(state: "connecting" | "reconnecting"): void {
    if (this.disposed || this.terminalEnded) {
      return;
    }
    this.options.onConnectionState?.(state);
    let socket: TerminalBrowserSocket;
    try {
      socket = this.createSocket(
        terminalSocketUrl(this.options.url, this.nextOutputSeq),
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.ackedResizeSeq = 0;
    this.nextResizeSeq = 0;
    this.resizeAcksConfirmed = false;
    this.resizeReportedAfterLayoutSettle = false;
    this.repaintNudgeInFlight = null;
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => this.handleMessage(socket, event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => this.handleClose(socket);
  }

  private handleOpen(socket: TerminalBrowserSocket): void {
    if (this.disposed || this.socket !== socket) {
      return;
    }
    this.lastPongAt = this.now();
    this.startHeartbeat(socket);
    if (this.visibilityReported) {
      this.trySend(
        socket,
        JSON.stringify({ type: "visibility", visible: this.visible }),
      );
    }
    this.beginResizeSettle(socket);
    this.flushInputs();
  }

  markLayoutSettled(): void {
    this.layoutSettled = true;
    if (this.settleTimeout !== null) {
      this.flushSettledResize();
      return;
    }
    const socket = this.socket;
    const size = this.lastResize;
    if (socket !== null && socket.readyState === SOCKET_OPEN && size !== null) {
      this.sendSettledResize(socket, size);
    }
  }

  private beginResizeSettle(socket: TerminalBrowserSocket): void {
    this.clearSettleTimeout();
    if (this.lastResize === null) {
      return;
    }
    if (this.layoutSettled) {
      this.sendSettledResize(socket, this.lastResize);
      return;
    }
    this.settleTimeout = setTimeout(
      () => this.flushSettledResize(),
      ATTACH_RESIZE_SETTLE_CEILING_MS,
    );
  }

  private flushSettledResize(): void {
    if (this.settleTimeout !== null) {
      clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
    const socket = this.socket;
    const settled = this.lastResize;
    const repaintRequested = this.repaintRequestedWhileSettling;
    this.repaintRequestedWhileSettling = false;
    if (
      this.disposed ||
      socket === null ||
      socket.readyState !== SOCKET_OPEN ||
      settled === null
    ) {
      return;
    }
    this.sendSettledResize(socket, settled);
    if (repaintRequested) {
      this.requestRepaint();
    }
  }

  private sendSettledResize(
    socket: TerminalBrowserSocket,
    size: { cols: number; rows: number },
  ): boolean {
    if (this.resizeReportedAfterLayoutSettle) {
      return true;
    }
    this.resizeReportedAfterLayoutSettle = this.sendResizeMessage(socket, size);
    return this.resizeReportedAfterLayoutSettle;
  }

  private clearSettleTimeout(): void {
    if (this.settleTimeout !== null) {
      clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
    this.repaintRequestedWhileSettling = false;
  }

  private handleMessage(socket: TerminalBrowserSocket, raw: unknown): void {
    if (this.disposed || this.socket !== socket || typeof raw !== "string") {
      return;
    }
    const receivedAt = this.options.onOutputFrameReceived ? this.now() : 0;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.options.onInvalidMessage?.();
      return;
    }
    const parsed = terminalServerMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.options.onInvalidMessage?.();
      return;
    }
    const message = parsed.data;
    if (message.type === "pong") {
      this.lastPongAt = this.now();
    }
    if (message.type === "features") {
      this.resizeAcksConfirmed = true;
      return;
    }
    if (message.type === "resize-applied") {
      this.handleResizeApplied(message.seq);
      return;
    }
    if (message.type === "attached") {
      this.reconnectAttempt = 0;
      this.options.onConnectionState?.("attached");
    }
    if (
      message.type === "attached" &&
      message.replayStartSeq > this.nextOutputSeq
    ) {
      this.options.onSequenceGap?.(this.nextOutputSeq, message.replayStartSeq);
      this.nextOutputSeq = message.replayStartSeq;
    }
    if (message.type === "output") {
      if (message.chunk.seq < this.nextOutputSeq) {
        return;
      }
      if (message.chunk.seq > this.nextOutputSeq) {
        this.options.onSequenceGap?.(this.nextOutputSeq, message.chunk.seq);
      }
      this.nextOutputSeq = message.chunk.seq + 1;
      this.options.onOutputFrameReceived?.(
        this.options.terminalId ?? "",
        receivedAt,
      );
    }
    if (message.type === "exited") {
      this.terminalEnded = true;
      this.clearReconnectTimeout();
    }
    if (
      message.type === "error" &&
      [
        "terminal_exited",
        "terminal_not_found",
        "terminal_not_running",
      ].includes(message.code)
    ) {
      this.terminalEnded = true;
      this.clearReconnectTimeout();
    }
    this.options.onMessage(message);
  }

  private handleClose(socket: TerminalBrowserSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.stopHeartbeat();
    this.clearDrainTimeout();
    this.clearRepaintTimeout();
    this.clearSettleTimeout();
    if (
      this.disposed ||
      this.terminalEnded ||
      !this.options.shouldReconnect()
    ) {
      this.options.onConnectionState?.("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (
      this.disposed ||
      this.terminalEnded ||
      this.reconnectTimeout !== null ||
      !this.options.shouldReconnect()
    ) {
      return;
    }
    this.options.onConnectionState?.("reconnecting");
    const delayIndex = Math.min(
      this.reconnectAttempt,
      this.reconnectDelaysMs.length - 1,
    );
    const delay = this.reconnectDelaysMs[delayIndex] ?? 0;
    this.reconnectAttempt += 1;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect("reconnecting");
    }, delay);
  }

  private enqueueInput(
    pending: PendingTerminalInput,
    inputEventAt?: number,
    alreadyRecorded = false,
  ): boolean {
    if (this.pendingInputBytes + pending.bytes > this.inputQueueMaxBytes) {
      this.options.onInputOverflow?.(this.inputQueueMaxBytes);
      return false;
    }
    this.pendingInputs.push(pending);
    this.pendingInputBytes += pending.bytes;
    if (!alreadyRecorded) {
      this.options.onInputEnqueued?.(
        this.options.terminalId ?? "",
        pending.enqueuedAt,
        inputEventAt,
      );
    }
    this.scheduleDrain();
    return true;
  }

  private flushInputs(): void {
    this.clearDrainTimeout();
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      return;
    }
    while (
      this.pendingInputs.length > 0 &&
      socketBufferedAmount(socket) <= this.socketHighWaterBytes
    ) {
      const pending = this.pendingInputs[0];
      if (
        !pending ||
        !this.trySend(
          socket,
          pending.payload,
          this.options.onInputSent
            ? (sentAt) =>
                this.options.onInputSent?.(
                  this.options.terminalId ?? "",
                  pending.enqueuedAt,
                  sentAt,
                )
            : undefined,
        )
      ) {
        break;
      }
      this.pendingInputs.shift();
      this.pendingInputBytes -= pending.bytes;
    }
    if (this.pendingInputs.length > 0) {
      this.scheduleDrain();
    }
  }

  private trySend(
    socket: TerminalBrowserSocket,
    payload: string,
    onSent?: (sentAt: number) => void,
  ): boolean {
    if (socket.readyState !== SOCKET_OPEN) {
      return false;
    }
    try {
      const sentAt = onSent === undefined ? undefined : this.now();
      socket.send(payload);
      if (onSent !== undefined && sentAt !== undefined) onSent(sentAt);
      return true;
    } catch {
      try {
        socket.close(1011, "send-failed");
      } catch {
        this.handleClose(socket);
      }
      return false;
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimeout !== null || this.socket?.readyState !== SOCKET_OPEN) {
      return;
    }
    this.drainTimeout = setTimeout(() => {
      this.drainTimeout = null;
      this.flushInputs();
    }, this.drainPollMs);
  }

  private clearDrainTimeout(): void {
    if (this.drainTimeout === null) {
      return;
    }
    clearTimeout(this.drainTimeout);
    this.drainTimeout = null;
  }

  private clearRepaintTimeout(): void {
    this.repaintNudgeInFlight = null;
    this.cancelRepaintRestore();
  }

  private cancelRepaintRestore(): void {
    if (this.repaintTimeout === null) {
      return;
    }
    clearTimeout(this.repaintTimeout);
    this.repaintTimeout = null;
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout === null) {
      return;
    }
    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
  }

  private startHeartbeat(socket: TerminalBrowserSocket): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== SOCKET_OPEN) {
        return;
      }
      if (this.now() - this.lastPongAt > this.heartbeatTimeoutMs) {
        socket.close(4000, "heartbeat-timeout");
        return;
      }
      this.trySend(socket, JSON.stringify({ type: "ping" }));
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval === null) {
      return;
    }
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }
}
