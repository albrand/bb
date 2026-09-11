import { existsSync } from "node:fs";
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

async function startServer(reattachTtlMs: number): Promise<{
  server: BridgeSocketServer;
  socketPath: string;
  received: string[];
  shutdowns: BridgeSocketShutdownReason[];
}> {
  const dir = await createShortSocketDir();
  const socketPath = join(dir, "w.sock");
  const received: string[] = [];
  const shutdowns: BridgeSocketShutdownReason[] = [];
  const server = createBridgeSocketServer({
    socketPath,
    reattachTtlMs,
    onOverflow: () => undefined,
    onDroppedOutput: () => undefined,
  });
  cleanups.push(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await server.listen({
    onLine: (line) => received.push(line),
    onShutdown: (reason) => shutdowns.push(reason),
  });
  return { server, socketPath, received, shutdowns };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createBridgeSocketServer", () => {
  it("holds output written while no runtime is attached and delivers it on reconnect", async () => {
    const { server, socketPath } = await startServer(60_000);
    const first = await connectBridgeSocket(socketPath);
    server.write('{"n":1}\n');
    await first.waitForLine((line) => line === '{"n":1}');
    first.socket.destroy();
    await first.closed;
    await wait(50);

    server.write('{"n":2}\n');
    server.write('{"n":3}\n');

    const second = await connectBridgeSocket(socketPath);
    await second.waitForLine((line) => line === '{"n":3}');
    expect(second.lines).toEqual(['{"n":2}', '{"n":3}']);
    second.socket.destroy();
  });

  it("lets the newest connection replace the previous one", async () => {
    const { server, socketPath, received } = await startServer(60_000);
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
    const { socketPath, shutdowns } = await startServer(150);
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
    const { socketPath, shutdowns } = await startServer(200);
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
    const { socketPath, received, shutdowns } = await startServer(60_000);
    const client = await connectBridgeSocket(socketPath);
    client.send({ method: "bridge/shutdown" });
    await client.closed;

    expect(shutdowns).toEqual(["requested"]);
    expect(received).toEqual([]);
  });
});
