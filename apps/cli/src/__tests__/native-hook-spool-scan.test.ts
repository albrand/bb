import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HookSpoolReader,
  MAX_LATE_PROBES_PER_SCAN,
  SPOOL_SCAN_BATCH,
  type OpenDirectoryCursor,
} from "../native-hook-spool.js";

const START = 1_000_000_000_000;
const POLL_MS = 750;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function newSpool(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bb-spool-scan-"));
  roots.push(directory);
  return directory;
}

function publish(spool: string, sequence: number, tool: string): void {
  const name = String(sequence).padStart(12, "0");
  const record = { hook_event_name: "PermissionRequest", tool_name: tool };
  writeFileSync(path.join(spool, name), JSON.stringify(record));
}

function scripted(
  names: string[],
  options: { chunk?: number; fail?: boolean; stall?: boolean },
) {
  const served = { calls: [] as number[], closes: 0, opens: 0 };
  const open: OpenDirectoryCursor = () => {
    served.opens += 1;
    let position = 0;
    return {
      close: () => {
        served.closes += 1;
      },
      readBatch: (max) => {
        if (options.fail === true) throw new Error("listing failed");
        const size = Math.min(max, options.chunk ?? max);
        const taken = names.slice(position, position + size);
        position += taken.length;
        served.calls.push(taken.length);
        const exhausted = position >= names.length;
        return { done: exhausted && options.stall !== true, names: taken };
      },
    };
  };
  return { open, served };
}

const toolOf = (record: unknown): string =>
  typeof record === "object" && record !== null && "tool_name" in record
    ? String(record.tool_name)
    : "";

const nothing = { records: [], unreadable: 0 };

describe("the spool reader maintains its directory in bounded steps", () => {
  it("reads at most one batch of entries per poll, however many entries the directory has", () => {
    const spool = newSpool();
    const names = Array.from({ length: 10_000 }, (_, index) => `kept-${index}`);
    const { open, served } = scripted(names, {});
    const reader = new HookSpoolReader(spool, open);
    for (let poll = 0; poll < 4; poll += 1) {
      expect(reader.read(START + poll * 2_000)).toEqual(nothing);
    }
    expect(served.calls).toEqual([
      SPOOL_SCAN_BATCH,
      SPOOL_SCAN_BATCH,
      1_808,
      SPOOL_SCAN_BATCH,
    ]);
    expect(served.opens).toBe(2);
  });

  it("reads a ready next record at the next poll while maintenance is pending", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open, served } = scripted(names, { stall: true });
    const reader = new HookSpoolReader(spool, open);
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      publish(spool, sequence, `Tool${sequence}`);
      const read = reader.read(START + sequence * POLL_MS);
      expect(read.records.map(toolOf)).toEqual([`Tool${sequence}`]);
      expect(read.unreadable).toBe(0);
    }
    expect(Math.max(...served.calls)).toBeLessThanOrEqual(SPOOL_SCAN_BATCH);
    expect(served.opens).toBe(1);
  });

  it("reads a ready next record at the next poll while maintenance is slow", () => {
    const spool = newSpool();
    const { open, served } = scripted(["kept-1", "kept-2", "kept-3"], {
      chunk: 1,
    });
    const reader = new HookSpoolReader(spool, open);
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      publish(spool, sequence, `Tool${sequence}`);
      const read = reader.read(START + sequence * POLL_MS);
      expect(read.records.map(toolOf)).toEqual([`Tool${sequence}`]);
    }
    expect(Math.max(...served.calls)).toBe(1);
  });

  it("still finds an abandoned temp file once the pass reaches it, and counts it once", () => {
    const spool = newSpool();
    publish(spool, 1, "One");
    const dead = spawnSync("sh", ["-c", "echo $$"]).stdout.toString().trim();
    const temp = `.tmp.${dead}.abcdef`;
    writeFileSync(path.join(spool, temp), "{");
    const { open } = scripted(["000000000001", "kept-a", "kept-b", temp], {
      chunk: 1,
    });
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    expect(reader.read(START + 2_000)).toEqual(nothing);
    expect(reader.read(START + 4_000)).toEqual(nothing);
    expect(reader.read(START + 6_000)).toEqual({ records: [], unreadable: 1 });
    expect(reader.read(START + 8_000)).toEqual(nothing);
    expect(reader.read(START + 10_000)).toEqual(nothing);
  });

  it("finds a gap beyond the forward probe from the pass when the hint regressed, skips it in steps and counts the loss once", () => {
    const spool = newSpool();
    publish(spool, 1, "One");
    publish(spool, 200, "Far");
    writeFileSync(path.join(spool, ".hint"), "1");
    const reader = new HookSpoolReader(spool);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    for (const offset of [2_000, 4_000, 6_000, 8_000]) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    expect(reader.read(START + 10_000)).toEqual({ records: [], unreadable: 1 });
    expect(reader.read(START + 12_000)).toEqual(nothing);
    expect(reader.read(START + 14_000)).toEqual(nothing);
    const last = reader.read(START + 16_000);
    expect(last.records.map(toolOf)).toEqual(["Far"]);
    expect(last.unreadable).toBe(0);
    expect(statSync(path.join(spool, "000000000002")).size).toBe(0);
  });

  it("finds a near gap by probing forward when the hint regressed and the pass never finishes", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    publish(spool, 6, "Six");
    writeFileSync(path.join(spool, ".hint"), "1");
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    for (const offset of [2_000, 4_000, 6_000, 8_000]) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    const skipped = reader.read(START + 10_000);
    expect(skipped.records.map(toolOf)).toEqual(["Six"]);
    expect(skipped.unreadable).toBe(1);
    expect(statSync(path.join(spool, "000000000005")).size).toBe(0);
  });

  it("uses the hint as an early positive signal for a gap beyond the forward probe while the pass is pending", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    publish(spool, 200, "Far");
    writeFileSync(path.join(spool, ".hint"), "200");
    for (const offset of [2_000, 4_000, 6_000, 8_000, 10_000]) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    expect(reader.read(START + 12_000)).toEqual({ records: [], unreadable: 1 });
    expect(reader.read(START + 14_000)).toEqual(nothing);
    expect(reader.read(START + 16_000)).toEqual(nothing);
    const last = reader.read(START + 18_000);
    expect(last.records.map(toolOf)).toEqual(["Far"]);
    expect(last.unreadable).toBe(0);
  });

  it("keeps a gap target seen only through the hint after the hint regresses, counting the loss once", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    publish(spool, 200, "Far");
    writeFileSync(path.join(spool, ".hint"), "200");
    for (const offset of [2_000, 4_000, 6_000, 8_000, 10_000]) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    expect(reader.read(START + 12_000)).toEqual({ records: [], unreadable: 1 });
    writeFileSync(path.join(spool, ".hint"), "1");
    expect(reader.read(START + 14_000)).toEqual(nothing);
    writeFileSync(path.join(spool, ".hint"), "200");
    expect(reader.read(START + 16_000)).toEqual(nothing);
    const last = reader.read(START + 18_000);
    expect(last.records.map(toolOf)).toEqual(["Far"]);
    expect(last.unreadable).toBe(0);
    expect(statSync(path.join(spool, "000000000199")).size).toBe(0);
    let total = 1;
    for (let offset = 20_000; offset <= 40_000; offset += 2_000) {
      const read = reader.read(START + offset);
      expect(read.records).toEqual([]);
      total += read.unreadable;
    }
    expect(total).toBe(1);
  });

  it("keeps a hint-only gap target across a published file that a reservation meets, then skips the second gap after its own wait", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    publish(spool, 40, "Mid");
    publish(spool, 200, "Far");
    writeFileSync(path.join(spool, ".hint"), "200");
    for (const offset of [2_000, 4_000, 6_000, 8_000, 10_000]) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    const first = reader.read(START + 12_000);
    expect(first.records.map(toolOf)).toEqual(["Mid"]);
    expect(first.unreadable).toBe(1);
    writeFileSync(path.join(spool, ".hint"), "1");
    for (const offset of [14_000, 16_000, 18_000, 20_000, 22_000]) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    expect(reader.read(START + 24_000)).toEqual({ records: [], unreadable: 1 });
    expect(reader.read(START + 26_000)).toEqual(nothing);
    const last = reader.read(START + 28_000);
    expect(last.records.map(toolOf)).toEqual(["Far"]);
    expect(last.unreadable).toBe(0);
    expect(reader.read(START + 30_000)).toEqual(nothing);
  });

  it("keeps a hint-only gap target when the next file already exists at scan time, then skips the later gap after its own wait", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    publish(spool, 3_000, "Far");
    writeFileSync(path.join(spool, ".hint"), "3000");
    expect(reader.read(START + 2_000)).toEqual(nothing);
    writeFileSync(path.join(spool, ".hint"), "1");
    for (let sequence = 2; sequence <= 2_101; sequence += 1) {
      publish(spool, sequence, "Burst");
    }
    const burst = reader.read(START + 4_000);
    expect(burst.records).toHaveLength(2_100);
    expect(burst.unreadable).toBe(0);
    for (let offset = 6_000; offset <= 14_000; offset += 2_000) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    expect(reader.read(START + 16_000)).toEqual({ records: [], unreadable: 1 });
    for (let offset = 18_000; offset <= 42_000; offset += 2_000) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    const last = reader.read(START + 44_000);
    expect(last.records.map(toolOf)).toEqual(["Far"]);
    expect(last.unreadable).toBe(0);
    expect(reader.read(START + 46_000)).toEqual(nothing);
  });

  it("ignores a hint whose file does not exist, also after it regresses: no reservations and no loss", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    writeFileSync(path.join(spool, ".hint"), "5000");
    let lost = 0;
    for (let offset = 2_000; offset <= 20_000; offset += 2_000) {
      const read = reader.read(START + offset);
      expect(read.records).toEqual([]);
      lost += read.unreadable;
    }
    writeFileSync(path.join(spool, ".hint"), "1");
    for (let offset = 22_000; offset <= 40_000; offset += 2_000) {
      const read = reader.read(START + offset);
      expect(read.records).toEqual([]);
      lost += read.unreadable;
    }
    expect(lost).toBe(0);
    expect(readdirSync(spool).sort()).toEqual([".hint", "000000000001"]);
  });

  it("drops a kept gap target when its file is gone, counting that as one loss and making no reservations", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    publish(spool, 200, "Far");
    writeFileSync(path.join(spool, ".hint"), "200");
    expect(reader.read(START + 2_000)).toEqual(nothing);
    rmSync(path.join(spool, "000000000200"));
    writeFileSync(path.join(spool, ".hint"), "1");
    let lost = 0;
    for (let offset = 4_000; offset <= 40_000; offset += 2_000) {
      const read = reader.read(START + offset);
      expect(read.records).toEqual([]);
      lost += read.unreadable;
    }
    expect(lost).toBe(1);
    expect(readdirSync(spool).sort()).toEqual([".hint", "000000000001"]);
  });

  it("counts a target whose file is removed after a pass listed it once, and skips the numbers up to it", () => {
    const spool = newSpool();
    publish(spool, 1, "One");
    publish(spool, 200, "Far");
    const reader = new HookSpoolReader(spool);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    rmSync(path.join(spool, "000000000200"));
    const perPoll: number[] = [];
    for (let offset = 2_000; offset <= 40_000; offset += 2_000) {
      const read = reader.read(START + offset);
      expect(read.records).toEqual([]);
      perPoll.push(read.unreadable);
    }
    expect(perPoll).toEqual([1, ...Array.from({ length: 19 }, () => 0)]);
    const reserved = Array.from({ length: 199 }, (_, index) =>
      String(index + 1).padStart(12, "0"),
    );
    expect(readdirSync(spool).sort()).toEqual(reserved);
  });

  it("counts a gap toward a nearer file as well when the deleted target is found before that gap's wait ends", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    publish(spool, 40, "Mid");
    publish(spool, 200, "Far");
    writeFileSync(path.join(spool, ".hint"), "200");
    expect(reader.read(START + 2_000)).toEqual(nothing);
    rmSync(path.join(spool, "000000000200"));
    writeFileSync(path.join(spool, ".hint"), "1");
    expect(reader.read(START + 4_000)).toEqual({ records: [], unreadable: 1 });
    for (const offset of [6_000, 8_000, 10_000]) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    const mid = reader.read(START + 12_000);
    expect(mid.records.map(toolOf)).toEqual(["Mid"]);
    expect(mid.unreadable).toBe(1);
    for (let offset = 14_000; offset <= 40_000; offset += 2_000) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
  });

  it("keeps a gap target when the stat of its file is inconclusive, without counting or clearing it, and completes the gap later", () => {
    const spool = newSpool();
    const names = Array.from({ length: 50_000 }, (_, index) => `kept-${index}`);
    const { open } = scripted(names, { stall: true });
    publish(spool, 1, "One");
    const reader = new HookSpoolReader(spool, open, () => "unknown");
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    publish(spool, 200, "Far");
    writeFileSync(path.join(spool, ".hint"), "200");
    expect(reader.read(START + 2_000)).toEqual(nothing);
    writeFileSync(path.join(spool, ".hint"), "1");
    for (const offset of [4_000, 6_000, 8_000, 10_000]) {
      expect(reader.read(START + offset)).toEqual(nothing);
    }
    expect(reader.read(START + 12_000)).toEqual({ records: [], unreadable: 1 });
    expect(reader.read(START + 14_000)).toEqual(nothing);
    expect(reader.read(START + 16_000)).toEqual(nothing);
    const last = reader.read(START + 18_000);
    expect(last.records.map(toolOf)).toEqual(["Far"]);
    expect(last.unreadable).toBe(0);
  });

  it("still counts content that appears in a skipped number at the next poll", () => {
    const spool = newSpool();
    publish(spool, 1, "One");
    publish(spool, 3, "Three");
    const reader = new HookSpoolReader(spool);
    for (const offset of [0, 2_000, 4_000, 6_000, 8_000, 10_000, 12_000]) {
      reader.read(START + offset);
    }
    writeFileSync(path.join(spool, "000000000002"), "{}");
    expect(reader.read(START + 14_000)).toEqual({ records: [], unreadable: 1 });
    expect(reader.read(START + 16_000)).toEqual(nothing);
  });

  it("re-probes every skipped number in turn, the oldest and one past the first probe budget included", () => {
    const spool = newSpool();
    publish(spool, 1, "One");
    publish(spool, 701, "Far");
    const reader = new HookSpoolReader(spool);
    const seen: string[] = [];
    let unreadable = 0;
    for (let offset = 0; offset <= 30_000; offset += 2_000) {
      const read = reader.read(START + offset);
      seen.push(...read.records.map(toolOf));
      unreadable += read.unreadable;
    }
    expect(seen).toEqual(["One", "Far"]);
    expect(unreadable).toBe(1);
    writeFileSync(path.join(spool, "000000000002"), "{}");
    writeFileSync(path.join(spool, "000000000500"), "{}");
    let late = 0;
    for (let offset = 32_000; offset <= 36_000; offset += 2_000) {
      late += reader.read(START + offset).unreadable;
    }
    expect(late).toBe(2);
    expect(reader.read(START + 38_000)).toEqual(nothing);
  });

  it("bounds the work of the late-range traversal per poll however many historical ranges there are, and still finds a late record inside an old range", () => {
    const spool = newSpool();
    const reader = new HookSpoolReader(spool);
    const ranges = Array.from({ length: 5_000 }, (_, index) => ({
      from: 2 * index + 10,
      to: 2 * index + 11,
    }));
    let reads = 0;
    const counted = new Proxy(ranges, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    Reflect.set(reader, "skipped", counted);
    Reflect.set(reader, "next", 20_000);
    writeFileSync(
      path.join(spool, String(2 * 4_000 + 10).padStart(12, "0")),
      "{}",
    );
    let busiest = 0;
    let found = -1;
    for (let poll = 0; poll < 80; poll += 1) {
      reads = 0;
      const read = reader.read(START + poll * 2_000);
      busiest = Math.max(busiest, reads);
      if (found < 0 && read.unreadable > 0) found = poll;
    }
    expect(busiest).toBeLessThanOrEqual(MAX_LATE_PROBES_PER_SCAN + 2);
    expect(found).toBeGreaterThanOrEqual(0);
    expect(found).toBeLessThan(80);
  });

  it("closes the directory handle when a pass finishes", () => {
    const spool = newSpool();
    const { open, served } = scripted(["kept-1", "kept-2"], {});
    const reader = new HookSpoolReader(spool, open);
    reader.read(START);
    expect(served.opens).toBe(1);
    expect(served.closes).toBe(1);
    reader.read(START + 2_000);
    expect(served.opens).toBe(2);
    expect(served.closes).toBe(2);
  });

  it("closes the directory handle when listing throws, and starts a new pass at the next tick", () => {
    const spool = newSpool();
    publish(spool, 1, "One");
    const { open, served } = scripted(["kept-1"], { fail: true });
    const reader = new HookSpoolReader(spool, open);
    expect(reader.read(START).records.map(toolOf)).toEqual(["One"]);
    expect(served).toMatchObject({ closes: 1, opens: 1 });
    expect(reader.read(START + 2_000)).toEqual(nothing);
    expect(served).toMatchObject({ closes: 2, opens: 2 });
  });
});
