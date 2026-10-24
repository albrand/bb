import type { ProviderHealthResult } from "@get-bb/plugin-sdk/provider-bridge";
import { describe, expect, it } from "vitest";
import { claudeAiStatusFromHealth } from "./claude-status.js";

function health(
  status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unknown",
  statusMessage: string | null = null,
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage,
      accountEmail: null,
      planLabel: null,
      installedVersion: null,
      minimumSupportedVersion: null,
      canInstall: true,
      canUpdate: true,
      loginCommand: "claude auth login",
    },
  } as ProviderHealthResult;
}

describe("claudeAiStatusFromHealth", () => {
  it("is ready when the sign-in is ready, including a lapsed token the CLI renews", () => {
    expect(claudeAiStatusFromHealth(health("ready"))).toEqual({ ready: true });
  });

  it("is not ready when the sign-in expired with nothing to renew it", () => {
    expect(claudeAiStatusFromHealth(health("expired"))).toEqual({
      ready: false,
      message:
        "The Claude Code sign-in expired and cannot renew. Run `claude auth login` on the primary machine",
    });
  });

  it("asks for a sign-in when signed out", () => {
    expect(claudeAiStatusFromHealth(health("unauthenticated"))).toEqual({
      ready: false,
      message: "Run `claude auth login` on the primary machine",
    });
  });

  it("keeps the renewal message when the sign-in was rejected", () => {
    expect(
      claudeAiStatusFromHealth(health("unauthenticated", "Sign in again")),
    ).toEqual({ ready: false, message: "Sign in again" });
  });

  it("asks for an install when the CLI is missing", () => {
    expect(claudeAiStatusFromHealth(health("not_installed"))).toEqual({
      ready: false,
      message: "Install Claude Code on the primary machine",
    });
  });

  it("reports an unreadable sign-in as not ready", () => {
    expect(
      claudeAiStatusFromHealth(health("unknown", "Keychain locked")),
    ).toEqual({ ready: false, message: "Keychain locked" });
  });
});
