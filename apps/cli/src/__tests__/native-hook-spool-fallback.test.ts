import {
  existsSync,
  mkdirSync,
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
  filesystemTypeOf,
  hookSpoolCandidates,
  hookSpoolSupportsLinks,
  openHookCapture,
  openHookSpool,
} from "../native-hook-spool.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function root(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bb-spool-fallback-"));
  roots.push(directory);
  return directory;
}

function groupAndOtherBits(directory: string): number {
  return process.platform === "win32" ? 0 : statSync(directory).mode & 0o077;
}

function refuseLinksUnder(refused: string): (directory: string) => boolean {
  return (directory) =>
    path.dirname(directory) === refused
      ? false
      : hookSpoolSupportsLinks(directory);
}

describe("choosing where the hook spool lives", () => {
  it("lists the system temp directory first, then a valid XDG_RUNTIME_DIR, then a directory under the bb home", () => {
    const base = root();
    const runtime = path.join(base, "run");
    mkdirSync(runtime);
    expect(
      hookSpoolCandidates({
        env: { XDG_RUNTIME_DIR: runtime },
        home: "/home/someone",
        tmpDir: "/tmp",
      }),
    ).toEqual([
      "/tmp",
      runtime,
      path.join("/home/someone", ".bb", "native-terminals", "hooks"),
    ]);
  });

  it("leaves XDG_RUNTIME_DIR out when it is unset, relative, missing or not a directory", () => {
    const base = root();
    const file = path.join(base, "file");
    writeFileSync(file, "");
    const home = path.join(base, "home");
    const expected = [
      "/tmp",
      path.join(home, ".bb", "native-terminals", "hooks"),
    ];
    for (const env of [
      {},
      { XDG_RUNTIME_DIR: "relative/run" },
      { XDG_RUNTIME_DIR: path.join(base, "missing") },
      { XDG_RUNTIME_DIR: file },
    ]) {
      expect(hookSpoolCandidates({ env, home, tmpDir: "/tmp" })).toEqual(
        expected,
      );
    }
  });

  it("ranks a candidate on a network filesystem after the local ones, keeping the order inside each group", () => {
    const base = root();
    const runtime = path.join(base, "run");
    mkdirSync(runtime);
    const home = path.join(base, "home");
    const homeHooks = path.join(home, ".bb", "native-terminals", "hooks");
    const NFS = 0x6969;
    const SMB2 = 0xfe534d42;
    const NINE_P = 0x01021997;
    const ext4 = 0xef53;
    const types = (
      byDirectory: Record<string, number | null>,
    ): ((directory: string) => number | null) => {
      return (directory) => byDirectory[directory] ?? null;
    };
    const rank = (byDirectory: Record<string, number | null>) =>
      hookSpoolCandidates({
        env: { XDG_RUNTIME_DIR: runtime },
        filesystemType: types(byDirectory),
        home,
        tmpDir: "/tmp",
      });
    expect(rank({ "/tmp": NFS, [runtime]: ext4, [homeHooks]: ext4 })).toEqual([
      runtime,
      homeHooks,
      "/tmp",
    ]);
    expect(
      rank({ "/tmp": SMB2, [runtime]: NINE_P, [homeHooks]: ext4 }),
    ).toEqual([homeHooks, "/tmp", runtime]);
    expect(rank({ "/tmp": ext4, [runtime]: ext4, [homeHooks]: NFS })).toEqual([
      "/tmp",
      runtime,
      homeHooks,
    ]);
    expect(rank({ "/tmp": null, [runtime]: null, [homeHooks]: null })).toEqual([
      "/tmp",
      runtime,
      homeHooks,
    ]);
  });

  it("reads the filesystem type of the nearest existing ancestor, and nothing where it is not available", () => {
    const base = root();
    expect(filesystemTypeOf(path.join(base, "not", "there"))).toEqual(
      filesystemTypeOf(base),
    );
    if (process.platform !== "linux") {
      expect(filesystemTypeOf(base)).toBeNull();
    } else {
      expect(typeof filesystemTypeOf(base)).toBe("number");
    }
  });

  it("uses the first candidate when it supports links", () => {
    const [first, second] = [root(), root()];
    const spool = openHookSpool([first, second], "thread");
    expect(spool).not.toBeNull();
    expect(path.dirname(spool ?? "")).toBe(first);
    expect(readdirSync(second)).toEqual([]);
    expect(groupAndOtherBits(spool ?? "")).toBe(0);
  });

  it("falls back to the next candidate when the first refuses links, and never selects the directory whose probe failed", () => {
    const [refusing, working] = [root(), root()];
    const spool = openHookSpool(
      [refusing, working],
      "thread",
      refuseLinksUnder(refusing),
    );
    expect(path.dirname(spool ?? "")).toBe(working);
    expect(readdirSync(refusing)).toEqual([]);
  });

  it("falls back past a candidate that cannot be created at all, and creates a missing private parent", () => {
    const base = root();
    const blocker = path.join(base, "blocker");
    writeFileSync(blocker, "");
    const created = path.join(base, ".bb", "native-terminals", "hooks");
    const spool = openHookSpool(
      [path.join(blocker, "child"), created],
      "thread",
    );
    expect(path.dirname(spool ?? "")).toBe(created);
    expect(groupAndOtherBits(created)).toBe(0);
  });

  it("returns nothing when no candidate supports links, leaving nothing behind", () => {
    const [first, second] = [root(), root()];
    const blocker = path.join(first, "blocker");
    writeFileSync(blocker, "");
    expect(
      openHookSpool(
        [path.join(blocker, "child"), second],
        "thread",
        refuseLinksUnder(second),
      ),
    ).toBeNull();
    expect(readdirSync(second)).toEqual([]);
    expect(existsSync(path.join(blocker, "child"))).toBe(false);
  });

  it("probes a directory that does not exist as unsupported", () => {
    expect(hookSpoolSupportsLinks(path.join(root(), "missing"))).toBe(false);
  });
});

describe("choosing how hook events are captured", () => {
  const record = () => {
    const calls = { appendFallback: 0, unsupported: 0 };
    return {
      calls,
      events: {
        appendFallback: () => {
          calls.appendFallback += 1;
        },
        unsupported: () => {
          calls.unsupported += 1;
        },
      },
    };
  };

  it("captures through the link spool when a candidate supports links, and logs nothing", () => {
    const parent = root();
    const { calls, events } = record();
    const capture = openHookCapture([parent], "thread", events);
    expect(typeof capture.source).toBe("string");
    expect(path.dirname(capture.directory ?? "")).toBe(parent);
    expect(calls).toEqual({ appendFallback: 0, unsupported: 0 });
  });

  it("uses a private append file as the last resort when every link probe fails, and logs the fallback once", () => {
    const [first, second] = [root(), root()];
    const { calls, events } = record();
    const capture = openHookCapture(
      [first, second],
      "thread",
      events,
      () => false,
    );
    if (
      typeof capture.source !== "object" ||
      !("appendFile" in capture.source)
    ) {
      throw new Error("expected the append fallback");
    }
    expect(path.dirname(path.dirname(capture.source.appendFile))).toBe(first);
    expect(path.dirname(capture.source.appendFile)).toBe(capture.directory);
    expect(statSync(capture.source.appendFile).size).toBe(0);
    expect(groupAndOtherBits(capture.directory ?? "")).toBe(0);
    expect(readdirSync(second)).toEqual([]);
    expect(calls).toEqual({ appendFallback: 1, unsupported: 0 });
  });

  it("reports the capture as unavailable, once, only when not even the append file can be created", () => {
    const base = root();
    const blocker = path.join(base, "blocker");
    writeFileSync(blocker, "");
    const { calls, events } = record();
    const capture = openHookCapture(
      [path.join(blocker, "a"), path.join(blocker, "b")],
      "thread",
      events,
    );
    expect(capture).toEqual({ directory: null, source: { unavailable: true } });
    expect(calls).toEqual({ appendFallback: 0, unsupported: 1 });
  });
});
