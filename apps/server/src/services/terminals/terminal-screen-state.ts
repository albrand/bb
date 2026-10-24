import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import type { TerminalScreenResponse } from "@bb/server-contract";

const TERMINAL_SCREEN_STATE_SCROLLBACK = 2_000;
const ESC = "\u001b";
const require = createRequire(import.meta.url);
const Terminal = require("@xterm/headless")
  .Terminal as typeof import("@xterm/headless").Terminal;
const { Unicode11Addon } =
  require("@xterm/addon-unicode11") as typeof import("@xterm/addon-unicode11");

type HeadlessTerminal = InstanceType<typeof Terminal>;
type HeadlessCell = NonNullable<
  ReturnType<
    NonNullable<
      ReturnType<HeadlessTerminal["buffer"]["active"]["getLine"]>
    >["getCell"]
  >
>;

function cellSgr(cell: HeadlessCell): string {
  const codes: string[] = ["0"];
  if (cell.isBold()) codes.push("1");
  if (cell.isDim()) codes.push("2");
  if (cell.isItalic()) codes.push("3");
  if (cell.isUnderline()) codes.push("4");
  if (cell.isBlink()) codes.push("5");
  if (cell.isInverse()) codes.push("7");
  if (cell.isInvisible()) codes.push("8");
  if (cell.isStrikethrough()) codes.push("9");
  if (cell.isOverline()) codes.push("53");
  if (cell.isFgRGB()) {
    const color = cell.getFgColor();
    codes.push(`38;2;${color >> 16};${(color >> 8) & 255};${color & 255}`);
  } else if (cell.isFgPalette()) {
    codes.push(`38;5;${cell.getFgColor()}`);
  } else {
    codes.push("39");
  }
  if (cell.isBgRGB()) {
    const color = cell.getBgColor();
    codes.push(`48;2;${color >> 16};${(color >> 8) & 255};${color & 255}`);
  } else if (cell.isBgPalette()) {
    codes.push(`48;5;${cell.getBgColor()}`);
  } else {
    codes.push("49");
  }
  return `${ESC}[${codes.join(";")}m`;
}

function restoreModes(terminal: HeadlessTerminal): string {
  const modes = terminal.modes;
  const privateModes: Array<[number, boolean]> = [
    [1, modes.applicationCursorKeysMode],
    [6, modes.originMode],
    [7, modes.wraparoundMode],
    [25, modes.showCursor],
    [45, modes.reverseWraparoundMode],
    [1004, modes.sendFocusMode],
    [2004, modes.bracketedPasteMode],
    [2026, modes.synchronizedOutputMode],
    [9001, modes.win32InputMode],
  ];
  const sequences = privateModes.map(
    ([mode, enabled]) => `${ESC}[?${mode}${enabled ? "h" : "l"}`,
  );
  sequences.push(`${ESC}[${modes.insertMode ? "4h" : "4l"}`);
  sequences.push(`${ESC}${modes.applicationKeypadMode ? "=" : ">"}`);
  if (modes.mouseTrackingMode !== "none") {
    const mouseMode =
      modes.mouseTrackingMode === "x10"
        ? 9
        : modes.mouseTrackingMode === "vt200"
          ? 1000
          : modes.mouseTrackingMode === "drag"
            ? 1002
            : 1003;
    sequences.push(`${ESC}[?${mouseMode}h`);
  }
  return sequences.join("");
}

function serializeVisibleScreen(terminal: HeadlessTerminal): {
  dataBase64: string;
  response: TerminalScreenResponse;
} {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  const parts = [`${ESC}[?6l${ESC}[?7l${ESC}[?25l${ESC}[2J`];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    let text = "";
    let previousSgr = "";
    parts.push(`${ESC}[${row + 1};1H`);
    for (let col = 0; col < terminal.cols; col += 1) {
      const cell = line?.getCell(col);
      if (cell === undefined || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      const sgr = cellSgr(cell);
      if (sgr !== previousSgr) {
        parts.push(sgr);
        previousSgr = sgr;
      }
      parts.push(chars);
    }
    rows.push(text.trimEnd());
  }
  const cursorCell = buffer
    .getLine(buffer.baseY + buffer.cursorY)
    ?.getCell(Math.min(buffer.cursorX, terminal.cols - 1));
  parts.push(
    `${ESC}[0m${ESC}[?6l${ESC}[${buffer.cursorY + 1};${buffer.cursorX + 1}H`,
  );
  if (cursorCell !== undefined) parts.push(cellSgr(cursorCell));
  parts.push(restoreModes(terminal));
  parts.push(`${ESC}[${buffer.cursorY + 1};${buffer.cursorX + 1}H`);
  const data = Buffer.from(parts.join(""), "utf8");
  return {
    dataBase64: data.toString("base64"),
    response: {
      rows,
      cursor: { col: buffer.cursorX, row: buffer.cursorY },
      cols: terminal.cols,
      gridRows: terminal.rows,
      truncated: false,
      complete: true,
    },
  };
}

export class TerminalScreenState {
  private readonly terminal: HeadlessTerminal;
  private cols: number;
  private rows: number;
  private pending = Promise.resolve();
  private nextSeq = 0;
  private valid = true;
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: TERMINAL_SCREEN_STATE_SCROLLBACK,
    });
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = "11";
  }

  push(seq: number, data: Uint8Array): void {
    if (this.disposed || !this.valid || seq < this.nextSeq) return;
    if (seq !== this.nextSeq) {
      this.valid = false;
      return;
    }
    this.nextSeq += 1;
    this.pending = this.pending
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.disposed) {
              resolve();
              return;
            }
            try {
              this.terminal.write(data, resolve);
            } catch (error) {
              reject(error);
            }
          }),
      )
      .catch(() => {
        this.valid = false;
      });
  }

  resize(cols: number, rows: number): void {
    if (
      this.disposed ||
      !this.valid ||
      (this.cols === cols && this.rows === rows)
    ) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    this.pending = this.pending
      .then(() => {
        if (!this.disposed) this.terminal.resize(cols, rows);
      })
      .catch(() => {
        this.valid = false;
      });
  }

  async snapshot(): Promise<
    | (TerminalScreenResponse & { checkpointSeq: number; dataBase64: string })
    | null
  > {
    await this.pending;
    if (this.disposed || !this.valid) return null;
    const snapshot = serializeVisibleScreen(this.terminal);
    return {
      ...snapshot.response,
      checkpointSeq: this.nextSeq,
      dataBase64: snapshot.dataBase64,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}

export class TerminalScreenStateCache {
  private readonly states = new Map<string, TerminalScreenState>();

  has(terminalId: string): boolean {
    return this.states.has(terminalId);
  }

  create(terminalId: string, cols: number, rows: number): void {
    if (this.states.has(terminalId)) return;
    this.states.set(terminalId, new TerminalScreenState(cols, rows));
  }

  push(
    terminalId: string,
    cols: number,
    rows: number,
    seq: number,
    data: Uint8Array,
  ): void {
    let state = this.states.get(terminalId);
    if (state === undefined) {
      if (seq !== 0) return;
      state = new TerminalScreenState(cols, rows);
      this.states.set(terminalId, state);
    }
    state.resize(cols, rows);
    state.push(seq, data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.states.get(terminalId)?.resize(cols, rows);
  }

  snapshot(terminalId: string) {
    return this.states.get(terminalId)?.snapshot() ?? Promise.resolve(null);
  }

  remove(terminalId: string): void {
    const state = this.states.get(terminalId);
    if (state === undefined) return;
    this.states.delete(terminalId);
    state.dispose();
  }

  dispose(): void {
    for (const state of this.states.values()) state.dispose();
    this.states.clear();
  }
}
