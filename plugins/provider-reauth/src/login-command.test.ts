import { describe, expect, it } from "vitest";
import { REAUTH_PROVIDERS } from "../contract.js";
import { loginTerminalCommand, loginTerminalTitle } from "./login-command.js";

describe("provider sign-in command", () => {
  it("is a fixed string per provider, with nothing interpolated into it", () => {
    expect(loginTerminalCommand("claude-code")).toBe(
      '[ "$(uname)" = Darwin ] && [ "$(launchctl managername 2>/dev/null)" = Aqua ] || exit 64; exec claude auth login',
    );
    expect(loginTerminalCommand("codex")).toBe(
      '[ "$(uname)" = Darwin ] && [ "$(launchctl managername 2>/dev/null)" = Aqua ] || exit 64; exec codex login',
    );
    expect(REAUTH_PROVIDERS.map(loginTerminalTitle)).toEqual([
      "bb sign-in: claude-code",
      "bb sign-in: codex",
    ]);
  });
});
