import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import {
  TerminalWebSocketTransport,
  type TerminalBrowserSocket,
  type TerminalSocketConnectionState,
} from "../src/terminal/terminal-websocket-transport.js";

class FakeTerminalBrowserSocket implements TerminalBrowserSocket {
  bufferedAmount: number | undefined = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = 0;
  readonly sent: string[] = [];
  throwOnSend = false;

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "" } as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(message: TerminalServerMessage): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.sent.push(data);
  }
}

interface TransportHarness {
  messages: TerminalServerMessage[];
  overflow: ReturnType<typeof vi.fn<(maxBytes: number) => void>>;
  sockets: FakeTerminalBrowserSocket[];
  states: TerminalSocketConnectionState[];
  transport: TerminalWebSocketTransport;
  urls: string[];
}

function createHarness(
  overrides: Partial<
    ConstructorParameters<typeof TerminalWebSocketTransport>[0]
  > = {},
): TransportHarness {
  const sockets: FakeTerminalBrowserSocket[] = [];
  const messages: TerminalServerMessage[] = [];
  const states: TerminalSocketConnectionState[] = [];
  const overflow = vi.fn<(maxBytes: number) => void>();
  const urls: string[] = [];
  const transport = new TerminalWebSocketTransport({
    terminalId: "term_1",
    createSocket: (url) => {
      urls.push(url);
      const socket = new FakeTerminalBrowserSocket();
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMs: 15_000,
    heartbeatTimeoutMs: 45_000,
    onConnectionState: (state) => states.push(state),
    onInputOverflow: overflow,
    onMessage: (message) => messages.push(message),
    reconnectDelaysMs: [100],
    shouldReconnect: () => true,
    url: "ws://example.test/ws/terminals/term-1",
    ...overrides,
  });
  return { messages, overflow, sockets, states, transport, urls };
}

function terminalSession(): TerminalSession {
  return {
    id: "term_1",
    threadId: "thr_1",
    environmentId: "env_1",
    hostId: "host_1",
    title: "Terminal",
    initialCwd: "/workspace",
    cols: 100,
    rows: 30,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
  };
}

function inputMessages(socket: FakeTerminalBrowserSocket): string[] {
  return socket.sent
    .map(
      (payload) => JSON.parse(payload) as { dataBase64?: string; type: string },
    )
    .filter((message) => message.type === "input")
    .map((message) => message.dataBase64 ?? "");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalWebSocketTransport", () => {
  it("records enqueue and actual socket send times for queued and immediate input", () => {
    let timestamp = 100;
    const inputEnqueued = vi.fn();
    const inputSent = vi.fn();
    const harness = createHarness({
      now: () => timestamp++,
      onInputEnqueued: inputEnqueued,
      onInputSent: inputSent,
    });
    const queuedInput = Buffer.from("queued").toString("base64");
    const immediateInput = Buffer.from("immediate").toString("base64");

    harness.transport.start();
    expect(harness.transport.sendInput(queuedInput, 95)).toBe(true);
    harness.sockets[0]?.open();
    expect(harness.transport.sendInput(immediateInput, 104)).toBe(true);

    expect(inputEnqueued.mock.calls).toEqual([
      ["term_1", 100, 95],
      ["term_1", 103, 104],
    ]);
    expect(inputSent.mock.calls).toEqual([
      ["term_1", 100, 102],
      ["term_1", 103, 104],
    ]);
    harness.transport.dispose();
  });

  it("reports visible state when a socket opens", () => {
    const harness = createHarness();

    harness.transport.setVisible(true);
    harness.transport.start();
    harness.sockets[0]?.open();

    expect(
      harness.sockets[0]?.sent
        .map((payload) => JSON.parse(payload))
        .filter((message) => message.type === "visibility"),
    ).toEqual([{ type: "visibility", visible: true }]);
    harness.transport.dispose();
  });

  it("reasserts the unchanged fit when a hidden terminal becomes visible", () => {
    const harness = createHarness();
    harness.transport.setVisible(true);
    harness.transport.markLayoutSettled();
    harness.transport.start();
    const socket = harness.sockets[0];
    socket?.open();
    harness.transport.sendResize(51, 47);
    harness.transport.setVisible(false);
    harness.transport.sendResize(39, 37);
    harness.transport.setVisible(true);

    expect(socket?.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "visibility", visible: true },
      { type: "resize", cols: 51, rows: 47 },
      { type: "visibility", visible: false },
      { type: "resize", cols: 39, rows: 37 },
      { type: "visibility", visible: true },
      { type: "resize", cols: 39, rows: 37 },
    ]);
    harness.transport.dispose();
  });

  it("queues input before open and preserves it across reconnect", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const firstInput = Buffer.from("before open").toString("base64");
    const secondInput = Buffer.from("while reconnecting").toString("base64");

    harness.transport.start();
    expect(harness.transport.sendInput(firstInput)).toBe(true);
    harness.sockets[0]?.open();
    expect(inputMessages(harness.sockets[0]!)).toEqual([firstInput]);

    harness.sockets[0]?.close();
    expect(harness.transport.sendInput(secondInput)).toBe(true);
    vi.advanceTimersByTime(100);
    harness.sockets[1]?.open();

    expect(inputMessages(harness.sockets[1]!)).toEqual([secondInput]);
    expect(harness.states).toContain("reconnecting");
    harness.transport.dispose();
  });

  it("filters replay duplicates after reconnect and reports sequence gaps", () => {
    vi.useFakeTimers();
    const gaps = vi.fn<(expectedSeq: number, receivedSeq: number) => void>();
    const harness = createHarness({ onSequenceGap: gaps });
    const output = (seq: number): TerminalServerMessage => ({
      type: "output",
      chunk: {
        seq,
        dataBase64: Buffer.from(String(seq)).toString("base64"),
      },
    });

    harness.transport.start();
    harness.sockets[0]?.open();
    harness.sockets[0]?.receive(output(0));
    harness.sockets[0]?.close();
    vi.advanceTimersByTime(100);
    harness.sockets[1]?.open();
    harness.sockets[1]?.receive(output(0));
    harness.sockets[1]?.receive(output(2));

    expect(
      harness.messages
        .filter((message) => message.type === "output")
        .map((message) => message.chunk.seq),
    ).toEqual([0, 2]);
    expect(gaps).toHaveBeenCalledWith(1, 2);
    expect(harness.urls).toEqual([
      "ws://example.test/ws/terminals/term-1?sinceSeq=0&outputAcks=1&resizeAcks=1",
      "ws://example.test/ws/terminals/term-1?sinceSeq=1&outputAcks=1&resizeAcks=1",
    ]);
    harness.transport.dispose();
  });

  it("replays output from the last parsed sequence when a hidden terminal returns", () => {
    const harness = createHarness();
    harness.transport.start();
    harness.sockets[0]?.open();
    harness.sockets[0]?.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: Buffer.from("first").toString("base64") },
    });
    harness.sockets[0]?.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: Buffer.from("hidden").toString("base64") },
    });

    harness.transport.replayOutputFrom(1);

    expect(harness.sockets[0]?.closeCalls).toHaveLength(1);
    expect(harness.urls[1]).toContain("sinceSeq=1");
    harness.sockets[1]?.open();
    harness.sockets[1]?.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: Buffer.from("hidden").toString("base64") },
    });

    expect(
      harness.messages
        .filter((message) => message.type === "output")
        .map((message) => message.chunk.seq),
    ).toEqual([0, 1, 1]);
    harness.transport.dispose();
  });

  it("includes the terminal ID in output frame timing callbacks", () => {
    const outputReceived = vi.fn();
    const harness = createHarness({
      now: () => 42,
      onOutputFrameReceived: outputReceived,
    });
    harness.transport.start();
    harness.sockets[0]?.open();
    harness.sockets[0]?.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: Buffer.from("frame").toString("base64") },
    });

    expect(outputReceived).toHaveBeenCalledWith("term_1", 42);
    harness.transport.dispose();
  });

  it("sends one acknowledgement for the furthest output parsed in a task", async () => {
    const harness = createHarness();
    harness.transport.start();
    harness.sockets[0]?.open();

    harness.transport.acknowledgeOutput(1);
    harness.transport.acknowledgeOutput(3);
    harness.transport.acknowledgeOutput(2);
    await Promise.resolve();

    expect(
      harness.sockets[0]?.sent.map((payload) => JSON.parse(payload)),
    ).toEqual([{ type: "ack", nextSeq: 3 }]);
    harness.transport.dispose();
  });

  it("reports a hidden document again after reconnecting", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.transport.setVisible(false);
    harness.transport.start();
    harness.sockets[0]?.open();
    harness.sockets[0]?.close();
    vi.advanceTimersByTime(100);
    harness.sockets[1]?.open();
    harness.transport.setVisible(true);

    expect(
      harness.sockets.map((socket) =>
        socket.sent
          .map((payload) => JSON.parse(payload))
          .filter((message) => message.type === "visibility"),
      ),
    ).toEqual([
      [{ type: "visibility", visible: false }],
      [
        { type: "visibility", visible: false },
        { type: "visibility", visible: true },
      ],
    ]);
    harness.transport.dispose();
  });

  it("reports an explicit replay truncation before accepting available output", () => {
    const gaps = vi.fn<(expectedSeq: number, receivedSeq: number) => void>();
    const harness = createHarness({ onSequenceGap: gaps });

    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.open();
    socket.receive({
      type: "attached",
      session: terminalSession(),
      replayStartSeq: 5,
      nextSeq: 8,
    });
    socket.receive({
      type: "output",
      chunk: {
        seq: 5,
        dataBase64: Buffer.from("available").toString("base64"),
      },
    });

    expect(gaps).toHaveBeenCalledOnce();
    expect(gaps).toHaveBeenCalledWith(0, 5);
    expect(
      harness.messages
        .filter((message) => message.type === "output")
        .map((message) => message.chunk.seq),
    ).toEqual([5]);
    harness.transport.dispose();
  });

  it("stays reconnecting with growing backoff when sockets open but never attach", () => {
    vi.useFakeTimers();
    const harness = createHarness({ reconnectDelaysMs: [100, 250, 500] });

    harness.transport.start();
    harness.sockets[0]?.open();
    harness.sockets[0]?.close();
    vi.advanceTimersByTime(100);
    harness.sockets[1]?.open();
    harness.sockets[1]?.close();
    vi.advanceTimersByTime(249);
    expect(harness.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(harness.sockets).toHaveLength(3);
    expect(harness.states).not.toContain("attached");

    harness.sockets[2]?.open();
    harness.sockets[2]?.receive({
      type: "attached",
      session: terminalSession(),
      replayStartSeq: 0,
      nextSeq: 0,
    });
    expect(harness.states.at(-1)).toBe("attached");
    harness.sockets[2]?.close();
    vi.advanceTimersByTime(100);
    expect(harness.sockets).toHaveLength(4);
    harness.transport.dispose();
  });

  it("holds input above the socket high-water mark and flushes after drain", () => {
    vi.useFakeTimers();
    const harness = createHarness({
      drainPollMs: 10,
      socketHighWaterBytes: 8,
    });
    const input = Buffer.from("queued").toString("base64");

    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.open();
    socket.bufferedAmount = 9;
    expect(harness.transport.sendInput(input)).toBe(true);
    expect(inputMessages(socket)).toEqual([]);

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(10);
    expect(inputMessages(socket)).toEqual([input]);
    harness.transport.dispose();
  });

  it("flushes input when the socket never reports bufferedAmount (React Native)", () => {
    vi.useFakeTimers();
    const harness = createHarness({
      drainPollMs: 10,
      socketHighWaterBytes: 8,
    });
    const queuedInput = Buffer.from("queued").toString("base64");
    const liveInput = Buffer.from("live").toString("base64");

    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.bufferedAmount = undefined;
    expect(harness.transport.sendInput(queuedInput)).toBe(true);
    socket.open();
    expect(inputMessages(socket)).toEqual([queuedInput]);

    expect(harness.transport.sendInput(liveInput)).toBe(true);
    expect(inputMessages(socket)).toEqual([queuedInput, liveInput]);
    vi.advanceTimersByTime(50);
    expect(inputMessages(socket)).toEqual([queuedInput, liveInput]);
    harness.transport.dispose();
  });

  it("reports bounded input queue overflow instead of silently dropping", () => {
    const harness = createHarness({ inputQueueMaxBytes: 3 });
    harness.transport.start();

    expect(
      harness.transport.sendInput(Buffer.from("four").toString("base64")),
    ).toBe(false);
    expect(harness.overflow).toHaveBeenCalledWith(3);
    harness.transport.dispose();
  });

  it("reconnects after a send exception without throwing to xterm", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.transport.start();
    const firstSocket = harness.sockets[0]!;
    firstSocket.open();
    firstSocket.throwOnSend = true;
    const input = Buffer.from("retry me").toString("base64");

    expect(() => harness.transport.sendInput(input)).not.toThrow();
    vi.advanceTimersByTime(100);
    harness.sockets[1]?.open();

    expect(inputMessages(harness.sockets[1]!)).toEqual([input]);
    harness.transport.dispose();
  });

  it("closes an unresponsive socket after the heartbeat deadline", () => {
    vi.useFakeTimers();
    let now = 0;
    const harness = createHarness({ now: () => now });
    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.open();

    now = 60_000;
    vi.advanceTimersByTime(60_000);

    expect(socket.closeCalls).toContainEqual({
      code: 4000,
      reason: "heartbeat-timeout",
    });
    harness.transport.dispose();
  });

  it("sends each distinct terminal size once", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.transport.sendResize(160, 48);
    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.open();
    harness.transport.markLayoutSettled();
    const resizes = () =>
      socket.sent.filter((message) => message.includes('"resize"'));
    expect(resizes()).toEqual([
      JSON.stringify({ type: "resize", cols: 160, rows: 48 }),
    ]);

    harness.transport.sendResize(160, 48);
    expect(resizes()).toHaveLength(1);
    harness.transport.sendResize(120, 40);
    expect(resizes()).toEqual([
      JSON.stringify({ type: "resize", cols: 160, rows: 48 }),
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
    ]);
    harness.transport.dispose();
  });

  it("reports the settled fit on first attach without another size change", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.transport.start();
    const socket = harness.sockets[0]!;
    socket.open();
    harness.transport.sendResize(128, 43);
    harness.transport.markLayoutSettled();

    expect(
      socket.sent.filter((message) => message.includes('"resize"')),
    ).toEqual([
      JSON.stringify({ type: "resize", cols: 128, rows: 43 }),
      JSON.stringify({ type: "resize", cols: 128, rows: 43 }),
    ]);
    harness.transport.dispose();
  });

  describe("attach resize settling", () => {
    function openUnsettled(cols: number, rows: number) {
      vi.useFakeTimers();
      const harness = createHarness();
      harness.transport.sendResize(cols, rows);
      harness.transport.start();
      const socket = harness.sockets[0]!;
      socket.open();
      const resizes = () =>
        socket.sent
          .filter((message) => message.includes('"resize"'))
          .map((message) => JSON.parse(message) as { cols: number });
      return { harness, resizes, socket };
    }

    it("sends once at the hard ceiling when the view never reports a settled layout", () => {
      const { harness, resizes } = openUnsettled(128, 43);

      vi.advanceTimersByTime(3000);
      harness.transport.sendResize(132, 43);
      vi.advanceTimersByTime(1999);
      expect(resizes()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(resizes()).toEqual([{ type: "resize", cols: 132, rows: 43 }]);
      vi.advanceTimersByTime(10_000);
      expect(resizes()).toHaveLength(1);
      harness.transport.dispose();
    });

    it.each([100, 800, 2000])(
      "sends one resize with the final size when layout settles at %i ms",
      (settleAtMs) => {
        const { harness, resizes } = openUnsettled(128, 43);

        vi.advanceTimersByTime(settleAtMs);
        harness.transport.sendResize(132, 43);
        vi.advanceTimersByTime(10_000);

        expect(resizes()).toEqual([{ type: "resize", cols: 132, rows: 43 }]);
        harness.transport.dispose();
      },
    );

    it("flushes at once when the view reports a settled layout", () => {
      const { harness, resizes } = openUnsettled(128, 43);

      vi.advanceTimersByTime(60);
      harness.transport.sendResize(132, 43);
      expect(resizes()).toEqual([]);
      harness.transport.markLayoutSettled();

      expect(resizes()).toEqual([{ type: "resize", cols: 132, rows: 43 }]);
      vi.advanceTimersByTime(3000);
      expect(resizes()).toHaveLength(1);
      harness.transport.dispose();
    });

    it("sends the nudge after the settled size when repaint is requested while settling", () => {
      const { harness, resizes } = openUnsettled(132, 43);

      harness.transport.requestRepaint();
      vi.advanceTimersByTime(100);
      expect(resizes()).toEqual([]);
      harness.transport.markLayoutSettled();
      vi.advanceTimersByTime(1000);

      expect(resizes().map((resize) => resize.cols)).toEqual([132, 131, 132]);
      harness.transport.dispose();
    });

    it("resends the unchanged client size on reconnect without a fit change", () => {
      const { harness, resizes, socket } = openUnsettled(132, 43);

      harness.transport.markLayoutSettled();
      socket.close();
      vi.advanceTimersByTime(100);
      const next = harness.sockets[1]!;
      next.open();

      expect(
        next.sent.filter((message) => message.includes('"resize"')),
      ).toEqual([JSON.stringify({ type: "resize", cols: 132, rows: 43 })]);
      expect(resizes()).toHaveLength(1);
      harness.transport.dispose();
    });

    it("drops the held size when the socket closes before it flushes", () => {
      const { harness, resizes, socket } = openUnsettled(128, 43);

      vi.advanceTimersByTime(100);
      socket.close();
      vi.advanceTimersByTime(3000);

      expect(resizes()).toEqual([]);
      harness.transport.dispose();
    });
  });

  describe("requestRepaint", () => {
    function openHarness(
      cols: number,
      rows: number,
      overrides: Parameters<typeof createHarness>[0] = {},
    ) {
      vi.useFakeTimers();
      const harness = createHarness(overrides);
      harness.transport.sendResize(cols, rows);
      harness.transport.start();
      const socket = harness.sockets[0]!;
      socket.open();
      harness.transport.markLayoutSettled();
      return { harness, socket };
    }

    it("waits for the replay acknowledgement before nudging and restores only after a gap", async () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.acknowledgeOutput(42);
      harness.transport.requestRepaint();

      expect(socket.sent).toEqual([
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.sent).toEqual([
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
        JSON.stringify({ type: "ack", nextSeq: 42 }),
        JSON.stringify({ type: "resize", cols: 99, rows: 30 }),
      ]);
      vi.advanceTimersByTime(399);
      expect(socket.sent).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(socket.sent.slice(3)).toEqual([
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      ]);
      harness.transport.sendResize(100, 30);
      expect(socket.sent).toHaveLength(4);
      harness.transport.dispose();
    });

    it("ends at the full size with one restore when a second repaint is requested inside the quiet delay", async () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(200);
      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(399);
      expect(socket.sent.at(-1)).toBe(
        JSON.stringify({ type: "resize", cols: 99, rows: 30 }),
      );
      vi.advanceTimersByTime(1);
      expect(socket.sent.at(-1)).toBe(
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      );
      vi.advanceTimersByTime(5000);
      expect(socket.sent.filter((m) => m.includes('"cols":100'))).toHaveLength(
        2,
      );
      harness.transport.dispose();
    });

    function openAckedHarness(
      cols: number,
      rows: number,
      released: (size: { cols: number; rows: number }) => void = () =>
        undefined,
    ) {
      const opened = openHarness(cols, rows, {
        onRepaintNudgeSizeReleased: released,
      });
      opened.socket.receive({ type: "features", resizeAcks: true });
      const ack = (seq: number) =>
        opened.socket.receive({ type: "resize-applied", seq });
      const echo = (size: { cols: number; rows: number }) =>
        opened.harness.transport.consumeRepaintNudgeEcho(size);
      return { ...opened, ack, echo };
    }

    const resizeFrame = (cols: number, rows: number, seq: number) =>
      JSON.stringify({ type: "resize", cols, rows, seq });

    it("sends no seq and never holds an echo when the server did not confirm resize acks", async () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);

      expect(socket.sent.at(-1)).toBe(
        JSON.stringify({ type: "resize", cols: 99, rows: 30 }),
      );
      expect(
        harness.transport.consumeRepaintNudgeEcho({ cols: 99, rows: 30 }),
      ).toBe(false);
      harness.transport.dispose();
    });

    it("asks for resize acks in the socket url", () => {
      const { harness } = openHarness(100, 30);

      expect(new URL(harness.urls[0]!).searchParams.get("resizeAcks")).toBe(
        "1",
      );
      harness.transport.dispose();
    });

    it("tags the nudge and the restore with increasing seq once the server confirmed resize acks", async () => {
      const { harness, socket } = openAckedHarness(100, 30);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(400);

      expect(socket.sent.slice(-2)).toEqual([
        resizeFrame(99, 30, 1),
        resizeFrame(100, 30, 2),
      ]);
      harness.transport.dispose();
    });

    it("reports the first size equal to its nudge as the echo, once", async () => {
      const { harness, echo } = openAckedHarness(100, 30);

      expect(echo({ cols: 99, rows: 30 })).toBe(false);
      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      expect(echo({ cols: 99, rows: 30 })).toBe(true);
      expect(echo({ cols: 99, rows: 30 })).toBe(false);
      harness.transport.dispose();
    });

    it("treats a size other than the nudge size as a peer's and applies it at once", async () => {
      const { harness, echo } = openAckedHarness(100, 30);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(100);

      expect(echo({ cols: 44, rows: 20 })).toBe(false);
      expect(echo({ cols: 99, rows: 30 })).toBe(true);
      harness.transport.dispose();
    });

    it("keeps the restore after a peer resized in the window so this client's own size does not stay narrowed", async () => {
      const { harness, socket, echo } = openAckedHarness(100, 30);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      expect(echo({ cols: 44, rows: 20 })).toBe(false);
      vi.advanceTimersByTime(400);

      expect(socket.sent.at(-1)).toBe(resizeFrame(100, 30, 2));
      harness.transport.dispose();
    });

    it("releases the held nudge size only when the restore is acknowledged without a newer report, however long that takes", async () => {
      const released = vi.fn<(size: { cols: number; rows: number }) => void>();
      const { harness, ack, echo } = openAckedHarness(100, 30, released);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      expect(echo({ cols: 99, rows: 30 })).toBe(true);
      ack(1);
      vi.advanceTimersByTime(400);
      vi.advanceTimersByTime(5000);
      expect(released).not.toHaveBeenCalled();
      ack(2);

      expect(released).toHaveBeenCalledOnce();
      expect(released).toHaveBeenCalledWith({ cols: 99, rows: 30 });
      harness.transport.dispose();
    });

    it("does not release when the restore echo arrives before its acknowledgement", async () => {
      const released = vi.fn<(size: { cols: number; rows: number }) => void>();
      const { harness, ack, echo } = openAckedHarness(100, 30, released);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      expect(echo({ cols: 99, rows: 30 })).toBe(true);
      ack(1);
      vi.advanceTimersByTime(400);
      expect(echo({ cols: 100, rows: 30 })).toBe(false);
      ack(2);

      expect(released).not.toHaveBeenCalled();
      harness.transport.dispose();
    });

    it("does not apply the held nudge size when the fitted size changes mid-window and the server reports the new shared size", async () => {
      const released = vi.fn<(size: { cols: number; rows: number }) => void>();
      const { harness, ack, echo } = openAckedHarness(100, 30, released);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      expect(echo({ cols: 99, rows: 30 })).toBe(true);
      harness.transport.sendResize(80, 24);
      expect(echo({ cols: 80, rows: 24 })).toBe(false);
      ack(1);
      ack(2);
      vi.advanceTimersByTime(5000);

      expect(released).not.toHaveBeenCalled();
      harness.transport.dispose();
    });

    it("applies the held nudge size after a fitted size change only when the acknowledgement arrives without a newer report", async () => {
      const released = vi.fn<(size: { cols: number; rows: number }) => void>();
      const { harness, ack, echo } = openAckedHarness(100, 30, released);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      echo({ cols: 99, rows: 30 });
      harness.transport.sendResize(200, 60);
      ack(1);
      vi.advanceTimersByTime(5000);
      expect(released).not.toHaveBeenCalled();
      ack(2);

      expect(released).toHaveBeenCalledOnce();
      expect(released).toHaveBeenCalledWith({ cols: 99, rows: 30 });
      harness.transport.dispose();
    });

    it("still takes the nudge report as the stale echo when the fit changed before it and it arrives 2 s later", async () => {
      const released = vi.fn<(size: { cols: number; rows: number }) => void>();
      const { harness, ack, echo } = openAckedHarness(100, 30, released);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      harness.transport.sendResize(80, 24);
      vi.advanceTimersByTime(2000);

      expect(echo({ cols: 99, rows: 30 })).toBe(true);
      expect(echo({ cols: 80, rows: 24 })).toBe(false);
      ack(1);
      ack(2);
      expect(released).not.toHaveBeenCalled();
      harness.transport.dispose();
    });

    it("applies a report at the nudge size that arrives after the nudge was acknowledged, however late, as a peer's", async () => {
      const { harness, ack, echo } = openAckedHarness(100, 30);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      harness.transport.sendResize(80, 24);
      ack(1);
      vi.advanceTimersByTime(2000);

      expect(echo({ cols: 99, rows: 30 })).toBe(false);
      harness.transport.dispose();
    });

    it("applies a peer at the nudge size that arrives after the whole exchange was acknowledged", async () => {
      const { harness, ack, echo } = openAckedHarness(100, 30);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(400);
      ack(1);
      ack(2);
      vi.advanceTimersByTime(2000);

      expect(echo({ cols: 99, rows: 30 })).toBe(false);
      harness.transport.dispose();
    });

    it("does not send the obsolete restore after the fitted size changed", async () => {
      const { harness, socket } = openAckedHarness(100, 30);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      harness.transport.sendResize(80, 24);
      const sentBefore = socket.sent.length;
      vi.advanceTimersByTime(5000);

      expect(socket.sent.length).toBe(sentBefore);
      expect(socket.sent.at(-1)).toBe(resizeFrame(80, 24, 2));
      harness.transport.dispose();
    });

    it("drops the held size silently on dispose", async () => {
      const released = vi.fn<(size: { cols: number; rows: number }) => void>();
      const { harness, ack, echo } = openAckedHarness(100, 30, released);

      harness.transport.requestRepaint();
      await vi.advanceTimersByTimeAsync(0);
      echo({ cols: 99, rows: 30 });
      harness.transport.dispose();
      ack(1);
      ack(2);
      vi.advanceTimersByTime(5000);

      expect(released).not.toHaveBeenCalled();
    });

    it("does not pass features and resize-applied to the view", () => {
      const { harness, socket } = openAckedHarness(100, 30);

      socket.receive({ type: "resize-applied", seq: 1 });

      expect(harness.messages).toEqual([]);
      harness.transport.dispose();
    });

    it("nudges rows instead of columns when the terminal is a single column wide", () => {
      const { harness, socket } = openHarness(1, 30);

      harness.transport.requestRepaint();
      vi.advanceTimersByTime(400);

      expect(socket.sent.slice(1)).toEqual([
        JSON.stringify({ type: "resize", cols: 1, rows: 29 }),
        JSON.stringify({ type: "resize", cols: 1, rows: 30 }),
      ]);
      harness.transport.dispose();
    });

    it("skips the nudge when the terminal is one column by one row", () => {
      const { harness, socket } = openHarness(1, 1);

      harness.transport.requestRepaint();
      vi.advanceTimersByTime(500);

      expect(socket.sent).toEqual([
        JSON.stringify({ type: "resize", cols: 1, rows: 1 }),
      ]);
      harness.transport.dispose();
    });

    it.each([
      [100, 30],
      [1, 30],
      [100, 1],
      [2, 2],
      [1, 1],
    ])(
      "never sends a resize larger than the current %i x %i grid while nudging",
      (cols, rows) => {
        const { harness, socket } = openHarness(cols, rows);

        harness.transport.requestRepaint();
        vi.advanceTimersByTime(500);

        const sizes = socket.sent
          .filter((message) => message.includes('"resize"'))
          .map(
            (message) => JSON.parse(message) as { cols: number; rows: number },
          );
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) {
          expect(size.cols).toBeLessThanOrEqual(cols);
          expect(size.rows).toBeLessThanOrEqual(rows);
        }
        expect(sizes.at(-1)).toEqual({ type: "resize", cols, rows });
        harness.transport.dispose();
      },
    );

    describe("a grid change while a nudge is pending", () => {
      function sentSizes(socket: { sent: string[] }) {
        return socket.sent
          .filter((message) => message.includes('"resize"'))
          .map(
            (message) => JSON.parse(message) as { cols: number; rows: number },
          );
      }

      function expectNoSizeAbove(
        sizes: { cols: number; rows: number }[],
        grids: { cols: number; rows: number }[],
      ) {
        expect(sizes).toHaveLength(grids.length);
        sizes.forEach((size, index) => {
          expect(size.cols).toBeLessThanOrEqual(grids[index]!.cols);
          expect(size.rows).toBeLessThanOrEqual(grids[index]!.rows);
        });
      }

      it("sends nothing larger than the grid when it shrinks to 1x1 before the nudge fires", () => {
        const { harness, socket } = openHarness(2, 2);

        harness.transport.requestRepaint();
        harness.transport.sendResize(1, 1);
        vi.advanceTimersByTime(500);

        const sizes = sentSizes(socket);
        expectNoSizeAbove(sizes, [
          { cols: 2, rows: 2 },
          { cols: 1, rows: 1 },
        ]);
        expect(sizes.at(-1)).toMatchObject({ cols: 1, rows: 1 });
        harness.transport.dispose();
      });

      it("restores to the latest size when the grid shrinks during the nudge gap", () => {
        const { harness, socket } = openHarness(2, 2);

        harness.transport.requestRepaint();
        vi.advanceTimersByTime(20);
        harness.transport.sendResize(1, 1);
        vi.advanceTimersByTime(500);

        const sizes = sentSizes(socket);
        expectNoSizeAbove(sizes, [
          { cols: 2, rows: 2 },
          { cols: 2, rows: 2 },
          { cols: 1, rows: 1 },
        ]);
        expect(sizes.at(-1)).toMatchObject({ cols: 1, rows: 1 });
        harness.transport.dispose();
      });

      it("ends at the grown size when the grid grows from 1x1 to 100x30 before the nudge fires", () => {
        const { harness, socket } = openHarness(1, 1);

        harness.transport.requestRepaint();
        harness.transport.sendResize(100, 30);
        vi.advanceTimersByTime(500);

        const sizes = sentSizes(socket);
        expect(sizes.at(-1)).toMatchObject({ cols: 100, rows: 30 });
        expect(sizes.map((size) => `${size.cols}x${size.rows}`)).toEqual([
          "1x1",
          "100x30",
        ]);
        harness.transport.dispose();
      });

      it("ends at the grown size when the grid grows during the nudge gap", () => {
        const { harness, socket } = openHarness(1, 30);

        harness.transport.requestRepaint();
        vi.advanceTimersByTime(20);
        harness.transport.sendResize(100, 30);
        vi.advanceTimersByTime(500);

        expect(sentSizes(socket).at(-1)).toMatchObject({ cols: 100, rows: 30 });
        harness.transport.dispose();
      });
    });

    it("does not restore after dispose", () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      vi.advanceTimersByTime(0);
      harness.transport.dispose();
      vi.advanceTimersByTime(500);

      expect(socket.sent).toEqual([
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
        JSON.stringify({ type: "resize", cols: 99, rows: 30 }),
      ]);
    });

    it("does not restore on the old socket after it closes and a new attach opens", () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      vi.advanceTimersByTime(0);
      socket.close();
      vi.advanceTimersByTime(100);
      const next = harness.sockets[1]!;
      next.open();
      vi.advanceTimersByTime(500);

      expect(socket.sent).toHaveLength(2);
      expect(next.sent).toEqual([
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      ]);
      harness.transport.dispose();
    });

    it("cancels a pending nudge on dispose", () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      harness.transport.dispose();
      vi.advanceTimersByTime(500);

      expect(socket.sent).toEqual([
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      ]);
    });

    it("cancels a pending nudge when the socket closes before a newer attach", () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      socket.close();
      vi.advanceTimersByTime(100);
      const next = harness.sockets[1]!;
      next.open();
      vi.advanceTimersByTime(500);

      expect(socket.sent).toHaveLength(1);
      expect(next.sent).toEqual([
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      ]);
      harness.transport.dispose();
    });

    it("drops a pending nudge when a real resize arrives before the replay flush", () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      harness.transport.sendResize(120, 40);
      vi.advanceTimersByTime(500);

      expect(socket.sent).toEqual([
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
        JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
      ]);
      harness.transport.dispose();
    });

    it("drops the restore when a real resize arrives during the gap", () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      vi.advanceTimersByTime(20);
      harness.transport.sendResize(120, 40);
      vi.advanceTimersByTime(500);

      expect(socket.sent.slice(2)).toEqual([
        JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
      ]);
      harness.transport.dispose();
    });

    it("collapses repeated requests into a single restore", () => {
      const { harness, socket } = openHarness(100, 30);

      harness.transport.requestRepaint();
      vi.advanceTimersByTime(30);
      harness.transport.requestRepaint();
      vi.advanceTimersByTime(500);

      expect(socket.sent.slice(1)).toEqual([
        JSON.stringify({ type: "resize", cols: 99, rows: 30 }),
        JSON.stringify({ type: "resize", cols: 99, rows: 30 }),
        JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      ]);
      harness.transport.dispose();
    });
  });
});
