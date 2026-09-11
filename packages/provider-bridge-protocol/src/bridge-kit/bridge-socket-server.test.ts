import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectBridgeSocket,
  createShortSocketDir,
} from "../testing/bridge-socket-client.js";
import {
  type BridgeSocketServer,
  type BridgeSocketShutdownReason,
  createBridgeSocketServer,
} from "./bridge-socket-server.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface StartServerOptions {
  reattachTtlMs?: number;
  memoryCapBytes?: number;
  hardCapBytes?: number;
}

async function startServer(options: StartServerOptions = {}): Promise<{
  server: BridgeSocketServer;
  socketPath: string;
  spillPath: string;
  received: string[];
  shutdowns: BridgeSocketShutdownReason[];
  backpressure: boolean[];
  lifecycle: string[];
}> {
  const dir = await createShortSocketDir();
  const socketPath = join(dir, "w.sock");
  const spillPath = join(dir, "w.buf");
  const received: string[] = [];
  const shutdowns: BridgeSocketShutdownReason[] = [];
  const backpressure: boolean[] = [];
  const lifecycle: string[] = [];
  const server = createBridgeSocketServer({
    socketPath,
    spillPath,
    reattachTtlMs: options.reattachTtlMs ?? 60_000,
    memoryCapBytes: options.memoryCapBytes ?? 1024 * 1024,
    hardCapBytes: options.hardCapBytes ?? 16 * 1024 * 1024,
    onOverflow: () => undefined,
    onBackpressure: (paused, retainedBytes) => {
      backpressure.push(paused);
      lifecycle.push(`${paused ? "pause" : "resume"}:${retainedBytes > 0}`);
    },
  });
  cleanups.push(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await server.listen({
    onLine: (line) => received.push(line),
    onShutdown: (reason) => {
      shutdowns.push(reason);
      lifecycle.push(`shutdown:${reason}`);
    },
  });
  return {
    server,
    socketPath,
    spillPath,
    received,
    shutdowns,
    backpressure,
    lifecycle,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function payload(n: number, padding = 0): string {
  return JSON.stringify({ n, pad: "x".repeat(padding) });
}

describe("createBridgeSocketServer", () => {
  it("numbers every output line and holds it until a runtime resumes past it", async () => {
    const { server, socketPath } = await startServer();
    server.write(`${payload(1)}\n${payload(2)}`);
    server.write(`\n${payload(3)}\n`);

    const client = await connectBridgeSocket(socketPath);
    await client.waitForLine((line) => line === payload(3));

    expect(client.frames.map((frame) => frame.wseq)).toEqual([1, 2, 3]);
    expect(client.lines).toEqual([payload(1), payload(2), payload(3)]);
    client.socket.destroy();
  });

  it("replays exactly the unacknowledged lines to the next runtime, with no gaps", async () => {
    const { server, socketPath } = await startServer();
    const first = await connectBridgeSocket(socketPath);
    for (let n = 1; n <= 5; n += 1) server.write(`${payload(n)}\n`);
    await first.waitForLine((line) => line === payload(5));
    first.ack(3);
    await wait(20);
    first.socket.destroy();
    await first.closed;
    for (let n = 6; n <= 8; n += 1) server.write(`${payload(n)}\n`);

    const second = await connectBridgeSocket(socketPath, { resumeAfter: 3 });
    await second.waitForLine((line) => line === payload(8));

    expect(second.frames.map((frame) => frame.wseq)).toEqual([4, 5, 6, 7, 8]);
    second.socket.destroy();
  });

  it("keeps a long detached period within its memory cap by spilling to disk", async () => {
    const memoryCapBytes = 64 * 1024;
    const { server, socketPath, spillPath } = await startServer({
      memoryCapBytes,
      hardCapBytes: 64 * 1024 * 1024,
    });
    const lineCount = 2_000;
    for (let n = 1; n <= lineCount; n += 1) {
      server.write(`${payload(n, 1_000)}\n`);
    }

    const stats = server.replayStats();
    expect(stats.memoryBytes).toBeLessThanOrEqual(memoryCapBytes);
    expect(stats.frames).toBe(lineCount);
    expect(stats.spilledBytes).toBeGreaterThan(1_900_000);
    expect(statSync(spillPath).size).toBe(stats.spilledBytes);

    const client = await connectBridgeSocket(socketPath);
    await client.waitForLine((line) => line === payload(lineCount, 1_000));
    expect(client.frames.map((frame) => frame.wseq)).toEqual(
      Array.from({ length: lineCount }, (_, index) => index + 1),
    );
    client.ack(lineCount);
    await wait(50);
    expect(server.replayStats()).toEqual({
      frames: 0,
      memoryBytes: 0,
      spilledBytes: 0,
    });
    expect(existsSync(spillPath)).toBe(false);
    client.socket.destroy();
  });

  it("pauses the provider at the hard cap instead of dropping output, and resumes once acknowledged", async () => {
    const { server, socketPath, backpressure } = await startServer({
      memoryCapBytes: 16 * 1024,
      hardCapBytes: 128 * 1024,
    });
    const client = await connectBridgeSocket(socketPath);
    for (let n = 1; n <= 200; n += 1) server.write(`${payload(n, 1_000)}\n`);

    expect(backpressure).toEqual([true]);
    expect(server.replayStats().frames).toBe(200);

    await client.waitForLine((line) => line === payload(200, 1_000));
    client.ack(200);
    await wait(50);
    expect(backpressure).toEqual([true, false]);
    client.socket.destroy();
  });

  it("never holds a detached worker paused, so the reattach window can still retire it", async () => {
    const { server, socketPath, backpressure, lifecycle } = await startServer({
      memoryCapBytes: 16 * 1024,
      hardCapBytes: 128 * 1024,
      reattachTtlMs: 150,
    });
    for (let n = 1; n <= 200; n += 1) server.write(`${payload(n, 1_000)}\n`);
    expect(backpressure).toEqual([]);

    const client = await connectBridgeSocket(socketPath);
    await client.waitForLine((line) => line === payload(200, 1_000));
    expect(backpressure).toEqual([true]);
    client.socket.destroy();
    await client.closed;
    await wait(20);
    expect(backpressure).toEqual([true, false]);

    for (let n = 201; n <= 400; n += 1) server.write(`${payload(n, 1_000)}\n`);
    await wait(250);
    expect(lifecycle).toEqual([
      "pause:true",
      "resume:true",
      "shutdown:abandoned",
    ]);
  });

  it("continues a paused provider before it acts on bridge/shutdown", async () => {
    const { server, socketPath, lifecycle } = await startServer({
      memoryCapBytes: 16 * 1024,
      hardCapBytes: 128 * 1024,
    });
    const client = await connectBridgeSocket(socketPath);
    for (let n = 1; n <= 200; n += 1) server.write(`${payload(n, 1_000)}\n`);
    expect(lifecycle).toEqual(["pause:true"]);

    client.send({ method: "bridge/shutdown" });
    await client.closed;
    expect(lifecycle).toEqual([
      "pause:true",
      "resume:true",
      "shutdown:requested",
    ]);
  });

  it("lets the newest connection replace the previous one", async () => {
    const { server, socketPath, received } = await startServer();
    const first = await connectBridgeSocket(socketPath);
    const second = await connectBridgeSocket(socketPath);
    await first.closed;

    second.send({ method: "ping" });
    server.write('{"to":"second"}\n');
    await second.waitForLine((line) => line === '{"to":"second"}');
    await wait(20);
    expect(received).toEqual(['{"jsonrpc":"2.0","method":"ping"}']);
    second.socket.destroy();
  });

  it("shuts down when no runtime reattaches within the reattach window", async () => {
    const { socketPath, shutdowns } = await startServer({ reattachTtlMs: 150 });
    const client = await connectBridgeSocket(socketPath);
    client.socket.destroy();
    await client.closed;

    await wait(60);
    expect(shutdowns).toEqual([]);
    await wait(250);
    expect(shutdowns).toEqual(["abandoned"]);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("keeps running when a runtime reattaches inside the window", async () => {
    const { socketPath, shutdowns } = await startServer({ reattachTtlMs: 200 });
    const first = await connectBridgeSocket(socketPath);
    first.socket.destroy();
    await first.closed;
    await wait(80);
    const second = await connectBridgeSocket(socketPath);

    await wait(300);
    expect(shutdowns).toEqual([]);
    second.socket.destroy();
  });

  it("shuts down on an explicit bridge/shutdown instead of passing it to the bridge", async () => {
    const { socketPath, received, shutdowns } = await startServer();
    const client = await connectBridgeSocket(socketPath);
    client.send({ method: "bridge/shutdown" });
    await client.closed;

    expect(shutdowns).toEqual(["requested"]);
    expect(received).toEqual([]);
  });
});
