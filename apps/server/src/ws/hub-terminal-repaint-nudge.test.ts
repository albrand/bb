import {
  TerminalWebSocketTransport,
  type TerminalBrowserSocket,
} from "@bb/client-core";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationHub } from "./hub.js";

const TERMINAL_ID = "term_1";
const FITTED = { cols: 132, rows: 46 };

function session(cols: number, rows: number): TerminalSession {
  return {
    id: TERMINAL_ID,
    threadId: "thr_1",
    environmentId: "env_1",
    hostId: "host_1",
    title: "Terminal",
    initialCwd: "/workspace",
    cols,
    rows,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
  };
}

interface TwoClientRoom {
  connect: () => void;
  advance: (ms: number) => void;
  delayReports: () => void;
  deliverReports: () => void;
  fit: (cols: number) => void;
  peerResizes: (cols: number, rows: number) => void;
  ptySize: () => { cols: number; rows: number };
  restoresSentByOwner: () => number;
  start: () => void;
  transport: TerminalWebSocketTransport;
  viewCols: () => number;
  viewHistory: number[];
}

function createRoom(): TwoClientRoom {
  vi.useFakeTimers();
  const hub = new NotificationHub();
  const ownerSocket = { close: () => undefined, send: () => undefined };
  const peerSocket = { close: () => undefined, send: () => undefined };
  hub.registerTerminalClient(TERMINAL_ID, ownerSocket);
  hub.registerTerminalClient(TERMINAL_ID, peerSocket);
  let pty = { ...FITTED };
  let fitted = FITTED.cols;
  let shared: number | null = null;
  const viewHistory: number[] = [];
  const viewCols = (): number => Math.min(fitted, shared ?? fitted);
  const track = (): void => {
    viewHistory.push(viewCols());
  };
  let restores = 0;
  let nudged = false;
  let delayed = false;
  const queued: unknown[] = [];

  const browserSocket: TerminalBrowserSocket & {
    deliver: (message: unknown) => void;
  } = {
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    readyState: 1,
    close: () => undefined,
    deliver(message) {
      this.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify(message) }),
      );
    },
    send(data: string) {
      const message: unknown = JSON.parse(data);
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "resize" ||
        !("cols" in message) ||
        typeof message.cols !== "number" ||
        !("rows" in message) ||
        typeof message.rows !== "number"
      ) {
        return;
      }
      const size = { cols: message.cols, rows: message.rows };
      if (size.cols === FITTED.cols - 1) {
        nudged = true;
      } else if (nudged && size.cols === FITTED.cols) {
        restores += 1;
      }
      hub.recordTerminalClientSize(TERMINAL_ID, ownerSocket, size, Date.now());
      const seq = Reflect.get(message, "seq");
      settle(ownerSocket, size, typeof seq === "number" ? seq : undefined);
      if (typeof seq === "number") {
        emit({ type: "resize-applied", seq });
      }
    },
  };

  const settle = (
    source: typeof ownerSocket | typeof peerSocket,
    reported: { cols: number; rows: number },
    seq?: number,
  ): void => {
    const shared = hub.terminalSharedSize(TERMINAL_ID, Date.now());
    if (shared === null) {
      return;
    }
    const changed = shared.cols !== pty.cols || shared.rows !== pty.rows;
    if (changed) {
      pty = shared;
    }
    if (
      source === peerSocket ||
      (source === ownerSocket &&
        seq === undefined &&
        changed &&
        (reported.cols !== shared.cols || reported.rows !== shared.rows))
    ) {
      emit({ type: "session-updated", session: session(shared.cols, shared.rows) });
    }
    if (source === ownerSocket && changed && seq !== undefined) {
      emit({
        type: "session-updated",
        session: session(shared.cols, shared.rows),
        resizeSeq: seq,
      });
    }
  };

  const emit = (message: unknown): void => {
    if (delayed) {
      queued.push(message);
      return;
    }
    browserSocket.deliver(message);
  };

  const transport = new TerminalWebSocketTransport({
    createSocket: () => browserSocket,
    onMessage: (message) => {
      if (message.type !== "session-updated") {
        return;
      }
      const reported = { cols: message.session.cols, rows: message.session.rows };
      if (!transport.consumeRepaintNudgeEcho(reported, message.resizeSeq)) {
        shared = reported.cols;
        track();
      }
    },
    onRepaintNudgeSizeReleased: (size) => {
      shared = size.cols;
      track();
    },
    shouldReconnect: () => false,
    url: "ws://example.test/ws/terminals/term_1",
  });
  transport.sendResize(FITTED.cols, FITTED.rows);

  let connected = false;
  const connect = (): void => {
    if (connected) {
      return;
    }
    connected = true;
    transport.start();
    browserSocket.onopen?.(new Event("open"));
    browserSocket.deliver({ type: "features", resizeAcks: true });
    transport.markLayoutSettled();
  };

  return {
    advance: (ms) => vi.advanceTimersByTime(ms),
    delayReports: () => {
      delayed = true;
    },
    deliverReports: () => {
      delayed = false;
      for (const message of queued.splice(0)) {
        browserSocket.deliver(message);
      }
    },
    fit: (cols) => {
      fitted = cols;
      track();
      transport.sendResize(cols, FITTED.rows);
    },
    peerResizes: (cols, rows) => {
      hub.recordTerminalClientSize(
        TERMINAL_ID,
        peerSocket,
        { cols, rows },
        Date.now(),
      );
      settle(peerSocket, { cols, rows });
    },
    ptySize: () => pty,
    restoresSentByOwner: () => restores,
    connect,
    start: () => {
      connect();
      transport.requestRepaint();
      vi.advanceTimersByTime(0);
    },
    transport,
    viewCols,
    viewHistory,
  };
}

describe("repaint nudge with a second client on the same terminal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a peer's smaller size as the shared size after the restore, and the owner's view follows it", () => {
    const room = createRoom();
    room.start();
    expect(room.ptySize().cols).toBe(FITTED.cols - 1);

    room.advance(100);
    room.peerResizes(44, 20);
    expect(room.viewCols()).toBe(44);

    room.advance(300);
    expect(room.restoresSentByOwner()).toBe(1);
    room.advance(1000);

    expect(room.ptySize()).toEqual({ cols: 44, rows: 20 });
    expect(room.viewCols()).toBe(44);
    room.transport.dispose();
  });

  it("applies a peer size that is exactly the nudge size when it is reported", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    expect(room.viewCols()).toBe(FITTED.cols - 1);

    room.advance(300);
    expect(room.restoresSentByOwner()).toBe(1);
    room.advance(1000);

    expect(room.ptySize()).toEqual({ cols: FITTED.cols - 1, rows: FITTED.rows });
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });

  it("returns to the real size when no peer interferes", () => {
    const room = createRoom();
    room.start();
    room.advance(1500);

    expect(room.ptySize()).toEqual(FITTED);
    expect(room.viewCols()).toBe(FITTED.cols);
    room.transport.dispose();
  });

  it("lets a larger peer leave the owner's size as the shared size", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.peerResizes(200, 60);
    room.advance(1500);

    expect(room.ptySize()).toEqual(FITTED);
    expect(room.viewCols()).toBe(FITTED.cols);
    room.transport.dispose();
  });

  it("never applies the nudge size when the fit grows between nudge and restore and a smaller peer resizes", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.fit(200);
    room.advance(50);
    room.peerResizes(44, 20);
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.restoresSentByOwner()).toBe(0);
    expect(room.ptySize().cols).toBe(44);
    expect(room.viewCols()).toBe(44);
    room.transport.dispose();
  });

  it("follows a peer at the nudge size and then the owner's smaller fit", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    room.advance(50);
    room.fit(100);
    room.advance(2000);

    expect(room.viewHistory).toContain(FITTED.cols - 1);
    expect(room.ptySize().cols).toBe(100);
    expect(room.viewCols()).toBe(100);
    room.transport.dispose();
  });

  it("applies a peer exactly at the nudge size once the restore or fit change is acknowledged without a newer report", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    room.advance(50);
    room.fit(200);
    room.advance(2000);

    expect(room.ptySize().cols).toBe(FITTED.cols - 1);
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });

  it("never applies a nudge report delivered 2 s late, and still applies a later peer at the same size", () => {
    const room = createRoom();
    room.delayReports();
    room.start();
    room.fit(200);
    room.advance(2000);
    room.deliverReports();
    room.advance(2000);
    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.viewCols()).toBe(200);

    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    expect(room.ptySize().cols).toBe(FITTED.cols - 1);
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });

  it("never applies the nudge size when the fit changes before the nudge report is delivered", () => {
    const room = createRoom();
    room.delayReports();
    room.start();
    room.fit(200);
    room.advance(50);
    room.deliverReports();
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.ptySize().cols).toBe(200);
    expect(room.viewCols()).toBe(200);
    room.transport.dispose();
  });

  it("never applies the nudge size when the fit changes before the nudge report and a smaller peer resizes", () => {
    const room = createRoom();
    room.delayReports();
    room.start();
    room.fit(200);
    room.peerResizes(44, 20);
    room.advance(50);
    room.deliverReports();
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.ptySize().cols).toBe(44);
    expect(room.viewCols()).toBe(44);
    room.transport.dispose();
  });

  it("is not stuck when the nudge report never arrives because a smaller peer already held the shared size", () => {
    const room = createRoom();
    room.connect();
    room.peerResizes(44, 20);
    room.start();
    room.advance(50);
    room.fit(200);
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.viewCols()).toBe(44);

    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    expect(room.ptySize().cols).toBe(FITTED.cols - 1);
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });

  it("applies a peer that later resizes to exactly the nudge size once the stale window has passed", () => {
    const room = createRoom();
    room.connect();
    room.peerResizes(300, 60);
    room.start();
    room.advance(50);
    room.fit(500);
    room.advance(2000);
    room.peerResizes(FITTED.cols - 1, FITTED.rows);

    expect(room.ptySize().cols).toBe(FITTED.cols - 1);
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });
});
