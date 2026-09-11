import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { readBoundedLines } from "./bounded-line-reader.js";
import { BridgeReplayBuffer } from "./bridge-replay-buffer.js";

export const BRIDGE_SOCKET_ENV = "BB_BRIDGE_SOCKET";
export const BRIDGE_SPILL_ENV = "BB_BRIDGE_SPILL";
export const BRIDGE_SOCKET_TRANSPORT_VERSION = 2 as const;
export const BRIDGE_SHUTDOWN_METHOD = "bridge/shutdown";
export const BRIDGE_RESUME_METHOD = "bridge/resume";
export const BRIDGE_ACK_METHOD = "bridge/ack";
export const BRIDGE_REATTACH_TTL_MS = 30 * 60 * 1000;
export const BRIDGE_REPLAY_MEMORY_CAP_BYTES = 64 * 1024 * 1024;
export const BRIDGE_REPLAY_HARD_CAP_BYTES = 1024 * 1024 * 1024;

export type BridgeSocketShutdownReason = "requested" | "abandoned";

export interface BridgeSocketServerArgs {
  socketPath: string;
  spillPath: string;
  reattachTtlMs: number;
  memoryCapBytes: number;
  hardCapBytes: number;
  onOverflow: (bytes: number) => void;
  onBackpressure: (paused: boolean, retainedBytes: number) => void;
}

export interface BridgeSocketListenArgs {
  onLine: (line: string) => void;
  onShutdown: (reason: BridgeSocketShutdownReason) => void;
}

export interface BridgeSocketServer {
  write(chunk: string | Uint8Array, callback?: (error?: Error) => void): void;
  listen(args: BridgeSocketListenArgs): Promise<void>;
  close(): void;
  replayStats(): ReturnType<BridgeReplayBuffer["stats"]>;
}

type BridgeControlMessage =
  | { kind: "shutdown" }
  | { kind: "resume"; afterWseq: number }
  | { kind: "ack"; through: number; keep: number[] };

export function parseBridgeControlMessage(
  line: string,
): BridgeControlMessage | null {
  if (!line.includes('"bridge/')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const method = Reflect.get(parsed, "method");
  const params: unknown = Reflect.get(parsed, "params");
  const numberParam = (name: string): number | null => {
    if (typeof params !== "object" || params === null) return null;
    const value: unknown = Reflect.get(params, name);
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  };
  if (method === BRIDGE_SHUTDOWN_METHOD) return { kind: "shutdown" };
  if (method === BRIDGE_RESUME_METHOD) {
    const afterWseq = numberParam("afterWseq");
    return afterWseq === null ? null : { kind: "resume", afterWseq };
  }
  if (method === BRIDGE_ACK_METHOD) {
    const through = numberParam("through");
    const keep = wseqListParam(params, "keep");
    return through === null || keep === null
      ? null
      : { kind: "ack", through, keep };
  }
  return null;
}

function wseqListParam(params: unknown, name: string): number[] | null {
  if (typeof params !== "object" || params === null) return null;
  const value: unknown = Reflect.get(params, name);
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const wseqs: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      return null;
    }
    wseqs.push(item);
  }
  return wseqs;
}

export function isBridgeShutdownRequest(line: string): boolean {
  return parseBridgeControlMessage(line)?.kind === "shutdown";
}

export function encodeBridgeFrame(wseq: number, line: string): Buffer {
  return Buffer.from(`${wseq}\t${line}\n`);
}

export function decodeBridgeFrame(
  frame: string,
): { wseq: number; line: string } | null {
  const tab = frame.indexOf("\t");
  if (tab <= 0) return null;
  const wseq = Number(frame.slice(0, tab));
  if (!Number.isSafeInteger(wseq) || wseq <= 0) return null;
  return { wseq, line: frame.slice(tab + 1) };
}

export function createBridgeSocketServer(
  args: BridgeSocketServerArgs,
): BridgeSocketServer {
  let server: Server | null = null;
  let current: Socket | null = null;
  let resumed = false;
  let reattachTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let listenArgs: BridgeSocketListenArgs | null = null;
  let nextWseq = 1;
  let paused = false;
  let kept: readonly number[] = [];
  const decoder = new StringDecoder("utf8");
  let partialLine = "";
  const buffer = new BridgeReplayBuffer({
    spillPath: args.spillPath,
    memoryCapBytes: args.memoryCapBytes,
  });

  function clearReattachTimer(): void {
    if (reattachTimer === null) return;
    clearTimeout(reattachTimer);
    reattachTimer = null;
  }

  function armReattachTimer(): void {
    clearReattachTimer();
    reattachTimer = setTimeout(() => {
      reattachTimer = null;
      shutdown("abandoned");
    }, args.reattachTtlMs);
  }

  function shutdown(reason: BridgeSocketShutdownReason): void {
    if (closed) return;
    const onShutdown = listenArgs?.onShutdown;
    close();
    onShutdown?.(reason);
  }

  function updateBackpressure(): void {
    const retained = buffer.retainedBytes();
    const attached = current !== null && !closed;
    if (!paused && attached && retained > args.hardCapBytes) {
      paused = true;
      args.onBackpressure(true, retained);
    } else if (paused && (!attached || retained <= args.memoryCapBytes)) {
      paused = false;
      args.onBackpressure(false, retained);
    }
  }

  function handleControl(socket: Socket, message: BridgeControlMessage): void {
    if (message.kind === "shutdown") {
      shutdown("requested");
      return;
    }
    if (message.kind === "ack") {
      kept = message.keep;
      buffer.ackThrough(message.through, kept);
      updateBackpressure();
      return;
    }
    buffer.ackThrough(message.afterWseq, kept);
    for (const frame of buffer.framesAfter(message.afterWseq)) {
      socket.write(frame.bytes);
    }
    resumed = true;
    updateBackpressure();
  }

  function attach(socket: Socket): void {
    if (closed || listenArgs === null) {
      socket.destroy();
      return;
    }
    const previous = current;
    current = socket;
    resumed = false;
    clearReattachTimer();
    previous?.destroy();
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (current !== socket) return;
      current = null;
      resumed = false;
      updateBackpressure();
      if (!closed) armReattachTimer();
    });
    const handlers = listenArgs;
    readBoundedLines({
      input: socket,
      onLine: (line) => {
        if (current !== socket) return;
        const control = parseBridgeControlMessage(line);
        if (control !== null) {
          handleControl(socket, control);
          return;
        }
        handlers.onLine(line);
      },
      onOverflow: args.onOverflow,
    });
  }

  function appendLine(line: string): void {
    const wseq = nextWseq;
    nextWseq += 1;
    const bytes = encodeBridgeFrame(wseq, line);
    buffer.append({ wseq, bytes });
    if (current !== null && resumed && current.writable) {
      current.write(bytes);
    }
  }

  function write(
    chunk: string | Uint8Array,
    callback?: (error?: Error) => void,
  ): void {
    const text =
      typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      appendLine(partialLine + text.slice(start, newline));
      partialLine = "";
      start = newline + 1;
    }
    partialLine += text.slice(start);
    updateBackpressure();
    if (callback !== undefined) queueMicrotask(() => callback());
  }

  function listen(handlers: BridgeSocketListenArgs): Promise<void> {
    listenArgs = handlers;
    const listening = createServer(attach);
    server = listening;
    return new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(args.socketPath, () => {
        listening.off("error", reject);
        try {
          chmodSync(args.socketPath, 0o600);
        } catch {}
        if (current === null) armReattachTimer();
        resolve();
      });
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearReattachTimer();
    current?.destroy();
    current = null;
    updateBackpressure();
    buffer.dispose();
    const listening = server;
    server = null;
    if (listening !== null) {
      listening.close();
      removeSocketFile(args.socketPath);
    }
  }

  return { write, listen, close, replayStats: () => buffer.stats() };
}

function removeSocketFile(socketPath: string): void {
  if (process.platform === "win32") return;
  try {
    unlinkSync(socketPath);
  } catch {}
}
