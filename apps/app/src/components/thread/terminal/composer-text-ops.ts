export interface TextChange {
  start: number;
  removedEnd: number;
  insertedEnd: number;
}

export function diffText(previous: string, next: string): TextChange | null {
  if (previous === next) return null;
  const limit = Math.min(previous.length, next.length);
  let start = 0;
  while (start < limit && previous[start] === next[start]) start += 1;
  let suffix = 0;
  while (
    suffix < limit - start &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    start,
    removedEnd: previous.length - suffix,
    insertedEnd: next.length - suffix,
  };
}

export function mapOffset(
  change: TextChange,
  offset: number,
  assoc: "before" | "after" = "after",
): number {
  if (offset < change.start) return offset;
  if (offset === change.start && change.removedEnd === change.start) {
    return assoc === "before" ? offset : change.insertedEnd;
  }
  if (offset >= change.removedEnd) {
    return offset + (change.insertedEnd - change.removedEnd);
  }
  return assoc === "before" ? change.start : change.insertedEnd;
}

export function mapCaret(change: TextChange, offset: number): number {
  if (offset === change.start && change.removedEnd > change.start) {
    return offset;
  }
  return mapOffset(change, offset, "after");
}

export function touchesRange(
  change: TextChange,
  start: number,
  end: number,
): boolean {
  return change.start <= end && change.removedEnd >= start;
}

const LIST_ITEM = /^(?:\d{1,2}[.)]|[-*•])\s/u;

export function joinDictation(
  before: string,
  piece: string,
  after: string,
): string {
  let text = piece;
  if (before.length > 0) {
    if (LIST_ITEM.test(text) && !before.endsWith("\n")) {
      text = `\n${text}`;
    } else if (!/\s$/u.test(before) && !/^[\s.,;:!?)]/u.test(text)) {
      text = ` ${text}`;
    }
  }
  if (after.length > 0 && !/^\s/u.test(after) && !/\s$/u.test(text)) {
    text = `${text} `;
  }
  return text;
}

export interface SentenceRange {
  start: number;
  end: number;
  complete: boolean;
}

const SENTENCE = /[^\n]*?(?:[.!?]+["')\]’”]*(?=\s|$)|\n|$)/gu;

export function sentenceRanges(text: string): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  for (const match of text.matchAll(SENTENCE)) {
    const value = match[0];
    if (value.length === 0) continue;
    const start = match.index;
    const trimmedStart = start + (value.length - value.trimStart().length);
    const body = value.trimEnd();
    if (body.trim().length === 0) continue;
    const range = {
      start: trimmedStart,
      end: start + body.length,
      complete: /[.!?]["')\]’”]*$/u.test(body) || value.endsWith("\n"),
    };
    const previous = ranges.at(-1);
    if (
      previous !== undefined &&
      LIST_MARKER.test(text.slice(previous.start, previous.end)) &&
      text.slice(previous.end, range.start).includes("\n") === false
    ) {
      previous.end = range.end;
      previous.complete = range.complete;
      continue;
    }
    ranges.push(range);
  }
  return ranges;
}

const LIST_MARKER = /^\d{1,2}[.)]$/u;

export function insideCodeFence(text: string, offset: number): boolean {
  let fences = 0;
  let index = text.indexOf("```");
  while (index >= 0 && index < offset) {
    fences += 1;
    index = text.indexOf("```", index + 3);
  }
  return fences % 2 === 1;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
