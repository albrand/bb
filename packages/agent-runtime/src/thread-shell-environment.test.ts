import { describe, expect, it } from "vitest";
import { resolveThreadEnvironment } from "./thread-shell-environment.js";

describe("resolveThreadEnvironment", () => {
  it("passes contributed values to the provider and reports them masked", () => {
    const resolved = resolveThreadEnvironment({
      baseShellEnv: {
        PATH: "/fake/shell/bin",
        BB_SERVER_URL: "http://127.0.0.1:3334",
      },
      contributedEnv: [
        {
          name: "FAKE_PLUGIN_TOKEN",
          value: "fake-secret-123",
          source: { plugin: "fake-pool" },
          reason: "Route the agent through the fake pool",
        },
        {
          name: "FAKE_PROXY_URL",
          value: { serverPath: "/plugins/fake-pool/proxy" },
          source: { plugin: "fake-pool" },
          reason: "Use the pool proxy",
        },
        {
          name: "GH_TOKEN",
          value: "fake-core-secret-456",
          source: { core: "machine-git" },
          reason: "Server gh login",
        },
      ],
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(resolved.envVars).toMatchObject({
      PATH: "/fake/shell/bin",
      FAKE_PLUGIN_TOKEN: "fake-secret-123",
      FAKE_PROXY_URL: "http://127.0.0.1:3334/plugins/fake-pool/proxy",
      GH_TOKEN: "fake-core-secret-456",
    });
    const reported = JSON.stringify(resolved.entries);
    expect(reported).not.toContain("fake-secret-123");
    expect(reported).not.toContain("fake-core-secret-456");
    expect(reported).not.toContain("/plugins/fake-pool/proxy");
    expect(resolved.entries).toEqual(
      expect.arrayContaining([
        { name: "PATH", source: "shell", value: "/fake/shell/bin" },
        {
          name: "FAKE_PLUGIN_TOKEN",
          source: { plugin: "fake-pool" },
          value: { masked: true },
          reason: "Route the agent through the fake pool",
        },
        {
          name: "FAKE_PROXY_URL",
          source: { plugin: "fake-pool" },
          value: { masked: true },
          reason: "Use the pool proxy",
        },
        {
          name: "GH_TOKEN",
          source: { core: "machine-git" },
          value: { masked: true },
          reason: "Server gh login",
        },
      ]),
    );
  });
});
