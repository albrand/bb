import type { ReauthProviderId } from "../contract.js";

export const HEADLESS_EXIT_CODE = 64;

const LOGIN_CLI_COMMANDS: Record<ReauthProviderId, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
};

export function loginTerminalTitle(providerId: ReauthProviderId): string {
  return `bb sign-in: ${providerId}`;
}

export function loginTerminalCommand(providerId: ReauthProviderId): string {
  const cli = LOGIN_CLI_COMMANDS[providerId];
  return `[ "$(uname)" = Darwin ] && [ "$(launchctl managername 2>/dev/null)" = Aqua ] || exit ${HEADLESS_EXIT_CODE}; exec ${cli}`;
}
