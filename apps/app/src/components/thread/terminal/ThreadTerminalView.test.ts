import { createTerminalGridMarker, TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { registerTerminalGridOscHandler } from "./terminal-grid-osc";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import {
  buildTerminalThemeFromCssColors,
  attachTerminalManualScrollIntentListeners,
  applyTerminalGridBeforeViewportRestore,
  applyTerminalGridAndKeepViewport,
  createTerminalViewportLineAnchor,
  restoreTerminalViewportToRetainedLine,
  restoreTerminalViewportOnResize,
  applyTerminalFontFamily,
  attachTerminalInputForwarding,
  captureTerminalContextMenuState,
  encodeTerminalInputChunks,
  handleTerminalServerMessage,
  forceTerminalFontMeasurement,
  focusTerminalFromTouchRelease,
  forwardTerminalData,
  loadOptionalTerminalWebglAddon,
  loadTerminalWebglRenderer,
  observeTerminalFontLoading,
  shouldFocusTerminalAfterAsyncMount,
  startTerminalTouchFocusGesture,
  subscribeToTerminalUserInput,
  TERMINAL_ALLOW_PROPOSED_API,
  TERMINAL_FONT_FAMILY,
  resolveTerminalFontFamily,
  writeTerminalOutput,
  writeRetainedTerminalOutput,
  updateTerminalTouchFocusGesture,
} from "./ThreadTerminalView";
import {
  createTerminalOsc8LinkHandler,
  requestTerminalLinkOpen,
} from "./terminal-links";
import {
  createTerminalViewportReplaySaveGate,
  createTerminalViewportPersistence,
  createTerminalTouchViewportSaveScheduler,
  createTerminalOutputLineAnchorTracker,
  registerTerminalOutputBoundaryHandler,
  readTerminalViewportAnchor,
  resolveTerminalViewportRestore,
  startTerminalOutputReplay,
  terminalViewportStorageKey,
  writeTerminalViewportAnchor,
} from "./terminal-viewport";

function outputAnchor(sequence: number, line: number, disposed = false) {
  return { sequence, line, expired: disposed };
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}
import {
  createEmptyFixedPanelTabsState,
  createTerminalFixedPanelTab,
  parseFixedPanelTabsState,
  serializeFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs-state";
import {
  createSidebarSplitState,
  moveSidebarTab,
  parseSidebarSplitState,
  resizeSidebarSplit,
  serializeSidebarSplitState,
} from "@/components/secondary-panel/sidebarSplitLayout";

describe("terminal hyperlinks", () => {
  it("preserves OSC-8 provenance through hover and primary activation", () => {
    const onActivate = vi.fn();
    const onHover = vi.fn();
    const handler = createTerminalOsc8LinkHandler({
      onActivate,
      onHover,
    });
    const event = { button: 0 } as MouseEvent;
    const range = {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    };

    handler.hover?.(event, "https://example.com/authorize", range);
    handler.activate(event, "https://example.com/authorize", range);
    handler.leave?.(event, "https://example.com/authorize", range);

    expect(onActivate).toHaveBeenCalledWith({
      source: "osc8",
      uri: "https://example.com/authorize",
    });
    expect(onHover).toHaveBeenNthCalledWith(1, {
      source: "osc8",
      uri: "https://example.com/authorize",
    });
    expect(onHover).toHaveBeenNthCalledWith(2, null);
  });

  it("does not activate OSC-8 links from a secondary click", () => {
    const onActivate = vi.fn();
    const handler = createTerminalOsc8LinkHandler({
      onActivate,
      onHover: vi.fn(),
    });
    const range = {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    };

    handler.activate(
      { button: 2 } as MouseEvent,
      "https://example.com/right-click",
      range,
    );

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("confirms concealed targets and directly opens detected URLs", () => {
    const openLink = vi.fn();
    const requestConfirmation = vi.fn();

    requestTerminalLinkOpen({
      openLink,
      requestConfirmation,
      target: { source: "osc8", uri: "https://example.com/concealed" },
    });
    requestTerminalLinkOpen({
      openLink,
      requestConfirmation,
      target: {
        source: "detected-url",
        uri: "https://example.com/visible",
      },
    });

    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(requestConfirmation).toHaveBeenCalledWith({
      source: "osc8",
      uri: "https://example.com/concealed",
    });
    expect(openLink).toHaveBeenCalledOnce();
    expect(openLink).toHaveBeenCalledWith("https://example.com/visible");
  });

  it("preserves link actions while copying the exact xterm selection", () => {
    const getSelection = vi.fn(() => "  wrapped terminal selection\n");
    const link = {
      source: "detected-url" as const,
      uri: "https://example.com/visible",
    };

    expect(
      captureTerminalContextMenuState({
        link,
        terminal: { getSelection },
      }),
    ).toEqual({
      link,
      selectionText: "  wrapped terminal selection\n",
    });
    expect(getSelection).toHaveBeenCalledOnce();
  });
});

function startTouchFocusGesture() {
  const gesture = startTerminalTouchFocusGesture(
    [{ identifier: 1, x: 40, y: 80 }],
    100,
  );
  if (gesture === null) {
    throw new Error("Expected one touch to start a focus gesture");
  }
  return gesture;
}

describe("terminal async mount focus", () => {
  it("preserves focus that moved to the composer while xterm loaded", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("does not let an explicit request override a newer focus target", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("focuses an opened terminal when focus stayed on its trigger", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: false,
        isPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("preserves a composer that was focused before xterm started mounting", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: false,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("focuses the terminal when its initiating trigger unmounted", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: false,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("does not focus a terminal after its panel closes", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: false,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: false,
        isPanelOpen: false,
      }),
    ).toBe(false);
  });
});

describe("terminal viewport restore", () => {
  function createStorage() {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => {
      values.set(key, value);
    });
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem,
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    };
  }

  it("persists a per-terminal content anchor and restores its exact line", () => {
    const storage = createStorage();
    const key = terminalViewportStorageKey("terminal-a");

    writeTerminalViewportAnchor(storage, key, {
      distanceFromTail: 12,
      lineOffset: 3,
      outputSequence: 42,
    });

    const anchor = readTerminalViewportAnchor(storage, key);
    expect(anchor).toEqual({
      distanceFromTail: 12,
      lineOffset: 3,
      outputSequence: 42,
    });
    expect(
      resolveTerminalViewportRestore({
        anchor,
        baseY: 80,
        outputLineAnchors: [outputAnchor(42, 51)],
        replayNextSequence: 50,
        replayStartSequence: 20,
      }),
    ).toBe(54);
  });

  it("restores the same content line when 500 newer lines replay", () => {
    expect(
      resolveTerminalViewportRestore({
        anchor: {
          distanceFromTail: 18,
          lineOffset: 2,
          outputSequence: 64,
        },
        baseY: 600,
        outputLineAnchors: [outputAnchor(64, 310)],
        replayNextSequence: 565,
        replayStartSequence: 50,
      }),
    ).toBe(312);
  });

  it("restores a retained client anchor after a server restart replay starts later", () => {
    expect(
      resolveTerminalViewportRestore({
        anchor: {
          distanceFromTail: 1200,
          lineOffset: 8,
          outputSequence: 10,
        },
        baseY: 3213,
        outputLineAnchors: [outputAnchor(10, 132)],
        replayNextSequence: 5353,
        replayStartSequence: 5274,
      }),
    ).toBe(140);
  });

  it("restores the observed phone anchor when replay contains its sequence", async () => {
    const terminal = new Terminal({ cols: 80, rows: 52, scrollback: 10_000 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    const outputLineAnchors: NonNullable<
      ReturnType<typeof tracker.recordOutputStart>
    >[] = [];
    tracker.reset();
    const chunks = [
      {
        seq: 0,
        data: new TextEncoder().encode(
          `${Array.from({ length: 3_000 }, (_, index) => `line ${String(index + 1).padStart(5, "0")}\r\n`).join("")}`,
        ),
      },
      ...Array.from({ length: 16 }, (_, index) => ({
        seq: index + 1,
        data: new Uint8Array(),
      })),
    ];
    await writeRetainedTerminalOutput({
      chunks,
      lastNotice: { current: null },
      session: {
        id: "term_phone_replay",
        threadId: "thr_1",
        environmentId: "env_1",
        hostId: "host_1",
        title: "Terminal",
        initialCwd: "/workspace",
        cols: 80,
        rows: 52,
        status: "exited",
        exitCode: null,
        closeReason: "daemon-disconnect",
        createdAt: 1,
        updatedAt: 1,
        lastUserInputAt: null,
      } satisfies TerminalSession,
      terminal,
      pipeline,
      onOutputStart: (sequence) => {
        const anchor = tracker.recordOutputStart(sequence);
        if (anchor) outputLineAnchors.push(anchor);
      },
    });

    const restoreLine = resolveTerminalViewportRestore({
      anchor: {
        distanceFromTail: 1_472,
        lineOffset: 1_473,
        outputSequence: 0,
      },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors,
      replayStartSequence: 0,
      replayNextSequence: 17,
    });
    terminal.scrollToLine(restoreLine);

    expect(restoreLine).toBe(1_473);
    expect(
      terminal.buffer.active.getLine(restoreLine)?.translateToString(true),
    ).toBe("line 01474");
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps the exact saved phone line when replay completion applies the PTY grid afterward", async () => {
    const terminal = new Terminal({ cols: 80, rows: 52, scrollback: 10_000 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    const outputLineAnchors: NonNullable<
      ReturnType<typeof tracker.recordOutputStart>
    >[] = [];
    tracker.reset();
    await writeRetainedTerminalOutput({
      chunks: [
        {
          seq: 0,
          data: new TextEncoder().encode(
            Array.from(
              { length: 9 },
              (_, i) => `line ${String(i + 1).padStart(5, "0")}\r\n`,
            ).join(""),
          ),
        },
        {
          seq: 1,
          data: new TextEncoder().encode(
            Array.from(
              { length: 515 },
              (_, i) => `line ${String(i + 10).padStart(5, "0")}\r\n`,
            ).join(""),
          ),
        },
        {
          seq: 2,
          data: new TextEncoder().encode(
            Array.from(
              { length: 1_313 },
              (_, i) => `line ${String(i + 525).padStart(5, "0")}\r\n`,
            ).join(""),
          ),
        },
        {
          seq: 3,
          data: new TextEncoder().encode(
            Array.from(
              { length: 341 },
              (_, i) => `line ${String(i + 1_838).padStart(5, "0")}\r\n`,
            ).join(""),
          ),
        },
        {
          seq: 4,
          data: new TextEncoder().encode(
            Array.from(
              { length: 682 },
              (_, i) => `line ${String(i + 2_179).padStart(5, "0")}\r\n`,
            ).join(""),
          ),
        },
        {
          seq: 5,
          data: new TextEncoder().encode(
            Array.from(
              { length: 140 },
              (_, i) => `line ${String(i + 2_861).padStart(5, "0")}\r\n`,
            ).join(""),
          ),
        },
        {
          seq: 6,
          data: new TextEncoder().encode("\u001b[?2004h\u001b]0;terminal: $ "),
        },
        { seq: 7, data: new Uint8Array() },
        { seq: 8, data: new TextEncoder().encode("\r\u001b[Kterminal: $ ") },
      ],
      lastNotice: { current: null },
      session: {
        id: "term_phone_resize_replay",
        threadId: "thr_1",
        environmentId: "env_1",
        hostId: "host_1",
        title: "Terminal",
        initialCwd: "/workspace",
        cols: 80,
        rows: 52,
        status: "running",
        exitCode: null,
        closeReason: null,
        createdAt: 1,
        updatedAt: 1,
        lastUserInputAt: null,
      } satisfies TerminalSession,
      terminal,
      pipeline,
      onOutputStart: (sequence) => {
        const anchor = tracker.recordOutputStart(sequence);
        if (anchor) outputLineAnchors.push(anchor);
      },
    });
    expect(outputLineAnchors.find(({ sequence }) => sequence === 2)?.line).toBe(
      524,
    );
    expect(terminal.buffer.active.baseY).toBe(2_949);

    await new Promise<void>((resolve) => {
      applyTerminalGridBeforeViewportRestore({
        pipeline,
        cols: 80,
        rows: 22,
        onGridApplied: () => {},
        restoreViewport: () => {
          const restoreLine = resolveTerminalViewportRestore({
            anchor: {
              distanceFromTail: 30,
              lineOffset: 2_396,
              outputSequence: 2,
            },
            baseY: terminal.buffer.active.baseY,
            outputLineAnchors,
            replayStartSequence: 0,
            replayNextSequence: 9,
          });
          terminal.scrollToLine(restoreLine);
        },
        afterRestore: resolve,
      });
    });

    expect(terminal.buffer.active.viewportY).toBe(2_920);
    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 02921");
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps replay output sequence markers at chunk starts while writes are queued", async () => {
    const terminal = new Terminal({ cols: 80, rows: 51, scrollback: 10_000 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    const outputLineAnchors: NonNullable<
      ReturnType<typeof tracker.recordOutputStart>
    >[] = [];
    const token = "replay-marker-test";
    tracker.reset();
    const markerHandler = registerTerminalOutputBoundaryHandler(
      terminal.parser,
      token,
      (sequence) => {
        const anchor = tracker.recordOutputStart(sequence);
        if (anchor) outputLineAnchors.push(anchor);
      },
    );
    const chunks = [
      { seq: 0, first: 1, count: 300 },
      { seq: 1, first: 301, count: 224 },
      { seq: 2, first: 525, count: 2_476 },
      ...Array.from({ length: 6 }, (_, index) => ({
        seq: index + 3,
        first: 0,
        count: 0,
      })),
    ];
    await Promise.all(
      chunks.map(
        ({ seq, first, count }) =>
          new Promise<void>((resolve) => {
            const data = Array.from(
              { length: count },
              (_, index) =>
                `line ${String(first + index).padStart(5, "0")}\r\n`,
            ).join("");
            writeTerminalOutput({
              data,
              isReplay: false,
              outputSequence: seq,
              outputBoundaryToken: token,
              onParsed: resolve,
              replayWriteState: { suppressedWriteCount: 0 },
              terminal,
              pipeline,
            });
          }),
      ),
    );

    const outputAnchor = outputLineAnchors.find(
      ({ sequence }) => sequence === 2,
    );
    expect(outputAnchor?.line).toBe(524);
    expect(terminal.buffer.active.baseY).toBe(2_950);
    const restoreLine = resolveTerminalViewportRestore({
      anchor: {
        distanceFromTail: 30,
        lineOffset: 2_396,
        outputSequence: 2,
      },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors,
      replayStartSequence: 0,
      replayNextSequence: 9,
    });
    terminal.scrollToLine(restoreLine);

    expect(restoreLine).toBe(2_920);
    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 02921");
    markerHandler.dispose();
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps a retained viewport marker when a reconnect replay starts later", async () => {
    const terminal = new Terminal({ cols: 80, rows: 52, scrollback: 10_000 });
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    const outputLineAnchors: NonNullable<
      ReturnType<typeof tracker.recordOutputStart>
    >[] = [];
    tracker.reset();
    const initialAnchor = tracker.recordOutputStart(0);
    if (initialAnchor) outputLineAnchors.push(initialAnchor);
    await writeTerminal(
      terminal,
      Array.from(
        { length: 3_000 },
        (_, index) => `line ${String(index + 1).padStart(5, "0")}\r\n`,
      ).join(""),
    );
    startTerminalOutputReplay({
      outputLineAnchors,
      sequence: 10,
      tracker,
    });
    await writeTerminal(terminal, "later replay data\r\n");
    const restoreLine = resolveTerminalViewportRestore({
      anchor: {
        distanceFromTail: 1_477,
        lineOffset: 1_473,
        outputSequence: 0,
      },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors,
      replayNextSequence: 17,
      replayStartSequence: 10,
    });
    terminal.scrollToLine(restoreLine);

    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 01474");
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps the observed replay anchor after a fit resize", async () => {
    const terminal = new Terminal({ cols: 80, rows: 52, scrollback: 10_000 });
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    const anchor = tracker.recordOutputStart(0)!;
    await writeTerminal(
      terminal,
      `${Array.from({ length: 3_000 }, (_, index) => `line ${String(index + 1).padStart(5, "0")}\r\n`).join("")}`,
    );
    const restoreLine = resolveTerminalViewportRestore({
      anchor: {
        distanceFromTail: 1_472,
        lineOffset: 1_473,
        outputSequence: 0,
      },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors: [anchor],
      replayStartSequence: 0,
      replayNextSequence: 17,
    });
    terminal.scrollToLine(restoreLine);

    terminal.resize(60, 24);
    terminal.resize(80, 52);

    expect(terminal.buffer.active.viewportY).toBe(1_473);
    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 01474");
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps the saved top line when the phone fit shrinks the replay grid", async () => {
    const terminal = new Terminal({ cols: 80, rows: 33, scrollback: 10_000 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    await writeTerminal(
      terminal,
      Array.from(
        { length: 1_023 },
        (_, index) => `line ${String(index + 1).padStart(5, "0")}\r\n`,
      ).join(""),
    );
    const anchor = tracker.recordOutputStart(3)!;
    await writeTerminal(
      terminal,
      Array.from(
        { length: 1_977 },
        (_, index) => `line ${String(index + 1_024).padStart(5, "0")}\r\n`,
      ).join(""),
    );
    const savedAnchor = {
      distanceFromTail: terminal.buffer.active.baseY - 1_100,
      lineOffset: 77,
      outputSequence: 3,
    };
    await new Promise<void>((resolve) => {
      applyTerminalGridBeforeViewportRestore({
        pipeline,
        cols: 80,
        rows: 56,
        fitGrid: { cols: 80, rows: 33 },
        onGridApplied: () => {},
        restoreViewport: () => {
          terminal.scrollToLine(
            resolveTerminalViewportRestore({
              anchor: savedAnchor,
              baseY: terminal.buffer.active.baseY,
              outputLineAnchors: [anchor],
              replayStartSequence: 1,
              replayNextSequence: 2,
            }),
          );
        },
        afterRestore: () => {
          if (terminal.rows !== 33) terminal.resize(80, 33);
          resolve();
        },
      });
    });

    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 01101");
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps the saved top line when a later fit changes the replay grid", async () => {
    const terminal = new Terminal({ cols: 80, rows: 33, scrollback: 10_000 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    const anchor = tracker.recordOutputStart(1)!;
    await writeTerminal(
      terminal,
      Array.from(
        { length: 3_000 },
        (_, index) => `line ${String(index + 1).padStart(5, "0")}\r\n`,
      ).join(""),
    );
    const savedAnchor = {
      distanceFromTail: terminal.buffer.active.baseY - 1_100,
      lineOffset: 1_100,
      outputSequence: 1,
    };
    terminal.scrollToLine(
      resolveTerminalViewportRestore({
        anchor: savedAnchor,
        baseY: terminal.buffer.active.baseY,
        outputLineAnchors: [anchor],
        replayStartSequence: 0,
        replayNextSequence: 8,
      }),
    );
    await new Promise<void>((resolve) => {
      applyTerminalGridAndKeepViewport({
        pipeline,
        cols: 80,
        rows: 56,
        onGridApplied: resolve,
        restoreViewport: () => {
          terminal.scrollToLine(
            resolveTerminalViewportRestore({
              anchor: savedAnchor,
              baseY: terminal.buffer.active.baseY,
              outputLineAnchors: [anchor],
              replayStartSequence: 0,
              replayNextSequence: 8,
            }),
          );
        },
      });
    });

    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 01101");
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps the saved line when the replay grid grows by 23 rows", async () => {
    const terminal = new Terminal({ cols: 80, rows: 33, scrollback: 10_000 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    await writeTerminal(
      terminal,
      Array.from(
        { length: 3_000 },
        (_, index) => `line ${String(index + 1).padStart(5, "0")}\r\n`,
      ).join(""),
    );
    const anchor = tracker.recordOutputStart(2)!;
    await writeTerminal(
      terminal,
      Array.from(
        { length: 3_000 },
        (_, index) => `line ${String(index + 3_001).padStart(5, "0")}\r\n`,
      ).join(""),
    );
    const savedAnchor = {
      distanceFromTail: terminal.buffer.active.baseY - 5_396,
      lineOffset: 2_396,
      outputSequence: 2,
    };
    terminal.scrollToLine(
      resolveTerminalViewportRestore({
        anchor: savedAnchor,
        baseY: terminal.buffer.active.baseY,
        outputLineAnchors: [anchor],
        replayStartSequence: 0,
        replayNextSequence: 16,
      }),
    );
    await new Promise<void>((resolve) => {
      applyTerminalGridAndKeepViewport({
        pipeline,
        cols: 80,
        rows: 56,
        onGridApplied: () => {},
        restoreViewport: () => {
          terminal.scrollToLine(
            resolveTerminalViewportRestore({
              anchor: savedAnchor,
              baseY: terminal.buffer.active.baseY,
              outputLineAnchors: [anchor],
              replayStartSequence: 0,
              replayNextSequence: 16,
            }),
          );
          resolve();
        },
      });
    });

    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 05397");
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps the saved line when another client resizes the terminal grid", async () => {
    const terminal = new Terminal({ cols: 80, rows: 56, scrollback: 10_000 });
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    const outputAnchor = tracker.recordOutputStart(0)!;
    await writeTerminal(
      terminal,
      Array.from(
        { length: 3_000 },
        (_, index) => `line ${String(index + 1).padStart(5, "0")}\r\n`,
      ).join(""),
    );
    const savedAnchor = {
      distanceFromTail: terminal.buffer.active.baseY - 1_100,
      lineOffset: 1_100,
      outputSequence: 0,
    };
    const restoreViewport = () => {
      terminal.scrollToLine(
        resolveTerminalViewportRestore({
          anchor: savedAnchor,
          baseY: terminal.buffer.active.baseY,
          outputLineAnchors: [outputAnchor],
          replayStartSequence: 0,
          replayNextSequence: 1,
        }),
      );
    };
    terminal.scrollToLine(1_100);
    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 01101");
    const viewportLineAnchor = createTerminalViewportLineAnchor(terminal);
    viewportLineAnchor.setLine(1_100);
    const pendingResizeFrame: { current: FrameRequestCallback | null } = {
      current: null,
    };
    const resizeSubscription = restoreTerminalViewportOnResize({
      terminal,
      canRestore: () => true,
      restoreViewport: () => {
        if (
          !restoreTerminalViewportToRetainedLine({
            terminal,
            lineAnchor: viewportLineAnchor,
          })
        ) {
          restoreViewport();
        }
      },
      requestFrame: (callback) => {
        pendingResizeFrame.current = callback;
        return 1;
      },
      cancelFrame: () => {
        pendingResizeFrame.current = null;
      },
    });

    terminal.resize(80, 33);
    pendingResizeFrame.current?.(0);

    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 01101");
    resizeSubscription.dispose();
    viewportLineAnchor.dispose();
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps the same output line when a companion size owner changes the shared grid", async () => {
    const terminal = new Terminal({ cols: 80, rows: 56, scrollback: 10_000 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    const outputAnchor = tracker.recordOutputStart(2)!;
    await writeTerminal(
      terminal,
      Array.from(
        { length: 3_000 },
        (_, index) =>
          `line ${String(index + 1).padStart(5, "0")} ${"x".repeat(54)}\r\n`,
      ).join(""),
    );
    const savedAnchor = {
      distanceFromTail: terminal.buffer.active.baseY - 2_396,
      lineOffset: 2_396,
      outputSequence: 2,
    };
    const viewportLineAnchor = createTerminalViewportLineAnchor(terminal);
    const restoreViewport = (afterGridResize = false) => {
      if (
        afterGridResize &&
        restoreTerminalViewportToRetainedLine({
          terminal,
          lineAnchor: viewportLineAnchor,
        })
      ) {
        return;
      }
      const line = resolveTerminalViewportRestore({
        anchor: savedAnchor,
        baseY: terminal.buffer.active.baseY,
        outputLineAnchors: [outputAnchor],
        replayStartSequence: 0,
        replayNextSequence: 16,
      });
      terminal.scrollToLine(line);
      viewportLineAnchor.setLine(line);
    };
    restoreViewport();
    const pendingResizeFrame: { current: FrameRequestCallback | null } = {
      current: null,
    };
    const resizeSubscription = restoreTerminalViewportOnResize({
      terminal,
      canRestore: () => true,
      restoreViewport: () => restoreViewport(true),
      requestFrame: (callback) => {
        pendingResizeFrame.current = callback;
        return 1;
      },
      cancelFrame: () => {
        pendingResizeFrame.current = null;
      },
    });

    await new Promise<void>((resolve) => {
      applyTerminalGridAndKeepViewport({
        pipeline,
        cols: 40,
        rows: 33,
        onGridApplied: resolve,
        restoreViewport: () => restoreViewport(true),
      });
    });
    pendingResizeFrame.current?.(0);

    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toMatch(/^line 02397 /);
    resizeSubscription.dispose();
    viewportLineAnchor.dispose();
    tracker.dispose();
    terminal.dispose();
  });

  it("keeps a saved marker live when the output anchor cap is exceeded", async () => {
    const terminal = new Terminal({ cols: 80, rows: 52, scrollback: 10_000 });
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    const outputLineAnchors: NonNullable<
      ReturnType<typeof tracker.recordOutputStart>
    >[] = [];
    tracker.reset();
    const outputAnchor = tracker.recordOutputStart(0)!;
    outputLineAnchors.push(outputAnchor);
    await writeTerminal(
      terminal,
      `${Array.from({ length: 3_000 }, (_, index) => `line ${String(index + 1).padStart(5, "0")}\r\n`).join("")}`,
    );
    const savedOutputLineAnchor = tracker.updatePinnedAnchor(
      null,
      outputAnchor,
      outputLineAnchors,
    )!;

    for (let sequence = 1; sequence <= 4_097; sequence += 1) {
      const outputAnchor = tracker.recordOutputStart(sequence);
      if (outputAnchor) outputLineAnchors.push(outputAnchor);
      if (outputLineAnchors.length > 4_096) {
        const removed = outputLineAnchors.splice(
          0,
          outputLineAnchors.length - 4_096,
        );
        tracker.forget(removed);
      }
    }

    const restoreLine = resolveTerminalViewportRestore({
      anchor: {
        distanceFromTail: 0,
        lineOffset: 1_473,
        outputSequence: 0,
      },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors: [...outputLineAnchors, savedOutputLineAnchor],
      replayStartSequence: 0,
      replayNextSequence: 4_098,
    });
    terminal.scrollToLine(restoreLine);

    expect(savedOutputLineAnchor.expired).toBe(false);
    expect(
      terminal.buffer.active.getLine(restoreLine)?.translateToString(true),
    ).toBe("line 01474");
    tracker.dispose();
    terminal.dispose();
  });

  it("restores an anchor in a middle chunk after replaying many small chunks", async () => {
    const terminal = new Terminal({ cols: 40, rows: 3, scrollback: 100 });
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    const anchors = [tracker.recordOutputStart(0)!];

    for (let sequence = 0; sequence < 20; sequence += 1) {
      await writeTerminal(
        terminal,
        `line ${String(sequence).padStart(5, "0")}\r\n`,
      );
      anchors.push(tracker.recordOutputStart(sequence + 1)!);
    }

    const restoreLine = resolveTerminalViewportRestore({
      anchor: { distanceFromTail: 10, lineOffset: 0, outputSequence: 8 },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors: anchors,
      replayNextSequence: 20,
      replayStartSequence: 0,
    });
    terminal.scrollToLine(restoreLine);

    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 00008");
    tracker.dispose();
    terminal.dispose();
  });

  it("restores to the oldest retained line when the saved marker is trimmed", async () => {
    const terminal = new Terminal({ cols: 40, rows: 3, scrollback: 10 });
    await writeTerminal(
      terminal,
      `${Array.from({ length: 12 }, (_, index) => `line ${String(index).padStart(5, "0")}\r\n`).join("")}line 00012`,
    );
    const markers: ReturnType<Terminal["registerMarker"]>[] = [];
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => {
        const marker = terminal.registerMarker();
        if (marker) markers.push(marker);
        return marker;
      },
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    const anchor = tracker.recordOutputStart(10);
    expect(anchor).toBeDefined();
    await writeTerminal(
      terminal,
      `\r\n${Array.from({ length: 30 }, (_, index) => `line ${String(index + 13).padStart(5, "0")}\r\n`).join("")}`,
    );
    const firstRetainedLine = terminal.buffer.active
      .getLine(0)
      ?.translateToString(true);
    const line = resolveTerminalViewportRestore({
      anchor: { distanceFromTail: 20, lineOffset: 8, outputSequence: 10 },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors: [anchor!],
      replayNextSequence: 11,
      replayStartSequence: 0,
    });

    expect(markers[0]?.isDisposed).toBe(true);
    expect(anchor?.expired).toBe(true);
    expect(line).toBe(0);
    terminal.scrollToLine(line);
    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe(firstRetainedLine);
    tracker.dispose();
    terminal.dispose();
  });

  it("restores a retained marker to the same content after scrollback trimming", async () => {
    const terminal = new Terminal({ cols: 40, rows: 3, scrollback: 1250 });
    const markers: ReturnType<Terminal["registerMarker"]>[] = [];
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => {
        const marker = terminal.registerMarker();
        if (marker) markers.push(marker);
        return marker;
      },
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    tracker.recordOutputStart(10);
    await writeTerminal(
      terminal,
      Array.from(
        { length: 1234 },
        (_, index) => `line ${String(index).padStart(5, "0")}\r\n`,
      ).join(""),
    );
    const anchor = tracker.recordOutputStart(11);
    expect(anchor).toBeDefined();
    await writeTerminal(terminal, "line 01234");
    await writeTerminal(
      terminal,
      `\r\n${Array.from({ length: 40 }, (_, index) => `line ${String(index + 1235).padStart(5, "0")}\r\n`).join("")}`,
    );
    const line = resolveTerminalViewportRestore({
      anchor: { distanceFromTail: 40, lineOffset: 0, outputSequence: 11 },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors: [anchor!],
      replayNextSequence: 12,
      replayStartSequence: 0,
    });
    terminal.scrollToLine(line);

    expect(anchor?.line).toBeGreaterThanOrEqual(0);
    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 01234");
    tracker.dispose();
    terminal.dispose();
  });

  it("uses one marker for many output sequence anchors", () => {
    const terminal = new Terminal({ cols: 40, rows: 3 });
    const registerMarker = vi.fn(() => terminal.registerMarker());
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker,
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });

    tracker.reset();
    for (let sequence = 0; sequence < 4096; sequence += 1) {
      tracker.recordOutputStart(sequence);
    }

    expect(registerMarker).toHaveBeenCalledOnce();
    tracker.dispose();
    terminal.dispose();
  });

  it("restores the saved marker after a server restart with later replay sequences", async () => {
    const terminal = new Terminal({ cols: 40, rows: 3, scrollback: 1000 });
    await writeTerminal(
      terminal,
      `${Array.from({ length: 132 }, (_, index) => `line ${String(index).padStart(5, "0")}\r\n`).join("")}line 00132`,
    );
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    tracker.reset();
    const markerAnchor = tracker.recordOutputStart(10);
    expect(markerAnchor).toBeDefined();
    await writeTerminal(
      terminal,
      `\r\n${Array.from({ length: 20 }, (_, index) => `line ${String(index + 133).padStart(5, "0")}\r\n`).join("")}`,
    );
    const lineOffset = 0;
    const restoreLine = resolveTerminalViewportRestore({
      anchor: { distanceFromTail: 100, lineOffset, outputSequence: 10 },
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors: [markerAnchor!],
      replayNextSequence: 5353,
      replayStartSequence: 5274,
    });
    terminal.scrollToLine(restoreLine);

    expect(
      terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY)
        ?.translateToString(true),
    ).toBe("line 00132");
    tracker.dispose();
    terminal.dispose();
  });

  it("restores an old negative line offset to the chunk start", () => {
    expect(
      resolveTerminalViewportRestore({
        anchor: {
          distanceFromTail: 18,
          lineOffset: -2,
          outputSequence: 64,
        },
        baseY: 600,
        outputLineAnchors: [outputAnchor(64, 310)],
        replayNextSequence: 565,
        replayStartSequence: 50,
      }),
    ).toBe(310);
  });

  it("restores to the top of replay when the anchored chunk expired", () => {
    expect(
      resolveTerminalViewportRestore({
        anchor: {
          distanceFromTail: 18,
          lineOffset: -2,
          outputSequence: 16,
        },
        baseY: 100,
        outputLineAnchors: [outputAnchor(17, 8)],
        replayNextSequence: 30,
        replayStartSequence: 17,
      }),
    ).toBe(0);
  });

  it("uses tail distance only when sequence numbering reset", () => {
    expect(
      resolveTerminalViewportRestore({
        anchor: {
          distanceFromTail: 12,
          lineOffset: -1,
          outputSequence: 42,
        },
        baseY: 80,
        outputLineAnchors: [outputAnchor(3, 5)],
        replayNextSequence: 8,
        replayStartSequence: 0,
      }),
    ).toBe(68);
  });

  it("restores the saved viewport after a reconnect replay", () => {
    const storage = createStorage();
    const key = terminalViewportStorageKey("terminal-a");
    const anchor = { distanceFromTail: 18, outputSequence: 64 };
    writeTerminalViewportAnchor(storage, key, anchor);
    const replaySaveGate = createTerminalViewportReplaySaveGate();

    replaySaveGate.finishRestore();
    replaySaveGate.beginReplay();
    expect(replaySaveGate.canSave(true)).toBe(false);
    const restoreLine = resolveTerminalViewportRestore({
      anchor: readTerminalViewportAnchor(storage, key),
      baseY: 100,
      outputLineAnchors: [outputAnchor(64, 84)],
      replayNextSequence: 80,
      replayStartSequence: 0,
    });
    replaySaveGate.finishRestore();

    expect(restoreLine).toBe(84);
    expect(replaySaveGate.canSave(false)).toBe(false);
    expect(replaySaveGate.canSave(true)).toBe(true);
  });

  it("does not replace a saved anchor with replay scroll events", () => {
    const storage = createStorage();
    const key = terminalViewportStorageKey("terminal-a");
    const anchor = { distanceFromTail: 18, outputSequence: 64 };
    writeTerminalViewportAnchor(storage, key, anchor);
    const persistence = createTerminalViewportPersistence({ storage, key });
    const replaySaveGate = createTerminalViewportReplaySaveGate();

    replaySaveGate.beginReplay();
    if (replaySaveGate.canSave(true)) {
      persistence.schedule({ distanceFromTail: 0, outputSequence: 0 });
    }
    persistence.flush();

    expect(readTerminalViewportAnchor(storage, key)).toEqual(anchor);
    replaySaveGate.finishRestore();
    if (replaySaveGate.canSave(false)) {
      persistence.schedule({ distanceFromTail: 0, outputSequence: 0 });
    }
    expect(readTerminalViewportAnchor(storage, key)).toEqual(anchor);
    if (replaySaveGate.canSave(true)) {
      persistence.schedule({ distanceFromTail: 15, outputSequence: 70 });
    }
    persistence.flush();

    expect(readTerminalViewportAnchor(storage, key)).toEqual({
      distanceFromTail: 15,
      outputSequence: 70,
    });
  });

  it.each(["wheel", "touchmove"] as const)(
    "saves an anchor when an inner element stops %s propagation",
    (eventType) => {
      const storage = createStorage();
      const key = terminalViewportStorageKey(`terminal-${eventType}`);
      const persistence = createTerminalViewportPersistence({ storage, key });
      const replaySaveGate = createTerminalViewportReplaySaveGate();
      const listeners: Array<{
        type: string;
        listener: EventListenerOrEventListenerObject;
        capture: boolean;
      }> = [];
      const parent = {
        addEventListener: vi.fn((type, listener, options) => {
          const capture =
            typeof options === "boolean"
              ? options
              : (options?.capture ?? false);
          listeners.push({ type, listener, capture });
        }),
        removeEventListener: vi.fn(),
      } as unknown as HTMLElement;
      let hasManualScrollIntent = false;
      attachTerminalManualScrollIntentListeners(
        parent,
        () => (hasManualScrollIntent = true),
      );
      replaySaveGate.finishRestore();

      let propagationStopped = false;
      const event = {
        type: eventType,
        stopPropagation: () => {
          propagationStopped = true;
        },
      } as unknown as Event;
      for (const entry of listeners.filter(
        (listener) => listener.type === eventType && listener.capture,
      )) {
        typeof entry.listener === "function"
          ? entry.listener(event)
          : entry.listener.handleEvent(event);
      }
      const stopPropagationAtInnerElement = (innerEvent: Event) =>
        innerEvent.stopPropagation();
      stopPropagationAtInnerElement(event);
      if (!propagationStopped) {
        for (const entry of listeners.filter(
          (listener) => listener.type === eventType && !listener.capture,
        )) {
          typeof entry.listener === "function"
            ? entry.listener(event)
            : entry.listener.handleEvent(event);
        }
      }
      if (replaySaveGate.canSave(hasManualScrollIntent)) {
        persistence.schedule({ distanceFromTail: 12, outputSequence: 42 });
      }
      persistence.flush();

      expect(
        listeners.find(
          (listener) => listener.type === eventType && listener.capture,
        ),
      ).toBeDefined();
      expect(propagationStopped).toBe(true);
      expect(storage.getItem(key)).not.toBeNull();
    },
  );

  it("saves a touch scroll after xterm updates its viewport", () => {
    let viewportY = 100;
    const frames = new Map<number, () => void>();
    let nextFrame = 0;
    const save = vi.fn();
    const scheduler = createTerminalTouchViewportSaveScheduler({
      getViewportY: () => viewportY,
      requestFrame: (callback) => {
        const handle = ++nextFrame;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => frames.delete(handle),
      save,
    });

    scheduler.schedule();
    viewportY = 84;
    [...frames.values()].forEach((callback) => callback());

    expect(save).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("does not save a touch gesture that leaves the viewport unchanged", () => {
    const frames = new Map<number, () => void>();
    let nextFrame = 0;
    const save = vi.fn();
    const scheduler = createTerminalTouchViewportSaveScheduler({
      getViewportY: () => 100,
      requestFrame: (callback) => {
        const handle = ++nextFrame;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => frames.delete(handle),
      save,
    });

    scheduler.schedule();
    [...frames.values()].forEach((callback) => callback());

    expect(save).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("keeps anchors isolated by terminal session", () => {
    expect(terminalViewportStorageKey("terminal-a")).not.toBe(
      terminalViewportStorageKey("terminal-b"),
    );
  });

  it("coalesces 1,000 scroll updates and flushes the latest anchor on unmount", () => {
    vi.useFakeTimers();
    try {
      const storage = createStorage();
      const key = terminalViewportStorageKey("terminal-a");
      const persistence = createTerminalViewportPersistence({ storage, key });

      for (let event = 0; event < 1_000; event += 1) {
        persistence.schedule({
          distanceFromTail: 1_000 - event,
          outputSequence: 42,
        });
      }

      expect(storage.setItem).not.toHaveBeenCalled();
      persistence.dispose();

      expect(storage.setItem).toHaveBeenCalledTimes(2);
      expect(readTerminalViewportAnchor(storage, key)).toEqual({
        distanceFromTail: 1,
        outputSequence: 42,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the 200 newest terminal anchors", () => {
    const storage = createStorage();
    for (let terminal = 1; terminal <= 201; terminal += 1) {
      writeTerminalViewportAnchor(
        storage,
        terminalViewportStorageKey(`terminal-${terminal}`),
        { distanceFromTail: terminal, outputSequence: terminal },
      );
    }

    expect(
      readTerminalViewportAnchor(
        storage,
        terminalViewportStorageKey("terminal-1"),
      ),
    ).toBeNull();
    expect(
      readTerminalViewportAnchor(
        storage,
        terminalViewportStorageKey("terminal-201"),
      ),
    ).toEqual({ distanceFromTail: 201, outputSequence: 201 });
    expect(storage.length).toBe(201);
  });

  it("restores the selected terminal and resized split with its viewport anchor", () => {
    const terminalA = createTerminalFixedPanelTab({ terminalId: "terminal-a" });
    const terminalB = createTerminalFixedPanelTab({ terminalId: "terminal-b" });
    const fixedTabs = createEmptyFixedPanelTabsState({
      lastUsedAt: 1_700_000_000_000,
      secondary: {
        activeTabId: terminalB.id,
        isOpen: true,
        tabs: [terminalA, terminalB],
      },
    });
    const restoredTabs = parseFixedPanelTabsState({
      initialValue: createEmptyFixedPanelTabsState({ lastUsedAt: 0 }),
      now: 1_700_000_000_000,
      storedValue: serializeFixedPanelTabsState({ state: fixedTabs }),
    });

    const initialSplit = createSidebarSplitState(
      [terminalA.id, terminalB.id],
      terminalA.id,
    );
    const split = moveSidebarTab(
      initialSplit,
      initialSplit.layout.focusedPaneId,
      terminalB.id,
      { paneId: initialSplit.layout.focusedPaneId, zone: "right" },
      { groupId: "terminal-b" },
    );
    const resizedSplit = resizeSidebarSplit(split, [], 0, 0.65);
    const restoredSplit = parseSidebarSplitState(
      serializeSidebarSplitState(resizedSplit),
      [terminalA.id, terminalB.id],
      restoredTabs.secondary.activeTabId ?? terminalA.id,
    );
    const storage = createStorage();
    const viewportKey = terminalViewportStorageKey("terminal-a");
    writeTerminalViewportAnchor(storage, viewportKey, {
      distanceFromTail: 15,
      outputSequence: 42,
    });

    expect(restoredTabs.secondary.activeTabId).toBe(terminalB.id);
    expect(restoredSplit.layout.root).toMatchObject({
      type: "split",
      sizes: [0.65, 0.35],
    });
    expect(
      resolveTerminalViewportRestore({
        anchor: readTerminalViewportAnchor(storage, viewportKey),
        baseY: 90,
        outputLineAnchors: [outputAnchor(24, 80)],
        replayNextSequence: 40,
        replayStartSequence: 20,
      }),
    ).toBe(75);
  });
});

describe("terminal touch focus", () => {
  it("focuses the terminal after a tap", () => {
    const focus = vi.fn();

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 43, y: 84 }],
        focus,
        gesture: startTouchFocusGesture(),
        releasedAt: 200,
        remainingTouchCount: 0,
      }),
    ).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not focus after a drag returns near its start", () => {
    const focus = vi.fn();
    const gesture = updateTerminalTouchFocusGesture(startTouchFocusGesture(), [
      { identifier: 1, x: 40, y: 120 },
    ]);

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 40, y: 81 }],
        focus,
        gesture,
        releasedAt: 200,
        remainingTouchCount: 0,
      }),
    ).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not focus after a long press", () => {
    const focus = vi.fn();

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 40, y: 80 }],
        focus,
        gesture: startTouchFocusGesture(),
        releasedAt: 800,
        remainingTouchCount: 0,
      }),
    ).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("invalidates the gesture when another touch starts", () => {
    expect(
      updateTerminalTouchFocusGesture(startTouchFocusGesture(), [
        { identifier: 1, x: 40, y: 80 },
        { identifier: 2, x: 80, y: 80 },
      ]),
    ).toBeNull();
  });
});

describe("terminal output encoding", () => {
  it("sizes the xterm to the attached PTY before writing legacy output", async () => {
    const terminal = new Terminal({ cols: 120, rows: 36 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const session = {
      id: "term_attach_grid",
      threadId: "thr_1",
      environmentId: "env_1",
      hostId: "host_1",
      title: "Terminal",
      initialCwd: "/workspace",
      cols: 55,
      rows: 56,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    } satisfies TerminalSession;

    handleTerminalServerMessage({
      acknowledgeOutput: vi.fn(),
      message: { type: "attached", session, nextSeq: 0, replayStartSeq: 0 },
      onReplayComplete: vi.fn(),
      replayNextSeq: null,
      replayWriteState: { suppressedWriteCount: 0 },
      setReplayNextSeq: vi.fn(),
      terminal,
      pipeline,
    });

    let resolveParsed!: () => void;
    const outputParsed = new Promise<void>((resolve) => {
      resolveParsed = resolve;
    });
    handleTerminalServerMessage({
      acknowledgeOutput: resolveParsed,
      message: {
        type: "output",
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("attached output").toString("base64"),
        },
      },
      onReplayComplete: vi.fn(),
      replayNextSeq: null,
      replayWriteState: { suppressedWriteCount: 0 },
      setReplayNextSeq: vi.fn(),
      terminal,
      pipeline,
    });
    await outputParsed;
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({
      cols: 55,
      rows: 56,
    });
    expect(terminal.buffer.active.getLine(0)?.translateToString()).toContain(
      "attached output",
    );
    terminal.dispose();
  });

  it("applies replayed grid markers before parsing the following bytes for two clients", async () => {
    const clients = [
      new Terminal({ cols: 18, rows: 5 }),
      new Terminal({ cols: 80, rows: 24 }),
    ];
    const pipelines = clients.map((terminal) =>
      createTerminalOutputPipeline(terminal),
    );
    const firstMarker = createTerminalGridMarker({ cols: 51, rows: 16 });
    const secondMarker = createTerminalGridMarker({ cols: 82, rows: 27 });
    const firstBytes = `${firstMarker}${"A".repeat(51)}\r\n`;
    const secondBytes = `${secondMarker}${"B".repeat(82)}\r\n`;
    await Promise.all(
      pipelines.map(
        (pipeline) =>
          new Promise<void>((resolve) =>
            pipeline.push(Buffer.from(firstBytes), resolve),
          ),
      ),
    );
    await Promise.all(
      pipelines.map(
        (pipeline) =>
          new Promise<void>((resolve) =>
            pipeline.push(Buffer.from(secondBytes), resolve),
          ),
      ),
    );

    for (const terminal of clients) {
      expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({
        cols: 82,
        rows: 27,
      });
      const rendered = Array.from(
        { length: terminal.buffer.active.length },
        (_, index) =>
          terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n");
      expect(rendered).toContain("A".repeat(51));
      expect(rendered).toContain("B".repeat(82));
      terminal.dispose();
    }
  });

  it("strips historical grid markers without resizing the live renderer", async () => {
    const terminal = new Terminal({ cols: 51, rows: 47 });
    const onGrid = vi.fn();
    const pipeline = createTerminalOutputPipeline(terminal, onGrid);
    const marker = Buffer.from(
      createTerminalGridMarker({ cols: 135, rows: 56 }),
    );
    const splitAt = Math.floor(marker.length / 2);

    pipeline.push(marker.subarray(0, splitAt), vi.fn(), false);
    await new Promise<void>((resolve) =>
      pipeline.push(
        Buffer.concat([
          marker.subarray(splitAt),
          Buffer.from("retained output"),
        ]),
        resolve,
        true,
      ),
    );

    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({
      cols: 51,
      rows: 47,
    });
    expect(onGrid).toHaveBeenCalledWith({ cols: 135, rows: 56 }, false);
    expect(
      Array.from({ length: terminal.buffer.active.length }, (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
    ).toContain("retained output");
    terminal.dispose();
  });

  it("keeps a newer grid when xterm parses it inside an earlier resize", async () => {
    const terminal = new Terminal({ cols: 30, rows: 6 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const markerA = createTerminalGridMarker({ cols: 120, rows: 36 });
    const markerB = createTerminalGridMarker({ cols: 55, rows: 12 });
    const chunks = [markerA, "A", markerB, "B".repeat(55)];
    let parsedChunks = 0;
    let resolveParsed!: () => void;
    const allParsed = new Promise<void>((resolve) => {
      resolveParsed = resolve;
    });
    for (const [seq, data] of chunks.entries()) {
      handleTerminalServerMessage({
        acknowledgeOutput: () => {
          parsedChunks += 1;
          if (parsedChunks === chunks.length) resolveParsed();
        },
        message: {
          type: "output",
          chunk: {
            seq,
            dataBase64: Buffer.from(data).toString("base64"),
          },
        },
        onReplayComplete: vi.fn(),
        replayNextSeq: null,
        replayWriteState: { suppressedWriteCount: 0 },
        setReplayNextSeq: vi.fn(),
        terminal,
        pipeline,
      });
    }
    await allParsed;

    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({
      cols: 55,
      rows: 12,
    });
    const rendered = Array.from(
      { length: terminal.buffer.active.length },
      (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(rendered).toContain("A");
    expect([...rendered].filter((character) => character === "B")).toHaveLength(
      55,
    );
    terminal.dispose();
  });

  it("waits for prior writes before resizing at a grid marker", async () => {
    const writeCallbacks: Array<() => void> = [];
    const resize = vi.fn();
    const pipeline = createTerminalOutputPipeline({
      resize,
      write: (_data, callback) => writeCallbacks.push(callback),
    });
    const afterResize = vi.fn();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    pipeline.push(
      Buffer.from(
        `before${createTerminalGridMarker({ cols: 51, rows: 12 })}after`,
      ),
      finish,
    );
    await Promise.resolve();

    expect(resize).not.toHaveBeenCalled();
    expect(writeCallbacks).toHaveLength(1);
    writeCallbacks.shift()?.();
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith(51, 12));
    expect(writeCallbacks).toHaveLength(1);
    writeCallbacks.shift()?.();
    await finished;
    pipeline.setGrid(51, 12, afterResize);
    await vi.waitFor(() => expect(afterResize).toHaveBeenCalledOnce());
  });

  it("keeps the replay-completion reveal callback when queued grids collapse", async () => {
    const writeCallbacks: Array<() => void> = [];
    const resize = vi.fn();
    const pipeline = createTerminalOutputPipeline({
      resize,
      write: (_data, callback) => writeCallbacks.push(callback),
    });
    const reveal = vi.fn();

    pipeline.push(Buffer.from("pending replay output"), () => undefined);
    await Promise.resolve();
    pipeline.push(
      Buffer.from(createTerminalGridMarker({ cols: 51, rows: 47 })),
      () => undefined,
    );
    pipeline.setGrid(51, 47, reveal);
    pipeline.push(
      Buffer.from(createTerminalGridMarker({ cols: 51, rows: 48 })),
      () => undefined,
    );
    writeCallbacks.shift()?.();

    await vi.waitFor(() => expect(reveal).toHaveBeenCalledOnce());
    expect(resize).toHaveBeenLastCalledWith(51, 48);
  });

  it("splits markers across output chunks before writing them to xterm", async () => {
    const terminal = new Terminal({ cols: 30, rows: 6 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const markerBytes = Buffer.from(
      createTerminalGridMarker({ cols: 51, rows: 12 }),
    );
    const splitAt = Math.floor(markerBytes.length / 2);
    await Promise.all([
      new Promise<void>((resolve) =>
        pipeline.push(
          Buffer.concat([
            Buffer.from("before"),
            markerBytes.subarray(0, splitAt),
          ]),
          resolve,
        ),
      ),
      new Promise<void>((resolve) =>
        pipeline.push(
          Buffer.concat([markerBytes.subarray(splitAt), Buffer.from("after")]),
          resolve,
        ),
      ),
    ]);
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({
      cols: 51,
      rows: 12,
    });
    const rendered = Array.from(
      { length: terminal.buffer.active.length },
      (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(rendered).toContain("beforeafter");
    terminal.dispose();
  });

  it("uses each grid around two markers in one chunk", async () => {
    const terminal = new Terminal({ cols: 30, rows: 6 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const input = `${createTerminalGridMarker({ cols: 12, rows: 5 })}A${"a".repeat(11)}\r\n${createTerminalGridMarker({ cols: 22, rows: 8 })}B${"b".repeat(21)}`;
    await new Promise<void>((resolve) =>
      pipeline.push(Buffer.from(input), resolve),
    );
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({
      cols: 22,
      rows: 8,
    });
    const rendered = Array.from(
      { length: terminal.buffer.active.length },
      (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(rendered).toContain("Aaaaaaaaaaaa");
    expect(rendered).toContain("Bbbbbbbbbbbbbbbbbbbbbb");
    terminal.dispose();
  });

  it("does not release later output reentrantly before a grid resize returns", async () => {
    const terminal = new Terminal({ cols: 30, rows: 6 });
    const pipeline = createTerminalOutputPipeline(terminal);
    let resizing = false;
    let writeDuringResize = false;
    const originalWrite = terminal.write.bind(terminal);
    terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      if (resizing) writeDuringResize = true;
      originalWrite(data, callback);
    }) as typeof terminal.write;
    const originalResize = terminal.resize.bind(terminal);
    terminal.resize = (cols: number, rows: number) => {
      resizing = true;
      originalResize(cols, rows);
      pipeline.push(Buffer.from("reentrant output"), () => undefined);
      resizing = false;
    };
    await new Promise<void>((resolve) =>
      pipeline.push(
        Buffer.from(
          `${createTerminalGridMarker({ cols: 51, rows: 12 })}after marker`,
        ),
        resolve,
      ),
    );
    await new Promise<void>((resolve) => terminal.write("", resolve));
    expect(writeDuringResize).toBe(false);
    expect(terminal.cols).toBe(51);
    expect(
      Array.from({ length: terminal.buffer.active.length }, (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
    ).toContain("reentrant output");
    terminal.dispose();
  });

  it("queues markerless output writes without waiting per chunk", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const pipeline = createTerminalOutputPipeline(terminal);
    let callbacks = 0;
    let writeCalls = 0;
    const originalWrite = terminal.write.bind(terminal);
    terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      writeCalls += 1;
      originalWrite(data, () => {
        callbacks += 1;
        callback?.();
      });
    }) as typeof terminal.write;
    const data = new Uint8Array(2 * 1024 * 1024).fill(120);
    const chunks = Array.from({ length: 32 }, (_, index) =>
      data.subarray(index * 65536, (index + 1) * 65536),
    );
    const settled = Promise.all(
      chunks.map(
        (chunk) =>
          new Promise<void>((resolve) => pipeline.push(chunk, resolve)),
      ),
    );
    expect(callbacks).toBe(0);
    expect(writeCalls).toBe(32);
    await settled;
    expect(callbacks).toBe(32);
    terminal.dispose();
  });

  it("registers the next sequence anchor in the preceding chunk parse callback", async () => {
    const writeCallbacks: Array<() => void> = [];
    const terminal = {
      resize: vi.fn(),
      write: vi.fn((_bytes: Uint8Array, callback: () => void) => {
        writeCallbacks.push(callback);
      }),
    };
    const outputStarts: number[] = [];
    const base = {
      acknowledgeOutput: vi.fn(),
      onOutputStart: (sequence: number) => outputStarts.push(sequence),
      onReplayComplete: vi.fn(),
      replayNextSeq: null,
      replayWriteState: { suppressedWriteCount: 0 },
      setReplayNextSeq: vi.fn(),
      terminal: terminal as unknown as Terminal,
      pipeline: createTerminalOutputPipeline(terminal),
    };

    for (const sequence of [0, 1]) {
      handleTerminalServerMessage({
        ...base,
        message: {
          type: "output",
          chunk: {
            seq: sequence,
            dataBase64: Buffer.from(`line ${sequence}`).toString("base64"),
          },
        },
      });
    }

    expect(outputStarts).toEqual([]);
    expect(writeCallbacks).toHaveLength(2);
    writeCallbacks.shift()?.();
    await vi.waitFor(() => expect(outputStarts).toEqual([1]));
    writeCallbacks.shift()?.();
    await vi.waitFor(() => expect(outputStarts).toEqual([1, 2]));
  });

  it("keeps unknown grid OSC invisible to an older stock xterm", async () => {
    const withMarker = new Terminal({ cols: 12, rows: 3 });
    const withoutMarker = new Terminal({ cols: 12, rows: 3 });
    const marker = createTerminalGridMarker({ cols: 40, rows: 8 });
    await new Promise<void>((resolve) =>
      withMarker.write(`${marker}visible text`, resolve),
    );
    await new Promise<void>((resolve) =>
      withoutMarker.write("visible text", resolve),
    );
    const visibleText = (terminal: Terminal) =>
      Array.from({ length: terminal.buffer.active.length }, (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString(),
      );
    expect(withMarker.cols).toBe(12);
    expect(visibleText(withMarker)).toEqual(visibleText(withoutMarker));
    withMarker.dispose();
    withoutMarker.dispose();
  });

  it("leaves the grid unchanged for a stock daemon stream without markers", async () => {
    const terminal = new Terminal({ cols: 30, rows: 7 });
    const registration = registerTerminalGridOscHandler(
      terminal,
      () => undefined,
    );
    await new Promise<void>((resolve) =>
      terminal.write("legacy output", resolve),
    );
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({
      cols: 30,
      rows: 7,
    });
    expect(terminal.buffer.active.getLine(0)?.translateToString()).toContain(
      "legacy output",
    );
    registration.dispose();
    terminal.dispose();
  });

  it("finishes rendering many retained chunks before the exit notice", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const session = {
      id: "term_many_chunks",
      threadId: "thr_1",
      environmentId: "env_1",
      hostId: "host_1",
      title: "Terminal",
      initialCwd: "/workspace",
      cols: 80,
      rows: 24,
      status: "exited",
      exitCode: 0,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    } satisfies TerminalSession;
    const chunks = Array.from({ length: 1_024 }, (_, index) => ({
      seq: index,
      data: new TextEncoder().encode(
        index === 1_023 ? "xFINAL-RETAINED-CHUNK" : "x",
      ),
    }));

    await writeRetainedTerminalOutput({
      chunks,
      lastNotice: { current: null },
      session,
      terminal,
    });

    const renderedText = Array.from(
      { length: terminal.buffer.active.length },
      (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString() ?? "",
    ).join("");
    expect(renderedText).toContain("Terminal exited with code 0");
    expect(renderedText.indexOf("FINAL-RETAINED-CHUNK")).toBeLessThan(
      renderedText.indexOf("Terminal exited with code 0"),
    );
    expect(
      renderedText.replace("Terminal exited with code 0", "").match(/x/g),
    ).toHaveLength(chunks.length);
    terminal.dispose();
  }, 10_000);

  it("writes the exit notice after all retained output has parsed", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const session = {
      id: "term_1",
      threadId: "thr_1",
      environmentId: "env_1",
      hostId: "host_1",
      title: "Terminal",
      initialCwd: "/workspace",
      cols: 80,
      rows: 24,
      status: "exited",
      exitCode: 0,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    } satisfies TerminalSession;

    await writeRetainedTerminalOutput({
      chunks: [
        { seq: 12, data: new TextEncoder().encode("CW-1\nCW-2\n") },
        { seq: 13, data: new TextEncoder().encode("CW-3\nCW-4\n") },
      ],
      lastNotice: { current: null },
      session,
      terminal,
    });

    const renderedText = Array.from(
      { length: terminal.buffer.active.length },
      (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString() ?? "",
    ).join("\n");
    expect(renderedText.indexOf("CW-1")).toBeLessThan(
      renderedText.indexOf("Terminal exited with code 0"),
    );
    expect(renderedText.indexOf("CW-4")).toBeLessThan(
      renderedText.indexOf("Terminal exited with code 0"),
    );
    terminal.dispose();
  });

  it("restores an exited daemon replay to a saved line in its first retained chunk", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const tracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal.registerMarker(),
      getCurrentLine: () =>
        terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    });
    const outputLineAnchors: NonNullable<
      ReturnType<typeof tracker.recordOutputStart>
    >[] = [];
    const chunks = [
      {
        seq: 0,
        data: new TextEncoder().encode(
          `${Array.from({ length: 3_000 }, (_, index) =>
            String(index + 1).padStart(5, "0"),
          ).join("\r\n")}\r\n`,
        ),
      },
      { seq: 1, data: new TextEncoder().encode("\r\n") },
      { seq: 2, data: new TextEncoder().encode("\r\n") },
      { seq: 3, data: new TextEncoder().encode("\r\n") },
      { seq: 4, data: new TextEncoder().encode("\r\n") },
    ];
    const savedAnchor = {
      distanceFromTail: 832,
      lineOffset: 2_123,
      outputSequence: 0,
    };
    await writeRetainedTerminalOutput({
      chunks,
      lastNotice: { current: null },
      session: {
        id: "term_daemon_replay",
        threadId: "thr_1",
        environmentId: "env_1",
        hostId: "host_1",
        title: "Terminal",
        initialCwd: "/workspace",
        cols: 80,
        rows: 24,
        status: "exited",
        exitCode: null,
        closeReason: "daemon-disconnect",
        createdAt: 1,
        updatedAt: 1,
        lastUserInputAt: null,
      } satisfies TerminalSession,
      terminal,
      pipeline,
      onOutputStart: (sequence) => {
        const anchor = tracker.recordOutputStart(sequence);
        if (anchor) outputLineAnchors.push(anchor);
      },
    });

    const restoredY = resolveTerminalViewportRestore({
      anchor: savedAnchor,
      baseY: terminal.buffer.active.baseY,
      outputLineAnchors,
      replayStartSequence: chunks[0]!.seq,
      replayNextSequence: 5,
    });

    expect(
      outputLineAnchors.find(({ sequence }) => sequence === 0),
    ).toBeDefined();
    expect(
      terminal.buffer.active.getLine(restoredY)?.translateToString(true),
    ).toBe("02124");
    tracker.dispose();
    terminal.dispose();
  });

  it("splits large paste input at the wire limit without losing UTF-8 bytes", () => {
    const input = `${"a".repeat(TERMINAL_DATA_MAX_BYTES - 1)}🙂tail`;
    const chunks = encodeTerminalInputChunks(input);
    const decoded = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk, "base64")),
    );

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) =>
          Buffer.from(chunk, "base64").byteLength <= TERMINAL_DATA_MAX_BYTES,
      ),
    ).toBe(true);
    expect(decoded.toString("utf8")).toBe(input);
  });

  it("keeps UTF-8 bytes intact when a glyph spans output chunks", () => {
    const encoded = new TextEncoder().encode("🙂");
    const first = decodeBase64Bytes(
      Buffer.from(encoded.subarray(0, 2)).toString("base64"),
    );
    const second = decodeBase64Bytes(
      Buffer.from(encoded.subarray(2)).toString("base64"),
    );
    const decoder = new TextDecoder();

    expect(
      decoder.decode(first, { stream: true }) + decoder.decode(second),
    ).toBe("🙂");
  });

  it.each(["€", "🙂"])(
    "renders split UTF-8 character %s through the terminal output handler",
    async (glyph) => {
      const terminal = new Terminal({ cols: 80, rows: 24 });
      const glyphBytes = Buffer.from(glyph);
      const payloads = [
        Buffer.concat([Buffer.from("before\n"), glyphBytes.subarray(0, 1)]),
        Buffer.concat([glyphBytes.subarray(1), Buffer.from(" after\n")]),
      ];
      payloads.forEach((payload, seq) => {
        handleTerminalServerMessage({
          acknowledgeOutput: vi.fn(),
          message: {
            type: "output",
            chunk: { seq, dataBase64: payload.toString("base64") },
          },
          onReplayComplete: vi.fn(),
          replayNextSeq: null,
          replayWriteState: { suppressedWriteCount: 0 },
          setReplayNextSeq: vi.fn(),
          terminal,
        });
      });
      await new Promise<void>((resolve) => terminal.write("", resolve));

      expect(
        terminal.buffer.active.getLine(0)?.translateToString().trimEnd(),
      ).toBe("before");
      expect(terminal.buffer.active.getLine(1)?.translateToString()).toContain(
        `${glyph} after`,
      );
      terminal.dispose();
    },
  );

  it("sends nothing for a touch fling's positionless wheel reports", () => {
    const onInput = vi.fn<(dataBase64: string) => void>();
    const onUserInput = vi.fn();
    const forward = (data: string) =>
      forwardTerminalData({
        data,
        isUserInput: true,
        onInput,
        onUserInput,
        replayWriteState: { suppressedWriteCount: 0 },
        sessionStatus: "running",
      });

    forward("\x1b[<65;NaN;NaNM\x1b[<65;NaN;NaNM");
    expect(onInput).not.toHaveBeenCalled();
    expect(onUserInput).not.toHaveBeenCalled();

    forward("\x1b[<65;NaN;NaNM\x1b[<65;10;4M");
    expect(onInput).toHaveBeenCalledOnce();
    expect(
      Buffer.from(onInput.mock.calls[0]?.[0] ?? "", "base64").toString("utf8"),
    ).toBe("\x1b[<65;10;4M");
  });

  it("does not send terminal protocol replies generated by replayed output", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const onInput = vi.fn<(dataBase64: string) => void>();
    const replayWriteState = { suppressedWriteCount: 0 };
    terminal.onData((data) => {
      forwardTerminalData({
        data,
        isUserInput: false,
        onInput,
        replayWriteState,
        sessionStatus: "running",
      });
    });

    writeTerminalOutput({
      data: "\u001b[6n",
      isReplay: true,
      onParsed: () => undefined,
      replayWriteState,
      terminal,
    });
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(onInput).not.toHaveBeenCalled();

    writeTerminalOutput({
      data: "\u001b[6n",
      isReplay: false,
      onParsed: () => undefined,
      replayWriteState,
      terminal,
    });
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(onInput).toHaveBeenCalledOnce();
    const encodedReply = onInput.mock.calls[0]?.[0];
    if (encodedReply === undefined) {
      throw new Error("Expected xterm to emit a cursor-position reply");
    }
    expect(Buffer.from(encodedReply, "base64").toString("utf8")).toBe(
      "\u001b[1;1R",
    );
    expect(replayWriteState.suppressedWriteCount).toBe(0);
    terminal.dispose();
  });

  it("feeds a checkpoint preview only from the checkpoint sequence onward", async () => {
    const terminal = new Terminal({ cols: 40, rows: 5 });
    const previewPush = vi.fn((bytes: Uint8Array, callback: () => void) =>
      callback(),
    );
    const replayWriteState = { suppressedWriteCount: 0 };
    const write = (sequence: number, isReplay: boolean) =>
      writeTerminalOutput({
        data: `chunk-${sequence}`,
        isReplay,
        outputSequence: sequence,
        replayCheckpointSequence: 3,
        onParsed: () => undefined,
        replayWriteState,
        terminal,
        replayPipeline: { push: previewPush },
      });

    write(0, true);
    await writeTerminal(terminal, "");
    expect(previewPush).not.toHaveBeenCalled();
    write(3, true);
    await writeTerminal(terminal, "");
    expect(Buffer.from(previewPush.mock.calls[0]?.[0] ?? []).toString()).toBe(
      "chunk-3",
    );
    write(4, false);
    await writeTerminal(terminal, "");
    expect(previewPush).toHaveBeenCalledTimes(2);
    expect(replayWriteState.suppressedWriteCount).toBe(0);
    terminal.dispose();
  });

  it("keeps keystrokes typed while replayed output is still parsing, and still drops the replay's protocol replies", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const sent: string[] = [];
    const replayWriteState = { suppressedWriteCount: 0 };
    const forwarding = attachTerminalInputForwarding({
      onData: (data, isUserInput) =>
        forwardTerminalData({
          data,
          isUserInput,
          onInput: (dataBase64) =>
            sent.push(Buffer.from(dataBase64, "base64").toString("utf8")),
          replayWriteState,
          sessionStatus: "running",
        }),
      terminal,
    });

    writeTerminalOutput({
      data: "\u001b[6nreplayed screen\u001b[6n",
      isReplay: true,
      onParsed: () => undefined,
      replayWriteState,
      terminal,
    });
    expect(replayWriteState.suppressedWriteCount).toBe(1);
    terminal.input("T", true);
    terminal.input("yped", true);
    await new Promise<void>((resolve) => terminal.write("", resolve));
    terminal.input("\r", true);

    expect(replayWriteState.suppressedWriteCount).toBe(0);
    expect(sent).toEqual(["T", "yped", "\r"]);

    writeTerminalOutput({
      data: "\u001b[6n",
      isReplay: false,
      onParsed: () => undefined,
      replayWriteState,
      terminal,
    });
    await new Promise<void>((resolve) => terminal.write("", resolve));
    expect(sent).toEqual(["T", "yped", "\r", "\u001b[1;16R"]);
    forwarding.dispose();
    terminal.dispose();
  });

  it("does not treat a replay's protocol reply as user input after a keystroke", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const sent: string[] = [];
    const replayWriteState = { suppressedWriteCount: 0 };
    const forwarding = attachTerminalInputForwarding({
      onData: (data, isUserInput) =>
        forwardTerminalData({
          data,
          isUserInput,
          onInput: (dataBase64) =>
            sent.push(Buffer.from(dataBase64, "base64").toString("utf8")),
          replayWriteState,
          sessionStatus: "running",
        }),
      terminal,
    });

    terminal.input("a", true);
    writeTerminalOutput({
      data: "\u001b[6n",
      isReplay: true,
      onParsed: () => undefined,
      replayWriteState,
      terminal,
    });
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(sent).toEqual(["a"]);
    forwarding.dispose();
    terminal.dispose();
  });

  it("drops all input during a replay, as before, when xterm no longer exposes the user-input signal", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const core: unknown = Reflect.get(terminal, "_core");
    const coreService: unknown =
      typeof core === "object" && core !== null
        ? Reflect.get(core, "coreService")
        : undefined;
    if (typeof coreService !== "object" || coreService === null) {
      throw new Error("Expected xterm to keep its core service");
    }
    Object.defineProperty(coreService, "onUserInput", { value: undefined });
    expect(subscribeToTerminalUserInput(terminal, () => undefined)).toBeNull();
    const sent: string[] = [];
    const replayWriteState = { suppressedWriteCount: 0 };
    const forwarding = attachTerminalInputForwarding({
      onData: (data, isUserInput) =>
        forwardTerminalData({
          data,
          isUserInput,
          onInput: (dataBase64) =>
            sent.push(Buffer.from(dataBase64, "base64").toString("utf8")),
          replayWriteState,
          sessionStatus: "running",
        }),
      terminal,
    });

    writeTerminalOutput({
      data: "\u001b[6nreplayed screen",
      isReplay: true,
      onParsed: () => undefined,
      replayWriteState,
      terminal,
    });
    terminal.input("lost", true);
    await new Promise<void>((resolve) => terminal.write("", resolve));
    terminal.input("kept", true);

    expect(sent).toEqual(["kept"]);
    forwarding.dispose();
    terminal.dispose();
  });

  it("requests a repaint only after the final replay chunk has parsed", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const replayWriteState = { suppressedWriteCount: 0 };
    const replayState = { nextSeq: null as number | null };
    const acknowledgeOutput = vi.fn();
    const session = {
      id: "term_1",
      threadId: "thr_1",
      environmentId: "env_1",
      hostId: "host_1",
      title: "Terminal",
      initialCwd: "/workspace",
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    } satisfies TerminalSession;
    const attachedMessage = {
      type: "attached",
      session,
      replayStartSeq: 7,
      nextSeq: 9,
    } satisfies TerminalServerMessage;
    const replayMessage = {
      type: "output",
      chunk: {
        seq: 8,
        dataBase64: Buffer.from("prompt", "utf8").toString("base64"),
      },
    } satisfies TerminalServerMessage;
    const onReplayComplete = vi.fn(() => {
      expect(
        terminal.buffer.active.getLine(0)?.translateToString().trimEnd(),
      ).toBe("prompt");
    });
    const handleMessage = (message: TerminalServerMessage) =>
      handleTerminalServerMessage({
        acknowledgeOutput,
        message,
        onReplayComplete,
        replayNextSeq: replayState.nextSeq,
        replayWriteState,
        setReplayNextSeq: (nextSeq) => {
          replayState.nextSeq = nextSeq;
        },
        terminal,
      });

    handleMessage(attachedMessage);
    expect(onReplayComplete).not.toHaveBeenCalled();
    handleMessage(replayMessage);
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(onReplayComplete).toHaveBeenCalledOnce();
    expect(acknowledgeOutput).toHaveBeenCalledWith(9);
    expect(replayState.nextSeq).toBeNull();
    terminal.dispose();
  });

  it("restores a synthetic TUI after a mid-stream alternate-screen replay", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const replayWriteState = { suppressedWriteCount: 0 };
    const replayState = { nextSeq: null as number | null };
    const session = {
      id: "term_1",
      threadId: "thr_1",
      environmentId: "env_1",
      hostId: "host_1",
      title: "Terminal",
      initialCwd: "/workspace",
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    } satisfies TerminalSession;
    let resolveRepaint = (): void => {};
    const repaint = new Promise<void>((resolve) => {
      resolveRepaint = resolve;
    });
    const fullScreen =
      "\u001b[2J\u001b[HClaude Code v2.1.296\u001b[12;1H[ Prompt ]\u001b[13;1H❯ run terminal reattach tests\u001b[23;1HOpus 5.5 · branch · ctx 4M\u001b[24;1HStatus · connected · footer\u001b[13;3H";
    const requestRepaint = vi.fn(() => {
      terminal.write(fullScreen, resolveRepaint);
    });
    const acknowledgeOutput = vi.fn();
    const handleMessage = (message: TerminalServerMessage) =>
      handleTerminalServerMessage({
        acknowledgeOutput,
        message,
        onReplayComplete: requestRepaint,
        replayNextSeq: replayState.nextSeq,
        replayWriteState,
        setReplayNextSeq: (nextSeq) => {
          replayState.nextSeq = nextSeq;
        },
        terminal,
      });

    handleMessage({
      type: "attached",
      session,
      replayStartSeq: 41,
      nextSeq: 42,
    });
    handleMessage({
      type: "output",
      chunk: {
        seq: 41,
        dataBase64: Buffer.from(
          "\u001b[?1049hmid-stream-tail",
          "utf8",
        ).toString("base64"),
      },
    });
    await repaint;

    const lines = Array.from({ length: 24 }, (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString().trimEnd(),
    );
    expect(requestRepaint).toHaveBeenCalledOnce();
    expect(terminal.buffer.active.type).toBe("alternate");
    expect(lines[0]).toContain("Claude Code v2.1.296");
    expect(lines[11]).toContain("[ Prompt ]");
    expect(lines[12]).toContain("❯ run terminal reattach tests");
    expect(lines[22]).toContain("Opus 5.5 · branch · ctx 4M");
    expect(lines[23]).toContain("Status · connected · footer");
    expect(terminal.buffer.active.cursorX).toBe(2);
    expect(terminal.buffer.active.cursorY).toBe(12);
    expect(acknowledgeOutput).toHaveBeenCalledWith(42);
    terminal.dispose();
  });

  it("allows the proposed xterm API that the Unicode 11 addon requires", () => {
    const terminal = new Terminal({
      allowProposedApi: TERMINAL_ALLOW_PROPOSED_API,
    });
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    expect(terminal.unicode.activeVersion).toBe("11");
    terminal.dispose();
  });
});

describe("buildTerminalThemeFromCssColors", () => {
  it("paints the terminal canvas and cursor cutout with the sidebar surface", () => {
    const get = vi.fn((name: string) => name);

    const theme = buildTerminalThemeFromCssColors(get);

    expect(theme.background).toBe("--sidebar");
    expect(theme.cursorAccent).toBe("--sidebar");
  });
});

describe("terminal font family", () => {
  it("uses the theme terminal font family when it is set", () => {
    expect(
      resolveTerminalFontFamily((name) =>
        name === "--font-terminal" ? '"Berkeley Mono", monospace' : undefined,
      ),
    ).toBe('"Berkeley Mono", monospace');
  });

  it("keeps the default stack when the theme does not set a font family", () => {
    expect(resolveTerminalFontFamily(() => undefined)).toBe(
      TERMINAL_FONT_FAMILY,
    );
  });

  it("keeps the default stack when the theme font family is blank", () => {
    expect(resolveTerminalFontFamily(() => "  ")).toBe(TERMINAL_FONT_FAMILY);
  });

  it("updates the xterm font family and schedules a refit only when it changes", () => {
    const terminal = { options: { fontFamily: "Old Font" } } as Parameters<
      typeof applyTerminalFontFamily
    >[0];
    const scheduleFit = vi.fn();

    expect(
      applyTerminalFontFamily(terminal, '"New Font", monospace', scheduleFit),
    ).toBe(true);
    expect(terminal.options.fontFamily).toBe('"New Font", monospace');
    expect(scheduleFit).toHaveBeenCalledOnce();

    scheduleFit.mockClear();
    expect(
      applyTerminalFontFamily(terminal, '"New Font", monospace', scheduleFit),
    ).toBe(false);
    expect(scheduleFit).not.toHaveBeenCalled();
  });

  it("remeasures and clears cached glyphs before refreshing after a font loads", () => {
    const fontFamily = '"New Font", monospace';
    let currentFontFamily = fontFamily;
    const fontFamilyChanges: string[] = [];
    const refresh = vi.fn();
    const clearTextureAtlas = vi.fn();
    const terminal = {
      options: {
        get fontFamily() {
          return currentFontFamily;
        },
        set fontFamily(value: string) {
          fontFamilyChanges.push(value);
          currentFontFamily = value;
        },
      },
      refresh,
      clearTextureAtlas,
      rows: 24,
    } as Parameters<typeof forceTerminalFontMeasurement>[0];

    forceTerminalFontMeasurement(terminal);

    expect(fontFamilyChanges).toEqual([`${fontFamily} `, fontFamily]);
    expect(clearTextureAtlas).toHaveBeenCalledOnce();
    expect(clearTextureAtlas).toHaveBeenCalledBefore(refresh);
    expect(refresh).toHaveBeenCalledWith(0, 23);
    expect(terminal.options.fontFamily).toBe(fontFamily);
  });
});

function createTerminalFontSet() {
  const events = new EventTarget();
  let finishLoading = () => {};
  const ready = new Promise<FontFaceSet>((resolve) => {
    finishLoading = () => resolve(fontSet as FontFaceSet);
  });
  const fontSet = Object.assign(events, { ready });
  return { fontSet, finishLoading };
}

describe("terminal font loading", () => {
  it("refreshes fonts imported after the initial ready promise resolves", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    finishLoading();
    await fontSet.ready;
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);
    await fontSet.ready;
    expect(refresh).toHaveBeenCalledOnce();

    fontSet.dispatchEvent(new Event("loadingdone"));
    expect(refresh).toHaveBeenCalledTimes(2);

    fontSet.dispatchEvent(new Event("loadingdone"));
    expect(refresh).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("ignores a pending ready callback after the terminal is disposed", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);

    dispose();
    finishLoading();
    await fontSet.ready;
    fontSet.dispatchEvent(new Event("loadingdone"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("removes the font listener when the terminal is disposed", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    const removeEventListener = vi.spyOn(fontSet, "removeEventListener");
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);
    finishLoading();
    await fontSet.ready;
    refresh.mockClear();

    dispose();
    fontSet.dispatchEvent(new Event("loadingdone"));

    expect(refresh).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith(
      "loadingdone",
      expect.any(Function),
    );
    removeEventListener.mockRestore();
  });
});

describe("loadTerminalWebglRenderer", () => {
  it("continues without WebGL when the optional module fails to load", async () => {
    const importAddon = vi.fn().mockRejectedValue(new Error("chunk failed"));

    await expect(
      loadOptionalTerminalWebglAddon(importAddon),
    ).resolves.toBeNull();
  });

  it("loads the accelerated renderer and falls back when its context is lost", () => {
    let onContextLoss = () => {};
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn((listener: () => void) => {
        onContextLoss = listener;
        return { dispose: vi.fn() };
      }),
    };
    const terminal = { loadAddon: vi.fn() };

    expect(loadTerminalWebglRenderer(terminal, () => addon).renderer).toBe(
      "webgl",
    );
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon);

    onContextLoss();

    expect(addon.dispose).toHaveBeenCalledOnce();
  });

  it("keeps the DOM renderer when WebGL addon registration fails", () => {
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const terminal = {
      loadAddon: vi.fn(() => {
        throw new Error("WebGL unavailable");
      }),
    };

    expect(loadTerminalWebglRenderer(terminal, () => addon).renderer).toBe(
      "dom",
    );
    expect(addon.dispose).toHaveBeenCalledOnce();
  });
});
