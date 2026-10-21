// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalWebSocketTransport } from "@bb/client-core";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { wsManager } from "@/lib/ws";
import {
  AppCommandProvider,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "./ThreadTerminalView";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  clearAttention: vi.fn(),
  deferSocketOpen: false,
  mediaQueryListeners: new Set<() => void>(),
  touchEnabled: false,
  toastError: vi.fn(),
  sockets: [] as TestTerminalSocket[],
  socketCreated: null as (() => void) | null,
  socketMessages: [] as string[],
  socketUrls: [] as string[],
}));

class TestTerminalSocket {
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  bufferedAmount = 0;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = TestTerminalSocket.CONNECTING;
  readonly opened: Promise<void>;
  readonly sent: string[] = [];
  private resolveOpened!: () => void;

  constructor(url: string) {
    testState.socketUrls.push(url);
    testState.sockets.push(this);
    testState.socketCreated?.();
    testState.socketCreated = null;
    this.opened = new Promise((resolve) => {
      this.resolveOpened = resolve;
    });
    if (!testState.deferSocketOpen) {
      queueMicrotask(() => this.open());
    }
  }

  open(): void {
    this.readyState = TestTerminalSocket.OPEN;
    this.onopen?.(new Event("open"));
    this.resolveOpened();
  }

  close(): void {
    this.readyState = TestTerminalSocket.CLOSED;
  }

  disconnect(): void {
    this.readyState = TestTerminalSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "test disconnect" } as CloseEvent);
  }

  send(data: string): void {
    this.sent.push(data);
    testState.socketMessages.push(data);
  }

  receive(message: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }
}

vi.mock("@/lib/sdk", () => ({
  sdk: {
    terminals: {
      experimental_attention: {
        clear: testState.clearAttention,
      },
    },
  },
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: testState.toastError },
}));

vi.mock("@bb/shared-ui/hooks/use-media-query", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const actual =
    await importOriginal<
      typeof import("@bb/shared-ui/hooks/use-media-query")
    >();
  return {
    ...actual,
    useMediaQuery: (query: string) => {
      const touchEnabled = useSyncExternalStore(
        (notify) => {
          testState.mediaQueryListeners.add(notify);
          return () => testState.mediaQueryListeners.delete(notify);
        },
        () => testState.touchEnabled,
        () => false,
      );
      const actualValue = actual.useMediaQuery(query);
      return query === "(pointer: coarse)" ? touchEnabled : actualValue;
    },
  };
});

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { showKeyboardHints: false },
      keybindings: [],
    },
  }),
}));

vi.mock("@/hooks/usePluginCommandBindings", () => ({
  usePluginCommandBindings: () => ({
    commands: [],
    defaults: [],
    keybindings: [
      {
        command: "thread.search",
        desktopOnly: false,
        shortcut: {
          key: "k",
          mod: false,
          meta: false,
          control: true,
          alt: false,
          shift: false,
        },
        when: { all: ["mainSurface"], none: ["terminalFocus"] },
      },
    ],
  }),
}));

function Handler() {
  useAppCommandHandler("thread.search", () => {
    testState.calls.push("search");
    return true;
  });
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  Reflect.set(wsManager, "deviceHandoffClientToken", null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  }
  testState.calls.length = 0;
  testState.sockets.length = 0;
  testState.socketCreated = null;
  testState.deferSocketOpen = false;
  testState.socketMessages.length = 0;
  testState.socketUrls.length = 0;
  testState.clearAttention.mockReset();
  testState.toastError.mockReset();
  testState.touchEnabled = false;
  testState.mediaQueryListeners.clear();
});

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

function prepareMobileTerminal(): void {
  testState.touchEnabled = true;
  vi.stubGlobal("WebSocket", TestTerminalSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}

      disconnect(): void {}

      observe(target: Element): void {
        this.callback(
          [
            {
              target,
              contentRect: { width: 354, height: 504 },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }

      unobserve(): void {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 9 }),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function offsetWidth(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 9 : 354;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function offsetHeight(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 18 : 504;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function clientWidth(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 9 : 354;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function clientHeight(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 18 : 504;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getBoundingClientRect(this: HTMLElement) {
      return new DOMRect(0, 0, this.clientWidth, this.clientHeight);
    },
  );
}

function renderMobileTerminal(): ReturnType<typeof makeTerminalSession> {
  const session = makeTerminalSession({
    id: "term_mobile_paste",
    status: "running",
    cols: 40,
    rows: 12,
  });
  render(
    <MemoryRouter>
      <AppCommandProvider>
        <ThreadTerminalView autoFocus={false} isPanelOpen session={session} />
      </AppCommandProvider>
    </MemoryRouter>,
  );
  return session;
}

describe("ThreadTerminalView terminal focus boundary", () => {
  it("preserves the open terminal and its scrollback when pointer mode changes", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    const session = renderMobileTerminal();

    await waitFor(() => expect(testState.sockets).toHaveLength(1));
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    const output = Array.from(
      { length: 48 },
      (_, index) => `retained-${String(index + 1).padStart(2, "0")}`,
    ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(output) },
    });
    await waitFor(() => {
      expect(document.querySelector(".xterm-rows")?.textContent).toContain(
        "retained-48",
      );
    });
    const xterm = document.querySelector(".xterm");
    expect(xterm).not.toBeNull();

    act(() => {
      testState.touchEnabled = true;
      for (const notify of [...testState.mediaQueryListeners]) notify();
    });

    await screen.findByRole("button", { name: "More terminal keys" });
    await waitFor(() => expect(testState.sockets).toHaveLength(1));
    expect(document.querySelector(".xterm")).toBe(xterm);
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select terminal text" }),
    );
    await waitFor(() => {
      const snapshot = screen.getByRole("textbox", {
        name: "Terminal text snapshot",
      }) as HTMLTextAreaElement;
      expect(snapshot.value).toContain("retained-01");
      expect(snapshot.value).toContain("retained-48");
    });
  });

  it("sends clipboard text once through xterm paste input", async () => {
    prepareMobileTerminal();
    const readText = vi.fn().mockResolvedValue("paste-once");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const session = renderMobileTerminal();

    await screen.findByRole("button", { name: "More terminal keys" });
    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "More terminal keys",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("\x1b[?2004h") },
    });
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitFor(() => {
      const inputMessages = testState.socketMessages
        .map(
          (message) =>
            JSON.parse(message) as { dataBase64?: string; type?: string },
        )
        .filter(
          (message): message is { dataBase64: string; type: "input" } =>
            message.type === "input" && typeof message.dataBase64 === "string",
        );
      expect(inputMessages).toHaveLength(1);
      expect(
        new TextDecoder().decode(
          decodeBase64Bytes(inputMessages[0]!.dataBase64),
        ),
      ).toBe("paste-once");
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(testState.toastError).not.toHaveBeenCalled();
  });

  it("shows the clipboard fallback without sending input when read is denied", async () => {
    prepareMobileTerminal();
    const readText = vi.fn().mockRejectedValue(new DOMException("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    renderMobileTerminal();

    await screen.findByRole("button", { name: "More terminal keys" });
    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "More terminal keys",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitFor(() => {
      expect(testState.toastError).toHaveBeenCalledWith(
        "This connection can’t read the clipboard. Long-press a message box and choose Paste.",
      );
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(
      testState.socketMessages
        .map((message) => JSON.parse(message) as { type?: string })
        .filter((message) => message.type === "input"),
    ).toHaveLength(0);
  });

  it("keeps the app identity when the server echoes it after terminal attach", async () => {
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        disconnect(): void {}
        observe(target: Element): void {
          this.callback(
            [
              {
                target,
                contentRect: { width: 390, height: 700 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        unobserve(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 20,
    });

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term-late-app-token",
              threadId: null,
              status: "running",
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(testState.socketUrls).toHaveLength(1));
    const initialToken = new URL(
      testState.socketUrls[0] ?? "ws://localhost",
    ).searchParams.get("handoffOwnerToken");
    expect(initialToken).toMatch(/^[A-Za-z0-9_-]{22}$/u);

    wsManager.handleIncomingMessage(
      JSON.stringify({
        type: "device-handoff-client-token",
        token: initialToken,
      }),
    );

    expect(testState.socketUrls).toHaveLength(1);

    testState.sockets[0]?.disconnect();
    await waitFor(() => expect(testState.socketUrls).toHaveLength(2));
    expect(
      new URL(testState.socketUrls[1] ?? "ws://localhost").searchParams.get(
        "handoffOwnerToken",
      ),
    ).toBe(initialToken);
  });

  it.each([
    {
      path: "desktop terminal tab",
      threadId: null,
      compact: false,
    },
    {
      path: "split-pane terminal",
      threadId: "thr_split_terminal",
      compact: false,
    },
    {
      path: "phone right-panel terminal tab",
      threadId: null,
      compact: true,
    },
    {
      path: "thread terminal with a threadless origin",
      threadId: null,
      compact: false,
    },
  ])("attaches the $path with its owning app token", async (view) => {
    wsManager.handleIncomingMessage(
      JSON.stringify({
        type: "device-handoff-client-token",
        token: "0123456789abcdefghij_-",
      }),
    );
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        disconnect(): void {}
        observe(target: Element): void {
          this.callback(
            [
              {
                target,
                contentRect: { width: 390, height: 700 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        unobserve(): void {}
      },
    );
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: view.compact && query === "(pointer: coarse)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 20,
    });
    const token = `view-path-owner-${view.path.replaceAll(" ", "-")}`;
    wsManager.handleIncomingMessage(
      JSON.stringify({ type: "device-handoff-client-token", token }),
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: `term-${view.path.replaceAll(" ", "-")}`,
              threadId: view.threadId,
              status: "running",
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(testState.socketUrls).toHaveLength(1));
    const url = new URL(testState.socketUrls[0] ?? "ws://localhost");
    expect(url.pathname).toBe(
      `/ws/terminals/term-${view.path.replaceAll(" ", "-")}`,
    );
    expect(url.searchParams.get("handoffOwnerToken")).toBe(token);
    await waitFor(() => {
      expect(
        testState.socketMessages
          .map((message) => JSON.parse(message))
          .some(
            (message) =>
              message.type === "visibility" && message.visible === true,
          ),
      ).toBe(true);
    });
  });

  it("clears attention when its terminal panel becomes visible", async () => {
    const session = makeTerminalSession({
      id: "term_attention",
      attention: { at: 10, kind: "bell", seq: 3 },
    });
    const updatedSession = { ...session, attention: null };
    const onSessionChange = vi.fn();
    testState.clearAttention.mockResolvedValue(updatedSession);

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function offsetWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element")
          ? 288
          : 108;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function offsetHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 18 : 90;
      },
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            onSessionChange={onSessionChange}
            session={session}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(testState.clearAttention).toHaveBeenCalledWith({
        terminalId: session.id,
      });
      expect(onSessionChange).toHaveBeenCalledWith(updatedSession);
    });
  });

  it("waits for fit dimensions before settling the initial main-pane layout", async () => {
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}

        disconnect(): void {}

        observe(target: Element): void {
          this.callback(
            [
              {
                target,
                contentRect: { width: 354, height: 504 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }

        unobserve(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function offsetWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 9 : 354;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function offsetHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 18 : 504;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function clientWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 9 : 354;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function clientHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 18 : 504;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        return new DOMRect(0, 0, this.clientWidth, this.clientHeight);
      },
    );
    const originalProposeDimensions = FitAddon.prototype.proposeDimensions;
    let fitDimensionsAvailable = false;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      function proposeDimensions(this: FitAddon) {
        return fitDimensionsAvailable
          ? originalProposeDimensions.call(this)
          : undefined;
      },
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_initial_main_fit_unmeasured",
              status: "running",
              cols: 120,
              rows: 36,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      testState.socketMessages
        .map((message) => JSON.parse(message) as { type?: string })
        .some((message) => message.type === "resize"),
    ).toBe(false);
    fitDimensionsAvailable = true;

    await waitFor(() => {
      const resize = testState.socketMessages
        .map(
          (message) => JSON.parse(message) as { cols?: number; type?: string },
        )
        .find((message) => message.type === "resize");
      expect(resize).toBeDefined();
      expect(resize?.cols).toBeLessThan(120);
    });

    const resizeFrames = () =>
      testState.socketMessages
        .map(
          (message) =>
            JSON.parse(message) as {
              cols?: number;
              rows?: number;
              type?: string;
            },
        )
        .filter((message) => message.type === "resize");
    const fittedSize = resizeFrames()[0];
    if (fittedSize?.cols === undefined || fittedSize.rows === undefined) {
      throw new Error("Expected a fitted terminal size");
    }
    const visibilityState = vi.spyOn(document, "visibilityState", "get");
    visibilityState.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: false });
    });

    visibilityState.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      const messages = testState.socketMessages.map(
        (message) =>
          JSON.parse(message) as {
            cols?: number;
            rows?: number;
            type?: string;
            visible?: boolean;
          },
      );
      const hiddenIndex = messages.findIndex(
        (message) => message.type === "visibility" && !message.visible,
      );
      const visibleIndex = messages.findIndex(
        (message, index) =>
          index > hiddenIndex &&
          message.type === "visibility" &&
          message.visible,
      );
      expect(hiddenIndex).toBeGreaterThanOrEqual(0);
      expect(visibleIndex).toBeGreaterThan(hiddenIndex);
      expect(
        messages
          .slice(visibleIndex + 1)
          .find(
            (message) =>
              message.type === "resize" &&
              message.cols === fittedSize.cols &&
              message.rows === fittedSize.rows,
          ),
      ).toEqual({
        type: "resize",
        cols: fittedSize.cols,
        rows: fittedSize.rows,
      });
    });
  });

  it("does not repaint-nudge the initial terminal replay", async () => {
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}

        disconnect(): void {}

        observe(target: Element): void {
          this.callback(
            [
              {
                target,
                contentRect: { width: 354, height: 504 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }

        unobserve(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function offsetWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 7 : 354;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function offsetHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 14 : 504;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function clientWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 7 : 354;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function clientHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 14 : 504;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        return new DOMRect(0, 0, this.clientWidth, this.clientHeight);
      },
    );
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      function proposeDimensions() {
        return { cols: 51, rows: 47 };
      },
    );
    const markLayoutSettled =
      TerminalWebSocketTransport.prototype.markLayoutSettled;
    let resolveLayoutSettled!: () => void;
    const layoutSettled = new Promise<void>((resolve) => {
      resolveLayoutSettled = resolve;
    });
    vi.spyOn(
      TerminalWebSocketTransport.prototype,
      "markLayoutSettled",
    ).mockImplementation(function (this: TerminalWebSocketTransport) {
      markLayoutSettled.call(this);
      resolveLayoutSettled();
    });
    let resolveSocketCreated!: () => void;
    const socketCreated = new Promise<void>((resolve) => {
      resolveSocketCreated = resolve;
    });
    testState.socketCreated = resolveSocketCreated;

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_first_attach_font_metrics",
              status: "running",
              cols: 120,
              rows: 36,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await socketCreated;
    const socket = testState.sockets[0]!;
    await Promise.all([socket.opened, layoutSettled]);
    const initialResizes = testState.socketMessages
      .map(
        (message) =>
          JSON.parse(message) as {
            cols?: number;
            rows?: number;
            type?: string;
          },
      )
      .filter((message) => message.type === "resize");
    expect(initialResizes).toEqual([{ type: "resize", cols: 51, rows: 47 }]);
    await waitFor(
      () =>
        expect(
          testState.socketMessages
            .map(
              (message) =>
                JSON.parse(message) as {
                  cols?: number;
                  rows?: number;
                  type?: string;
                },
            )
            .filter((message) => message.type === "resize"),
        ).toEqual([{ type: "resize", cols: 51, rows: 47 }]),
      { timeout: 6_000 },
    );
    const session = makeTerminalSession({
      id: "term_first_attach_font_metrics",
      status: "running",
      cols: 120,
      rows: 36,
    });
    testState.sockets[0]?.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    await waitFor(
      () =>
        expect(
          testState.socketMessages
            .map(
              (message) =>
                JSON.parse(message) as {
                  cols?: number;
                  rows?: number;
                  type?: string;
                },
            )
            .filter((message) => message.type === "resize"),
        ).toEqual([{ type: "resize", cols: 51, rows: 47 }]),
      { timeout: 6_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      testState.socketMessages
        .map(
          (message) =>
            JSON.parse(message) as {
              cols?: number;
              rows?: number;
              type?: string;
            },
        )
        .filter((message) => message.type === "resize"),
    ).toEqual([{ type: "resize", cols: 51, rows: 47 }]);

    testState.deferSocketOpen = true;
    testState.sockets[0]?.disconnect();
    await waitFor(() => expect(testState.sockets).toHaveLength(2));
    const reconnectedSocket = testState.sockets[1]!;
    vi.useFakeTimers();
    reconnectedSocket.open();
    await reconnectedSocket.opened;
    reconnectedSocket.receive({ type: "features", resizeAcks: true });
    reconnectedSocket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    const socketResizes = () =>
      reconnectedSocket.sent
        .map(
          (message) =>
            JSON.parse(message) as {
              cols?: number;
              rows?: number;
              seq?: number;
              type?: string;
            },
        )
        .filter((message) => message.type === "resize");
    await vi.waitFor(() => {
      expect(socketResizes()).toContainEqual({
        type: "resize",
        cols: 50,
        rows: 47,
        seq: 1,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(socketResizes().at(-1)).toEqual({
      type: "resize",
      cols: 50,
      rows: 47,
      seq: 1,
    });
    reconnectedSocket.receive({ type: "resize-applied", seq: 1 });
    expect(socketResizes().at(-1)).toEqual({
      type: "resize",
      cols: 51,
      rows: 47,
      seq: 2,
    });
    expect(
      socketResizes()
        .slice(-2)
        .map(({ type, cols, rows }) => ({ type, cols, rows })),
    ).toEqual([
      { type: "resize", cols: 50, rows: 47 },
      { type: "resize", cols: 51, rows: 47 },
    ]);
  }, 15_000);

  it("suppresses terminal-scoped shortcuts from the real xterm input", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function offsetWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element")
          ? 288
          : 108;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function offsetHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 18 : 90;
      },
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <Handler />
          <button type="button" aria-label="Outside terminal" />
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_focus",
              threadId: "thr_focus",
              environmentId: "env_focus",
              hostId: "host_focus",
              createdAt: 1,
              updatedAt: 1,
              status: "running",
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    const terminalInput = await waitFor(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (textarea === null) throw new Error("xterm input is not mounted");
      return textarea;
    });
    const outside = screen.getByLabelText("Outside terminal");
    const dispatchSearch = (target: Element) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "k",
      });
      target.dispatchEvent(event);
      return event;
    };

    expect(dispatchSearch(outside).defaultPrevented).toBe(true);
    expect(testState.calls).toEqual(["search"]);
    testState.calls.length = 0;
    terminalInput.focus();
    expect(document.activeElement).toBe(terminalInput);

    const event = dispatchSearch(terminalInput);

    expect(event.defaultPrevented).toBe(false);
    expect(testState.calls).toEqual([]);
  });
});
