import { fork, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  TERMINAL_DATA_SOCKET_PATH,
  TERMINAL_DATA_SOCKET_TICKET_HEADER,
  hostDaemonOnlineRpcResponseMessageSchema,
  type HostDaemonOnlineRpcRequestMessage,
  type HostDaemonOnlineRpcResponseMessage,
} from "@bb/host-daemon-contract";
import type {
  TerminalClientMessage,
  TerminalSession,
} from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ChildTerminalSocket } from "./child-terminal-socket.js";
import type { DaemonSessionChange } from "./daemon-data-sockets.js";
import { TERMINAL_DATA_PLANE_PROBE_IPC_VERSION } from "@bb/host-daemon-contract";
import {
  startTerminalDataPlane,
  type TerminalDataPlane,
} from "./terminal-data-plane.js";

const childEntry = fileURLToPath(
  new URL("../../../terminal-data-plane/child-main.ts", import.meta.url),
);
const STEP_TIMEOUT_MS = 30_000;
const HOST_KEY_HEADER = "Bearer host-key-1";

const session: TerminalSession = {
  id: "term_1",
  threadId: null,
  environmentId: null,
  hostId: "host_1",
  title: "shell",
  initialCwd: "/tmp",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  closeReason: null,
  createdAt: 1,
  updatedAt: 1,
  lastUserInputAt: null,
};

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type DaemonMode = "capable" | "flaky" | "manual" | "refusing";

interface DataSocketDial {
  socket: WebSocket | null;
  status: number | null;
}

function dialDataSocket(
  port: number,
  headers: Record<string, string>,
): Promise<DataSocketDial> {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${TERMINAL_DATA_SOCKET_PATH}`,
      { headers },
    );
    cleanups.push(() => socket.terminate());
    socket.once("open", () => resolve({ socket, status: null }));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ socket: null, status: response.statusCode ?? 0 });
    });
    socket.once("error", () => resolve({ socket: null, status: 0 }));
  });
}

interface Fixture {
  children: ChildProcess[];
  closeSession(sessionId?: string): void;
  commands: string[];
  currentSessionId: { value: string | null };
  sequenceBase: { value: number };
  daemonFrames: Array<Record<string, unknown>>;
  daemonSockets: WebSocket[];
  detached: ChildTerminalSocket[];
  directOutput: Array<{ daemonSessionId: string; enabled: boolean }>;
  failBrowserAttach: { value: boolean };
  fallbackRouted: boolean[];
  fallbackUpgrades: string[];
  inputActivity: string[];
  outputBatches: Array<{ chunks: Array<{ dataBase64: string; seq: number }>; daemonSessionId: string; terminalId: string }>;
  openSession(sessionId?: string): void;
  plane: TerminalDataPlane;
  port: number;
  received: TerminalClientMessage[];
  releaseConnects(): void;
  tickets: string[];
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function rpcAnswer(
  message: HostDaemonOnlineRpcRequestMessage,
  outcome: { result: unknown } | null,
): HostDaemonOnlineRpcResponseMessage {
  return hostDaemonOnlineRpcResponseMessageSchema.parse(
    outcome === null
      ? {
          type: "host-rpc.response",
          requestId: message.requestId,
          commandType: message.command.type,
          ok: false,
          errorCode: "invalid_command",
          errorMessage: "Invalid host RPC command",
        }
      : {
          type: "host-rpc.response",
          requestId: message.requestId,
          commandType: message.command.type,
          ok: true,
          result: outcome.result,
        },
  );
}

async function createFixture(mode: DaemonMode = "capable"): Promise<Fixture> {
  const server: Server = createServer();
  const fallbackUpgrades: string[] = [];
  const fallbackRouted: boolean[] = [];
  const failBrowserAttach = { value: false };
  server.on("upgrade", (request, socket: Socket) => {
    fallbackUpgrades.push(request.url ?? "");
    fallbackRouted.push(plane.isTerminalRouted("term_1"));
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });
  const children: ChildProcess[] = [];
  const commands: string[] = [];
  const daemonFrames: Array<Record<string, unknown>> = [];
  const daemonSockets: WebSocket[] = [];
  const detached: ChildTerminalSocket[] = [];
  const directOutput: Array<{ daemonSessionId: string; enabled: boolean }> = [];
  const inputActivity: string[] = [];
  const outputBatches: Array<{ chunks: Array<{ dataBase64: string; seq: number }>; daemonSessionId: string; terminalId: string }> = [];
  const received: TerminalClientMessage[] = [];
  const tickets: string[] = [];
  const pendingConnects: Array<() => void> = [];
  const attachedSockets = new Set<ChildTerminalSocket>();
  const nextSeqBySocket = new Map<ChildTerminalSocket, number>();
  const currentSessionId: { value: string | null } = { value: null };
  const sequenceBase = { value: 0 };
  let listener: ((change: DaemonSessionChange) => void) | null = null;
  let port = 0;
  const plane = startTerminalDataPlane({
    daemons: {
      currentSessionIdForHost: (hostId) =>
        hostId === "host_1" ? currentSessionId.value : null,
      request: async ({ message }) => {
        commands.push(message.command.type);
        if (mode === "refusing") {
          return rpcAnswer(message, null);
        }
        if (mode === "flaky" && commands.length === 1) {
          throw new Error("probe timed out");
        }
        if (message.command.type === "terminal-data-plane.probe") {
          return rpcAnswer(message, {
            result: {
              dataSocket: true,
              ipcVersion: TERMINAL_DATA_PLANE_PROBE_IPC_VERSION,
            },
          });
        }
        if (message.command.type !== "terminal-data-plane.connect") {
          throw new Error(`Unexpected command ${message.command.type}`);
        }
        tickets.push(message.command.ticket);
        if (mode === "manual") {
          await new Promise<void>((resolve) => {
            pendingConnects.push(resolve);
          });
          return rpcAnswer(message, { result: { connected: false } });
        }
        const dial = await dialDataSocket(port, {
          authorization: HOST_KEY_HEADER,
          [TERMINAL_DATA_SOCKET_TICKET_HEADER]: message.command.ticket,
        });
        if (dial.socket !== null) {
          const socket = dial.socket;
          daemonSockets.push(socket);
          socket.on("message", (data) => {
            const frame = JSON.parse(data.toString()) as Record<string, unknown>;
            daemonFrames.push(frame);
            if (frame.type === "terminal.input") {
              const seq = daemonFrames.filter(
                (entry) => entry.type === "terminal.input",
              ).length;
              socket.send(
                JSON.stringify({
                  type: "terminal.output",
                  terminalId: frame.terminalId,
                  chunk: { seq: 5 + seq, dataBase64: frame.dataBase64 },
                }),
              );
            }
          });
        }
        return rpcAnswer(message, {
          result: { connected: dial.socket !== null },
        });
      },
      setSessionDirectOutput: (args) => {
        directOutput.push(args);
        for (const socket of [...attachedSockets]) {
          socket.close(1013, "terminal-output-path-changed");
        }
      },
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      verify: async (authorizationHeader) => {
        if (authorizationHeader !== HOST_KEY_HEADER) {
          throw new Error("unauthorized");
        }
        return { hostId: "host_1" };
      },
    },
    dataSocketRetryDelaysMs: [50, 50, 50, 50, 50, 50, 50, 50],
    guard: {
      config: { serverPort: 3001, appUrl: undefined, devAppPort: undefined },
    },
    lifecycle: {
      attach: ({ sinceSeq, socket }) => {
        attachedSockets.add(socket);
        nextSeqBySocket.set(socket, sinceSeq + 1);
        socket.send(
          JSON.stringify({
            type: "attached",
            session,
            replayStartSeq: sinceSeq,
            nextSeq: sinceSeq + 1,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "output",
            chunk: { seq: sinceSeq, dataBase64: base64("replayed") },
          }),
        );
      },
      detach: ({ socket }) => {
        attachedSockets.delete(socket);
        detached.push(socket);
      },
      handleMessage: ({ message }) => {
        received.push(message);
      },
      recordInputActivity: (terminalId) => {
        inputActivity.push(terminalId);
      },
      stripHolderMarkersFromDataPlaneOutput: (_terminalId, chunk) => [chunk],
      recordOutputBatch: ({ chunks, daemonSessionId, terminalId }) =>
        outputBatches.push({ chunks, daemonSessionId, terminalId }),
    },
    logger: {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    },
    resolveTerminal: (terminalId) =>
      terminalId === "term_1" && currentSessionId.value !== null
        ? {
            terminalId,
            daemonSessionId: currentSessionId.value,
            sequenceBase: sequenceBase.value,
          }
        : null,
    server,
    spawn: () => {
      const child = fork(childEntry, [], {
        execArgv: ["--conditions=source", "--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      children.push(child);
      const send = child.send.bind(child) as (...args: unknown[]) => boolean;
      (child as { send: unknown }).send = (...args: unknown[]) => {
        const message = args[0] as { type?: string };
        if (failBrowserAttach.value && message.type === "browser.attach") {
          throw new Error("injected browser.attach send failure");
        }
        return send(...args);
      };
      return child;
    },
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
  cleanups.push(() => {
    plane.stop();
    for (const child of children) {
      child.kill("SIGKILL");
    }
    server.closeAllConnections();
    server.close();
  });
  return {
    children,
    closeSession: (sessionId = "session_1") => {
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null;
      }
      listener?.({ kind: "closed", sessionId });
    },
    commands,
    currentSessionId,
    sequenceBase,
    daemonFrames,
    daemonSockets,
    detached,
    directOutput,
    failBrowserAttach,
    fallbackRouted,
    fallbackUpgrades,
    inputActivity,
    outputBatches,
    openSession: (sessionId = "session_1") => {
      currentSessionId.value = sessionId;
      listener?.({ kind: "opened", hostId: "host_1", sessionId });
    },
    plane,
    port,
    received,
    releaseConnects: () => {
      for (const release of pendingConnects.splice(0)) {
        release();
      }
    },
    tickets,
  };
}

interface Client {
  closed(): boolean;
  frames: Array<Record<string, unknown>>;
  socket: WebSocket;
}

function connectClient(port: number, path: string): Client {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const frames: Array<Record<string, unknown>> = [];
  let closed = false;
  socket.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => {
    closed = true;
  });
  cleanups.push(() => socket.terminate());
  return { closed: () => closed, frames, socket };
}

async function attachedFixture(): Promise<Fixture> {
  const fixture = await createFixture();
  await until(() => fixture.plane.state === "ready", "the child");
  fixture.openSession();
  await until(
    () => fixture.plane.isSessionAttached("session_1"),
    "the daemon data socket",
  );
  return fixture;
}

describe("terminal data plane", () => {
  it("forwards output from an attached daemon data socket with no browser watching", async () => {
    const fixture = await attachedFixture();
    const daemon = fixture.daemonSockets[0];
    if (!daemon) {
      throw new Error("The daemon data socket was not created");
    }
    for (let seq = 0; seq < 8; seq += 1) {
      daemon.send(
        JSON.stringify({
          type: "terminal.output",
          terminalId: "term_1",
          chunk: { seq, dataBase64: base64(`R-${seq + 1}\n`) },
        }),
      );
    }
    await until(
      () => fixture.outputBatches.reduce((total, batch) => total + batch.chunks.length, 0) === 8,
      "the retained output batch",
    );
    expect(fixture.plane.attachedSocketCount).toBe(0);
    expect(fixture.plane.isTerminalRouted("term_1")).toBe(false);
    expect(fixture.outputBatches).toEqual([
      {
        terminalId: "term_1",
        daemonSessionId: "session_1",
        chunks: Array.from({ length: 8 }, (_, seq) => ({
          seq,
          dataBase64: base64(`R-${seq + 1}\n`),
        })),
      },
    ]);
  }, 120_000);

  it(
    "rolls a terminal's route back before the legacy fallback when the helper cannot take the browser, then recovers byte-exact",
    async () => {
      const fixture = await attachedFixture();
      const first = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=5");
      await until(() => first.frames.length >= 2, "the first replay");
      first.socket.send(
        JSON.stringify({ type: "input", dataBase64: base64("one") }),
      );
      await until(() => first.frames.length >= 3, "the first echo");
      expect(fixture.plane.isTerminalRouted("term_1")).toBe(true);
      first.socket.close();
      await until(() => fixture.detached.length === 1, "the first detach");

      fixture.failBrowserAttach.value = true;
      const refused = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=6");
      await until(() => refused.closed(), "the refused handoff");
      expect(fixture.fallbackUpgrades).toEqual(["/ws/terminals/term_1?sinceSeq=6"]);
      expect(fixture.fallbackRouted).toEqual([false]);
      expect(fixture.plane.isTerminalRouted("term_1")).toBe(false);
      expect(fixture.plane.attachedSocketCount).toBe(0);

      fixture.failBrowserAttach.value = false;
      const recovered = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=6");
      await until(() => recovered.frames.length >= 2, "the recovered replay");
      recovered.socket.send(
        JSON.stringify({ type: "input", dataBase64: base64("two") }),
      );
      await until(() => recovered.frames.length >= 3, "the recovered echo");
      expect(recovered.frames).toEqual([
        { type: "attached", session, replayStartSeq: 6, nextSeq: 7 },
        { type: "output", chunk: { seq: 6, dataBase64: base64("replayed") } },
        { type: "output", chunk: { seq: 7, dataBase64: base64("two") } },
      ]);
      expect(fixture.plane.isTerminalRouted("term_1")).toBe(true);
      expect(fixture.fallbackUpgrades).toHaveLength(1);
    },
    120_000,
  );

  it(
    "carries a terminal's bytes between the browser and the daemon's data socket and leaves the rest to the server",
    async () => {
      const fixture = await attachedFixture();
      expect(fixture.commands).toEqual([
        "terminal-data-plane.probe",
        "terminal-data-plane.connect",
      ]);
      expect(fixture.directOutput).toEqual([
        { daemonSessionId: "session_1", enabled: true },
      ]);

      const client = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=5");
      await until(() => client.frames.length >= 2, "the replay");
      client.socket.send(
        JSON.stringify({ type: "input", dataBase64: base64("typed") }),
      );
      await until(() => client.frames.length >= 3, "the echo");

      expect(client.frames).toEqual([
        { type: "attached", session, replayStartSeq: 5, nextSeq: 6 },
        { type: "output", chunk: { seq: 5, dataBase64: base64("replayed") } },
        { type: "output", chunk: { seq: 6, dataBase64: base64("typed") } },
      ]);
      expect(fixture.daemonFrames).toEqual([
        { type: "terminal.input", terminalId: "term_1", dataBase64: base64("typed") },
      ]);
      expect(fixture.received).toEqual([]);
      await until(() => fixture.inputActivity.length === 1, "the input activity");
      expect(fixture.inputActivity).toEqual(["term_1"]);
      expect(fixture.plane.attachedSocketCount).toBe(1);
      expect(fixture.fallbackUpgrades).toEqual([]);

      const stranger = connectClient(fixture.port, "/ws/terminals/term_other");
      await until(() => stranger.closed(), "the unknown terminal to be refused");
      expect(fixture.fallbackUpgrades).toEqual(["/ws/terminals/term_other"]);

      client.socket.close();
      await until(() => fixture.detached.length === 1, "the detach");
      expect(fixture.plane.attachedSocketCount).toBe(0);
    },
    120_000,
  );

  it(
    "attaches after a probe that got no answer",
    async () => {
      const fixture = await createFixture("flaky");
      await until(() => fixture.plane.state === "ready", "the child");
      fixture.openSession();
      await until(
        () => fixture.plane.isSessionAttached("session_1"),
        "the daemon data socket",
      );

      expect(fixture.commands).toEqual([
        "terminal-data-plane.probe",
        "terminal-data-plane.probe",
        "terminal-data-plane.connect",
      ]);
      const client = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=0");
      await until(() => client.frames.length >= 2, "the replay");
      expect(fixture.fallbackUpgrades).toEqual([]);
    },
    120_000,
  );

  it(
    "leaves every terminal on the server for a daemon that refuses the probe, and stops asking",
    async () => {
      const fixture = await createFixture("refusing");
      await until(() => fixture.plane.state === "ready", "the child");
      fixture.openSession();
      await until(() => fixture.commands.length === 9, "the last probe");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const client = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=0");
      await until(() => client.closed(), "the in-process path");

      expect(fixture.commands).toEqual(
        Array.from({ length: 9 }, () => "terminal-data-plane.probe"),
      );
      expect(fixture.tickets).toEqual([]);
      expect(fixture.plane.isSessionAttached("session_1")).toBe(false);
      expect(fixture.directOutput).toEqual([]);
      expect(fixture.fallbackUpgrades).toEqual(["/ws/terminals/term_1?sinceSeq=0"]);
      expect(fixture.plane.attachedSocketCount).toBe(0);
    },
    120_000,
  );

  it(
    "delivers rebased output to a browser that reconnects after a daemon restart",
    async () => {
      const fixture = await attachedFixture();
      const first = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=5");
      await until(() => first.frames.length >= 2, "the initial replay");
      fixture.closeSession("session_1");
      await until(() => first.closed(), "the old daemon socket to close");
      fixture.sequenceBase.value = 6;
      fixture.openSession("session_2");
      await until(() => fixture.daemonSockets.length === 2, "the restarted daemon");
      const reconnected = connectClient(
        fixture.port,
        "/ws/terminals/term_1?sinceSeq=6",
      );
      await until(() => reconnected.frames.length >= 2, "the reconnect replay");
      fixture.daemonSockets[1]?.send(
        JSON.stringify({
          type: "terminal.output",
          terminalId: "term_1",
          chunk: { seq: 1, dataBase64: base64("after-restart") },
        }),
      );
      await until(
        () => reconnected.frames.some((frame) => frame.type === "output" &&
          (frame.chunk as { dataBase64: string }).dataBase64 === base64("after-restart")),
        "the post-restart output",
      );

      expect(reconnected.frames.filter((frame) => frame.type === "output")).toEqual([
        { type: "output", chunk: { seq: 6, dataBase64: base64("replayed") } },
        { type: "output", chunk: { seq: 7, dataBase64: base64("after-restart") } },
      ]);
    },
    120_000,
  );

  it(
    "returns terminals to the server when the data socket drops and takes them back once it reconnects",
    async () => {
      const fixture = await attachedFixture();
      const client = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=5");
      await until(() => client.frames.length >= 2, "the replay");
      client.socket.send(
        JSON.stringify({ type: "input", dataBase64: base64("typed") }),
      );
      await until(() => client.frames.length >= 3, "the echo");

      fixture.daemonSockets[0]?.terminate();
      await until(() => client.closed(), "the browser socket to be closed");
      await until(() => fixture.detached.length === 1, "the detach");
      expect(fixture.directOutput.slice(0, 2)).toEqual([
        { daemonSessionId: "session_1", enabled: true },
        { daemonSessionId: "session_1", enabled: false },
      ]);

      await until(() => fixture.daemonSockets.length === 2, "the second dial");
      await until(
        () => fixture.plane.isSessionAttached("session_1"),
        "the data socket to return",
      );
      const again = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=6");
      await until(() => again.frames.length >= 2, "the replay after reconnect");
      again.socket.send(
        JSON.stringify({ type: "input", dataBase64: base64("more") }),
      );
      await until(() => again.frames.length >= 3, "the echo after reconnect");

      expect(again.frames[0]).toMatchObject({
        type: "attached",
        replayStartSeq: 6,
        nextSeq: 7,
      });
      expect(again.frames.slice(1)).toEqual([
        { type: "output", chunk: { seq: 6, dataBase64: base64("replayed") } },
        { type: "output", chunk: { seq: 7, dataBase64: base64("more") } },
      ]);
      expect(fixture.fallbackUpgrades).toEqual([]);
    },
    120_000,
  );

  it(
    "falls back to the server while the child is down and attaches the daemon again after it respawns",
    async () => {
      const fixture = await attachedFixture();
      const client = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=0");
      await until(() => client.frames.length >= 2, "the replay");

      fixture.children[0]?.kill("SIGKILL");
      await until(() => client.closed(), "the browser socket to drop");
      await until(() => fixture.detached.length === 1, "the detach");
      expect(fixture.plane.state).not.toBe("ready");
      expect(fixture.plane.isSessionAttached("session_1")).toBe(false);

      const duringOutage = connectClient(
        fixture.port,
        "/ws/terminals/term_1?sinceSeq=2",
      );
      await until(() => duringOutage.closed(), "the in-process fallback");
      expect(fixture.fallbackUpgrades).toEqual(["/ws/terminals/term_1?sinceSeq=2"]);

      await until(() => fixture.plane.state === "ready", "the respawn");
      expect(fixture.children).toHaveLength(2);
      await until(
        () => fixture.plane.isSessionAttached("session_1"),
        "the data socket after respawn",
      );
      const afterRespawn = connectClient(
        fixture.port,
        "/ws/terminals/term_1?sinceSeq=2",
      );
      await until(() => afterRespawn.frames.length >= 2, "the replay after respawn");
      expect(afterRespawn.frames[0]).toMatchObject({
        type: "attached",
        replayStartSeq: 2,
        nextSeq: 3,
      });
    },
    120_000,
  );

  it(
    "stops carrying a host's terminals when its daemon session closes",
    async () => {
      const fixture = await attachedFixture();
      const client = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=0");
      await until(() => client.frames.length >= 2, "the replay");
      let daemonClosed = false;
      fixture.daemonSockets[0]?.on("close", () => {
        daemonClosed = true;
      });

      fixture.closeSession();
      await until(() => daemonClosed, "the data socket to be closed");
      await until(() => client.closed(), "the browser socket to be closed");

      expect(fixture.plane.isSessionAttached("session_1")).toBe(false);
      expect(fixture.directOutput.at(-1)).toEqual({
        daemonSessionId: "session_1",
        enabled: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fixture.tickets).toHaveLength(1);
    },
    120_000,
  );

  it(
    "admits a data socket only with an unused ticket, the ticket's host key, no browser origin and a current session",
    async () => {
      const fixture = await createFixture("manual");
      await until(() => fixture.plane.state === "ready", "the child");
      fixture.openSession();
      const nextTicket = async (): Promise<string> => {
        const seen = fixture.tickets.length;
        fixture.releaseConnects();
        await until(() => fixture.tickets.length > seen, "a fresh ticket");
        return fixture.tickets.at(-1) ?? "";
      };
      const dial = (headers: Record<string, string>) =>
        dialDataSocket(fixture.port, headers);

      expect((await dial({ authorization: HOST_KEY_HEADER })).status).toBe(401);
      expect(
        (
          await dial({
            authorization: HOST_KEY_HEADER,
            [TERMINAL_DATA_SOCKET_TICKET_HEADER]: "not-a-ticket-not-a-ticket",
          })
        ).status,
      ).toBe(401);

      const fromBrowser = await nextTicket();
      expect(
        (
          await dial({
            authorization: HOST_KEY_HEADER,
            origin: "http://127.0.0.1:3001",
            [TERMINAL_DATA_SOCKET_TICKET_HEADER]: fromBrowser,
          })
        ).status,
      ).toBe(403);

      const wrongKey = await nextTicket();
      expect(
        (
          await dial({
            authorization: "Bearer other-host-key",
            [TERMINAL_DATA_SOCKET_TICKET_HEADER]: wrongKey,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await dial({
            authorization: HOST_KEY_HEADER,
            [TERMINAL_DATA_SOCKET_TICKET_HEADER]: wrongKey,
          })
        ).status,
      ).toBe(401);

      const replacedSession = await nextTicket();
      fixture.currentSessionId.value = "session_2";
      expect(
        (
          await dial({
            authorization: HOST_KEY_HEADER,
            [TERMINAL_DATA_SOCKET_TICKET_HEADER]: replacedSession,
          })
        ).status,
      ).toBe(403);
      fixture.currentSessionId.value = "session_1";
      expect(fixture.plane.isSessionAttached("session_1")).toBe(false);

      const valid = await nextTicket();
      const admitted = await dial({
        authorization: HOST_KEY_HEADER,
        [TERMINAL_DATA_SOCKET_TICKET_HEADER]: valid,
      });
      expect(admitted.socket).not.toBeNull();
      await until(
        () => fixture.plane.isSessionAttached("session_1"),
        "the admitted data socket",
      );
      expect(
        (
          await dial({
            authorization: HOST_KEY_HEADER,
            [TERMINAL_DATA_SOCKET_TICKET_HEADER]: valid,
          })
        ).status,
      ).toBe(401);
      expect(fixture.fallbackUpgrades).toEqual([]);
    },
    120_000,
  );
});
