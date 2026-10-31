// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalWebSocketTransport } from "@bb/client-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  waitForReadiness,
  waitForReadinessCondition,
} from "./ThreadTerminalView.terminal-focus-test-utils";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { wsManager } from "@/lib/ws";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
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
  screen: vi.fn(),
  output: vi.fn(),
}));

class TestTerminalSocket {
  readonly protocol = "bb.terminal.resize-echo.v1";
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
      experimental_screen: testState.screen,
      output: testState.output,
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
  testState.deferSocketOpen = false;
  testState.socketMessages.length = 0;
  testState.socketUrls.length = 0;
  testState.clearAttention.mockReset();
  testState.screen.mockReset();
  testState.output.mockReset();
  testState.toastError.mockReset();
  testState.touchEnabled = false;
  testState.mediaQueryListeners.clear();
});

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

vi.setConfig({ testTimeout: 30_000 });

describe("ThreadTerminalView terminal visibility and panel", () => {
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

  it("reports hidden visibility when its panel closes while the document stays visible", async () => {
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(108);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(90);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(108);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(90);

    const props = {
      autoFocus: false,
      isPanelOpen: true,
      session: makeTerminalSession({ id: "term_panel_visibility" }),
    };
    const view = render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView {...props} />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: true });
    });
    view.rerender(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView {...props} isPanelOpen={false} />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: false });
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
});

it.each([
  {
    device: "phone",
    width: 390,
    cols: 51,
    rows: 37,
    renderCols: 80,
    renderRows: 24,
    scale: "1",
  },
  {
    device: "desktop",
    width: 1280,
    cols: 76,
    rows: 40,
    renderCols: 80,
    renderRows: 24,
    scale: "0.95",
  },
])(
  "preserves exited native output layout on $device after touch focus and remount",
  async ({ width, cols, rows, renderCols, renderRows, scale }) => {
    vi.stubGlobal("innerWidth", width);
    const sendResize = vi.spyOn(
      TerminalWebSocketTransport.prototype,
      "sendResize",
    );
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(374);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(526);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 357, 281),
    );
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols,
      rows,
    });
    testState.output.mockResolvedValue({
      chunks: [{ seq: 0, dataBase64: btoa("LAST-ANSWER\r\n") }],
      nextSeq: 1,
    });
    const props = {
      autoFocus: false,
      isPanelOpen: true,
      retainNativeOutput: true,
      session: makeTerminalSession({
        status: "exited",
        exitCode: 0,
        cols: 80,
        rows: 24,
      }),
    };
    for (let i = 0; i < 2; i++) {
      const view = render(
        <MemoryRouter>
          <AppCommandProvider>
            <ThreadTerminalView {...props} />
          </AppCommandProvider>
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          view.container.querySelector("[data-terminal-renderer] .xterm"),
        ).not.toBeNull(),
      );
      await waitFor(() =>
        expect(testState.output).toHaveBeenCalledTimes(i + 1),
      );
      await waitFor(() =>
        expect(
          view.container.querySelector(".xterm-rows")?.textContent,
        ).toContain("LAST-ANSWER"),
      );
      await waitFor(() =>
        expect(
          view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.dataset.renderGridCols,
        ).toBe(String(renderCols)),
      );
      expect(
        view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
          ?.dataset.renderGridRows,
      ).toBe(String(renderRows));
      expect(
        view.container.querySelector<HTMLElement>(".xterm")?.dataset
          .surfaceScale,
      ).toBe(scale);
      const textarea =
        view.container.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.focus();
      fireEvent.pointerDown(textarea, { pointerType: "touch" });
      fireEvent.pointerUp(textarea, { pointerType: "touch" });
      fireEvent(window, new Event("resize"));
      await waitFor(() =>
        expect(
          view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.style.opacity,
        ).not.toBe("0"),
      );
      expect(sendResize).not.toHaveBeenCalled();
      expect(
        testState.socketMessages.some(
          (message) => JSON.parse(message).type === "resize",
        ),
      ).toBe(false);
      view.unmount();
    }
  },
);
