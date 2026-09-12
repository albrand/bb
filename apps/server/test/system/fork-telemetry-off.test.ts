import { describe, expect, it } from "vitest";
import { loadServerConfig } from "@bb/config/server";

// The loader needs these to resolve at all outside a real install; they say
// nothing about telemetry.
const BASE_ENV = {
  BB_DATA_DIR: "/tmp/fork-telemetry-off",
  BB_HOST_DAEMON_PORT: "49162",
  BB_SERVER_PORT: "49161",
  NODE_ENV: "development",
} as const;
import { createTelemetryService } from "../../src/services/system/telemetry.js";

/**
 * This fork sends no usage events anywhere. A default key or a default-true
 * flag would reinstate them silently on the next upstream merge, so both are
 * asserted here rather than left to review.
 */
describe("fork: telemetry is off by default", () => {
  it("resolves to no PostHog key and no opt-in, with nothing set", () => {
    const config = loadServerConfig({ env: { ...BASE_ENV } });
    expect(config.BB_POSTHOG_API_KEY).toBe("");
    expect(config.BB_TELEMETRY).toBe(false);
  });

  it("still lets someone opt in explicitly", () => {
    const config = loadServerConfig({
      env: { ...BASE_ENV, BB_POSTHOG_API_KEY: "phc_example", BB_TELEMETRY: "true" },
    });
    expect(config.BB_POSTHOG_API_KEY).toBe("phc_example");
    expect(config.BB_TELEMETRY).toBe(true);
  });

  it("captures nothing when built with those defaults, even if enabled", async () => {
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof globalThis.fetch;
    try {
      const telemetry = await createTelemetryService({
        apiKey: loadServerConfig({ env: { ...BASE_ENV } }).BB_POSTHOG_API_KEY,
        appSurface: "desktop",
        appVersion: "0.42.1",
        dataDir: "/tmp/fork-telemetry-off",
        // Even with the flag forced on, an empty key must keep it silent.
        enabled: true,
        logger: {
          debug: () => {},
          error: () => {},
          info: () => {},
          warn: () => {},
        } as never,
      });
      telemetry.capture({ name: "app_started" });
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
