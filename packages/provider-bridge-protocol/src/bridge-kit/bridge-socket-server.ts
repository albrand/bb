import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { readBoundedLines } from "./bounded-line-reader.js";

export const BRIDGE_SOCKET_ENV = "BB_BRIDGE_SOCKET";
export const BRIDGE_SHUTDOWN_METHOD = "bridge/shutdown";
export const BRIDGE_REATTACH_TTL_MS = 30 * 60 * 1000;
export const BRIDGE_DISCONNECTED_BUFFER_MAX_BYTES = 64 * 1024 * 1024;

export type BridgeSocketShutdownReason = "requested" | "abandoned";

export interface BridgeSocketServerArgs {
  socketPath: string;
  reattachTtlMs: number;
  onOverflow: (bytes: number) => void;
  onDroppedOutput: (bytes: number) => void;
}

export interface BridgeSocketListenArgs {
  onLine: (line: string) => void;
  onShutdown: (reason: BridgeSocketShutdownReason) => void;
}

export interface BridgeSocketServer {
  write(chunk: string | Uint8Array, callback?: (error?: Error) => void): void;
  listen(args: BridgeSocketListenArgs): Promise<void>;
  close(): void;
}

export function isBridgeShutdownRequest(line: string): boolean {
  if (!line.includes(BRIDGE_SHUTDOWN_METHOD)) return false;
  try {
    const parsed: unknown = JSON.parse(line);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Reflect.get(parsed, "method") === BRIDGE_SHUTDOWN_METHOD
    );
  } catch {
    return false;
  }
}

export function createBridgeSocketServer(
  args: BridgeSocketServerArgs,
): BridgeSocketServer {
  let server: Server | null = null;
  let current: Socket | null = null;
  let reattachTimer: NodeJS.Timeout | null = null;
  let closed = false;
  const queued: Buffer[] = [];
  let queuedBytes = 0;
  let listenArgs: BridgeSocketListenArgs | null = null;

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

  function attach(socket: Socket): void {
    if (closed || listenArgs === null) {
      socket.destroy();
      return;
    }
    const previous = current;
    current = socket;
    clearReattachTimer();
    previous?.destroy();
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (current !== socket) return;
      current = null;
      if (!closed) armReattachTimer();
    });
    const handlers = listenArgs;
    readBoundedLines({
      input: socket,
      onLine: (line) => {
        if (current !== socket) return;
        if (isBridgeShutdownRequest(line)) {
          shutdown("requested");
          return;
        }
        handlers.onLine(line);
      },
      onOverflow: args.onOverflow,
    });
    const pending = queued.splice(0);
    queuedBytes = 0;
    for (const chunk of pending) {
      socket.write(chunk);
    }
  }

  function write(
    chunk: string | Uint8Array,
    callback?: (error?: Error) => void,
  ): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (current !== null && current.writable) {
      current.write(bytes, (error) => callback?.(error ?? undefined));
      return;
    }
    if (queuedBytes + bytes.length > BRIDGE_DISCONNECTED_BUFFER_MAX_BYTES) {
      args.onDroppedOutput(bytes.length);
    } else {
      queued.push(Buffer.from(bytes));
      queuedBytes += bytes.length;
    }
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
    const listening = server;
    server = null;
    if (listening !== null) {
      listening.close();
      removeSocketFile(args.socketPath);
    }
  }

  return { write, listen, close };
}

function removeSocketFile(socketPath: string): void {
  if (process.platform === "win32") return;
  try {
    unlinkSync(socketPath);
  } catch {}
}
