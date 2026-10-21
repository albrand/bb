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
  it("matches visible output after replaying output received while hidden", async () => {
    const visibleTerminal = new Terminal({ cols: 30, rows: 6 });
    const hiddenTerminal = new Terminal({ cols: 30, rows: 6 });
    const visiblePipeline = createTerminalOutputPipeline(visibleTerminal);
    const hiddenPipeline = createTerminalOutputPipeline(hiddenTerminal);
    const chunks = ["before ", "\u001b[3", "1mhidden\u001b[0m after"];
    const write = async (
      terminal: Terminal,
      pipeline: ReturnType<typeof createTerminalOutputPipeline>,
      seq: number,
      bytes: string,
      visible: boolean,
    ) => {
      let parsed!: () => void;
      const completion = new Promise<void>((resolve) => {
        parsed = resolve;
      });
      handleTerminalServerMessage({
        acknowledgeOutput: parsed,
        message: {
          type: "output",
          chunk: { seq, dataBase64: Buffer.from(bytes).toString("base64") },
        },
        onReplayComplete: vi.fn(),
        replayNextSeq: null,
        replayWriteState: { suppressedWriteCount: 0 },
        setReplayNextSeq: vi.fn(),
        shouldProcessOutput: () => visible,
        terminal,
        pipeline,
      });
      if (visible) await completion;
    };

    for (const [seq, chunk] of chunks.entries()) {
      await write(visibleTerminal, visiblePipeline, seq, chunk, true);
      await write(hiddenTerminal, hiddenPipeline, seq, chunk, false);
    }
    expect(
      hiddenTerminal.buffer.active.getLine(0)?.translateToString().trimEnd(),
    ).toBe("");
    for (const [seq, chunk] of chunks.entries()) {
      await write(hiddenTerminal, hiddenPipeline, seq, chunk, true);
    }

    const visibleLines = Array.from(
      { length: visibleTerminal.buffer.active.length },
      (_, index) =>
        visibleTerminal.buffer.active.getLine(index)?.translateToString(),
    );
    const replayedLines = Array.from(
      { length: hiddenTerminal.buffer.active.length },
      (_, index) =>
        hiddenTerminal.buffer.active.getLine(index)?.translateToString(),
    );
    expect(replayedLines).toEqual(visibleLines);
    expect(hiddenTerminal.buffer.active.getLine(0)?.getCell(7)?.getFgColor()).toBe(
      1,
    );
    visibleTerminal.dispose();
    hiddenTerminal.dispose();
  });

  it("replays a hidden output chunk before parsing a split escape sequence on show", async () => {
    const terminal = new Terminal({ cols: 30, rows: 6 });
    const pipeline = createTerminalOutputPipeline(terminal);
    const acknowledged: number[] = [];
    const replayWriteState = { suppressedWriteCount: 0 };
    let visible = false;
    const sendOutput = async (seq: number, bytes: string) => {
      let parsed!: () => void;
      const completion = new Promise<void>((resolve) => {
        parsed = resolve;
      });
      handleTerminalServerMessage({
        acknowledgeOutput: (nextSeq) => {
          acknowledged.push(nextSeq);
          parsed();
        },
        message: {
          type: "output",
          chunk: { seq, dataBase64: Buffer.from(bytes).toString("base64") },
        },
        onReplayComplete: vi.fn(),
        replayNextSeq: null,
        replayWriteState,
        setReplayNextSeq: vi.fn(),
        shouldProcessOutput: () => visible,
        terminal,
        pipeline,
      });
      if (visible) await completion;
    };

    await sendOutput(0, "\u001b[3");
    expect(acknowledged).toEqual([]);
    expect(
      terminal.buffer.active.getLine(0)?.translateToString().trimEnd(),
    ).toBe("");

    visible = true;
    await sendOutput(0, "\u001b[3");
    await sendOutput(1, "1mOK");

    expect(terminal.buffer.active.getLine(0)?.translateToString()).toContain(
      "OK",
    );
    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(
      1,
    );
    expect(acknowledged).toEqual([1, 2]);
    terminal.dispose();
  });

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
    const chunks = Array.from({ length: 1_024 }, (_, index) =>
      new TextEncoder().encode(index === 1_023 ? "xFINAL-RETAINED-CHUNK" : "x"),
    );

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
        new TextEncoder().encode("CW-1\nCW-2\n"),
        new TextEncoder().encode("CW-3\nCW-4\n"),
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
