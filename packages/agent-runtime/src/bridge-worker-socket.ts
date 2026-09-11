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
  BRIDGE_SHUTDOWN_METHOD,
  BRIDGE_SOCKET_ENV,
  BRIDGE_SOCKET_TRANSPORT_VERSION,
  BRIDGE_SPILL_ENV,
  decodeBridgeFrame,
  readBoundedLines,
} from "@bb/provider-bridge-protocol/bridge-kit";
import { BridgeLineAckTracker } from "./bridge-line-ack-tracker.js";
import {
  type BridgeWorkerRegistryEntry,
  type BridgeWorkerThread,
  type BridgeWorkerWorkspace,
  BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
  fallbackSocketRoot,
  privateDirectoryProblem,
  readProcessIdentity,
  readProcessIdentityAsync,
  removeBridgeWorkerFiles,
  socketDirectoryFor,
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
  spillPath: string;
}

export interface SpawnSocketBridgeWorkerArgs {
  kind: "spawn";
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workerDir: string;
  connectTimeoutMs: number;
  registration: BridgeWorkerRegistration;
  workspace: BridgeWorkerWorkspace;
}

export interface AdoptSocketBridgeWorkerArgs {
  kind: "adopt";
  entry: BridgeWorkerRegistryEntry;
  workerDir: string;
  connectTimeoutMs: number;
}

interface WorkerProcessHandle {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeAllListeners(event: "exit" | "error"): unknown;
}

const ADOPTED_WORKER_EXIT_POLL_MS = 5_000;

class AdoptedProcessHandle extends EventEmitter implements WorkerProcessHandle {
  exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  killed = false;
  private readonly recordedPid: number;
  private readonly processIdentity: string;
  private readonly poll: NodeJS.Timeout;
  private polling = false;

  constructor(entry: { pid: number; processIdentity: string }) {
    super();
    this.recordedPid = entry.pid;
    this.processIdentity = entry.processIdentity;
    this.poll = setInterval(() => {
      void this.checkStillRunning();
    }, ADOPTED_WORKER_EXIT_POLL_MS);
    this.poll.unref();
  }

  get pid(): number | undefined {
    return this.isRecordedProcess() ? this.recordedPid : undefined;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (!this.isRecordedProcess()) return false;
    try {
      process.kill(this.recordedPid, signal);
      this.killed = true;
      return true;
    } catch {
      return false;
    }
  }

  markGone(): void {
    if (this.exitCode !== null) return;
    this.stopWatching();
    this.exitCode = -1;
    this.emit("exit", this.exitCode, null);
  }

  stopWatching(): void {
    clearInterval(this.poll);
  }

  private isRecordedProcess(): boolean {
    return (
      this.exitCode === null &&
      readProcessIdentity(this.recordedPid) === this.processIdentity
    );
  }

  private async checkStillRunning(): Promise<void> {
    if (this.polling || this.exitCode !== null) return;
    this.polling = true;
    try {
      const identity = await readProcessIdentityAsync(this.recordedPid);
      if (identity !== this.processIdentity) this.markGone();
    } finally {
      this.polling = false;
    }
  }
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
const BRIDGE_WORKER_FORCE_STOP_GRACE_MS = 1_000;
const UNIX_SOCKET_PATH_MAX_BYTES = process.platform === "darwin" ? 103 : 107;

export function allocateBridgeWorkerPaths(
  workerDir: string,
): BridgeWorkerPaths {
  ensurePrivateDirectory(workerDir);
  const id = randomBytes(6).toString("hex");
  const logPath = join(workerDir, `${id}.log`);
  const spillPath = join(workerDir, `${id}.buf`);
  if (process.platform === "win32") {
    return {
      id,
      socketPath: `\\\\.\\pipe\\bb-bridge-worker-${id}`,
      logPath,
      spillPath,
    };
  }
  const socketName = `${id}.sock`;
  const socketDir = fitsUnixSocketPath(join(workerDir, socketName))
    ? workerDir
    : fallbackSocketDirectory(workerDir);
  const socketPath = join(socketDir, socketName);
  if (!fitsUnixSocketPath(socketPath)) {
    throw new Error(
      `Bridge worker socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${UNIX_SOCKET_PATH_MAX_BYTES}-byte unix socket path limit on ${process.platform}: ${socketPath}`,
    );
  }
  return { id, socketPath, logPath, spillPath };
}

function fitsUnixSocketPath(path: string): boolean {
  return Buffer.byteLength(path) <= UNIX_SOCKET_PATH_MAX_BYTES;
}

function fallbackSocketDirectory(workerDir: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error(
      `Bridge worker directory ${workerDir} is too long for a unix socket path, and there is no user id for a private fallback directory`,
    );
  }
  return privateSocketDirectory({
    root: fallbackSocketRoot(uid),
    uid,
    workerDir,
  });
}

export function privateSocketDirectory(args: {
  root: string;
  uid: number;
  workerDir: string;
}): string {
  const dir = socketDirectoryFor(args.root, args.workerDir);
  for (const path of [args.root, dir]) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, "code") === "EEXIST")) {
        throw error;
      }
    }
    const problem = privateDirectoryProblem(path, args.uid);
    if (problem !== null) {
      throw new Error(
        `Refusing bridge worker socket directory ${path}: ${problem}`,
      );
    }
  }
  return dir;
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
  private readonly child: WorkerProcessHandle;
  private readonly registryEntry: BridgeWorkerRegistryEntry | null;
  private resumeRequested: boolean;
  private readonly connectTimeoutMs: number;
  private socket: Socket | null = null;
  private released = false;
  private daemonStopped = false;
  private exited = false;
  private stdoutEnded = false;
  private stderrEnded = false;
  private closeEmitted = false;
  private lastReceivedWseq = 0;
  private ackedWseq = 0;
  private ackedKeepKey = "";
  private ackTimer: NodeJS.Timeout | null = null;
  private unconfirmedResponses: { id: string | number; wseq: number }[] = [];
  private readonly restoredKeeps = new Set<number>();
  private lineHandler: ((line: string, wseq: number | null) => void) | null =
    null;
  readonly ackTracker: BridgeLineAckTracker;

  constructor(args: SpawnSocketBridgeWorkerArgs | AdoptSocketBridgeWorkerArgs) {
    super();
    this.workerDir = args.workerDir;
    if (args.kind === "adopt") {
      this.id = args.entry.id;
      this.socketPath = args.entry.socketPath;
      this.logPath = join(args.workerDir, `${args.entry.id}.log`);
      this.child = new AdoptedProcessHandle(args.entry);
      this.registryEntry = args.entry;
      this.resumeRequested = false;
    } else {
      const paths = allocateBridgeWorkerPaths(args.workerDir);
      this.id = paths.id;
      this.socketPath = paths.socketPath;
      this.logPath = paths.logPath;
      this.resumeRequested = true;
      const logFd = openSync(this.logPath, "a", 0o600);
      let child: ChildProcess;
      try {
        child = spawnPortableProcess({
          command: args.command,
          args: args.args,
          cwd: args.cwd,
          detached: supportsProcessGroups(),
          env: {
            ...args.env,
            [BRIDGE_SOCKET_ENV]: this.socketPath,
            [BRIDGE_SPILL_ENV]: paths.spillPath,
          },
          stdio: ["ignore", logFd, logFd],
        });
      } finally {
        closeSync(logFd);
      }
      child.unref();
      this.child = child;
      const processIdentity =
        child.pid === undefined ? null : readProcessIdentity(child.pid);
      this.registryEntry =
        child.pid === undefined || processIdentity === null
          ? null
          : {
              ...args.registration,
              id: this.id,
              formatVersion: BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
              pid: child.pid,
              processIdentity,
              socketPath: this.socketPath,
              bridgeProtocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
              transportVersion: BRIDGE_SOCKET_TRANSPORT_VERSION,
              startedAt: new Date().toISOString(),
              workspace: args.workspace,
              threads: {},
            };
      if (this.registryEntry !== null) {
        writeBridgeWorkerEntry(this.workerDir, this.registryEntry);
      }
    }
    this.ackTracker = new BridgeLineAckTracker({
      workerId: this.id,
      onAckable: () => this.scheduleAck(),
    });
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
    this.connectTimeoutMs = args.connectTimeoutMs;
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

  recordThread(threadId: string, thread: BridgeWorkerThread | null): void {
    const entry = this.registryEntry;
    if (entry === null || this.exited || this.released) return;
    if (thread === null) {
      if (!(threadId in entry.threads)) return;
      delete entry.threads[threadId];
    } else {
      entry.threads[threadId] = thread;
    }
    writeBridgeWorkerEntry(this.workerDir, entry);
  }

  resume(): void {
    if (this.resumeRequested) return;
    this.resumeRequested = true;
    if (this.socket !== null) this.sendResume(this.socket);
  }

  private sendResume(socket: Socket): void {
    socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: BRIDGE_RESUME_METHOD,
        params: { afterWseq: this.ackTracker.ackableThrough() },
      })}\n`,
    );
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.child instanceof AdoptedProcessHandle) this.child.stopWatching();
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
      this.stdin.unpipe(socket);
      if (this.exited || this.released) {
        this.stdout.end();
        return;
      }
      for (const unconfirmed of this.unconfirmedResponses.splice(0)) {
        this.ackTracker.restoreKept(unconfirmed.wseq, unconfirmed.id);
        this.restoredKeeps.add(unconfirmed.wseq);
      }
      void this.connect(Date.now() + this.connectTimeoutMs);
    });
    if (this.resumeRequested) this.sendResume(socket);
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
    if (decoded.wseq <= this.lastReceivedWseq && !this.restoredKeeps.has(decoded.wseq)) {
      return;
    }
    this.restoredKeeps.delete(decoded.wseq);
    this.lastReceivedWseq = Math.max(this.lastReceivedWseq, decoded.wseq);
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
        if (id !== null) {
          const kept = this.ackTracker.keptWseqFor(id);
          if (kept !== null && this.socket !== null) {
            this.unconfirmedResponses.push({ id, wseq: kept });
          }
          this.ackTracker.responded(id);
        }
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
    const keep = this.ackTracker.keptWseqs();
    const keepKey = keep.join(",");
    if (
      socket === null ||
      !socket.writable ||
      (through <= this.ackedWseq && keepKey === this.ackedKeepKey)
    ) {
      return;
    }
    this.ackedWseq = Math.max(this.ackedWseq, through);
    this.ackedKeepKey = keepKey;
    socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: BRIDGE_ACK_METHOD,
        params: { through: this.ackedWseq, keep },
      })}\n`,
    );
    this.unconfirmedResponses = [];
  }

  get stoppedByDaemon(): boolean {
    return this.daemonStopped;
  }

  get registeredPid(): number | null {
    return this.registryEntry?.pid ?? null;
  }

  private failToConnect(): void {
    if (this.exited || this.released) return;
    this.daemonStopped = true;
    const error = new Error(
      `Provider bridge worker did not open its socket at ${this.socketPath}`,
    );
    if (this.child instanceof AdoptedProcessHandle) {
      this.emit("error", error);
      this.child.markGone();
      return;
    }
    void this.stopUnreachableWorker();
    this.emit("error", error);
  }

  private async stopUnreachableWorker(): Promise<void> {
    const asked = await requestBridgeWorkerShutdown(
      this.socketPath,
      BRIDGE_WORKER_FORCE_STOP_GRACE_MS,
    );
    if (!asked && !this.exited) {
      this.child.kill("SIGTERM");
    }
    await this.whenExited(BRIDGE_WORKER_FORCE_STOP_GRACE_MS);
    if (this.exited) return;
    killProcessGroup({ child: this.child, signal: "SIGKILL" });
  }

  private whenExited(timeoutMs: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.off("exit", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      this.once("exit", done);
    });
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

function requestBridgeWorkerShutdown(
  socketPath: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let asked = false;
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    timer.unref();
    socket.once("connect", () => {
      asked = true;
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: BRIDGE_SHUTDOWN_METHOD })}\n`,
      );
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(asked);
    });
  });
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
