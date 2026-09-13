import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const PLUGIN_ID = "provider-reauth";

function createHost() {
  return createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      system: {
        providerStates: async () => ({
          providers: [
            {
              providerId: "claude-code",
              displayName: "Claude Code",
              status: "ready",
            },
          ],
        }),
      },
    },
  });
}

describe("provider re-auth plugin", () => {
  it("registers the sign-in verb and its rpc", async () => {
    const host = createHost();

    await plugin(host.bb);

    expect(host.harness.registrations.cli?.name).toBe("provider-signin");
    expect(
      host.harness.registrations.cli?.commands.map((command) => command.name),
    ).toEqual(["claude-code", "codex", "status"]);
    expect(host.harness.registrations.rpcMethods).toEqual([
      "reauth.start",
      "reauth.status",
    ]);
    await host.harness.dispose();
  });

  it("does not start a sign-in for a provider that is already ready", async () => {
    const host = createHost();
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("reauth.start", {
        providerId: "claude-code",
        hostId: "host-one",
      }),
    ).resolves.toEqual({ started: false, reason: "already-ready" });
    await host.harness.dispose();
  });

  it("reports nothing running before any sign-in starts", async () => {
    const host = createHost();
    await plugin(host.bb);

    const status = await host.harness.behavior.runCli(["status"]);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toBe("No provider sign-in is running.\n");
    await host.harness.dispose();
  });

  it("rejects a sign-in request without a host", async () => {
    const host = createHost();
    await plugin(host.bb);

    const result = await host.harness.behavior.runCli(["claude-code"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--host <host-id>");
    await host.harness.dispose();
  });
});
