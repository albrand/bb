import type { ProviderHealthResult } from "@get-bb/plugin-sdk/provider-bridge";
import type { ClaudeAiStatus } from "./host-contract.js";

const SIGN_IN_MESSAGE = "Run `claude auth login` on the primary machine";
const EXPIRED_MESSAGE =
  "The Claude Code sign-in expired and cannot renew. Run `claude auth login` on the primary machine";

export function claudeAiStatusFromHealth(
  result: ProviderHealthResult,
): ClaudeAiStatus {
  if (!result.supported) {
    return { ready: false, message: "Claude Code is not supported here" };
  }
  const { status, statusMessage } = result.health;
  switch (status) {
    case "ready":
      return { ready: true };
    case "expired":
      return {
        ready: false,
        message: statusMessage ?? EXPIRED_MESSAGE,
      };
    case "not_installed":
      return {
        ready: false,
        message: "Install Claude Code on the primary machine",
      };
    case "unauthenticated":
      return { ready: false, message: statusMessage ?? SIGN_IN_MESSAGE };
    default:
      return {
        ready: false,
        message: statusMessage ?? "bb could not read the Claude Code sign-in",
      };
  }
}
