import { describe, expect, it } from "vitest";
import { normalizeTerminalTitle } from "./thread-terminal-title";

describe("terminal title normalization", () => {
  it("returns null for blank titles", () => {
    expect(normalizeTerminalTitle({ title: "  " })).toBeNull();
  });

  it("trims ordinary titles without changing their content", () => {
    expect(normalizeTerminalTitle({ title: "  Edited title  " })).toBe(
      "Edited title",
    );
  });

  it("does not split an astral character at the title limit", () => {
    const prefix = "x".repeat(199);
    expect(normalizeTerminalTitle({ title: `${prefix}𠮷tail` })).toBe(prefix);
  });

  it("uses the shell path leaf as the live terminal title", () => {
    expect(
      normalizeTerminalTitle({
        title:
          "michael@Michaels-MacBook-Pro:~/.bb-dev/worktrees/env_gj4ep9emi8/bb",
      }),
    ).toBe("bb");
  });

  it("uses the shell path leaf when the host separator has whitespace", () => {
    expect(
      normalizeTerminalTitle({
        title: "root@do-1: ~/.bb/worktrees/env_4gfkk8evua/bb",
      }),
    ).toBe("bb");
  });

  it("uses a short shell path title", () => {
    expect(
      normalizeTerminalTitle({
        title: "michael@host:~/bb",
      }),
    ).toBe("bb");
  });
});
