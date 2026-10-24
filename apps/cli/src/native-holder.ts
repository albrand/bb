import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const NATIVE_HOLDER_REAP_AFTER_MS = 15 * 60_000;
const NATIVE_HOLDER_FIRST_CLIENT_TIMEOUT_MS = 20_000;
const NATIVE_HOLDER_REAP_CHECK_MS = 30_000;
const UNIX_SOCKET_PATH_MAX_BYTES = 100;
const NATIVE_HOLDER_LOG_MAX_BYTES = 256 * 1024;
const NATIVE_HOLDER_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

export function writeNativeHolderAttachMarker(
  output: { write(chunk: string): unknown },
  terminalId: string,
): void {
  output.write(`\u001b]7717;bb-holder;${terminalId}\u0007`);
}

export function logNativeHolderEvent(
  socketPath: string,
  event: string,
  fields: Record<string, number | string | null>,
): void {
  const logPath = socketPath.endsWith(".sock")
    ? socketPath.replace(/\.sock$/u, ".log")
    : `${socketPath}.log`;
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, 200) : value,
    ]),
  );
  const line = `${JSON.stringify({
    time: new Date().toISOString(),
    event: event.slice(0, 200),
    ...safeFields,
  })}\n`;
  try {
    const lineBytes = Buffer.byteLength(line);
    const fd = openSync(logPath, "a", 0o600);
    try {
      fchmodSync(fd, 0o600);
      const existingSize = fstatSync(fd).size;
      if (
        existingSize > NATIVE_HOLDER_LOG_MAX_BYTES ||
        (lineBytes <= NATIVE_HOLDER_LOG_MAX_BYTES &&
          existingSize + lineBytes > NATIVE_HOLDER_LOG_MAX_BYTES)
      ) {
        ftruncateSync(fd, 0);
      }
      if (lineBytes <= NATIVE_HOLDER_LOG_MAX_BYTES) {
        const record = Buffer.from(line);
        let offset = 0;
        while (offset < record.length) {
          offset += writeSync(fd, record, offset, record.length - offset);
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return;
  }
}

export const NativeHolderFrame = {
  input: 1,
  resize: 2,
  credential: 3,
  output: 17,
  exit: 18,
} as const;

export interface NativeHolderMessage {
  type: number;
  payload: Buffer;
}

export function encodeNativeHolderFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export class NativeHolderFrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): NativeHolderMessage[] {
    this.buffered =
      this.buffered.length === 0
        ? chunk
        : Buffer.concat([this.buffered, chunk]);
    const messages: NativeHolderMessage[] = [];
    while (this.buffered.length >= 5) {
      const length = this.buffered.readUInt32BE(1);
      if (this.buffered.length < 5 + length) break;
      messages.push({
        type: this.buffered.readUInt8(0),
        payload: Buffer.from(this.buffered.subarray(5, 5 + length)),
      });
      this.buffered = this.buffered.subarray(5 + length);
    }
    return messages;
  }
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

function parseSize(payload: Buffer): TerminalSize | null {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { cols, rows } = value as Record<string, unknown>;
  if (typeof cols !== "number" || typeof rows !== "number") return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < 1 || rows < 1) return null;
  return { cols, rows };
}

function parseExitCode(payload: Buffer): number {
  try {
    const value: unknown = JSON.parse(payload.toString("utf8"));
    if (typeof value === "object" && value !== null) {
      const code = (value as Record<string, unknown>).code;
      if (typeof code === "number" && Number.isInteger(code)) return code;
    }
  } catch {
    return 1;
  }
  return 1;
}

export function nativeHolderSocketPath(args: {
  baseUrl: string;
  home: string;
  threadId: string;
  tmpDir: string;
}): string {
  const scope = createHash("sha256")
    .update(args.baseUrl)
    .digest("hex")
    .slice(0, 8);
  const name = `${args.threadId}-${scope}.sock`;
  const inHome = path.join(args.home, ".bb", "native-terminals", name);
  if (Buffer.byteLength(inHome) <= UNIX_SOCKET_PATH_MAX_BYTES) return inHome;
  return path.join(args.tmpDir, "bb-native-terminals", name);
}

export function defaultNativeHolderSocketPath(
  baseUrl: string,
  threadId: string,
): string {
  return nativeHolderSocketPath({
    baseUrl,
    home: os.homedir(),
    threadId,
    tmpDir: os.tmpdir(),
  });
}

export function nativeHolderStatusSocketPath(socketPath: string): string {
  return socketPath.endsWith(".sock")
    ? socketPath.replace(/\.sock$/u, ".p")
    : `${socketPath}.p`;
}

export async function nativeHolderIsAlive(
  socketPath: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  const statusPath = nativeHolderStatusSocketPath(socketPath);
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(statusPath);
    let settled = false;
    let response = "";
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.length >= 1) finish(response[0] === "1");
    });
    socket.on("end", () => finish(response === "1"));
    socket.on("error", () => finish(false));
  });
}

function listenPrivately(server: net.Server, socketPath: string): void {
  const previous = process.umask(0o177);
  try {
    server.listen(socketPath);
  } finally {
    process.umask(previous);
  }
}

export interface NativeHolderPty {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NativeHolderProcess {
  command: string;
  args: string[];
}

export interface RunNativeHolderOptions {
  socketPath: string;
  holderPid?: number;
  holderPgid?: number;
  holderSid?: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  reapAfterMs?: number;
  firstClientTimeoutMs?: number;
  credentialRoot?: string;
  prepare(context: {
    credential: string | null;
    credentialSocket: string;
    currentCredential(): string | null;
  }): Promise<NativeHolderProcess>;
  onCredentialChanged?(): void;
  spawnPty(
    process: NativeHolderProcess,
    options: {
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): NativeHolderPty;
  tick?(): Promise<void>;
  tickIntervalMs?: number;
  checkTerminal?(): Promise<NativeTerminalCheck>;
  detachedCheckIntervalMs?: number;
  onSocketReady?(): void;
  onSocketClosed?(): void;
}

const TERMINAL_CLOSES_THAT_STOP_THE_CLI = new Set([
  "user",
  "thread-archived",
  "thread-deleted",
  "environment-destroyed",
  "host-removed",
]);

const NATIVE_HOLDER_IGNORED_SIGNALS = [
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGTERM",
] as const;

export function ignoreNativeHolderSignals(
  target: NodeJS.Process,
  socketPath?: string,
  ownsSocket: () => boolean = () => true,
): () => void {
  const ignore = (signal: (typeof NATIVE_HOLDER_IGNORED_SIGNALS)[number]) =>
    (): void => {
      if (socketPath !== undefined && ownsSocket()) {
        logNativeHolderEvent(socketPath, "ignored-signal", { signal });
      }
    };
  const handlers = new Map(
    NATIVE_HOLDER_IGNORED_SIGNALS.map((signal) => [signal, ignore(signal)]),
  );
  for (const signal of NATIVE_HOLDER_IGNORED_SIGNALS) {
    const handler = handlers.get(signal);
    if (handler !== undefined) target.on(signal, handler);
  }
  return () => {
    for (const signal of NATIVE_HOLDER_IGNORED_SIGNALS) {
      const handler = handlers.get(signal);
      if (handler !== undefined) target.off(signal, handler);
    }
  };
}

export function nativeTerminalClosedForGood(
  view: {
    terminal: { status: string; closeReason: string | null } | null;
  } | null,
): boolean {
  if (view === null) return true;
  const terminal = view.terminal;
  if (terminal === null || terminal.status !== "exited") return false;
  return (
    terminal.closeReason !== null &&
    TERMINAL_CLOSES_THAT_STOP_THE_CLI.has(terminal.closeReason)
  );
}

export type NativeTerminalCheck =
  | "closed-for-good"
  | "awaiting-daemon"
  | "detached";

export function nativeTerminalCheck(
  view: {
    terminal: { status: string; closeReason: string | null } | null;
  } | null,
): NativeTerminalCheck {
  if (nativeTerminalClosedForGood(view)) return "closed-for-good";
  return view?.terminal?.status === "disconnected"
    ? "awaiting-daemon"
    : "detached";
}

function removeSocketFile(
  socketPath: string,
  expected?: { dev: number; ino: number },
): void {
  try {
    if (expected !== undefined) {
      const current = lstatSync(socketPath);
      if (current.dev !== expected.dev || current.ino !== expected.ino) return;
    }
    unlinkSync(socketPath);
  } catch {
    return;
  }
}

function writeFrame(
  socket: net.Socket | null,
  type: number,
  payload: Buffer,
): void {
  if (socket === null || socket.destroyed) return;
  socket.write(encodeNativeHolderFrame(type, payload));
}

export async function runNativeHolder(
  options: RunNativeHolderOptions,
): Promise<number> {
  mkdirSync(path.dirname(options.socketPath), { recursive: true, mode: 0o700 });
  const reapAfterMs = options.reapAfterMs ?? NATIVE_HOLDER_REAP_AFTER_MS;
  let client: net.Socket | null = null;
  let detachedSince = Date.now();
  let pty: NativeHolderPty | null = null;
  let pendingSize: TerminalSize | null = null;
  let pendingInput = "";
  let pendingOutput: Buffer[] = [];
  let pendingOutputBytes = 0;
  let redrawOnResize = false;
  let credential: string | null = null;
  let starting = false;
  let finished = false;
  let ptyExited = false;
  let pausedFor: string | null = null;
  let terminalCheckSettledSinceDetach = false;
  let mainSocketIdentity: { dev: number; ino: number } | null = null;
  let statusSocketIdentity: { dev: number; ino: number } | null = null;
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const timers: NodeJS.Timeout[] = [];

  const server = net.createServer();
  const statusSocketPath = nativeHolderStatusSocketPath(options.socketPath);
  const statusServer = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.end(pty !== null && !finished ? "1" : "0");
  });
  const credentialDir = mkdtempSync(
    path.join(options.credentialRoot ?? os.tmpdir(), "bb-nc-"),
  );
  chmodSync(credentialDir, 0o700);
  const credentialSocketPath = path.join(credentialDir, "s");
  const credentialServer = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.end(credential ?? "");
  });
  let finishReason = "child exited";
  const finish = (code: number, reason = finishReason): void => {
    if (finished) return;
    finished = true;
    logNativeHolderEvent(options.socketPath, "holder-finish", { reason });
    options.onSocketClosed?.();
    for (const timer of timers) clearInterval(timer);
    writeFrame(
      client,
      NativeHolderFrame.exit,
      Buffer.from(JSON.stringify({ code })),
    );
    client?.end();
    server.close();
    if (mainSocketIdentity !== null) {
      removeSocketFile(options.socketPath, mainSocketIdentity);
    }
    statusServer.close();
    if (statusSocketIdentity !== null) {
      removeSocketFile(statusSocketPath, statusSocketIdentity);
    }
    credential = null;
    credentialServer.close();
    rmSync(credentialDir, { recursive: true, force: true });
    resolveExit(code);
  };

  const applySize = (next: TerminalSize): void => {
    if (ptyExited) return;
    const activePty = pty;
    if (activePty === null) {
      pendingSize = next;
      return;
    }
    const resize = (cols: number, rows: number): void => {
      try {
        activePty.resize(cols, rows);
      } catch (error) {
        if (
          ptyExited ||
          (error instanceof Error &&
            (("code" in error && error.code === "EBADF") ||
              error.message.endsWith(", EBADF")))
        ) {
          return;
        }
        throw error;
      }
    };
    if (redrawOnResize) {
      redrawOnResize = false;
      resize(next.cols, next.rows > 1 ? next.rows - 1 : next.rows + 1);
    }
    resize(next.cols, next.rows);
  };

  const sendOutput = (data: Buffer): void => {
    if (client !== null) {
      writeFrame(client, NativeHolderFrame.output, data);
      return;
    }
    pendingOutput.push(data);
    pendingOutputBytes += data.byteLength;
    while (
      pendingOutputBytes > NATIVE_HOLDER_OUTPUT_MAX_BYTES &&
      pendingOutput.length > 0
    ) {
      const first = pendingOutput[0];
      if (first === undefined) break;
      const excess = pendingOutputBytes - NATIVE_HOLDER_OUTPUT_MAX_BYTES;
      if (first.byteLength <= excess) {
        pendingOutput.shift();
        pendingOutputBytes -= first.byteLength;
      } else {
        pendingOutput[0] = first.subarray(excess);
        pendingOutputBytes -= excess;
      }
    }
  };

  const start = async (): Promise<void> => {
    if (starting) return;
    starting = true;
    let child: NativeHolderProcess;
    try {
      child = await options.prepare({
        credential,
        credentialSocket: credentialSocketPath,
        currentCredential: () => credential,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendOutput(Buffer.from(`${message}\r\n`));
      finish(1);
      return;
    }
    const initial = pendingSize ?? { cols: 120, rows: 40 };
    try {
      pty = options.spawnPty(child, {
        cols: initial.cols,
        rows: initial.rows,
        cwd: options.cwd,
        env: options.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendOutput(Buffer.from(`${message}\r\n`));
      finish(1);
      return;
    }
    pendingSize = null;
    logNativeHolderEvent(options.socketPath, "holder-start", {
      pid: options.holderPid ?? process.pid,
      pgid: options.holderPgid ?? process.pid,
      sid: options.holderSid ?? process.pid,
      cliPid: pty.pid,
    });
    if (pendingInput.length > 0) {
      pty.write(pendingInput);
      pendingInput = "";
    }
    pty.onData((data) => {
      sendOutput(Buffer.from(data, "utf8"));
    });
    pty.onExit(({ exitCode, signal }) => {
      ptyExited = true;
      logNativeHolderEvent(options.socketPath, "pty-child-exit", {
        exitCode,
        signal: signal ?? null,
      });
      finish(
        Number.isInteger(exitCode) && exitCode >= 0
          ? exitCode
          : 128 + (signal ?? 0),
        finishReason,
      );
    });
  };

  server.on("connection", (socket) => {
    if (finished) {
      socket.destroy();
      return;
    }
    client?.destroy();
    client = socket;
    for (const chunk of pendingOutput) {
      writeFrame(client, NativeHolderFrame.output, chunk);
    }
    pendingOutput = [];
    pendingOutputBytes = 0;
    redrawOnResize = pty !== null;
    const decoder = new NativeHolderFrameDecoder();
    const text = new StringDecoder("utf8");
    socket.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        if (message.type === NativeHolderFrame.input) {
          const input = text.write(message.payload);
          if (input.length === 0) continue;
          if (pty === null) pendingInput += input;
          else pty.write(input);
        } else if (message.type === NativeHolderFrame.credential) {
          const next = message.payload.toString("utf8");
          if (next.length > 0 && next !== credential) {
            credential = next;
            options.onCredentialChanged?.();
          }
        } else if (message.type === NativeHolderFrame.resize) {
          const next = parseSize(message.payload);
          if (next !== null) applySize(next);
          if (pty === null) void start();
        }
      }
    });
    const detach = (): void => {
      if (client !== socket) return;
      client = null;
      detachedSince = Date.now();
      terminalCheckSettledSinceDetach = false;
    };
    socket.on("close", detach);
    socket.on("error", detach);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => {
        server.off("error", reject);
        resolve();
      });
      listenPrivately(server, options.socketPath);
    });
    chmodSync(options.socketPath, 0o600);
    const mainSocketStat = lstatSync(options.socketPath);
    mainSocketIdentity = { dev: mainSocketStat.dev, ino: mainSocketStat.ino };
    await new Promise<void>((resolve, reject) => {
      credentialServer.once("error", reject);
      credentialServer.once("listening", () => {
        credentialServer.off("error", reject);
        resolve();
      });
      listenPrivately(credentialServer, credentialSocketPath);
    });
    chmodSync(credentialSocketPath, 0o600);
    if (
      existsSync(statusSocketPath) &&
      !(await nativeHolderIsAlive(options.socketPath))
    ) {
      removeSocketFile(statusSocketPath);
    }
    await new Promise<void>((resolve, reject) => {
      statusServer.once("error", reject);
      statusServer.once("listening", () => {
        statusServer.off("error", reject);
        resolve();
      });
      listenPrivately(statusServer, statusSocketPath);
    });
    chmodSync(statusSocketPath, 0o600);
    const statusSocketStat = lstatSync(statusSocketPath);
    statusSocketIdentity = {
      dev: statusSocketStat.dev,
      ino: statusSocketStat.ino,
    };
    options.onSocketReady?.();
  } catch (error) {
    server.close();
    if (mainSocketIdentity !== null) {
      removeSocketFile(options.socketPath, mainSocketIdentity);
    }
    statusServer.close();
    if (statusSocketIdentity !== null) {
      removeSocketFile(statusSocketPath, statusSocketIdentity);
    }
    credentialServer.close();
    rmSync(credentialDir, { recursive: true, force: true });
    throw error;
  }

  const firstClientTimeoutMs =
    options.firstClientTimeoutMs ?? NATIVE_HOLDER_FIRST_CLIENT_TIMEOUT_MS;
  const firstClient = setTimeout(() => {
    if (pty === null && !starting) finish(1);
  }, firstClientTimeoutMs);
  timers.push(firstClient);

  timers.push(
    setInterval(
      () => {
        if (pty === null || client !== null) return;
        if (
          options.checkTerminal !== undefined &&
          (pausedFor !== null || !terminalCheckSettledSinceDetach)
        ) {
          return;
        }
        if (Date.now() - detachedSince >= reapAfterMs) {
          finishReason = "reap after detach";
          pty.kill("SIGHUP");
        }
      },
      Math.min(NATIVE_HOLDER_REAP_CHECK_MS, reapAfterMs),
    ),
  );
  if (options.checkTerminal !== undefined) {
    const checkTerminal = options.checkTerminal;
    let checking = false;
    const pauseReap = (reason: string): void => {
      if (client !== null) return;
      detachedSince = Date.now();
      if (pausedFor === reason) return;
      pausedFor = reason;
      logNativeHolderEvent(options.socketPath, "reap-paused", { reason });
    };
    timers.push(
      setInterval(() => {
        if (pty === null || client !== null || checking) return;
        checking = true;
        checkTerminal()
          .then((state) => {
            if (client !== null) return;
            if (state === "closed-for-good") {
              finishReason = "explicit close";
              pty?.kill("SIGHUP");
            } else if (state === "awaiting-daemon") {
              pauseReap("bb awaits the host daemon");
            } else {
              pausedFor = null;
            }
          })
          .catch(() => {
            pauseReap("bb unreachable");
          })
          .finally(() => {
            checking = false;
            terminalCheckSettledSinceDetach = true;
          });
      }, options.detachedCheckIntervalMs ?? 2_000),
    );
  }
  if (options.tick !== undefined) {
    const tick = options.tick;
    timers.push(
      setInterval(() => {
        if (pty !== null) tick().catch(() => undefined);
      }, options.tickIntervalMs ?? 2_000),
    );
  }

  try {
    return await exited;
  } finally {
    credential = null;
    credentialServer.close();
    rmSync(credentialDir, { recursive: true, force: true });
  }
}

export type NativeHolderConnection =
  | { kind: "attached"; socket: net.Socket }
  | { kind: "ended" }
  | { kind: "did-not-start" };

export async function openNativeHolderConnection(args: {
  socketPath: string;
  reattachOnly: boolean;
  startHolder(): void;
  startTimeoutMs: number;
}): Promise<NativeHolderConnection> {
  const running = await connectNativeHolder(args.socketPath);
  if (running !== null) return { kind: "attached", socket: running };
  if (args.reattachOnly) return { kind: "ended" };
  args.startHolder();
  const started = await waitForNativeHolder(
    args.socketPath,
    args.startTimeoutMs,
  );
  return started === null
    ? { kind: "did-not-start" }
    : { kind: "attached", socket: started };
}

export async function connectNativeHolder(
  socketPath: string,
): Promise<net.Socket | null> {
  let socketIdentity: { dev: number; ino: number } | null = null;
  try {
    const socketStat = lstatSync(socketPath);
    socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
  } catch {
    socketIdentity = null;
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" && socketIdentity !== null) {
        removeSocketFile(socketPath, socketIdentity);
      }
      resolve(null);
    });
  });
}

export async function waitForNativeHolder(
  socketPath: string,
  timeoutMs: number,
): Promise<net.Socket | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await connectNativeHolder(socketPath);
    if (socket !== null) return socket;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export interface NativeHolderClientIo {
  input: NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => unknown;
    isTTY?: boolean;
  };
  output: NodeJS.WritableStream & {
    columns?: number;
    rows?: number;
    on(event: "resize", listener: () => void): unknown;
  };
  fallbackSize: TerminalSize;
  credential?: string | null;
}

export async function pipeNativeHolderClient(
  socket: net.Socket,
  io: NativeHolderClientIo,
): Promise<number> {
  const raw =
    io.input.isTTY === true && typeof io.input.setRawMode === "function";
  if (raw) io.input.setRawMode?.(true);
  const sendSize = (): void => {
    const cols = io.output.columns ?? io.fallbackSize.cols;
    const rows = io.output.rows ?? io.fallbackSize.rows;
    socket.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.resize,
        Buffer.from(JSON.stringify({ cols, rows })),
      ),
    );
  };
  const onInput = (chunk: Buffer | string): void => {
    const payload =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    socket.write(encodeNativeHolderFrame(NativeHolderFrame.input, payload));
  };
  if (io.credential !== undefined && io.credential !== null) {
    socket.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.credential,
        Buffer.from(io.credential, "utf8"),
      ),
    );
  }
  io.output.on("resize", sendSize);
  io.input.on("data", onInput);
  io.input.resume();
  sendSize();
  const decoder = new NativeHolderFrameDecoder();
  try {
    return await new Promise<number>((resolve) => {
      let code: number | null = null;
      socket.on("data", (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          if (message.type === NativeHolderFrame.output) {
            io.output.write(message.payload);
          } else if (message.type === NativeHolderFrame.exit) {
            code = parseExitCode(message.payload);
          }
        }
      });
      socket.on("close", () => resolve(code ?? 1));
      socket.on("error", () => undefined);
    });
  } finally {
    io.input.off("data", onInput);
    io.input.pause();
    if (raw) io.input.setRawMode?.(false);
  }
}
