import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import {
  killProcessGroup,
  spawnPortableProcess,
  supportsProcessGroups,
} from "@bb/process-utils";
import { PROVIDER_BRIDGE_PROTOCOL_VERSION } from "@bb/provider-bridge-protocol";
import {
  BRIDGE_ACK_METHOD,
  BRIDGE_RESUME_METHOD,
  BRIDGE_SOCKET_ENV,
  BRIDGE_SOCKET_TRANSPORT_VERSION,
  decodeBridgeFrame,
  readBoundedLines,
} from "@bb/provider-bridge-protocol/bridge-kit";
import { BridgeLineAckTracker } from "./bridge-line-ack-tracker.js";
import {
  removeBridgeWorkerFiles,
  writeBridgeWorkerEntry,
} from "./bridge-worker-registry.js";

export interface BridgeWorkerProcess {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  on(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: () => void): this;
  emit(event: "exit" | "close" | "error", ...args: unknown[]): boolean;
}

export interface BridgeWorkerPaths {
  id: string;
  socketPath: string;
  logPath: string;
}

export interface SpawnSocketBridgeWorkerArgs {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workerDir: string;
  connectTimeoutMs: number;
  registration: BridgeWorkerRegistration;
}

export interface BridgeWorkerRegistration {
  environmentId: string;
  pluginId: string;
  processKey: string;
  providerId: string;
}

export const BRIDGE_WORKER_CONNECT_TIMEOUT_MS = 15_000;
const BRIDGE_WORKER_CONNECT_RETRY_MS = 25;
const BRIDGE_WORKER_ACK_INTERVAL_MS = 25;
const BRIDGE_WORKER_LOG_TAIL_BYTES = 4_000;
const UNIX_SOCKET_PATH_MAX_BYTES = process.platform === "darwin" ? 103 : 107;

export function allocateBridgeWorkerPaths(
  workerDir: string,
): BridgeWorkerPaths {
  ensurePrivateDirectory(workerDir);
  const id = randomBytes(6).toString("hex");
  const logPath = join(workerDir, `${id}.log`);
  if (process.platform === "win32") {
    return { id, socketPath: `\\\\.\\pipe\\bb-bridge-worker-${id}`, logPath };
  }
  const socketPath = join(workerDir, `${id}.sock`);
  const socketPathBytes = Buffer.byteLength(socketPath);
  if (socketPathBytes > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Bridge worker socket path is ${socketPathBytes} bytes, over the ${UNIX_SOCKET_PATH_MAX_BYTES}-byte unix socket path limit on ${process.platform}: ${socketPath}`,
    );
  }
  return { id, socketPath, logPath };
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const stat = statSync(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `Bridge worker directory ${dir} is owned by uid ${stat.uid}, not the current user (${uid})`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

export class SocketBridgeWorker
  extends EventEmitter
  implements BridgeWorkerProcess
{
  readonly id: string;
  readonly socketPath: string;
  readonly logPath: string;
  readonly workerDir: string;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly child: ChildProcess;
  private socket: Socket | null = null;
  private released = false;
  private exited = false;
  private stdoutEnded = false;
  private stderrEnded = false;
  private closeEmitted = false;
  private lastReceivedWseq = 0;
  private ackedWseq = 0;
  private ackTimer: NodeJS.Timeout | null = null;
  private lineHandler: ((line: string, wseq: number | null) => void) | null =
    null;
  readonly ackTracker: BridgeLineAckTracker;

  constructor(args: SpawnSocketBridgeWorkerArgs) {
    super();
    const paths = allocateBridgeWorkerPaths(args.workerDir);
    this.id = paths.id;
    this.socketPath = paths.socketPath;
    this.logPath = paths.logPath;
    this.workerDir = args.workerDir;
    this.ackTracker = new BridgeLineAckTracker({
      workerId: this.id,
      onAckable: () => this.scheduleAck(),
    });
    const logFd = openSync(this.logPath, "a", 0o600);
    try {
      this.child = spawnPortableProcess({
        command: args.command,
        args: args.args,
        cwd: args.cwd,
        detached: supportsProcessGroups(),
        env: { ...args.env, [BRIDGE_SOCKET_ENV]: this.socketPath },
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      closeSync(logFd);
    }
    this.child.unref();
    if (this.child.pid !== undefined) {
      writeBridgeWorkerEntry(this.workerDir, {
        ...args.registration,
        id: this.id,
        pid: this.child.pid,
        socketPath: this.socketPath,
        bridgeProtocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        transportVersion: BRIDGE_SOCKET_TRANSPORT_VERSION,
        startedAt: new Date().toISOString(),
      });
    }
    this.stdout.resume();
    this.stdout.on("end", () => {
      this.stdoutEnded = true;
      this.maybeEmitClose();
    });
    this.stderr.on("end", () => {
      this.stderrEnded = true;
      this.maybeEmitClose();
    });
    this.child.on("error", (error) => {
      this.emit("error", error);
    });
    this.child.on("exit", (code, signal) => {
      this.handleExit(code, signal);
    });
    void this.connect(Date.now() + args.connectTimeoutMs);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode;
  }

  get killed(): boolean {
    return this.child.killed;
  }

  kill(signal: NodeJS.Signals): boolean {
    return this.child.kill(signal);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.child.removeAllListeners("exit");
    this.child.removeAllListeners("error");
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    this.sendAck(this.ackTracker.ackableThrough());
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      this.stdin.unpipe(socket);
      socket.end();
      socket.unref();
    }
  }

  private async connect(deadline: number): Promise<void> {
    while (!this.exited && !this.released) {
      try {
        const socket = await connectSocket(this.socketPath);
        if (this.exited || this.released) {
          socket.destroy();
          return;
        }
        this.attach(socket);
        return;
      } catch {
        if (Date.now() > deadline) {
          this.failToConnect();
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, BRIDGE_WORKER_CONNECT_RETRY_MS),
        );
      }
    }
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stdout.end();
    });
    socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: BRIDGE_RESUME_METHOD,
        params: { afterWseq: this.lastReceivedWseq },
      })}\n`,
    );
    this.stdin.pipe(socket);
    this.observeResponses();
    readBoundedLines({
      input: socket,
      onLine: (frame) => {
        if (this.socket !== socket) return;
        this.receiveFrame(frame);
      },
      onOverflow: () => undefined,
    });
  }

  private receiveFrame(frame: string): void {
    const decoded = decodeBridgeFrame(frame);
    if (decoded === null) {
      this.lineHandler?.(frame, null);
      return;
    }
    if (decoded.wseq <= this.lastReceivedWseq) return;
    this.lastReceivedWseq = decoded.wseq;
    this.lineHandler?.(decoded.line, decoded.wseq);
  }

  setLineHandler(handler: (line: string, wseq: number | null) => void): void {
    this.lineHandler = handler;
  }

  private observingResponses = false;

  private observeResponses(): void {
    if (this.observingResponses) return;
    this.observingResponses = true;
    let pending = "";
    this.stdin.on("data", (chunk: Buffer | string) => {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const id = responseId(line);
        if (id !== null) this.ackTracker.responded(id);
        newline = pending.indexOf("\n");
      }
    });
  }

  private scheduleAck(): void {
    if (this.ackTimer !== null) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.sendAck(this.ackTracker.ackableThrough());
    }, BRIDGE_WORKER_ACK_INTERVAL_MS);
    this.ackTimer.unref();
  }

  private sendAck(through: number): void {
    const socket = this.socket;
    if (socket === null || through <= this.ackedWseq || !socket.writable) {
      return;
    }
    this.ackedWseq = through;
    socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: BRIDGE_ACK_METHOD,
        params: { through },
      })}\n`,
    );
  }

  private failToConnect(): void {
    if (this.exited || this.released) return;
    killProcessGroup({ child: this.child, signal: "SIGKILL" });
    this.emit(
      "error",
      new Error(
        `Provider bridge worker did not open its socket at ${this.socketPath}`,
      ),
    );
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.emit("exit", code, signal);
    const tail = readFileTail(this.logPath, BRIDGE_WORKER_LOG_TAIL_BYTES);
    removeBridgeWorkerFiles({
      dir: this.workerDir,
      id: this.id,
      socketPath: this.socketPath,
    });
    if (tail.length > 0) this.stderr.write(tail);
    this.stderr.end();
    if (this.socket === null) this.stdout.end();
  }

  private maybeEmitClose(): void {
    if (this.closeEmitted || !this.exited) return;
    if (!this.stdoutEnded || !this.stderrEnded) return;
    this.closeEmitted = true;
    this.emit("close", this.child.exitCode, this.child.signalCode);
  }
}

function responseId(line: string): string | number | null {
  if (line.includes('"method"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const id: unknown = Reflect.get(parsed, "id");
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

function readFileTail(path: string, maxBytes: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer;
  } finally {
    closeSync(fd);
  }
}
