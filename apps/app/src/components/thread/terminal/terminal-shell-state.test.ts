import { describe, expect, it, vi } from "vitest";
import {
  parseTerminalShellOsc,
  clearTerminalCurrentCwd,
  getTerminalCurrentCwd,
  terminalPromptLine,
  terminalCwdTitle,
  shouldUseTerminalCwdTitle,
  terminalSpawnCwd,
  setTerminalCurrentCwd,
  parseTerminalOsc52Copy,
  registerTerminalOsc52Handler,
} from "./terminal-shell-state";

describe("terminal shell OSC state", () => {
  it("offers OSC 52 copy payloads and ignores queries and retained replays", () => {
    expect(parseTerminalOsc52Copy("c;b2s=")).toBe("ok");
    expect(parseTerminalOsc52Copy("c;?")).toBeNull();
    expect(parseTerminalOsc52Copy("p;b2s=")).toBeNull();

    let handler: ((data: string) => boolean) | undefined;
    let isReplay = true;
    const onCopy = vi.fn();
    const dispose = registerTerminalOsc52Handler(
      {
        parser: {
          registerOscHandler(_identifier, callback) {
            handler = callback;
            return { dispose: () => {} };
          },
        },
      },
      onCopy,
      () => isReplay,
    );
    expect(handler?.("c;b2s=")).toBe(true);
    expect(onCopy).not.toHaveBeenCalled();
    isReplay = false;
    expect(handler?.("c;b2s=")).toBe(true);
    expect(onCopy).toHaveBeenCalledWith("ok");
    dispose.dispose();
  });
  it("parses OSC 7 local file URLs and normalizes their paths", () => {
    expect(parseTerminalShellOsc(7, "file://localhost/tmp/a/../b")).toEqual({
      type: "cwd",
      cwd: "/tmp/b",
    });
    expect(parseTerminalShellOsc(7, "file:///tmp/a%20b")).toEqual({
      type: "cwd",
      cwd: "/tmp/a b",
    });
    expect(
      parseTerminalShellOsc(7, "file://localhost/tmp%2F..%2F..%2Fsecret"),
    ).toEqual({ type: "cwd", cwd: "/secret" });
  });

  it.each([
    ["/tmp/q%3Fx", "/tmp/q?x"],
    ["/tmp/h%23x", "/tmp/h#x"],
    ["/tmp/p%2520x", "/tmp/p%20x"],
    ["/tmp/s%20p", "/tmp/s p"],
    ["/tmp/caf%C3%A9", "/tmp/café"],
  ])("decodes an encoded OSC 7 path once: %s", (encodedPath, cwd) => {
    expect(parseTerminalShellOsc(7, `file://localhost${encodedPath}`)).toEqual({
      type: "cwd",
      cwd,
    });
  });

  it.each([
    "https://example.com/tmp",
    "file://attacker.example/tmp",
    "file://localhost/tmp%00evil",
    "file://user@localhost/tmp",
    "file://localhost:42/tmp",
    "file://localhost/tmp?cmd=touch",
    "file://localhost/%ZZ",
    `file://localhost/${"a".repeat(5000)}`,
  ])("rejects hostile OSC 7 payload %s", (payload) => {
    expect(parseTerminalShellOsc(7, payload)).toBeNull();
  });

  it("parses OSC 133 and VS Code OSC 633 command boundaries", () => {
    expect(parseTerminalShellOsc(133, "A")).toEqual({ type: "prompt-start" });
    expect(parseTerminalShellOsc(633, "B")).toEqual({ type: "command-start" });
    expect(parseTerminalShellOsc(633, "C")).toEqual({ type: "command-start" });
    expect(parseTerminalShellOsc(633, "P;Cwd=/tmp/work/../project")).toEqual({
      type: "cwd",
      cwd: "/tmp/project",
    });
    expect(parseTerminalShellOsc(133, "D;1")).toEqual({
      type: "command-finish",
      exitCode: 1,
    });
    expect(parseTerminalShellOsc(133, "D;0")).toEqual({
      type: "command-finish",
      exitCode: 0,
    });
    expect(parseTerminalShellOsc(133, "D;$(touch /tmp/pwned)")).toBeNull();
    expect(parseTerminalShellOsc(633, "D;not-a-number")).toBeNull();
  });

  it("uses a cwd leaf as the default title", () => {
    expect(terminalCwdTitle("/tmp/work/../project")).toBe("project");
  });

  it("preserves a user-set title when cwd changes", () => {
    expect(
      shouldUseTerminalCwdTitle({
        currentTitle: "src",
        defaultTitle: "zsh",
        previousCwdTitle: "src",
      }),
    ).toBe(true);
    expect(
      shouldUseTerminalCwdTitle({
        currentTitle: "project name",
        defaultTitle: "zsh",
        previousCwdTitle: "src",
      }),
    ).toBe(false);
  });

  it("inherits the reported cwd for a split and otherwise uses the initial cwd", () => {
    expect(
      terminalSpawnCwd({ currentCwd: "/tmp/current", initialCwd: "/root" }),
    ).toBe("/tmp/current");
    expect(
      terminalSpawnCwd({ currentCwd: undefined, initialCwd: "/root" }),
    ).toBe("/root");
    expect(terminalSpawnCwd({ currentCwd: undefined, initialCwd: "~" })).toBe(
      undefined,
    );
  });

  it("shares reported cwd with other terminal creation surfaces", () => {
    setTerminalCurrentCwd("term-focused", "/tmp/current");
    expect(getTerminalCurrentCwd("term-focused")).toBe("/tmp/current");
    clearTerminalCurrentCwd("term-focused");
    expect(getTerminalCurrentCwd("term-focused")).toBeUndefined();
  });

  it("finds the previous and next prompt boundary around the viewport", () => {
    expect(terminalPromptLine([2, 8, 13], 9, "previous")).toBe(8);
    expect(terminalPromptLine([2, 8, 13], 9, "next")).toBe(13);
    expect(terminalPromptLine([2, 8, 13], 2, "previous")).toBeNull();
  });
});
