import { once } from "node:events";
import { Socket, type AddressInfo } from "node:net";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  TerminalDataPlaneChild,
  type TerminalDataPlaneSocket,
} from "./data-plane-child.js";
import { HOLDER_MARKER_PENDING_TIMEOUT_MS } from "../services/terminals/holder-marker.js";
import {
  TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES,
  TERMINAL_DATA_PLANE_INPUT_COALESCE_MS,
  TERMINAL_DATA_PLANE_IPC_VERSION,
  TERMINAL_DATA_PLANE_PENDING_REPLAY_BUFFER_BYTES,
  TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES,
  TERMINAL_DATA_PLANE_SOCKET_FRAME_OVERHEAD_BYTES,
  TERMINAL_DATA_PLANE_STATS_INTERVAL_MS,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneMainMessage,
} from "./ipc-contract.js";

const v = TERMINAL_DATA_PLANE_IPC_VERSION;

const session: TerminalSession = {
  id: "term_a",
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

function chunk(seq: number, text = `out-${seq}`) {
  return { seq, dataBase64: base64(text) };
}

class FakeSocket implements TerminalDataPlaneSocket {
  bufferedAmount = 0;
  readonly closes: Array<{
    code: number | undefined;
    reason: string | undefined;
  }> = [];
  readonly sent: string[] = [];
  terminated = false;
  private closeListeners: Array<() => void> = [];
  private messageListeners: Array<(data: unknown) => void> = [];

  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(
    event: "close" | "error" | "message",
    listener:
      | (() => void)
      | ((error: Error) => void)
      | ((data: unknown) => void),
  ): unknown {
    if (event === "close") {
      this.closeListeners.push(listener as () => void);
    } else if (event === "message") {
      this.messageListeners.push(listener as (data: unknown) => void);
    }
    return this;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  receive(message: unknown): void {
    const data =
      typeof message === "string" ? message : JSON.stringify(message);
    for (const listener of this.messageListeners) {
      listener(data);
    }
  }

  emitClose(): void {
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  outputSeqs(): number[] {
    return this.frames()
      .filter((frame) => frame.type === "output")
      .map((frame) => (frame.chunk as { seq: number }).seq);
  }
}

class RecordingSocket implements TerminalDataPlaneSocket {
  peakBufferedAmount = 0;
  sends = 0;
  terminated = false;

  constructor(private readonly socket: WebSocket) {}

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(
    event: "close" | "error" | "message",
    listener:
      | (() => void)
      | ((error: Error) => void)
      | ((data: unknown) => void),
  ): unknown {
    this.socket.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  send(data: string): void {
    this.sends += 1;
    this.socket.send(data);
    this.peakBufferedAmount = Math.max(
      this.peakBufferedAmount,
      this.socket.bufferedAmount,
    );
  }

  terminate(): void {
    this.terminated = true;
    this.socket.terminate();
  }
}

interface Harness {
  child: TerminalDataPlaneChild;
  clock: { now: number };
  exits: number;
  failNextUpgrade: boolean;
  holdSends: boolean;
  nextUpgrade: TerminalDataPlaneSocket | null;
  releaseSends(): void;
  sockets: FakeSocket[];
  toMain: TerminalDataPlaneChildMessage[];
}

const harnesses: Harness[] = [];

function createHarness(): Harness {
  const held: Array<() => void> = [];
  const state: Omit<Harness, "child"> = {
    clock: { now: 1_000_000 },
    exits: 0,
    failNextUpgrade: false,
    holdSends: false,
    nextUpgrade: null,
    releaseSends: () => {
      for (const done of held.splice(0)) {
        done();
      }
    },
    sockets: [],
    toMain: [],
  };
  const child = new TerminalDataPlaneChild({
    exit: () => {
      state.exits += 1;
    },
    now: () => state.clock.now,
    rssBytes: () => 4096,
    sendToMain: (message, onSent) => {
      state.toMain.push(message);
      if (state.holdSends) {
        held.push(onSent);
      } else {
        onSent();
      }
    },
    upgrade: () => {
      if (state.failNextUpgrade) {
        state.failNextUpgrade = false;
        return Promise.reject(new Error("handshake refused"));
      }
      if (state.nextUpgrade !== null) {
        const next = state.nextUpgrade;
        state.nextUpgrade = null;
        return Promise.resolve(next);
      }
      const socket = new FakeSocket();
      state.sockets.push(socket);
      return Promise.resolve(socket);
    },
  });
  const harness = Object.assign(state, { child });
  harnesses.push(harness);
  return harness;
}

function ofType<Type extends TerminalDataPlaneChildMessage["type"]>(
  harness: Harness,
  type: Type,
): Array<Extract<TerminalDataPlaneChildMessage, { type: Type }>> {
  return harness.toMain.filter(
    (
      message,
    ): message is Extract<TerminalDataPlaneChildMessage, { type: Type }> =>
      message.type === type,
  );
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

function main(harness: Harness, message: TerminalDataPlaneMainMessage): void {
  harness.child.handleMainMessage(message, undefined);
}

async function attachBrowser(
  harness: Harness,
  args: {
    attachId: string;
    daemonSessionId?: string;
    outputAcks?: boolean;
    terminalId: string;
    url?: string;
  },
): Promise<FakeSocket> {
  const before = harness.sockets.length;
  harness.child.handleMainMessage(
    {
      v,
      type: "browser.attach",
      attachId: args.attachId,
      terminalId: args.terminalId,
      daemonSessionId: args.daemonSessionId ?? "session_1",
      outputAcks: args.outputAcks ?? false,
      sequenceBase: 0,
      sinceSeq: 0,
      request: {
        url: args.url ?? `/ws/terminals/${args.terminalId}`,
        headers: [],
        headBase64: "",
      },
    },
    new Socket(),
  );
  await settle();
  const socket = harness.sockets[before];
  if (socket === undefined) {
    throw new Error("The upgrade did not produce a socket");
  }
  return socket;
}

function replay(
  harness: Harness,
  args: {
    attachId: string;
    chunks?: Array<{ seq: number; dataBase64: string }>;
    nextSeq: number;
    replayStartSeq?: number;
    terminalId: string;
  },
): void {
  main(harness, {
    v,
    type: "browser.replay",
    attachId: args.attachId,
    terminalId: args.terminalId,
    session: { ...session, id: args.terminalId },
    replayStartSeq: args.replayStartSeq ?? 0,
    chunks: args.chunks ?? [],
    nextSeq: args.nextSeq,
  });
}

async function attachLive(
  harness: Harness,
  args: Parameters<typeof attachBrowser>[1] & { nextSeq?: number },
): Promise<FakeSocket> {
  const socket = await attachBrowser(harness, args);
  replay(harness, {
    attachId: args.attachId,
    terminalId: args.terminalId,
    nextSeq: args.nextSeq ?? 0,
  });
  return socket;
}

async function attachDaemon(
  harness: Harness,
  daemonSessionId: string,
): Promise<FakeSocket> {
  const before = harness.sockets.length;
  harness.child.handleMainMessage(
    {
      v,
      type: "daemon.attach",
      daemonSessionId,
      request: { url: "/internal/terminal-data", headers: [], headBase64: "" },
    },
    new Socket(),
  );
  await settle();
  const socket = harness.sockets[before];
  if (socket === undefined) {
    throw new Error("The upgrade did not produce a socket");
  }
  return socket;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.child.shutdown();
  }
  vi.useRealTimers();
});

describe("terminal data plane child", () => {
  it("keeps two terminals on one daemon session apart in both directions", async () => {
    const harness = createHarness();
    const a = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    const b = await attachLive(harness, {
      attachId: "b1",
      terminalId: "term_b",
    });

    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0),
    });
    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_b",
      chunk: chunk(0, "for-b"),
    });
    a.receive({ type: "input", dataBase64: base64("typed-in-a") });

    expect(a.outputSeqs()).toEqual([0]);
    expect(a.sent.join("")).not.toContain(base64("for-b"));
    expect(b.sent.join("")).not.toContain(base64("out-0"));
    expect(ofType(harness, "terminal.input")).toEqual([
      {
        v,
        type: "terminal.input",
        attachId: "a1",
        terminalId: "term_a",
        dataBase64: base64("typed-in-a"),
      },
    ]);
  });

  it("binds the socket to the terminal named by main when the URL names another", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      url: "/ws/terminals/term_b",
    });

    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_b",
      chunk: chunk(0),
    });
    expect(socket.outputSeqs()).toEqual([]);

    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0),
    });
    socket.receive({ type: "input", dataBase64: base64("x") });

    expect(socket.outputSeqs()).toEqual([0]);
    expect(
      ofType(harness, "terminal.input").map((message) => message.terminalId),
    ).toEqual(["term_a"]);
  });

  it("accepts a browser socket only as an IPC handle", async () => {
    const harness = createHarness();

    main(harness, {
      v,
      type: "browser.attach",
      attachId: "a1",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      outputAcks: false,
      sequenceBase: 0,
      sinceSeq: 0,
      request: { url: "/ws/terminals/term_a", headers: [], headBase64: "" },
    });
    await settle();

    expect(harness.sockets).toHaveLength(0);
    expect(harness.child.browserSocketCount).toBe(0);
    expect(ofType(harness, "browser.rejected")).toMatchObject([
      { attachId: "a1", code: "missing_socket" },
    ]);
  });

  it("destroys a handle that arrives with a message that takes none or is invalid", () => {
    const harness = createHarness();
    const stray = new Socket();
    const malformed = new Socket();
    const wrongDirection = new Socket();

    harness.child.handleMainMessage(
      { v, type: "terminal.unroute", terminalId: "term_a" },
      stray,
    );
    harness.child.handleMainMessage({ v, type: "browser.attach" }, malformed);
    harness.child.handleMainMessage(
      { v, type: "ready", pid: 1 },
      wrongDirection,
    );

    expect(stray.destroyed).toBe(true);
    expect(malformed.destroyed).toBe(true);
    expect(wrongDirection.destroyed).toBe(true);
    expect(harness.child.rejectedMainMessageCount).toBe(2);
    expect(harness.child.browserSocketCount).toBe(0);
  });

  it("reports a failed upgrade and destroys the socket", async () => {
    const harness = createHarness();
    harness.failNextUpgrade = true;
    const handle = new Socket();

    harness.child.handleMainMessage(
      {
        v,
        type: "browser.attach",
        attachId: "a1",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        outputAcks: false,
        sequenceBase: 0,
        sinceSeq: 0,
        request: { url: "/ws/terminals/term_a", headers: [], headBase64: "" },
      },
      handle,
    );
    await settle();

    expect(handle.destroyed).toBe(true);
    expect(ofType(harness, "browser.rejected")).toMatchObject([
      { attachId: "a1", code: "upgrade_failed", message: "handshake refused" },
    ]);
    expect(ofType(harness, "browser.attached")).toEqual([]);
  });

  it("terminates a socket whose attach was closed while the upgrade was running", async () => {
    const harness = createHarness();

    harness.child.handleMainMessage(
      {
        v,
        type: "browser.attach",
        attachId: "a1",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        outputAcks: false,
        sequenceBase: 0,
        sinceSeq: 0,
        request: { url: "/ws/terminals/term_a", headers: [], headBase64: "" },
      },
      new Socket(),
    );
    main(harness, {
      v,
      type: "browser.close",
      target: { kind: "terminal", terminalId: "term_a" },
      code: 1000,
      reason: "terminal-closed",
    });
    await settle();

    expect(harness.sockets[0]?.terminated).toBe(true);
    expect(ofType(harness, "browser.attached")).toEqual([]);
    expect(ofType(harness, "browser.rejected")).toMatchObject([
      { attachId: "a1", code: "closed_before_attach" },
    ]);
  });

  it("writes the attached frame and the replay before live output that arrived first", async () => {
    const harness = createHarness();
    const socket = await attachBrowser(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });

    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(2),
    });
    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(3),
    });
    expect(socket.sent).toEqual([]);

    replay(harness, {
      attachId: "a1",
      terminalId: "term_a",
      chunks: [chunk(0), chunk(1), chunk(2)],
      nextSeq: 3,
    });
    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(4),
    });

    expect(socket.frames()[0]).toMatchObject({
      type: "attached",
      replayStartSeq: 0,
      nextSeq: 3,
    });
    expect(socket.outputSeqs()).toEqual([0, 1, 2, 3, 4]);
    expect(ofType(harness, "browser.resync")).toEqual([]);
  });

  it("never writes a chunk below the socket's next sequence", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      nextSeq: 5,
    });

    for (const seq of [3, 4, 5, 5, 6, 4, 6, 7]) {
      main(harness, {
        v,
        type: "terminal.output",
        terminalId: "term_a",
        chunk: chunk(seq),
      });
    }

    expect(socket.outputSeqs()).toEqual([5, 6, 7]);
  });

  it("asks main for a resync once on a gap and resumes without loss or duplicate", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      nextSeq: 2,
    });

    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(2),
    });
    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(5),
    });
    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(6),
    });

    expect(socket.outputSeqs()).toEqual([2]);
    expect(ofType(harness, "browser.resync")).toEqual([
      {
        v,
        type: "browser.resync",
        attachId: "a1",
        terminalId: "term_a",
        fromSeq: 3,
      },
    ]);

    replay(harness, {
      attachId: "a1",
      terminalId: "term_a",
      replayStartSeq: 1,
      chunks: [chunk(1), chunk(2), chunk(3), chunk(4), chunk(5)],
      nextSeq: 6,
    });
    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(7),
    });

    expect(socket.outputSeqs()).toEqual([2, 3, 4, 5, 6, 7]);
    expect(
      socket.frames().filter((frame) => frame.type === "attached"),
    ).toHaveLength(1);
    expect(ofType(harness, "browser.resync")).toHaveLength(1);
  });

  it("closes the socket when a resync replay cannot cover the gap", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      nextSeq: 2,
    });

    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(9),
    });
    replay(harness, {
      attachId: "a1",
      terminalId: "term_a",
      replayStartSeq: 6,
      chunks: [chunk(6), chunk(7), chunk(8)],
      nextSeq: 9,
    });

    expect(socket.outputSeqs()).toEqual([]);
    expect(socket.closes).toEqual([{ code: 1013, reason: "replay-gap" }]);
    expect(ofType(harness, "browser.detached")).toMatchObject([
      { attachId: "a1" },
    ]);
  });

  it("closes a socket whose pending replay buffer passes the cap", async () => {
    const harness = createHarness();
    const socket = await attachBrowser(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    const large = "A".repeat(64 * 1024);
    const needed =
      Math.ceil(
        TERMINAL_DATA_PLANE_PENDING_REPLAY_BUFFER_BYTES / large.length,
      ) + 1;

    for (let seq = 0; seq < needed; seq += 1) {
      main(harness, {
        v,
        type: "terminal.output",
        terminalId: "term_a",
        chunk: { seq, dataBase64: large },
      });
    }

    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([
      { code: 1013, reason: "replay-buffer-overflow" },
    ]);
    expect(ofType(harness, "browser.detached")).toEqual([
      {
        v,
        type: "browser.detached",
        attachId: "a1",
        terminalId: "term_a",
        lastAckedSeq: null,
      },
    ]);
    expect(harness.child.browserSocketCount).toBe(0);
  });

  it("closes a browser socket whose send backlog passes the hard cap", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    socket.bufferedAmount = TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES + 1;

    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0),
    });
    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(1),
    });

    expect(socket.outputSeqs()).toEqual([0]);
    expect(socket.closes).toEqual([{ code: 1013, reason: "browser-backlog" }]);
  });

  it("holds control frames until the attached frame has been written", async () => {
    const harness = createHarness();
    const socket = await attachBrowser(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });

    main(harness, {
      v,
      type: "browser.send",
      terminalId: "term_a",
      message: { type: "session-updated", session },
    });
    expect(socket.sent).toEqual([]);

    replay(harness, { attachId: "a1", terminalId: "term_a", nextSeq: 0 });
    main(harness, {
      v,
      type: "browser.send",
      terminalId: "term_a",
      message: { type: "error", code: "terminal_error", message: "boom" },
    });

    expect(socket.frames().map((frame) => frame.type)).toEqual([
      "attached",
      "session-updated",
      "error",
    ]);
  });

  it("sends a reply only to the attach it names, held until the attached frame is written", async () => {
    const harness = createHarness();
    const named = await attachBrowser(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    const other = await attachBrowser(harness, {
      attachId: "a2",
      terminalId: "term_a",
    });

    main(harness, {
      v,
      type: "browser.reply",
      attachId: "a1",
      message: { type: "resize-applied", seq: 4 },
    });
    main(harness, {
      v,
      type: "browser.reply",
      attachId: "a1",
      message: {
        type: "session-updated",
        session: { ...session, cols: 39 },
        resizeSeq: 5,
      },
    });
    expect(named.sent).toEqual([]);

    replay(harness, { attachId: "a1", terminalId: "term_a", nextSeq: 0 });
    replay(harness, { attachId: "a2", terminalId: "term_a", nextSeq: 0 });
    main(harness, {
      v,
      type: "browser.send",
      terminalId: "term_a",
      message: { type: "session-updated", session },
    });
    main(harness, {
      v,
      type: "browser.reply",
      attachId: "a1",
      message: { type: "features", resizeAcks: true },
    });

    expect(named.frames().map((frame) => frame.type)).toEqual([
      "attached",
      "resize-applied",
      "session-updated",
      "session-updated",
      "features",
    ]);
    expect(named.frames()[2]).toEqual({
      type: "session-updated",
      session: { ...session, cols: 39 },
      resizeSeq: 5,
    });
    expect(other.frames().map((frame) => frame.type)).toEqual([
      "attached",
      "session-updated",
    ]);
  });

  it("answers ping itself and passes resize, ack and visibility to main", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      outputAcks: true,
    });
    harness.toMain.length = 0;

    socket.receive({ type: "ping" });
    socket.receive({ type: "resize", cols: 120, rows: 40 });
    socket.receive({ type: "ack", nextSeq: 7 });
    socket.receive({ type: "visibility", visible: false });
    socket.emitClose();

    expect(socket.frames().at(-1)).toEqual({ type: "pong" });
    expect(harness.toMain).toEqual([
      {
        v,
        type: "browser.control",
        attachId: "a1",
        terminalId: "term_a",
        message: { type: "resize", cols: 120, rows: 40 },
      },
      {
        v,
        type: "terminal.ack",
        attachId: "a1",
        terminalId: "term_a",
        nextSeq: 7,
      },
      {
        v,
        type: "terminal.visibility",
        attachId: "a1",
        terminalId: "term_a",
        visible: false,
      },
      {
        v,
        type: "browser.detached",
        attachId: "a1",
        terminalId: "term_a",
        lastAckedSeq: 6,
      },
    ]);
  });

  it("closes a socket that sends a frame outside the browser protocol", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });

    socket.receive({ type: "input", dataBase64: "not base64!" });
    socket.receive({ type: "input", dataBase64: base64("after-close") });

    expect(socket.closes).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(ofType(harness, "terminal.input")).toEqual([]);
    expect(ofType(harness, "browser.detached")).toHaveLength(1);
  });

  it("sends the first keystroke at once and coalesces the burst behind it", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });

    for (const key of ["a", "b", "c", "d"]) {
      socket.receive({ type: "input", dataBase64: base64(key) });
    }
    expect(
      ofType(harness, "terminal.input").map((message) => message.dataBase64),
    ).toEqual([base64("a")]);

    vi.advanceTimersByTime(TERMINAL_DATA_PLANE_INPUT_COALESCE_MS);
    expect(
      ofType(harness, "terminal.input").map((message) => message.dataBase64),
    ).toEqual([base64("a"), base64("bcd")]);

    vi.advanceTimersByTime(TERMINAL_DATA_PLANE_INPUT_COALESCE_MS * 2);
    socket.receive({ type: "input", dataBase64: base64("e") });
    expect(
      ofType(harness, "terminal.input").map((message) => message.dataBase64),
    ).toEqual([base64("a"), base64("bcd"), base64("e")]);
  });

  it("never merges input from two browsers into one relay and names the browser that typed it", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    const second = await attachLive(harness, {
      attachId: "a2",
      terminalId: "term_a",
    });

    first.receive({ type: "input", dataBase64: base64("1") });
    first.receive({ type: "input", dataBase64: base64("2") });
    second.receive({ type: "input", dataBase64: base64("3") });
    second.receive({ type: "input", dataBase64: base64("4") });
    first.receive({ type: "input", dataBase64: base64("5") });
    vi.advanceTimersByTime(TERMINAL_DATA_PLANE_INPUT_COALESCE_MS);

    expect(
      ofType(harness, "terminal.input").map((message) => [
        message.attachId,
        message.dataBase64,
      ]),
    ).toEqual([
      ["a1", base64("1")],
      ["a1", base64("2")],
      ["a2", base64("34")],
      ["a1", base64("5")],
    ]);
  });

  it("reports input activity at most once a second per terminal", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });

    socket.receive({ type: "input", dataBase64: base64("a") });
    harness.clock.now += 999;
    socket.receive({ type: "input", dataBase64: base64("b") });
    harness.clock.now += 1;
    socket.receive({ type: "input", dataBase64: base64("c") });

    expect(
      ofType(harness, "terminal.input-activity").map((message) => message.at),
    ).toEqual([1_000_000, 1_001_000]);
  });

  it("closes the terminal's sockets when input waiting for main passes the cap", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    const other = await attachLive(harness, {
      attachId: "b1",
      terminalId: "term_b",
    });
    harness.holdSends = true;
    const block = Buffer.alloc(48 * 1024, 0x61).toString("base64");
    const blocks =
      Math.ceil(TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES / block.length) + 2;

    for (let index = 0; index < blocks; index += 1) {
      socket.receive({ type: "input", dataBase64: block });
      vi.advanceTimersByTime(TERMINAL_DATA_PLANE_INPUT_COALESCE_MS);
    }

    expect(socket.closes).toEqual([{ code: 1013, reason: "input-backlog" }]);
    expect(other.closes).toEqual([]);
    const relayed = ofType(harness, "terminal.input").reduce(
      (total, message) => total + message.dataBase64.length,
      0,
    );
    expect(relayed).toBeLessThanOrEqual(
      TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES,
    );

    harness.releaseSends();
    harness.holdSends = false;
    other.receive({ type: "input", dataBase64: base64("still-works") });
    expect(ofType(harness, "terminal.input").at(-1)).toMatchObject({
      terminalId: "term_b",
      dataBase64: base64("still-works"),
    });
  });

  it("closes the terminal's sockets when input waiting for a stalled data socket passes the cap", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_1");
    for (const terminalId of ["term_a", "term_b"]) {
      main(harness, {
        v,
        type: "terminal.route",
        terminalId,
        daemonSessionId: "session_1",
        mode: "data-socket",
      });
    }
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      daemonSessionId: "session_1",
    });
    const other = await attachLive(harness, {
      attachId: "b1",
      terminalId: "term_b",
      daemonSessionId: "session_1",
    });
    const queued = () =>
      daemon.sent.reduce((total, frame) => total + Buffer.byteLength(frame), 0);
    const block = Buffer.alloc(48 * 1024, 0x61).toString("base64");
    const blocks =
      Math.ceil(TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES / block.length) + 5;

    for (let index = 0; index < blocks; index += 1) {
      socket.receive({ type: "input", dataBase64: block });
      daemon.bufferedAmount = queued();
    }

    expect(socket.closes).toEqual([{ code: 1013, reason: "input-backlog" }]);
    expect(other.closes).toEqual([]);
    expect(queued()).toBeLessThanOrEqual(
      TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES,
    );
    expect(ofType(harness, "terminal.input")).toEqual([]);
    expect(daemon.terminated).toBe(false);

    daemon.bufferedAmount = 0;
    other.receive({ type: "input", dataBase64: base64("still-works") });
    expect(daemon.frames().at(-1)).toEqual({
      type: "terminal.input",
      terminalId: "term_b",
      dataBase64: base64("still-works"),
    });
  });

  it("writes to a data socket only while the frame fits under the hard cap", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_1");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      outputAcks: true,
    });
    for (const seq of [0, 1, 2, 3]) {
      daemon.receive({
        type: "terminal.output",
        terminalId: "term_a",
        chunk: chunk(seq),
      });
    }
    const ack = (nextSeq: number) =>
      JSON.stringify({ type: "terminal.ack", terminalId: "term_a", nextSeq });

    daemon.bufferedAmount =
      TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES -
      Buffer.byteLength(ack(2)) -
      TERMINAL_DATA_PLANE_SOCKET_FRAME_OVERHEAD_BYTES;
    browser.receive({ type: "ack", nextSeq: 2 });

    expect(daemon.sent.at(-1)).toBe(ack(2));
    expect(daemon.terminated).toBe(false);
    const written = daemon.sent.length;

    daemon.bufferedAmount =
      TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES -
      Buffer.byteLength(ack(3)) -
      TERMINAL_DATA_PLANE_SOCKET_FRAME_OVERHEAD_BYTES +
      1;
    browser.receive({ type: "ack", nextSeq: 3 });
    browser.receive({ type: "ack", nextSeq: 4 });

    expect(daemon.sent.length).toBe(written);
    expect(daemon.terminated).toBe(true);
    expect(ofType(harness, "daemon.detached")).toEqual([
      { v, type: "daemon.detached", daemonSessionId: "session_1" },
    ]);
  });

  it("writes nothing to a data socket whose send backlog is at the hard cap", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_1");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      outputAcks: true,
    });
    for (const seq of [0, 1, 2]) {
      daemon.receive({
        type: "terminal.output",
        terminalId: "term_a",
        chunk: chunk(seq),
      });
    }
    const written = daemon.sent.length;
    daemon.bufferedAmount = TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES;

    browser.receive({ type: "ack", nextSeq: 2 });

    expect(daemon.sent.length).toBe(written);
    expect(daemon.terminated).toBe(true);
    expect(ofType(harness, "daemon.detached")).toEqual([
      { v, type: "daemon.detached", daemonSessionId: "session_1" },
    ]);
  });

  it("keeps a stalled ws data socket within the input cap and the hard cap", async () => {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      perMessageDeflate: false,
    });
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      perMessageDeflate: false,
    });
    const opened = once(client, "open");
    const [real] = (await once(server, "connection")) as [WebSocket];
    await opened;
    try {
      const harness = createHarness();
      const daemon = new RecordingSocket(real);
      harness.nextUpgrade = daemon;
      harness.child.handleMainMessage(
        {
          v,
          type: "daemon.attach",
          daemonSessionId: "session_1",
          request: {
            url: "/internal/terminal-data",
            headers: [],
            headBase64: "",
          },
        },
        new Socket(),
      );
      await settle();
      for (const terminalId of ["term_a", "term_b"]) {
        main(harness, {
          v,
          type: "terminal.route",
          terminalId,
          daemonSessionId: "session_1",
          mode: "data-socket",
        });
      }
      const typing = await attachLive(harness, {
        attachId: "a1",
        terminalId: "term_a",
      });
      const reader = await attachLive(harness, {
        attachId: "b1",
        terminalId: "term_b",
        outputAcks: true,
      });
      for (const seq of [0, 1, 2, 3]) {
        client.send(
          JSON.stringify({
            type: "terminal.output",
            terminalId: "term_b",
            chunk: chunk(seq),
          }),
        );
      }
      await vi.waitFor(() => {
        expect(reader.outputSeqs()).toEqual([0, 1, 2, 3]);
        expect(real.bufferedAmount).toBe(0);
      });

      const block = Buffer.alloc(48 * 1024, 0x61).toString("base64");
      for (
        let index = 0;
        index < 2048 && typing.closes.length === 0;
        index += 1
      ) {
        typing.receive({ type: "input", dataBase64: block });
      }

      expect(typing.closes).toEqual([{ code: 1013, reason: "input-backlog" }]);
      expect(reader.closes).toEqual([]);
      expect(daemon.peakBufferedAmount).toBeLessThanOrEqual(
        TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES,
      );
      expect(daemon.peakBufferedAmount).toBeGreaterThan(
        TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES - 2 * block.length,
      );
      expect(ofType(harness, "terminal.input")).toEqual([]);

      const ack = (nextSeq: number) =>
        JSON.stringify({ type: "terminal.ack", terminalId: "term_b", nextSeq });
      const ackBudget =
        Buffer.byteLength(ack(2)) +
        TERMINAL_DATA_PLANE_SOCKET_FRAME_OVERHEAD_BYTES;
      const largeFrameHeaderBytes = 10;
      real.send(
        Buffer.alloc(
          TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES -
            real.bufferedAmount -
            ackBudget -
            largeFrameHeaderBytes,
        ),
      );
      expect(real.bufferedAmount).toBe(
        TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES - ackBudget,
      );
      const sends = daemon.sends;

      reader.receive({ type: "ack", nextSeq: 2 });

      expect(daemon.sends).toBe(sends + 1);
      expect(real.bufferedAmount).toBeGreaterThan(
        TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES - ackBudget,
      );
      expect(real.bufferedAmount).toBeLessThanOrEqual(
        TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES,
      );

      reader.receive({ type: "ack", nextSeq: 3 });
      reader.receive({ type: "ack", nextSeq: 4 });

      expect(daemon.sends).toBe(sends + 1);
      expect(daemon.peakBufferedAmount).toBeLessThanOrEqual(
        TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES,
      );
      expect(daemon.terminated).toBe(true);
      expect(ofType(harness, "daemon.detached")).toEqual([
        { v, type: "daemon.detached", daemonSessionId: "session_1" },
      ]);
    } finally {
      client.terminate();
      real.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("carries a data-socket terminal without sending its bytes through main", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_1");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      outputAcks: true,
    });
    harness.toMain.length = 0;

    daemon.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0),
    });
    daemon.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(1),
    });
    browser.receive({ type: "input", dataBase64: base64("ls\n") });
    browser.receive({ type: "ack", nextSeq: 2 });

    expect(browser.outputSeqs()).toEqual([0, 1]);
    expect(daemon.frames()).toEqual([
      { type: "terminal.flow-control", terminalId: "term_a", enabled: true },
      {
        type: "terminal.input",
        terminalId: "term_a",
        dataBase64: base64("ls\n"),
      },
      { type: "terminal.ack", terminalId: "term_a", nextSeq: 2 },
    ]);
    expect(harness.toMain.map((message) => message.type)).toEqual([
      "terminal.input-activity",
    ]);
  });

  it("drops and counts a data-socket frame for a terminal routed elsewhere", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.child.start();
    const owner = await attachDaemon(harness, "session_1");
    const intruder = await attachDaemon(harness, "session_2");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_relay",
      daemonSessionId: "session_2",
      mode: "main-relay",
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    const relayBrowser = await attachLive(harness, {
      attachId: "r1",
      terminalId: "term_relay",
      daemonSessionId: "session_2",
    });

    intruder.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0, "forged"),
    });
    intruder.receive({
      type: "terminal.output",
      terminalId: "term_relay",
      chunk: chunk(0, "forged"),
    });
    intruder.receive({
      type: "terminal.output",
      terminalId: "term_unknown",
      chunk: chunk(0),
    });
    owner.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0, "real"),
    });

    expect(browser.frames().filter((frame) => frame.type === "output")).toEqual(
      [{ type: "output", chunk: chunk(0, "real") }],
    );
    expect(relayBrowser.outputSeqs()).toEqual([]);

    vi.advanceTimersByTime(TERMINAL_DATA_PLANE_STATS_INTERVAL_MS);
    expect(ofType(harness, "stats")).toEqual([
      {
        v,
        type: "stats",
        rssBytes: 4096,
        browserSockets: 2,
        daemonSockets: 2,
        droppedMisroutedFrames: 2,
      },
    ]);
    harness.child.shutdown();
  });

  it("never joins a browser to a data socket of a session main did not bind it to", async () => {
    const harness = createHarness();
    const first = await attachDaemon(harness, "session_1");
    const second = await attachDaemon(harness, "session_2");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const bound = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      daemonSessionId: "session_1",
    });
    const stale = await attachBrowser(harness, {
      attachId: "a2",
      terminalId: "term_a",
      daemonSessionId: "session_0",
    });

    stale.receive({ type: "input", dataBase64: base64("early") });
    replay(harness, { attachId: "a2", terminalId: "term_a", nextSeq: 0 });

    expect(first.frames()).toEqual([]);
    expect(ofType(harness, "terminal.input")).toMatchObject([
      { terminalId: "term_a", dataBase64: base64("early") },
    ]);
    expect(stale.sent).toEqual([]);
    expect(stale.closes).toEqual([
      { code: 1013, reason: "daemon-session-changed" },
    ]);

    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_2",
      mode: "data-socket",
    });
    second.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0, "from-session-2"),
    });
    bound.receive({ type: "input", dataBase64: base64("late") });

    expect(bound.closes).toEqual([
      { code: 1013, reason: "daemon-session-changed" },
    ]);
    expect(bound.outputSeqs()).toEqual([]);
    expect(second.frames()).toEqual([]);
    expect(
      ofType(harness, "browser.detached").map((message) => message.attachId),
    ).toEqual(["a2", "a1"]);
  });

  it("sends input and acks through main while the routed data socket is missing", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      outputAcks: true,
    });

    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0),
    });
    browser.receive({ type: "input", dataBase64: base64("before") });
    browser.receive({ type: "ack", nextSeq: 1 });

    expect(browser.outputSeqs()).toEqual([0]);
    expect(ofType(harness, "terminal.input")).toMatchObject([
      { terminalId: "term_a", dataBase64: base64("before") },
    ]);
    expect(ofType(harness, "terminal.ack")).toEqual([
      {
        v,
        type: "terminal.ack",
        attachId: "a1",
        terminalId: "term_a",
        nextSeq: 1,
      },
    ]);

    const daemon = await attachDaemon(harness, "session_1");
    expect(ofType(harness, "daemon.attached")).toEqual([
      { v, type: "daemon.attached", daemonSessionId: "session_1" },
    ]);
    daemon.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(1),
    });
    daemon.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(2),
    });
    browser.receive({ type: "input", dataBase64: base64("during") });
    browser.receive({ type: "ack", nextSeq: 3 });

    expect(browser.outputSeqs()).toEqual([0, 1, 2]);
    expect(daemon.frames()).toEqual([
      { type: "terminal.flow-control", terminalId: "term_a", enabled: true },
      {
        type: "terminal.input",
        terminalId: "term_a",
        dataBase64: base64("during"),
      },
      { type: "terminal.ack", terminalId: "term_a", nextSeq: 3 },
    ]);
    expect(ofType(harness, "terminal.ack")).toHaveLength(1);

    daemon.emitClose();
    browser.receive({ type: "input", dataBase64: base64("after") });
    browser.receive({ type: "ack", nextSeq: 3 });
    vi.advanceTimersByTime(TERMINAL_DATA_PLANE_INPUT_COALESCE_MS);

    expect(ofType(harness, "daemon.detached")).toEqual([
      { v, type: "daemon.detached", daemonSessionId: "session_1" },
    ]);
    expect(harness.child.daemonSocketCount).toBe(0);
    expect(
      ofType(harness, "terminal.input").map((message) => message.dataBase64),
    ).toEqual([base64("before"), base64("after")]);
    expect(ofType(harness, "terminal.ack")).toHaveLength(2);
  });

  it("strips holder markers from data-plane client output when whole, split, or bytewise", async () => {
    const grid = Buffer.from("\u001b]7791;bb-grid;80;24\u0007");
    const marker = Buffer.from("\u001b]7717;bb-holder;term_a\u0007");
    const body = Buffer.from("beforeafter");
    const bytes = Buffer.concat([grid, marker, body]);
    const scenarios = [
      [bytes],
      ...Array.from({ length: bytes.length - 1 }, (_, index) => [
        bytes.subarray(0, index + 1),
        bytes.subarray(index + 1),
      ]),
      Array.from({ length: bytes.length }, (_, index) =>
        bytes.subarray(index, index + 1),
      ),
    ];
    for (const parts of scenarios) {
      const harness = createHarness();
      main(harness, {
        v,
        type: "terminal.route",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        mode: "data-socket",
        holderMarkerPending: true,
      });
      const browser = await attachLive(harness, {
        attachId: "a1",
        terminalId: "term_a",
        daemonSessionId: "session_1",
      });
      const daemon = await attachDaemon(harness, "session_1");
      for (const [seq, part] of parts.entries()) {
        daemon.receive({
          type: "terminal.output",
          terminalId: "term_a",
          chunk: { seq, dataBase64: part.toString("base64") },
        });
      }
      const output = browser
        .frames()
        .filter((frame) => frame.type === "output")
        .map((frame) => frame.chunk as { seq: number; dataBase64: string });
      const received = Buffer.concat(
        output.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
      );
      expect(received.includes(Buffer.from("7717;bb-holder"))).toBe(false);
      expect(received.toString()).toBe(Buffer.concat([grid, body]).toString());
      expect(output.map((chunk) => chunk.seq)).toEqual(
        parts.map((_, index) => index),
      );
      harness.child.shutdown();
    }
  });

  it.each([
    ...Array.from({ length: 17 }, (_, index) => index + 1),
    Buffer.byteLength("\u001b]7717;bb-holder;") + 3,
  ])(
    "strips holder markers split at byte %i after a 2 s delay",
    async (splitAt) => {
      vi.useFakeTimers();
      const harness = createHarness();
      main(harness, {
        v,
        type: "terminal.route",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        mode: "data-socket",
        holderMarkerPending: true,
      });
      const browser = await attachLive(harness, {
        attachId: "a1",
        terminalId: "term_a",
        daemonSessionId: "session_1",
      });
      const daemon = await attachDaemon(harness, "session_1");
      const grid = Buffer.from("\u001b]7791;bb-grid;80;24\u0007");
      const marker = Buffer.from("\u001b]7717;bb-holder;term_a\u0007");
      const first = Buffer.concat([grid, marker.subarray(0, splitAt)]);
      daemon.receive({
        type: "terminal.output",
        terminalId: "term_a",
        chunk: { seq: 0, dataBase64: first.toString("base64") },
      });
      await vi.advanceTimersByTimeAsync(HOLDER_MARKER_PENDING_TIMEOUT_MS);
      const beforeRemainder = browser
        .frames()
        .filter((frame) => frame.type === "output")
        .map((frame) => frame.chunk as { dataBase64: string });
      expect(beforeRemainder).toHaveLength(splitAt <= 3 ? 1 : 0);
      await vi.advanceTimersByTimeAsync(
        2_000 - HOLDER_MARKER_PENDING_TIMEOUT_MS,
      );
      expect(
        browser.frames().filter((frame) => frame.type === "output"),
      ).toHaveLength(splitAt <= 3 ? 1 : 0);
      daemon.receive({
        type: "terminal.output",
        terminalId: "term_a",
        chunk: {
          seq: 1,
          dataBase64: Buffer.concat([
            marker.subarray(splitAt),
            Buffer.from("after"),
          ]).toString("base64"),
        },
      });
      const output = browser
        .frames()
        .filter((frame) => frame.type === "output")
        .map((frame) => frame.chunk as { dataBase64: string });
      const received = Buffer.concat(
        output.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
      );
      expect(received.includes(Buffer.from("7717;bb-holder"))).toBe(false);
      const ambiguousPrefix =
        splitAt <= 3 ? marker.subarray(0, splitAt) : Buffer.alloc(0);
      expect(received.toString()).toBe(
        Buffer.concat([
          grid,
          ambiguousPrefix,
          splitAt <= 3 ? Buffer.from("\u001b\\") : Buffer.alloc(0),
          Buffer.from("after"),
        ]).toString(),
      );
      harness.child.shutdown();
    },
  );

  it.each([
    [4, 300, "same-chunk"],
    [8, 2_000, "later-chunk"],
    [Buffer.byteLength("\u001b]7791;bb-grid;"), 300, "same-chunk"],
    [Buffer.byteLength("\u001b]7791;bb-grid;80;"), 2_000, "later-chunk"],
  ] as const)(
    "keeps holder filtering pending across a delayed partial grid prefix at byte %i (%i ms, %s)",
    async (splitAt, delayMs, markerPlacement) => {
      vi.useFakeTimers();
      const harness = createHarness();
      main(harness, {
        v,
        type: "terminal.route",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        mode: "data-socket",
        holderMarkerPending: true,
      });
      const browser = await attachLive(harness, {
        attachId: "a1",
        terminalId: "term_a",
        daemonSessionId: "session_1",
      });
      const daemon = await attachDaemon(harness, "session_1");
      const grid = Buffer.from("\u001b]7791;bb-grid;80;24\u0007");
      const holder = Buffer.from("\u001b]7717;bb-holder;term_a\u0007");
      const after = Buffer.from("AFTER\n");
      daemon.receive({
        type: "terminal.output",
        terminalId: "term_a",
        chunk: {
          seq: 0,
          dataBase64: grid.subarray(0, splitAt).toString("base64"),
        },
      });
      await vi.advanceTimersByTimeAsync(delayMs);
      expect(
        browser.frames().filter((frame) => frame.type === "output"),
      ).toEqual([]);
      const sameChunk = markerPlacement === "same-chunk";
      const rest = Buffer.concat([
        grid.subarray(splitAt),
        ...(sameChunk ? [holder, after] : []),
      ]);
      daemon.receive({
        type: "terminal.output",
        terminalId: "term_a",
        chunk: { seq: 1, dataBase64: rest.toString("base64") },
      });
      if (!sameChunk) {
        await vi.advanceTimersByTimeAsync(delayMs);
        daemon.receive({
          type: "terminal.output",
          terminalId: "term_a",
          chunk: {
            seq: 2,
            dataBase64: Buffer.concat([holder, after]).toString("base64"),
          },
        });
      }
      const output = browser
        .frames()
        .filter((frame) => frame.type === "output")
        .map((frame) => frame.chunk as { seq: number; dataBase64: string });
      const received = Buffer.concat(
        output.map((part) => Buffer.from(part.dataBase64, "base64")),
      );
      expect(received.toString()).toBe(`${grid.toString()}AFTER\n`);
      expect(received.toString()).not.toContain("7717;bb-holder");
      expect(received.toString().match(/AFTER\n/gu)).toHaveLength(1);
      expect(output.map((part) => part.seq)).toEqual(
        markerPlacement === "same-chunk" ? [0, 1] : [0, 1, 2],
      );
      harness.child.shutdown();
    },
  );

  it.each(["\u001b", "\u001b]", "\u001b]7"])(
    "flushes short ambiguous prefix %j after the timeout",
    async (text) => {
      vi.useFakeTimers();
      const harness = createHarness();
      main(harness, {
        v,
        type: "terminal.route",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        mode: "data-socket",
        holderMarkerPending: true,
      });
      const browser = await attachLive(harness, {
        attachId: "a1",
        terminalId: "term_a",
        daemonSessionId: "session_1",
      });
      const daemon = await attachDaemon(harness, "session_1");
      daemon.receive({
        type: "terminal.output",
        terminalId: "term_a",
        chunk: { seq: 0, dataBase64: Buffer.from(text).toString("base64") },
      });
      await vi.advanceTimersByTimeAsync(HOLDER_MARKER_PENDING_TIMEOUT_MS);
      const output = browser
        .frames()
        .filter((frame) => frame.type === "output")
        .map((frame) => frame.chunk as { dataBase64: string });
      expect(
        Buffer.concat(
          output.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
        ).toString(),
      ).toBe(text);
      harness.child.shutdown();
    },
  );

  it("releases ESC ]7; immediately because it cannot begin a holder marker", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
      holderMarkerPending: true,
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      daemonSessionId: "session_1",
    });
    const daemon = await attachDaemon(harness, "session_1");
    const cwdStart = Buffer.from("\u001b]7;");
    daemon.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: { seq: 0, dataBase64: cwdStart.toString("base64") },
    });
    expect(
      browser.frames().filter((frame) => frame.type === "output"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HOLDER_MARKER_PENDING_TIMEOUT_MS * 2);
    const output = browser
      .frames()
      .filter((frame) => frame.type === "output")
      .map((frame) => frame.chunk as { dataBase64: string });
    expect(
      Buffer.concat(
        output.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
      ).toString(),
    ).toBe(cwdStart.toString());
    harness.child.shutdown();
  });

  it("drops a session's routes and closes its data socket on daemon.detach", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_1");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });

    main(harness, { v, type: "daemon.detach", daemonSessionId: "session_1" });
    daemon.receive({
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0),
    });

    expect(daemon.closes).toEqual([{ code: 1000, reason: "daemon-detached" }]);
    expect(browser.outputSeqs()).toEqual([]);
    expect(harness.child.daemonSocketCount).toBe(0);
  });

  it("closes sockets on browser.close and terminal.resync and reports each once", async () => {
    const harness = createHarness();
    const first = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    const second = await attachLive(harness, {
      attachId: "a2",
      terminalId: "term_a",
    });
    const third = await attachLive(harness, {
      attachId: "b1",
      terminalId: "term_b",
    });

    main(harness, {
      v,
      type: "browser.close",
      target: { kind: "attach", attachId: "a1" },
      code: 1000,
      reason: "done",
    });
    first.emitClose();
    main(harness, { v, type: "terminal.resync", terminalId: "term_a" });
    main(harness, {
      v,
      type: "terminal.output",
      terminalId: "term_a",
      chunk: chunk(0),
    });

    expect(first.closes).toEqual([{ code: 1000, reason: "done" }]);
    expect(second.closes).toEqual([{ code: 1013, reason: "terminal-resync" }]);
    expect(third.closes).toEqual([]);
    expect(second.outputSeqs()).toEqual([]);
    expect(
      ofType(harness, "browser.detached").map((message) => message.attachId),
    ).toEqual(["a1", "a2"]);
    expect(harness.child.browserSocketCount).toBe(1);
  });

  it("terminates every socket and exits on shutdown", async () => {
    const harness = createHarness();
    harness.child.start();
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
    });
    const daemon = await attachDaemon(harness, "session_1");
    const late = new Socket();

    main(harness, { v, type: "shutdown" });
    harness.child.handleMainMessage(
      {
        v,
        type: "browser.attach",
        attachId: "late",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        outputAcks: false,
        sequenceBase: 0,
        sinceSeq: 0,
        request: { url: "/ws/terminals/term_a", headers: [], headBase64: "" },
      },
      late,
    );
    harness.child.shutdown();

    expect(browser.terminated).toBe(true);
    expect(daemon.terminated).toBe(true);
    expect(late.destroyed).toBe(true);
    expect(harness.exits).toBe(1);
    expect(harness.child.browserSocketCount).toBe(0);
    expect(harness.child.daemonSocketCount).toBe(0);
  });
});
