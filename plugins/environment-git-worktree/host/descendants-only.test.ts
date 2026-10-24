import { describe, expect, it } from "vitest";
import { descendantsOnly } from "./descendants-only.js";
import type { ProcReader } from "./holders.js";

function table(parents: Record<string, number>): ProcReader {
  const reject = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    readlink: reject,
    readFile: async (path) => {
      const pid = path.split("/")[2] ?? "";
      const parent = parents[pid];
      if (parent === undefined) throw new Error("ENOENT");
      return `${pid} (a b) S ${parent} 1 1 0`;
    },
    readdir: async () => [...Object.keys(parents), "self", "stat"],
    lstatId: reject,
    statId: reject,
    creationMs: reject,
    subdirectories: reject,
  };
}

describe("descendantsOnly", () => {
  it("keeps the root and its descendants and drops every other process", async () => {
    const reader = descendantsOnly(
      table({ "100": 1, "200": 100, "300": 200, "400": 1, "500": 400 }),
      100,
    );
    expect(await reader.readdir("/proc")).toEqual([
      "100",
      "200",
      "300",
      "self",
      "stat",
    ]);
  });

  it("leaves other directories untouched", async () => {
    const reader = descendantsOnly(table({ "100": 1 }), 100);
    expect(await reader.readdir("/proc/100/task")).toEqual([
      "100",
      "self",
      "stat",
    ]);
  });
});
