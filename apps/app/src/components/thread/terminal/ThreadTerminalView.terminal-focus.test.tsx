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
import { Terminal } from "@xterm/xterm";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REPAINT_RESTORE_DELAY_MS,
  TerminalWebSocketTransport,
} from "@bb/client-core";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { wsManager } from "@/lib/ws";
import * as terminalModules from "./terminal-modules";
import {
  AppCommandProvider,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView, writeTerminalOutput } from "./ThreadTerminalView";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  clearAttention: vi.fn(),
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
  private resolveOpened!: () => void;

  constructor(url: string) {
    testState.socketUrls.push(url);
    testState.sockets.push(this);
    testState.socketCreated?.();
    testState.socketCreated = null;
    this.opened = new Promise((resolve) => {
      this.resolveOpened = resolve;
    });
    queueMicrotask(() => {
      this.readyState = TestTerminalSocket.OPEN;
      this.onopen?.(new Event("open"));
      this.resolveOpened();
    });
  }

  close(): void {
    this.readyState = TestTerminalSocket.CLOSED;
  }

  disconnect(): void {
    this.readyState = TestTerminalSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "test disconnect" } as CloseEvent);
  }

  send(data: string): void {
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
  sessionStorage.removeItem("bb:terminal-viewport:term_mobile_paste");
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
  testState.socketMessages.length = 0;
  testState.socketUrls.length = 0;
  testState.clearAttention.mockReset();
  testState.toastError.mockReset();
  testState.touchEnabled = false;
  testState.mediaQueryListeners.clear();
});

function waitForReadiness<T>(
  promise: Promise<T>,
  failureMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(failureMessage)), 5_000);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

async function waitForReadinessCondition<T>(
  callback: () => T,
  failureMessage: string,
): Promise<T> {
  try {
    return await waitFor(callback, { timeout: 5_000 });
  } catch {
    const terminalError = document.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )?.textContent;
    throw new Error(
      terminalError ? `${failureMessage}: ${terminalError}` : failureMessage,
    );
  }
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

vi.setConfig({ testTimeout: 30_000 });

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

function stubVisibleIntersectionObserver(): void {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        private readonly callback: IntersectionObserverCallback,
        _options?: IntersectionObserverInit,
      ) {}

      disconnect(): void {}

      observe(target: Element): void {
        this.callback(
          [
            {
              target,
              isIntersecting: true,
              intersectionRect: new DOMRect(0, 0, 354, 504),
            } as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
      }

      unobserve(): void {}
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

function scrollTerminalAsUser(terminal: Terminal, line: number): void {
  const screen = document.querySelector(".xterm-screen");
  if (!screen) throw new Error("terminal screen was not mounted");
  fireEvent.wheel(screen, { deltaY: -1 });
  terminal.scrollToLine(line);
}

function writeReplay(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    writeTerminalOutput({
      data,
      isReplay: true,
      onParsed: resolve,
      replayWriteState: { suppressedWriteCount: 0 },
      terminal,
    });
  });
}

describe("ThreadTerminalView terminal focus boundary", () => {
  it("reveals before a pending search add-on loads, then attaches it", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    stubVisibleIntersectionObserver();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    type SearchAddonModule = Awaited<
      ReturnType<typeof terminalModules.importTerminalSearchAddon>
    >;
    let resolveSearch!: (module: SearchAddonModule) => void;
    const searchModule = new Promise<SearchAddonModule>((resolve) => {
      resolveSearch = resolve;
    });
    vi.spyOn(terminalModules, "importTerminalSearchAddon").mockReturnValue(
      searchModule,
    );
    const originalOpen = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function openTerminal(
      this: Terminal,
      element: HTMLElement,
    ) {
      originalOpen.call(this, element);
    });

    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm")).not.toBeNull(),
      "terminal did not open while search was pending",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    const terminalElement = document.querySelector(".xterm");
    if (!terminalElement) throw new Error("terminal was not opened");
    fireEvent.pointerDown(terminalElement);
    document
      .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
      ?.focus();
    await waitForReadinessCondition(
      () => {
        const renderer = document.querySelector<HTMLElement>(
          "[data-terminal-renderer]",
        );
        expect(renderer?.style.opacity).toBe("");
      },
      "terminal did not reveal while search was pending",
    );
    expect(
      (screen.getByRole("button", {
        name: "Search terminal output",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    const addon = await import("@xterm/addon-search");
    await act(async () => resolveSearch(addon));
    await waitForReadinessCondition(
      () => {
        expect(
          (screen.getByRole("button", {
            name: "Search terminal output",
          }) as HTMLButtonElement).disabled,
        ).toBe(false);
      },
      "search add-on did not attach after loading",
    );
  }, 30_000);

  it("keeps the terminal open when an optional search add-on fails", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    vi.spyOn(terminalModules, "importTerminalSearchAddon").mockRejectedValue(
      new Error("search add-on unavailable"),
    );
    renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm")).not.toBeNull(),
      "terminal did not open after optional search failed",
    );
    expect(document.querySelector("[data-terminal-renderer]")).not.toBeNull();
  }, 30_000);

  it("uses Unicode 11 cell widths for replayed wide TUI status lines", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    stubVisibleIntersectionObserver();
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    let actualTerminal: Terminal | null = null;
    let unicodeVersionAtOpen: string | undefined;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      actualTerminal = this;
      unicodeVersionAtOpen = this.unicode.activeVersion;
      open.call(this, element);
    });
    class WebglAddon {
      activate(_terminal: Terminal): void {}
      dispose(): void {}
      onContextLoss(_listener: () => void) {
        return { dispose: () => {} };
      }
    }
    vi.spyOn(terminalModules, "importTerminalWebglAddon").mockResolvedValue({
      WebglAddon,
    } as Awaited<ReturnType<typeof terminalModules.importTerminalWebglAddon>>);

    renderMobileTerminal();
    await waitForReadinessCondition(
      () => {
        expect(document.querySelector(".xterm")).not.toBeNull();
        expect(actualTerminal).not.toBeNull();
        expect(unicodeVersionAtOpen).toBe("11");
      },
      "Unicode 11 was not active when the terminal opened",
    );
    expect(unicodeVersionAtOpen).toBe("11");
    const terminal = actualTerminal;
    if (!terminal) throw new Error("terminal did not open");
    const line = `🧐界${" ".repeat(31)}12:34`;
    await writeReplay(terminal, line);

    const [{ SearchAddon }, { WebLinksAddon }, { Unicode11Addon }] =
      await Promise.all([
        import("@xterm/addon-search"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
      ]);
    const referenceHost = document.createElement("div");
    document.body.append(referenceHost);
    const reference = new Terminal({
      allowProposedApi: true,
      cols: 40,
      rows: 12,
    });
    reference.loadAddon(new FitAddon());
    reference.loadAddon(new Unicode11Addon());
    reference.unicode.activeVersion = "11";
    reference.open(referenceHost);
    reference.loadAddon(new SearchAddon());
    reference.loadAddon(new WebLinksAddon(() => {}));
    reference.loadAddon(new WebglAddon());
    await new Promise<void>((resolve) => reference.write(line, resolve));

    const positions = (terminal: Terminal) => {
      const row = terminal.buffer.active.getLine(0);
      return {
        emoji: row?.getCell(0)?.getChars(),
        cjk: row?.getCell(2)?.getChars(),
        statusStart: row?.getCell(35)?.getChars(),
        statusEnd: row?.getCell(39)?.getChars(),
        cursorX: terminal.buffer.active.cursorX,
      };
    };
    expect(positions(terminal)).toEqual(positions(reference));
    expect(positions(terminal)).toMatchObject({
      emoji: "🧐",
      cjk: "界",
      statusStart: "1",
      statusEnd: "4",
    });
    reference.dispose();
    referenceHost.remove();
  }, 30_000);

  it("preserves terminal state when WebGL attaches after replay", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    stubVisibleIntersectionObserver();
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    type WebglModule = Awaited<
      ReturnType<typeof terminalModules.importTerminalWebglAddon>
    >;
    let resolveWebgl!: (module: WebglModule) => void;
    const webglModule = new Promise<WebglModule>((resolve) => {
      resolveWebgl = resolve;
    });
    vi.spyOn(terminalModules, "importTerminalWebglAddon").mockReturnValue(
      webglModule,
    );
    class WebglAddon {
      activate(_terminal: Terminal): void {}
      dispose(): void {}
      onContextLoss(_listener: () => void) {
        return { dispose: () => {} };
      }
    }
    const mountedTerminal: { current: Terminal | null } = { current: null };
    const loadAddon = Terminal.prototype.loadAddon;
    vi.spyOn(Terminal.prototype, "loadAddon").mockImplementation(function (
      this: Terminal,
      addon: Parameters<typeof loadAddon>[0],
    ) {
      mountedTerminal.current ??= this;
      loadAddon.call(this, addon);
    });
    renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm")).not.toBeNull(),
      "terminal did not open before WebGL resolution",
    );
    const terminal = mountedTerminal.current;
    if (!terminal) throw new Error("terminal did not mount");
    const history = Array.from(
      { length: 160 },
      (_, index) => `history ${String(index + 1).padStart(3, "0")}`,
    ).join("\r\n");
    await writeReplay(terminal, history);
    await waitForReadinessCondition(
      () => expect(terminal.buffer.active.baseY).toBeGreaterThan(0),
      "replay history did not render before WebGL resolution",
    );
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm-screen")).not.toBeNull(),
      "terminal screen did not render replay history",
    );
    const screen = document.querySelector(".xterm-screen");
    if (!screen) throw new Error("terminal screen was not mounted");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fireEvent.wheel(screen, { deltaY: -120 });
    }
    const before = {
      cols: terminal.cols,
      rows: terminal.rows,
      cursorX: terminal.buffer.active.cursorX,
      cursorY: terminal.buffer.active.cursorY,
      baseY: terminal.buffer.active.baseY,
      viewportY: terminal.buffer.active.viewportY,
      retainedLine: terminal.buffer.active.getLine(5)?.translateToString(true),
    };
    expect(before.viewportY).toBeLessThan(before.baseY);
    await act(async () => resolveWebgl({ WebglAddon } as WebglModule));
    await waitForReadinessCondition(
      () =>
        expect(
          document.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.dataset.terminalRenderer,
        ).toBe("webgl"),
      "WebGL renderer did not attach after replay",
    );
    expect({
      cols: terminal.cols,
      rows: terminal.rows,
      cursorX: terminal.buffer.active.cursorX,
      cursorY: terminal.buffer.active.cursorY,
      baseY: terminal.buffer.active.baseY,
      viewportY: terminal.buffer.active.viewportY,
      retainedLine: terminal.buffer.active.getLine(5)?.translateToString(true),
    }).toEqual(before);
  }, 30_000);

  it("keeps the DOM renderer and replay working when WebGL import fails", async () => {
    prepareMobileTerminal();
    vi.spyOn(terminalModules, "importTerminalWebglAddon").mockRejectedValue(
      new Error("WebGL unavailable"),
    );
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm")).not.toBeNull(),
      "terminal did not open after WebGL import failed",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({ type: "attached", session, replayStartSeq: 0, nextSeq: 1 });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("DOM renderer remains active") },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          document.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.dataset.terminalRenderer,
        ).toBe("dom"),
      "DOM renderer fallback did not remain active",
    );
    await waitForReadinessCondition(
      () =>
        expect(
          document
            .querySelector(".xterm")
            ?.textContent?.replace(/\s+/g, " "),
        ).toContain("DOM renderer remains active"),
      "terminal did not render output after WebGL import failed",
    );
  }, 30_000);

  it("mounts and records output boundaries without crypto.randomUUID", async () => {
    prepareMobileTerminal();
    const originalRandomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    let uuidBytes: Uint8Array | undefined;
    const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      const result = originalGetRandomValues(array);
      if (result.byteLength === 16) {
        uuidBytes = new Uint8Array(
          result.buffer,
          result.byteOffset,
          result.byteLength,
        ).slice();
      }
      return result;
    });
    let outputBoundaryHandler:
      | ((payload: string) => boolean | Promise<boolean>)
      | undefined;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      parent: HTMLElement,
    ) {
      open.call(this, parent);
      const registerOscHandler = this.parser.registerOscHandler.bind(
        this.parser,
      );
      vi.spyOn(this.parser, "registerOscHandler").mockImplementation(
        (identifier, callback) => {
          if (identifier === 7778) outputBoundaryHandler = callback;
          return registerOscHandler(identifier, callback);
        },
      );
    });
    try {
      renderMobileTerminal();
      await waitForReadinessCondition(
        () => expect(document.querySelector(".xterm")).not.toBeNull(),
        "terminal did not mount within 5000 ms",
      );
      expect(document.querySelector(".xterm")).not.toBeNull();
      const generatedBytes = uuidBytes;
      if (!generatedBytes) throw new Error("UUID bytes were not generated");
      generatedBytes[6] = (generatedBytes[6]! & 0x0f) | 0x40;
      generatedBytes[8] = (generatedBytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(generatedBytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      );
      const token = `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
      if (!outputBoundaryHandler) {
        throw new Error("terminal output boundary handler was not registered");
      }
      expect(await outputBoundaryHandler(`${token}:0`)).toBe(true);
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: originalRandomUUID,
      });
    }
  });

  it("keeps a bottom-following client at the bottom after output and a shared resize", async () => {
    prepareMobileTerminal();
    let fitCols = 40;
    let fitRows = 12;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: fitCols, rows: fitRows }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const lines = (start: number, end: number) =>
      Array.from(
        { length: end - start + 1 },
        (_, index) => `line ${String(start + index).padStart(5, "0")}`,
      ).join("\r\n");
    const baseYBeforeOutput = getTerminal().buffer.active.baseY;
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(lines(1, 1_000)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.baseY).toBeGreaterThan(
          baseYBeforeOutput + 100,
        ),
      "terminal output was not parsed within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "replay output was not acknowledged within 5000 ms",
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa(lines(1_001, 1_100)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 2 }),
      "live output was not acknowledged within 5000 ms",
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    fitCols = 38;
    fitRows = 5;
    await act(async () => {
      socket.receive({
        type: "session-updated",
        session: { ...session, cols: 38, rows: 5 },
      });
      await Promise.resolve();
    });
    await waitForReadinessCondition(() => {
      expect(getTerminal().cols).toBe(38);
      expect(getTerminal().rows).toBe(5);
    }, "shared PTY grid resize was not applied within 5000 ms");
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "bottom-following client did not remain at the bottom after companion resize",
    );
  });

  it("keeps a saved bottom-follow position after live output and a shared resize", async () => {
    prepareMobileTerminal();
    let fitCols = 40;
    let fitRows = 12;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: fitCols, rows: fitRows }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const lines = (start: number, end: number) =>
      Array.from(
        { length: end - start + 1 },
        (_, index) => `line ${String(start + index).padStart(5, "0")}`,
      ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(lines(1, 300)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "replay output was not acknowledged within 5000 ms",
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    scrollTerminalAsUser(getTerminal(), getTerminal().buffer.active.baseY - 1);
    expect(
      getTerminal().buffer.active.viewportY,
      "terminal scrollLines did not move above the bottom",
    ).toBeLessThan(getTerminal().buffer.active.baseY);
    getTerminal().scrollToBottom();
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    await new Promise((resolve) => setTimeout(resolve, 275));
    expect(
      JSON.parse(
        sessionStorage.getItem("bb:terminal-viewport:term_mobile_paste") ??
          "null",
      ),
    ).toMatchObject({ distanceFromTail: 0, outputSequence: 0 });
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa(lines(301, 500)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 2 }),
      "live output was not acknowledged within 5000 ms",
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    fitCols = 38;
    fitRows = 5;
    socket.receive({
      type: "session-updated",
      session: { ...session, cols: 38, rows: 5 },
    });
    act(() => getTerminal().resize(38, 5));
    await waitForReadinessCondition(() => {
      expect(getTerminal().cols).toBe(38);
      expect(getTerminal().rows).toBe(5);
    }, "shared PTY grid resize was not applied within 5000 ms");
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "bottom-following client did not remain at the bottom after companion resize",
    );
  });

  it("keeps a live scrolled-up line through a shared resize without stored viewport state", async () => {
    prepareMobileTerminal();
    const openTerminal = Terminal.prototype.open;
    let mountedTerminal: Terminal | null = null;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    expect(
      sessionStorage.getItem("bb:terminal-viewport:term_mobile_paste"),
    ).toBeNull();
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const output = Array.from(
      { length: 300 },
      (_, index) => `line ${String(index + 1).padStart(5, "0")}`,
    ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(output) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "replay output was not acknowledged within 5000 ms",
    );
    const terminal = getTerminal();
    terminal.scrollToLine(terminal.buffer.active.baseY - 1);
    expect(
      terminal.buffer.active.viewportY,
      "terminal did not scroll above the bottom before shared resize",
    ).toBeLessThan(terminal.buffer.active.baseY);
    const topLine = terminal.buffer.active
      .getLine(terminal.buffer.active.viewportY)
      ?.translateToString(true);
    expect(topLine).toMatch(/^line \d{5}$/);
    expect(
      sessionStorage.getItem("bb:terminal-viewport:term_mobile_paste"),
    ).toBeNull();
    socket.receive({
      type: "session-updated",
      session: { ...session, cols: 38, rows: 5 },
    });
    await waitForReadinessCondition(() => {
      expect(terminal.cols).toBe(38);
      expect(terminal.rows).toBe(5);
    }, "shared PTY grid resize was not applied within 5000 ms");
    await waitForReadinessCondition(() => {
      expect(terminal.buffer.active.viewportY).toBeLessThan(
        terminal.buffer.active.baseY,
      );
      expect(
        terminal.buffer.active
          .getLine(terminal.buffer.active.viewportY)
          ?.translateToString(true),
      ).toBe(topLine);
    }, "shared resize moved the live scrolled-up line");
  });

  it("restores a reloaded bottom-following client after a terminal resize", async () => {
    prepareMobileTerminal();
    let fitRows = 12;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: 40, rows: fitRows }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    sessionStorage.setItem(
      "bb:terminal-viewport:term_mobile_paste",
      JSON.stringify({
        distanceFromTail: 0,
        lineOffset: 100,
        outputSequence: 0,
      }),
    );
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const output = Array.from(
      { length: 500 },
      (_, index) => `line ${String(index + 1).padStart(5, "0")}`,
    ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(output) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "bottom-follow replay was not acknowledged within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "reloaded bottom-following client was not at the bottom after replay",
    );
    fitRows = 11;
    act(() => getTerminal().resize(40, fitRows));
    await waitForReadinessCondition(
      () => expect(getTerminal().rows).toBe(11),
      "settled terminal grid resize was not applied within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "reloaded bottom-following client did not settle at the bottom",
    );
  });

  it("keeps a live bottom-following client at the bottom after typed output and a shared resize", async () => {
    prepareMobileTerminal();
    let fitCols = 40;
    let fitRows = 12;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: fitCols, rows: fitRows }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const lines = (start: number, end: number) =>
      Array.from(
        { length: end - start + 1 },
        (_, index) => `line ${String(start + index).padStart(5, "0")}`,
      ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(lines(1, 1_000)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "replay output was not acknowledged within 5000 ms",
    );
    scrollTerminalAsUser(getTerminal(), getTerminal().buffer.active.baseY - 1);
    expect(
      getTerminal().buffer.active.viewportY,
      "terminal scrollLines did not move above the bottom before typed output",
    ).toBeLessThan(getTerminal().buffer.active.baseY);
    await new Promise((resolve) => setTimeout(resolve, 275));
    getTerminal().input("echo case-c\r", true);
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa(`${lines(1_001, 1_100)}\r\n`) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 2 }),
      "live output was not acknowledged within 5000 ms",
    );
    getTerminal().scrollToBottom();
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "typed live output did not move the terminal to the bottom",
    );
    fitCols = 38;
    fitRows = 5;
    socket.receive({
      type: "output",
      chunk: {
        seq: 2,
        dataBase64: btoa(
          `\u001b]7791;bb-grid;38;5\u0007${lines(1_101, 1_120)}\r\n`,
        ),
      },
    });
    await waitForReadinessCondition(() => {
      expect(getTerminal().cols).toBe(38);
      expect(getTerminal().rows).toBe(5);
    }, "in-band shared PTY grid marker was not applied within 5000 ms");
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 3 }),
      "in-band resize output was not acknowledged within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "typed-output client left the bottom after companion resize",
    );
  });

  it("keeps a restored scrolled-up content line through the component column reflow", async () => {
    prepareMobileTerminal();
    let fitCols = 40;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: fitCols, rows: 12 }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    sessionStorage.setItem(
      "bb:terminal-viewport:term_mobile_paste",
      JSON.stringify({
        distanceFromTail: 388,
        lineOffset: 100,
        outputSequence: 0,
      }),
    );
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const output = Array.from({ length: 500 }, (_, index) => {
      const number = String(index + 1).padStart(5, "0");
      return `line ${number} ${"0123456789".repeat(2)}01234567`;
    }).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(output) },
    });
    await waitForReadinessCondition(
      () => expect(getTerminal().buffer.active.baseY).toBeGreaterThan(0),
      "terminal output was not parsed within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "saved viewport replay was not acknowledged within 5000 ms",
    );
    const lineBefore = getTerminal()
      .buffer.active.getLine(getTerminal().buffer.active.viewportY)
      ?.translateToString(true);
    expect(lineBefore).toMatch(/^line \d{5} /);
    expect(lineBefore?.length).toBeGreaterThan(20);
    expect(getTerminal().buffer.active.viewportY).toBeLessThan(
      getTerminal().buffer.active.baseY,
    );
    fitCols = 20;
    act(() => getTerminal().resize(20, 12));
    await waitForReadinessCondition(
      () => expect(getTerminal().cols).toBe(20),
      "component column reflow was not applied within 5000 ms",
    );

    await waitForReadinessCondition(
      () =>
        expect(
          getTerminal()
            .buffer.active.getLine(getTerminal().buffer.active.viewportY)
            ?.translateToString(true)
            ?.match(/^line (\d{5}) /)?.[1],
        ).toBe(lineBefore?.match(/^line (\d{5}) /)?.[1]),
      "component did not restore the scrolled line after shared column reflow",
    );
  });

  it("uses gesture-start scale for uneven multi-frame pinch gestures", async () => {
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
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));
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
        const fontSize = Number(
          document
            .querySelector("[data-terminal-renderer]")
            ?.getAttribute("data-terminal-font-size") ?? 12,
        );
        return {
          cols: Math.round(612 / fontSize),
          rows: Math.round(676.8 / (fontSize * 1.2)),
        };
      },
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_multiframe_pinch",
              status: "running",
              cols: 51,
              rows: 47,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(testState.sockets).toHaveLength(1));
    const pane = document.querySelector(".group\\/terminal-pane");
    const fontSizeNode = document.querySelector("[data-terminal-renderer]");
    expect(pane).not.toBeNull();
    expect(fontSizeNode?.getAttribute("data-terminal-font-size")).toBe("12");

    const dispatchTouches = (
      type: "touchstart" | "touchmove" | "touchend",
      distance: number,
      ending = false,
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const points = [
        { identifier: 1, clientX: 100 - distance / 2, clientY: 100 },
        { identifier: 2, clientX: 100 + distance / 2, clientY: 100 },
      ];
      const touchList = (items: typeof points) =>
        Object.assign(items, { item: (index: number) => items[index] ?? null });
      Object.defineProperty(event, "touches", {
        value: touchList(ending ? [] : points),
      });
      Object.defineProperty(event, "targetTouches", {
        value: touchList(ending ? [] : points),
      });
      Object.defineProperty(event, "changedTouches", {
        value: touchList(points),
      });
      fireEvent(pane as HTMLElement, event);
    };
    const resizeMessages = () =>
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

    await waitFor(() => expect(resizeMessages()).toHaveLength(1));
    const originalGrid = resizeMessages().at(-1);
    dispatchTouches("touchstart", 100);
    for (const ratio of [
      1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5,
    ]) {
      dispatchTouches("touchmove", 100 * ratio);
    }
    dispatchTouches("touchend", 150, true);
    await waitFor(() =>
      expect(fontSizeNode?.getAttribute("data-terminal-font-size")).toBe("18"),
    );
    await waitFor(() => expect(resizeMessages()).toHaveLength(2));
    expect(resizeMessages().at(-1)).toEqual({
      type: "resize",
      cols: 34,
      rows: 31,
    });

    dispatchTouches("touchstart", 150);
    for (const ratio of [1.45, 1.4, 1.35, 1.3, 1.25, 1.2, 1.15, 1.1, 1.05, 1]) {
      dispatchTouches("touchmove", 150 * (ratio / 1.5));
    }
    dispatchTouches("touchend", 100, true);
    await waitFor(() =>
      expect(fontSizeNode?.getAttribute("data-terminal-font-size")).toBe("12"),
    );
    await waitFor(() => expect(resizeMessages()).toHaveLength(3));
    expect(resizeMessages().at(-1)).toEqual(originalGrid);
  });

  it("preserves the open terminal and its scrollback when pointer mode changes", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    const session = renderMobileTerminal();

    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const output = Array.from(
      { length: 48 },
      (_, index) => `retained-${String(index + 1).padStart(2, "0")}`,
    ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(output) },
    });
    await waitForReadinessCondition(() => {
      expect(document.querySelector(".xterm-rows")?.textContent).toContain(
        "retained-48",
      );
    }, "retained-48 rendered BEFORE pointer toggle");
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "retained-48 replay was not acknowledged BEFORE pointer toggle",
    );
    const xterm = document.querySelector(".xterm");
    expect(xterm).not.toBeNull();

    act(() => {
      testState.touchEnabled = true;
      for (const notify of [...testState.mediaQueryListeners]) notify();
    });

    await waitForReadinessCondition(
      () => screen.getByRole("button", { name: "More terminal keys" }),
      "mobile terminal controls were not rendered within 5000 ms",
    );
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not retained after pointer mode changed within 5000 ms",
    );
    expect(document.querySelector(".xterm")).toBe(xterm);
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa("after-toggle-output") },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 2 }),
      "new output was not acknowledged AFTER pointer toggle",
    );
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select terminal text" }),
    );
    await waitForReadinessCondition(() => {
      const snapshot = screen.getByRole("textbox", {
        name: "Terminal text snapshot",
      }) as HTMLTextAreaElement;
      expect(snapshot.value).toContain("retained-01");
      expect(snapshot.value).toContain("retained-48");
      expect(snapshot.value).toContain("after-toggle-output");
    }, "scrollback survives pointer toggle: retained and new output must render");
  }, 30_000);

  it("sends clipboard text once through xterm paste input", async () => {
    prepareMobileTerminal();
    const readText = vi.fn().mockResolvedValue("paste-once");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const session = renderMobileTerminal();

    await waitForReadinessCondition(
      () => screen.getByRole("button", { name: "More terminal keys" }),
      "mobile terminal controls were not rendered within 5000 ms",
    );
    await waitForReadinessCondition(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "More terminal keys",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    }, "mobile terminal controls did not become enabled within 5000 ms");
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

    await waitForReadinessCondition(() => {
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
    }, "clipboard text was not sent through terminal input within 5000 ms");
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

    await waitForReadinessCondition(
      () => screen.getByRole("button", { name: "More terminal keys" }),
      "mobile terminal controls were not rendered within 5000 ms",
    );
    await waitForReadinessCondition(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "More terminal keys",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    }, "mobile terminal controls did not become enabled within 5000 ms");
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitForReadinessCondition(() => {
      expect(testState.toastError).toHaveBeenCalledWith(
        "This connection can’t read the clipboard. Long-press a message box and choose Paste.",
      );
    }, "clipboard denial fallback was not shown within 5000 ms");
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
    await waitForReadinessCondition(
      () => expect(testState.socketUrls).toHaveLength(1),
      "initial terminal socket URL was not created within 5000 ms",
    );
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
    await waitForReadinessCondition(
      () => expect(testState.socketUrls).toHaveLength(2),
      "terminal socket did not reconnect within 5000 ms",
    );
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

    await waitForReadinessCondition(
      () => expect(testState.socketUrls).toHaveLength(1),
      "terminal socket URL was not created within 5000 ms",
    );
    const url = new URL(testState.socketUrls[0] ?? "ws://localhost");
    expect(url.pathname).toBe(
      `/ws/terminals/term-${view.path.replaceAll(" ", "-")}`,
    );
    expect(url.searchParams.get("handoffOwnerToken")).toBe(token);
    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages
          .map((message) => JSON.parse(message))
          .some(
            (message) =>
              message.type === "visibility" && message.visible === true,
          ),
      ).toBe(true);
    }, "terminal visibility was not reported within 5000 ms");
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

    await waitForReadinessCondition(() => {
      expect(testState.clearAttention).toHaveBeenCalledWith({
        terminalId: session.id,
      });
      expect(onSessionChange).toHaveBeenCalledWith(updatedSession);
    }, "terminal attention was not cleared within 5000 ms");
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
    let unavailableFitMeasurements = 0;
    let resolveUnavailableFitMeasurements!: () => void;
    const unavailableFitMeasurementsReady = new Promise<void>((resolve) => {
      resolveUnavailableFitMeasurements = resolve;
    });
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      function proposeDimensions(this: FitAddon) {
        if (fitDimensionsAvailable) {
          return originalProposeDimensions.call(this);
        }
        unavailableFitMeasurements += 1;
        if (unavailableFitMeasurements === 2) {
          resolveUnavailableFitMeasurements();
        }
        return undefined;
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

    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: true });
    }, "terminal visibility was not reported within 5000 ms");
    await waitForReadiness(
      unavailableFitMeasurementsReady,
      "initial fit dimensions were not measured while unavailable within 5000 ms",
    );
    expect(
      testState.socketMessages
        .map((message) => JSON.parse(message) as { type?: string })
        .some((message) => message.type === "resize"),
    ).toBe(false);
    fitDimensionsAvailable = true;

    await waitForReadinessCondition(() => {
      const resize = testState.socketMessages
        .map(
          (message) => JSON.parse(message) as { cols?: number; type?: string },
        )
        .find((message) => message.type === "resize");
      expect(resize).toBeDefined();
      expect(resize?.cols).toBeLessThan(120);
    }, "initial fitted resize was not sent within 5000 ms");

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
    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: false });
    }, "terminal hidden visibility was not reported within 5000 ms");

    visibilityState.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await waitForReadinessCondition(() => {
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
    }, "terminal visible visibility was not restored after focus within 5000 ms");
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

    await waitForReadiness(
      socketCreated,
      "socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0]!;
    await Promise.all([
      waitForReadiness(socket.opened, "socket did not open within 5000 ms"),
      waitForReadiness(layoutSettled, "layout did not settle within 5000 ms"),
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
    expect(resizeFrames()).toEqual([{ type: "resize", cols: 51, rows: 47 }]);
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
    expect(resizeFrames()).toEqual([{ type: "resize", cols: 51, rows: 47 }]);
    await vi.advanceTimersByTimeAsync(REPAINT_RESTORE_DELAY_MS + 1);
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

    testState.sockets[0]?.disconnect();
    await vi.advanceTimersByTimeAsync(100);
    const reconnectedSocket = testState.sockets[1];
    if (!reconnectedSocket) {
      throw new Error("terminal socket was not recreated after disconnect");
    }
    await waitForReadiness(
      reconnectedSocket.opened,
      "reconnected socket did not open within 5000 ms",
    );
    reconnectedSocket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    await vi.advanceTimersByTimeAsync(REPAINT_RESTORE_DELAY_MS + 1);
    await waitForReadinessCondition(
      () =>
        expect(resizeFrames().slice(-2)).toEqual([
          { type: "resize", cols: 50, rows: 47 },
          { type: "resize", cols: 51, rows: 47 },
        ]),
      "reconnected terminal resize was not restored within 5000 ms",
    );
  }, 30_000);

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

    const terminalInput = await waitForReadinessCondition(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (textarea === null) throw new Error("xterm input is not mounted");
      return textarea;
    }, "xterm input was not mounted within 5000 ms");
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
