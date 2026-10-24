import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishHooks } from "./hook-spool.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function newRoot(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bb-publish-hooks-"));
  roots.push(directory);
  return directory;
}

const names = (directory: string): string[] => readdirSync(directory).sort();

const lines = (...values: string[]): string => values.join("\n");

describe("publishHooks writes the same numbered files as a full scan would", () => {
  it("numbers records from 1 in order and writes each line byte for byte", () => {
    const directory = path.join(newRoot(), "spool");
    publishHooks(directory, lines("a", "b"));
    publishHooks(directory, lines("c", ""));
    expect(names(directory)).toEqual([
      "000000000001",
      "000000000002",
      "000000000003",
    ]);
    const contents = names(directory).map((name) =>
      readFileSync(path.join(directory, name), "utf8"),
    );
    expect(contents).toEqual(["a", "b", "c"]);
  });

  it("continues after the highest file that already exists when it first sees a directory", () => {
    const directory = path.join(newRoot(), "spool");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "000000000001"), "one");
    writeFileSync(path.join(directory, "000000000007"), "seven");
    publishHooks(directory, "eight");
    expect(names(directory)).toEqual([
      "000000000001",
      "000000000007",
      "000000000008",
    ]);
  });

  it("does not invent a gap when the directory was removed and the path is reused", () => {
    const directory = path.join(newRoot(), "spool");
    publishHooks(directory, lines("a", "b", "c", "d"));
    rmSync(directory, { force: true, recursive: true });
    publishHooks(directory, lines("e", "f"));
    expect(names(directory)).toEqual(["000000000001", "000000000002"]);
  });

  it("does not invent a gap when the files were removed but the directory stayed", () => {
    const directory = path.join(newRoot(), "spool");
    publishHooks(directory, lines("a", "b", "c"));
    for (const name of names(directory)) rmSync(path.join(directory, name));
    publishHooks(directory, "d");
    expect(names(directory)).toEqual(["000000000001"]);
  });

  it("moves past a number that another writer took, never overwriting it", () => {
    const directory = path.join(newRoot(), "spool");
    publishHooks(directory, "first");
    writeFileSync(path.join(directory, "000000000002"), "taken");
    writeFileSync(path.join(directory, "000000000003"), "taken too");
    publishHooks(directory, lines("second", "third"));
    expect(names(directory)).toEqual([
      "000000000001",
      "000000000002",
      "000000000003",
      "000000000004",
      "000000000005",
    ]);
    expect(readFileSync(path.join(directory, "000000000002"), "utf8")).toBe(
      "taken",
    );
    expect(readFileSync(path.join(directory, "000000000004"), "utf8")).toBe(
      "second",
    );
    expect(readFileSync(path.join(directory, "000000000005"), "utf8")).toBe(
      "third",
    );
  });
});
