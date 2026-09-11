import { mkdtemp } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedLines } from "../bridge-kit/bounded-line-reader.js";

export interface BridgeSocketTestClient {
  socket: Socket;
  lines: string[];
  closed: Promise<void>;
  send(message: Record<string, unknown>): void;
  waitForLine(predicate: (line: string) => boolean): Promise<string>;
}

export async function createShortSocketDir(): Promise<string> {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  return mkdtemp(join(base, "bbw-"));
}

export async function connectBridgeSocket(
  socketPath: string,
  timeoutMs = 10_000,
): Promise<BridgeSocketTestClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await connectOnce(socketPath);
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
      const waiters: {
        predicate: (line: string) => boolean;
        resolve: (line: string) => void;
      }[] = [];
      readBoundedLines({
        input: socket,
        onLine: (line) => {
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
      resolve({
        socket,
        lines,
        closed,
        send: (message) => {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
        },
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
