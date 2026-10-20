import { describe, expect, it } from "vitest";
import { parseTerminalProgressOsc } from "./terminal-progress";

describe("terminal progress OSC", () => {
  it("converts OSC 9;4 progress values to thread progress fractions", () => {
    expect(parseTerminalProgressOsc("4;1;75")).toBe(0.75);
  });

  it("clears progress for OSC 9;4 state zero", () => {
    expect(parseTerminalProgressOsc("4;0")).toBeNull();
  });

  it("ignores unrelated and invalid progress payloads", () => {
    expect(parseTerminalProgressOsc("3;1;75")).toBeUndefined();
    expect(parseTerminalProgressOsc("4;1;101")).toBeUndefined();
    expect(parseTerminalProgressOsc("4;wat")).toBeUndefined();
  });
});
