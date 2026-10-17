import { describe, expect, it } from "vitest";
import { REAUTH_PROVIDERS } from "../contract.js";
import { loginTerminalCommand, loginTerminalTitle } from "./login-command.js";

describe("provider sign-in command", () => {
  it("keeps desktop sign-in on the local Aqua session", () => {
    expect(loginTerminalCommand("claude-code", true)).toBe(
      '[ "$(uname)" = Darwin ] && [ "$(launchctl managername 2>/dev/null)" = Aqua ] || exit 64; exec claude auth login',
    );
    expect(loginTerminalCommand("codex", true)).toBe(
      '[ "$(uname)" = Darwin ] && [ "$(launchctl managername 2>/dev/null)" = Aqua ] || exit 64; exec codex login',
    );
  });

  it("uses callback-free login commands for remote hosts", () => {
    expect(loginTerminalCommand("claude-code", false)).toBe(
      "exec claude auth login",
    );
    expect(loginTerminalCommand("codex", false)).toBe(
      "exec codex login --device-auth",
    );
  });

  it("keeps terminal titles stable", () => {
    expect(REAUTH_PROVIDERS.map(loginTerminalTitle)).toEqual([
      "bb sign-in: claude-code",
      "bb sign-in: codex",
    ]);
  });
});
