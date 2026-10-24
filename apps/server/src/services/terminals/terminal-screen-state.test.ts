import { describe, expect, it } from "vitest";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { TerminalScreenState } from "./terminal-screen-state.js";

function create(cols = 40, rows = 5, scrollback = 2_000) {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  return terminal;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function visibleState(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    rows: Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.baseY + row);
      return Array.from({ length: terminal.cols }, (_, col) => {
        const cell = line?.getCell(col);
        return cell === undefined
          ? null
          : {
              chars: cell.getChars() || (cell.getWidth() === 1 ? " " : ""),
              width: cell.getWidth(),
              fg: cell.getFgColor(),
              bg: cell.getBgColor(),
              bold: cell.isBold(),
              underline: cell.isUnderline(),
            };
      });
    }),
    cursor: { col: buffer.cursorX, row: buffer.cursorY },
  };
}

function bufferState(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    rows: Array.from({ length: buffer.length }, (_, index) =>
      buffer.getLine(index)?.translateToString(true).trimEnd(),
    ),
    cursor: { col: buffer.cursorX, row: buffer.cursorY },
  };
}

describe("TerminalScreenState", () => {
  it("reconstructs the full replay's visible cells and cursor from snapshot plus ordered suffix", async () => {
    const before =
      "\u001b[2J\u001b[H\u001b[38;2;20;120;220mready 界🙂\u001b[0m\u001b[5;20H99%";
    const after = "\u001b[5;20H100%\u001b[4;4Hnext";
    const state = new TerminalScreenState(40, 5);
    state.push(0, Buffer.from(before));
    const snapshot = await state.snapshot();
    expect(snapshot).not.toBeNull();
    if (snapshot === null)
      throw new Error("screen state did not produce a snapshot");

    const fromSnapshot = create();
    await write(
      fromSnapshot,
      Buffer.from(snapshot.dataBase64, "base64").toString(),
    );
    state.push(snapshot.checkpointSeq, Buffer.from(after));
    await write(fromSnapshot, after);
    const fullReplay = create();
    await write(fullReplay, before + after);
    expect(visibleState(fromSnapshot)).toEqual(visibleState(fullReplay));

    const dropped = create();
    await write(dropped, Buffer.from(snapshot.dataBase64, "base64").toString());
    await write(dropped, "\u001b[5;20H100%");
    expect(visibleState(dropped)).not.toEqual(visibleState(fullReplay));

    const swapped = create();
    await write(swapped, Buffer.from(snapshot.dataBase64, "base64").toString());
    await write(swapped, "\u001b[4;4Hnext\u001b[5;20H100%");
    expect(visibleState(swapped)).not.toEqual(visibleState(fullReplay));

    state.dispose();
    fromSnapshot.dispose();
    fullReplay.dispose();
    dropped.dispose();
    swapped.dispose();
  });

  it("invalidates on a missing sequence instead of serving a misleading frame", async () => {
    const state = new TerminalScreenState(40, 5);
    state.push(1, Buffer.from("missed sequence zero"));
    await expect(state.snapshot()).resolves.toBeNull();
    state.dispose();
  });

  it("preserves the older-history seam when a lazy history page meets the snapshot and suffix", async () => {
    const olderRows = Array.from({ length: 2_005 }, (_, index) =>
      `history-${index + 1}`,
    );
    const olderLines = `${olderRows.join("\r\n")}\r\n`;
    const before = "\u001b[2J\u001b[Hscreen 界🙂\u001b[5;20H99%";
    const after = "\u001b[5;20H100%\u001b[4;4Hnext";
    const state = new TerminalScreenState(40, 5);
    state.push(0, Buffer.from(before));
    const snapshot = await state.snapshot();
    expect(snapshot).not.toBeNull();
    if (snapshot === null)
      throw new Error("screen state did not produce a snapshot");

    const resumed = create(40, 5, 10_000);
    await write(resumed, olderLines);
    await write(resumed, Buffer.from(snapshot.dataBase64, "base64").toString());
    state.push(snapshot.checkpointSeq, Buffer.from(after));
    await write(resumed, after);

    const fullReplay = create(40, 5, 10_000);
    await write(fullReplay, olderLines + before + after);
    expect(bufferState(resumed)).toEqual(bufferState(fullReplay));
    expect(visibleState(resumed)).toEqual(visibleState(fullReplay));

    const droppedAtSeam = create(40, 5, 10_000);
    await write(
      droppedAtSeam,
      `${olderRows.slice(0, -1).join("\r\n")}\r\n`,
    );
    await write(
      droppedAtSeam,
      Buffer.from(snapshot.dataBase64, "base64").toString(),
    );
    await write(droppedAtSeam, after);
    expect(bufferState(droppedAtSeam)).not.toEqual(bufferState(fullReplay));

    const duplicatedAtSeam = create(40, 5, 10_000);
    await write(duplicatedAtSeam, `${olderLines}history-2005\r\n`);
    await write(
      duplicatedAtSeam,
      Buffer.from(snapshot.dataBase64, "base64").toString(),
    );
    await write(duplicatedAtSeam, after);
    expect(bufferState(duplicatedAtSeam)).not.toEqual(bufferState(fullReplay));

    state.dispose();
    resumed.dispose();
    fullReplay.dispose();
    droppedAtSeam.dispose();
    duplicatedAtSeam.dispose();
  });
});
