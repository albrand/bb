import { describe, expect, it } from "vitest";
import {
  diffText,
  formatElapsed,
  insideCodeFence,
  joinDictation,
  mapOffset,
  sentenceRanges,
} from "./composer-text-ops";

describe("diffText and mapOffset", () => {
  it("keeps an anchor after text typed before it", () => {
    const change = diffText("hello world", "hey hello world");
    expect(change).not.toBeNull();
    expect(mapOffset(change!, 11)).toBe(15);
    expect(mapOffset(change!, 0, "before")).toBe(0);
  });

  it("moves an anchor past text typed exactly at it when associating after", () => {
    const change = diffText("abc", "abXc")!;
    expect(mapOffset(change, 2, "after")).toBe(3);
    expect(mapOffset(change, 2, "before")).toBe(2);
  });

  it("collapses an anchor inside a deleted range to its edge", () => {
    const change = diffText("one two three", "one three")!;
    expect(mapOffset(change, 6, "after")).toBe(5);
    expect(mapOffset(change, 6, "before")).toBe(5);
  });

  it("handles repeated characters without shifting the wrong side", () => {
    const change = diffText("aaa", "aaaa")!;
    expect(change.removedEnd - change.start).toBe(0);
    expect(change.insertedEnd - change.start).toBe(1);
  });
});

describe("joinDictation", () => {
  it("adds a space between existing words and dictation", () => {
    expect(joinDictation("Fix the bug", "Then add tests.", "")).toBe(
      " Then add tests.",
    );
  });

  it("starts a list on its own line", () => {
    expect(joinDictation("Plan:", "1. Check auth.", "")).toBe(
      "\n1. Check auth.",
    );
  });

  it("keeps punctuation attached and spaces before following text", () => {
    expect(joinDictation("Done", ", thanks", "")).toBe(", thanks");
    expect(joinDictation("", "Hello", "world")).toBe("Hello ");
  });
});

describe("sentenceRanges", () => {
  it("marks finished sentences complete and the trailing one incomplete", () => {
    const text = "The user are here. Is it ok? still typing";
    const ranges = sentenceRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      "The user are here.",
      "Is it ok?",
      "still typing",
    ]);
    expect(ranges.map((range) => range.complete)).toEqual([true, true, false]);
  });

  it("treats a line break as the end of a sentence", () => {
    const text = "1. check auth\n2. verify tokens";
    const ranges = sentenceRanges(text);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      "1. check auth",
      "2. verify tokens",
    ]);
    expect(ranges.map((range) => range.complete)).toEqual([true, false]);
  });

  it("does not split version numbers or file names", () => {
    const text = "Bump to v2.3.1 in package.json now.";
    expect(sentenceRanges(text)).toHaveLength(1);
  });
});

describe("insideCodeFence", () => {
  it("detects offsets inside fenced code", () => {
    const text = "see\n```\nconst a = 1;\n```\nafter";
    expect(insideCodeFence(text, text.indexOf("const"))).toBe(true);
    expect(insideCodeFence(text, text.indexOf("after"))).toBe(false);
  });
});

describe("formatElapsed", () => {
  it("formats minutes and seconds", () => {
    expect(formatElapsed(65_400)).toBe("1:05");
    expect(formatElapsed(0)).toBe("0:00");
  });
});
