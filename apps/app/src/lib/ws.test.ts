import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clientMessageSchema, type ClientMessage } from "@bb/domain";
import type { RealtimeSubscriptionTarget } from "@bb/server-contract";

const fakeSocketState = vi.hoisted(() => {
  type CloseHandler = () => void;
  type MessageHandler = (event: MessageEvent) => void;
  type OpenHandler = () => void;
  interface ReconnectOptions {
    minReconnectionDelay?: number;
    reconnectionDelayGrowFactor?: number;
  }

  class FakeReconnectingWebSocket {
    onclose: CloseHandler | null = null;
    onmessage: MessageHandler | null = null;
    onopen: OpenHandler | null = null;
    readyState = 1;
    readonly sentMessages: string[] = [];
    readonly options: ReconnectOptions | undefined;

    constructor(
      _url: string,
      _protocols?: unknown,
      options?: ReconnectOptions,
    ) {
      this.options = options;
      instances.push(this);
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }

    open(): void {
      this.readyState = 1;
      this.onopen?.();
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }
  }

  const instances: FakeReconnectingWebSocket[] = [];

  return {
    FakeReconnectingWebSocket,
    instances,
  };
});

vi.mock("partysocket/ws", () => ({
  default: fakeSocketState.FakeReconnectingWebSocket,
}));

vi.mock("./dev-websocket-url", () => ({
  buildBrowserWebSocketUrl: () => "ws://bb.test/ws",
}));

import {
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PONG_TIMEOUT_MS,
  REALTIME_RESUME_HIDDEN_THRESHOLD_MS,
  REALTIME_RESUME_PONG_TIMEOUT_MS,
  WebSocketManager,
  type WebSocketConnectedEvent,
  type WebSocketManagerBrowserEvents,
} from "./ws";

const THREAD_TARGET = {
  kind: "thread-detail",
  threadId: "thr_1",
} satisfies RealtimeSubscriptionTarget;
const PROJECT_TARGET = {
  kind: "project-list",
} satisfies RealtimeSubscriptionTarget;

const legacyThreadOpenSignalSchema = z.object({
  type: z.literal("thread-open"),
  projectId: z.string(),
  threadId: z.string(),
  split: z.enum(["right", "down", "left", "top", "replace"]),
  file: z.unknown().nullable(),
  terminalAction: z
    .object({
      action: z.enum(["focus", "openBrowser"]),
      terminalId: z.string(),
      url: z.string().optional(),
    })
    .optional(),
});

describe("thread-open compatibility", () => {
  it("lets an older app parse the thread-open signal while dropping layout fields", () => {
    const parsed = legacyThreadOpenSignalSchema.parse({
      type: "thread-open",
      projectId: "proj_1",
      threadId: "thr_1",
      split: "replace",
      file: null,
      terminalLayoutAction: {
        action: "split",
        terminalId: "term_1",
        side: "right",
      },
    });
    expect(parsed.threadId).toBe("thr_1");
    expect(parsed).not.toHaveProperty("terminalLayoutAction");
  });
});

interface ConnectedManager {
  manager: WebSocketManager;
  socket: FakeSocket;
}

interface FakeSocket {
  readonly sentMessages: string[];
  close: () => void;
  open: () => void;
}

function installOpenWebSocketConstructor(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    },
  });
}

function readClientMessages(socket: FakeSocket): readonly ClientMessage[] {
  return socket.sentMessages
    .map((message) => clientMessageSchema.parse(JSON.parse(message)))
    .filter((message) => message.type !== "device-handoff-device");
}

function getOnlySocket(): FakeSocket {
  const socket = fakeSocketState.instances[0];
  if (!socket) {
    throw new Error("Expected websocket to be created");
  }
  return socket;
}

function createConnectedManager(): ConnectedManager {
  const manager = new WebSocketManager();
  manager.connect();
  const socket = getOnlySocket();
  socket.open();
  return { manager, socket };
}

describe("WebSocketManager subscriptions", () => {
  it("never sends a target the server would reject", () => {
    const { manager, socket } = createConnectedManager();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const oversized = {
      kind: "plugin-read",
      pluginId: "usage",
      method: "getUsage",
      read: { input: "x".repeat(17_000) },
    } satisfies RealtimeSubscriptionTarget;
    try {
      manager.subscribe(oversized);
      manager.subscribe(THREAD_TARGET);
      manager.unsubscribe(oversized);
      socket.close();
      socket.open();

      expect(readClientMessages(socket)).toEqual([
        { type: "subscribe", target: THREAD_TARGET },
        { type: "subscribe", targets: [THREAD_TARGET] },
      ]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  it("ref-counts duplicate subscriptions and unsubscribes only after the final cleanup", async () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(THREAD_TARGET);
    manager.subscribe(THREAD_TARGET);

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
    ]);

    manager.unsubscribe(THREAD_TARGET);

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
    ]);

    manager.unsubscribe(THREAD_TARGET);
    await Promise.resolve();

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
      {
        type: "unsubscribe",
        target: THREAD_TARGET,
      },
    ]);
  });

  it("keeps a subscription that a remount releases and retakes in the same task", async () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(THREAD_TARGET);
    manager.unsubscribe(THREAD_TARGET);
    manager.subscribe(THREAD_TARGET);
    await Promise.resolve();
    manager.unsubscribe(THREAD_TARGET);
    manager.unsubscribe(THREAD_TARGET);
    await Promise.resolve();

    expect(readClientMessages(socket)).toEqual([
      { type: "subscribe", target: THREAD_TARGET },
      { type: "unsubscribe", target: THREAD_TARGET },
    ]);
  });

  it("resends active subscriptions when the websocket reconnects", () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(THREAD_TARGET);
    manager.subscribe(PROJECT_TARGET);
    socket.sentMessages.length = 0;

    socket.close();
    socket.open();

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        targets: [THREAD_TARGET, PROJECT_TARGET],
      },
    ]);
  });

  it("resends the active device-handoff view on reconnect, but does not send an empty view", () => {
    const { manager, socket } = createConnectedManager();

    manager.setDeviceHandoffView("thread-1");
    expect(readClientMessages(socket)).toEqual([
      {
        type: "device-handoff-view",
        threadId: "thread-1",
        terminalSessionId: null,
      },
    ]);
    socket.sentMessages.length = 0;

    manager.setDeviceHandoffView(null);
    expect(readClientMessages(socket)).toEqual([
      {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: null,
      },
    ]);
    socket.sentMessages.length = 0;

    manager.setDeviceHandoffView(null);
    expect(readClientMessages(socket)).toEqual([]);

    manager.setDeviceHandoffView("thread-1");
    socket.sentMessages.length = 0;
    socket.close();
    socket.open();

    expect(readClientMessages(socket)).toEqual([
      {
        type: "device-handoff-view",
        threadId: "thread-1",
        terminalSessionId: null,
      },
    ]);
  });

  it("tracks the active standalone terminal handoff view and resends it on reconnect", () => {
    const { manager, socket } = createConnectedManager();

    manager.setDeviceHandoffView(null, "term-a");
    expect(readClientMessages(socket)).toEqual([
      {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: "term-a",
      },
    ]);
    socket.sentMessages.length = 0;
    socket.close();
    socket.open();
    expect(readClientMessages(socket)).toEqual([
      {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: "term-a",
      },
    ]);
    socket.sentMessages.length = 0;

    manager.setDeviceHandoffView(null, "term-b");
    expect(readClientMessages(socket)).toEqual([
      {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: "term-b",
      },
    ]);
  });
});

describe("WebSocketManager device handoff attachment token", () => {
  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  const originalWebSocket = globalThis.WebSocket;

  function installBrowserStorage(throwOnAccess = false): void {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => {
          if (throwOnAccess) throw new Error("storage unavailable");
          return values.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (throwOnAccess) throw new Error("storage unavailable");
          values.set(key, value);
        },
        removeItem: (key: string) => values.delete(key),
      },
      crypto: globalThis.crypto,
      btoa: globalThis.btoa,
      location: { origin: "http://localhost" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }

  it("creates and stores a browser device id before the first WebSocket connection", async () => {
    const storageKey = "bb-device-handoff-device-id";
    installBrowserStorage();
    window.localStorage.removeItem(storageKey);
    vi.resetModules();
    const { WebSocketManager: FreshWebSocketManager } = await import("./ws");
    const manager = new FreshWebSocketManager();
    const deviceId = manager.getDeviceHandoffClientToken();
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(window.localStorage.getItem(storageKey)).toBe(deviceId);
    manager.connect();
    const socket = getOnlySocket();
    socket.open();
    expect(JSON.parse(socket.sentMessages[0] ?? "{}")).toEqual({
      type: "device-handoff-device",
      token: deviceId,
    });
    manager.disconnect();
    window.localStorage.removeItem(storageKey);
  });

  it("reuses an in-memory device id when local storage is unavailable", async () => {
    installBrowserStorage(true);
    vi.resetModules();
    const { WebSocketManager: FreshWebSocketManager } = await import("./ws");
    const manager = new FreshWebSocketManager();
    const deviceId = manager.getDeviceHandoffClientToken();
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    manager.connect();
    const socket = getOnlySocket();
    socket.open();
    expect(JSON.parse(socket.sentMessages[0] ?? "{}")).toEqual({
      type: "device-handoff-device",
      token: deviceId,
    });
    expect(manager.getDeviceHandoffClientToken()).toBe(deviceId);
    manager.disconnect();
  });

  it("stores a token delivered by the server and notifies terminal views", () => {
    const manager = new WebSocketManager();
    const callback = vi.fn();
    manager.onDeviceHandoffClientToken(callback);
    manager.handleIncomingMessage(
      JSON.stringify({
        type: "device-handoff-client-token",
        token: "0123456789abcdefghij_-",
      }),
    );
    expect(manager.getDeviceHandoffClientToken()).toBe(
      "0123456789abcdefghij_-",
    );
    expect(callback).toHaveBeenCalledWith("0123456789abcdefghij_-");
  });

  it("replays the current token to a terminal view that subscribes late", () => {
    const manager = new WebSocketManager();
    const token = "0123456789abcdefghij_-";
    manager.handleIncomingMessage(
      JSON.stringify({ type: "device-handoff-client-token", token }),
    );
    const callback = vi.fn();

    manager.onDeviceHandoffClientToken(callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(token);
  });
});

describe("WebSocketManager thread-open signals", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  function dispatchRaw(payload: unknown): void {
    const instance = fakeSocketState.instances[0];
    if (!instance) {
      throw new Error("Expected websocket instance");
    }
    instance.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  it("notifies layout listeners and buffers an included file once", () => {
    const { manager } = createConnectedManager();
    const threadOpen = vi.fn();
    const changed = vi.fn();
    manager.onThreadOpen(threadOpen);
    manager.onChanged(changed);

    const signal = {
      type: "thread-open",
      projectId: "proj_1",
      threadId: "thr_1",
      split: "right",
      file: {
        source: "workspace",
        path: "src/index.ts",
        lineNumber: 7,
      },
    };
    dispatchRaw(signal);

    expect(threadOpen).toHaveBeenCalledWith(signal);
    expect(changed).not.toHaveBeenCalled();
    expect(manager.consumePendingOpenFile("thr_1")).toEqual(signal.file);
    expect(manager.consumePendingOpenFile("thr_1")).toBeNull();
  });

  it("still routes changed messages to onChanged", () => {
    const { manager } = createConnectedManager();
    const changed = vi.fn();
    const threadOpen = vi.fn();
    manager.onChanged(changed);
    manager.onThreadOpen(threadOpen);

    dispatchRaw({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["events-appended"],
    });

    expect(changed).toHaveBeenCalledTimes(1);
    expect(threadOpen).not.toHaveBeenCalled();
  });

  it("delivers known layout actions and ignores unrelated future fields", () => {
    const { manager } = createConnectedManager();
    const threadOpen = vi.fn();
    manager.onThreadOpen(threadOpen);

    dispatchRaw({
      type: "thread-open",
      projectId: "proj_1",
      threadId: "thr_1",
      split: "replace",
      file: null,
      futureAction: { value: "ignored" },
      terminalLayoutAction: {
        action: "split",
        terminalId: "term_1",
        side: "right",
      },
    });

    expect(threadOpen).toHaveBeenCalledWith({
      type: "thread-open",
      projectId: "proj_1",
      threadId: "thr_1",
      split: "replace",
      file: null,
      terminalLayoutAction: {
        action: "split",
        terminalId: "term_1",
        side: "right",
      },
    });
  });

  it("delivers typed terminal actions on thread-open signals", () => {
    const { manager } = createConnectedManager();
    const threadOpen = vi.fn();
    manager.onThreadOpen(threadOpen);

    dispatchRaw({
      type: "thread-open",
      projectId: "proj_1",
      threadId: "thr_1",
      split: "replace",
      file: null,
      terminalAction: {
        action: "openBrowser",
        terminalId: "term_1",
        url: "http://localhost:3000",
      },
    });

    expect(threadOpen).toHaveBeenCalledWith({
      type: "thread-open",
      projectId: "proj_1",
      threadId: "thr_1",
      split: "replace",
      file: null,
      terminalAction: {
        action: "openBrowser",
        terminalId: "term_1",
        url: "http://localhost:3000",
      },
    });
  });

  it("routes typed thread-pane actions separately", () => {
    const { manager } = createConnectedManager();
    const paneAction = vi.fn();
    const threadOpen = vi.fn();
    manager.onThreadPaneAction(paneAction);
    manager.onThreadOpen(threadOpen);

    const signal = {
      type: "thread-pane-action",
      projectId: "proj_1",
      threadId: "thr_1",
      action: "spotlight",
    } as const;
    dispatchRaw(signal);

    expect(paneAction).toHaveBeenCalledWith(signal);
    expect(threadOpen).not.toHaveBeenCalled();
  });
});

interface FakeBrowserEvents extends WebSocketManagerBrowserEvents {
  setVisible: (visible: boolean) => void;
  goOnline: () => void;
}

function createFakeBrowserEvents(initiallyVisible = true): FakeBrowserEvents {
  let visible = initiallyVisible;
  const visibilityListeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  return {
    isDocumentVisible: () => visible,
    subscribeToVisibility: (listener) => {
      visibilityListeners.add(listener);
      return () => {
        visibilityListeners.delete(listener);
      };
    },
    subscribeToOnline: (listener) => {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
    setVisible: (nextVisible) => {
      visible = nextVisible;
      for (const listener of visibilityListeners) {
        listener();
      }
    },
    goOnline: () => {
      for (const listener of onlineListeners) {
        listener();
      }
    },
  };
}

function getSocketAt(index: number): FakeSocket & {
  onmessage: ((event: MessageEvent) => void) | null;
  readyState: number;
} {
  const socket = fakeSocketState.instances[index];
  if (!socket) {
    throw new Error(`Expected websocket instance #${index}`);
  }
  return socket;
}

function receive(
  socket: { onmessage: ((event: MessageEvent) => void) | null },
  payload: unknown,
): void {
  socket.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
}

function pingCount(socket: FakeSocket): number {
  return readClientMessages(socket).filter((message) => message.type === "ping")
    .length;
}

describe("WebSocketManager liveness", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  function createLiveManager(browserEvents = createFakeBrowserEvents()) {
    const manager = new WebSocketManager(browserEvents);
    const connectedEvents: WebSocketConnectedEvent[] = [];
    manager.onConnected((event) => connectedEvents.push(event));
    manager.connect();
    const socket = getSocketAt(0);
    socket.open();
    return { browserEvents, connectedEvents, manager, socket };
  }

  it("pings an idle visible socket on the interval and reconnects when no frame answers", () => {
    const { connectedEvents, socket } = createLiveManager();
    const openedAt = Date.now();

    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
    expect(pingCount(socket)).toBe(1);
    receive(socket, { type: "pong" });
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
    expect(fakeSocketState.instances).toHaveLength(1);

    vi.advanceTimersByTime(
      REALTIME_PING_INTERVAL_MS - REALTIME_PONG_TIMEOUT_MS,
    );
    expect(pingCount(socket)).toBe(2);
    const lastActivityAt = openedAt + REALTIME_PING_INTERVAL_MS;
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);

    expect(fakeSocketState.instances).toHaveLength(2);
    expect(socket.readyState).toBe(3);
    const replacement = getSocketAt(1);
    replacement.open();
    expect(connectedEvents).toEqual([
      { reconnected: false },
      { reconnected: true, disconnectedAt: lastActivityAt },
    ]);
  });

  it("treats any inbound frame as liveness and skips pings while frames flow", () => {
    const { socket } = createLiveManager();

    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS - 1000);
    receive(socket, {
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(1000);
    expect(pingCount(socket)).toBe(0);

    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
    expect(pingCount(socket)).toBe(1);
    receive(socket, { type: "pong" });
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
    expect(fakeSocketState.instances).toHaveLength(1);
  });

  it("does not ping while hidden and probes once on becoming visible", () => {
    const { browserEvents, socket } = createLiveManager();

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS * 4);
    expect(pingCount(socket)).toBe(0);

    browserEvents.setVisible(true);
    expect(pingCount(socket)).toBe(1);
    receive(socket, { type: "pong" });
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
    expect(pingCount(socket)).toBe(2);
  });

  it("probes on becoming visible even when buffered frames land on resume", () => {
    const { browserEvents, socket } = createLiveManager();

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS * 4);
    receive(socket, {
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["events-appended"],
    });
    browserEvents.setVisible(true);

    expect(pingCount(socket)).toBe(1);
    vi.advanceTimersByTime(REALTIME_RESUME_PONG_TIMEOUT_MS);
    expect(fakeSocketState.instances).toHaveLength(2);
  });

  it("replaces the socket when a stale frame arrives instead of a pong", () => {
    const { browserEvents, socket } = createLiveManager();

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS * 4);
    browserEvents.setVisible(true);
    expect(pingCount(socket)).toBe(1);

    receive(socket, {
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(REALTIME_RESUME_PONG_TIMEOUT_MS);

    expect(fakeSocketState.instances).toHaveLength(2);
  });

  it("reconnects a silent socket 1.5 s after a resume probe, not after 5 s", () => {
    const { browserEvents, socket } = createLiveManager();

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS * 4);
    browserEvents.setVisible(true);
    expect(pingCount(socket)).toBe(1);

    vi.advanceTimersByTime(REALTIME_RESUME_PONG_TIMEOUT_MS - 100);
    expect(fakeSocketState.instances).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(fakeSocketState.instances).toHaveLength(2);
  });

  it("shortens a pending interval pong timer when a resume probe fires", () => {
    const { browserEvents, socket } = createLiveManager();

    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
    expect(pingCount(socket)).toBe(1);
    browserEvents.goOnline();
    expect(pingCount(socket)).toBe(2);

    vi.advanceTimersByTime(REALTIME_RESUME_PONG_TIMEOUT_MS);
    expect(fakeSocketState.instances).toHaveLength(2);
  });

  it("keeps a pending resume pong timer when the interval ping fires", () => {
    const { browserEvents, socket } = createLiveManager();

    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS - 100);
    browserEvents.goOnline();
    vi.advanceTimersByTime(100);
    expect(pingCount(socket)).toBe(2);

    vi.advanceTimersByTime(REALTIME_RESUME_PONG_TIMEOUT_MS - 100);
    expect(fakeSocketState.instances).toHaveLength(2);
  });

  it("fires onResumed once after a long hide, never after a short hide, and on online", () => {
    const { browserEvents, manager } = createLiveManager();
    const onResumed = vi.fn();
    manager.onResumed(onResumed);

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_RESUME_HIDDEN_THRESHOLD_MS - 3_000);
    browserEvents.setVisible(true);
    expect(onResumed).not.toHaveBeenCalled();

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_RESUME_HIDDEN_THRESHOLD_MS + 1_000);
    browserEvents.setVisible(true);
    browserEvents.setVisible(true);
    expect(onResumed).toHaveBeenCalledTimes(1);

    browserEvents.goOnline();
    expect(onResumed).toHaveBeenCalledTimes(2);
  });

  it("fires onResumed when a tab that started hidden becomes visible after the threshold", () => {
    const { browserEvents, manager } = createLiveManager(
      createFakeBrowserEvents(false),
    );
    const onResumed = vi.fn();
    manager.onResumed(onResumed);

    vi.advanceTimersByTime(REALTIME_RESUME_HIDDEN_THRESHOLD_MS + 1_000);
    browserEvents.setVisible(true);

    expect(onResumed).toHaveBeenCalledTimes(1);
  });

  it("does not fire onResumed for online events while hidden", () => {
    const { browserEvents, manager } = createLiveManager();
    const onResumed = vi.fn();
    manager.onResumed(onResumed);

    browserEvents.setVisible(false);
    browserEvents.goOnline();

    expect(onResumed).not.toHaveBeenCalled();
  });

  it("stops watching after a long hide, across reconnects, until visible again", () => {
    const { browserEvents, manager, socket } = createLiveManager();
    const onResumed = vi.fn();
    manager.onResumed(onResumed);
    manager.subscribe(THREAD_TARGET);
    const nonPingMessages = () =>
      readClientMessages(socket).filter((message) => message.type !== "ping");

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_RESUME_HIDDEN_THRESHOLD_MS - 1);
    browserEvents.setVisible(true);
    browserEvents.setVisible(false);
    vi.advanceTimersByTime(REALTIME_RESUME_HIDDEN_THRESHOLD_MS);
    socket.close();
    socket.open();
    manager.subscribe(PROJECT_TARGET);
    browserEvents.setVisible(true);

    expect(nonPingMessages()).toEqual([
      { type: "subscribe", target: THREAD_TARGET },
      { type: "visibility", visible: false },
      { type: "visibility", visible: false },
      { type: "subscribe", targets: [THREAD_TARGET] },
      { type: "subscribe", target: PROJECT_TARGET },
      { type: "visibility", visible: true },
    ]);
    expect(onResumed).toHaveBeenCalledTimes(1);
    expect(onResumed).toHaveBeenCalledWith([THREAD_TARGET, PROJECT_TARGET]);

    browserEvents.goOnline();
    expect(onResumed).toHaveBeenLastCalledWith([]);
  });

  it("schedules the first automatic reconnect within 500 ms of a close", () => {
    createLiveManager();
    const options = fakeSocketState.instances[0]?.options;
    const minDelay = options?.minReconnectionDelay ?? Infinity;

    expect(minDelay).toBeGreaterThanOrEqual(250);
    expect(minDelay).toBeLessThan(500);
    expect(options?.reconnectionDelayGrowFactor).toBe(2);
  });

  it("reconnects immediately on visible or online when the socket is closed", () => {
    const { browserEvents, connectedEvents, socket } = createLiveManager();

    browserEvents.setVisible(false);
    socket.close();
    const closedAt = Date.now();
    vi.advanceTimersByTime(500);
    expect(fakeSocketState.instances).toHaveLength(1);

    browserEvents.setVisible(true);
    expect(fakeSocketState.instances).toHaveLength(2);
    getSocketAt(1).open();
    expect(connectedEvents.at(-1)).toEqual({
      reconnected: true,
      disconnectedAt: closedAt,
    });

    getSocketAt(1).close();
    browserEvents.goOnline();
    expect(fakeSocketState.instances).toHaveLength(3);
  });

  it("reconnects immediately when the socket closes while a probe is outstanding", () => {
    const { browserEvents, connectedEvents, socket } = createLiveManager();
    const openedAt = Date.now();

    browserEvents.setVisible(false);
    vi.advanceTimersByTime(60_000);
    browserEvents.setVisible(true);
    expect(pingCount(socket)).toBe(1);
    vi.advanceTimersByTime(1000);
    socket.close();

    expect(fakeSocketState.instances).toHaveLength(2);
    getSocketAt(1).open();
    expect(connectedEvents.at(-1)).toEqual({
      reconnected: true,
      disconnectedAt: openedAt,
    });
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
    expect(fakeSocketState.instances).toHaveLength(2);
  });

  it("re-sends subscriptions on the replacement socket after a failed probe", () => {
    const { manager } = createLiveManager();
    manager.subscribe(THREAD_TARGET);

    vi.advanceTimersByTime(
      REALTIME_PING_INTERVAL_MS + REALTIME_PONG_TIMEOUT_MS,
    );
    const replacement = getSocketAt(1);
    replacement.open();

    expect(readClientMessages(replacement)).toEqual([
      { type: "subscribe", targets: [THREAD_TARGET] },
    ]);
    expect(manager.getConnectionState()).toBe("connected");
  });
});
