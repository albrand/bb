import { mkdtemp } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedLines } from "../bridge-kit/bounded-line-reader.js";
import { decodeBridgeFrame } from "../bridge-kit/bridge-socket-server.js";

export interface BridgeSocketTestFrame {
  wseq: number;
  line: string;
}

export interface BridgeSocketTestClient {
  socket: Socket;
  lines: string[];
  frames: BridgeSocketTestFrame[];
  closed: Promise<void>;
  send(message: Record<string, unknown>): void;
  ack(through: number, keep?: readonly number[]): void;
  lastWseq(): number;
  waitForLine(predicate: (line: string) => boolean): Promise<string>;
}

export interface ConnectBridgeSocketOptions {
  resumeAfter?: number | null;
  timeoutMs?: number;
}

export async function createShortSocketDir(): Promise<string> {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  return mkdtemp(join(base, "bbw-"));
}

export async function connectBridgeSocket(
  socketPath: string,
  options: ConnectBridgeSocketOptions = {},
): Promise<BridgeSocketTestClient> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    try {
      const client = await connectOnce(socketPath);
      const resumeAfter =
        options.resumeAfter === undefined ? 0 : options.resumeAfter;
      if (resumeAfter !== null) {
        client.send({
          method: "bridge/resume",
          params: { afterWseq: resumeAfter },
        });
      }
      return client;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function connectOnce(socketPath: string): Promise<BridgeSocketTestClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => undefined);
      const lines: string[] = [];
      const frames: BridgeSocketTestFrame[] = [];
      const waiters: {
        predicate: (line: string) => boolean;
        resolve: (line: string) => void;
      }[] = [];
      readBoundedLines({
        input: socket,
        onLine: (raw) => {
          const decoded = decodeBridgeFrame(raw);
          const line = decoded?.line ?? raw;
          if (decoded !== null) frames.push(decoded);
          lines.push(line);
          for (const waiter of waiters.splice(0)) {
            if (waiter.predicate(line)) waiter.resolve(line);
            else waiters.push(waiter);
          }
        },
        onOverflow: () => undefined,
      });
      const closed = new Promise<void>((resolveClosed) => {
        socket.once("close", () => resolveClosed());
      });
      const send = (message: Record<string, unknown>): void => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      };
      resolve({
        socket,
        lines,
        frames,
        closed,
        send,
        ack: (through, keep = []) =>
          send({ method: "bridge/ack", params: { through, keep } }),
        lastWseq: () => frames.at(-1)?.wseq ?? 0,
        waitForLine: (predicate) => {
          const existing = lines.find(predicate);
          if (existing !== undefined) return Promise.resolve(existing);
          return new Promise((resolveLine) => {
            waiters.push({ predicate, resolve: resolveLine });
          });
        },
      });
    });
  });
}
