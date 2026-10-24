import { describe, expect, it } from "vitest";
import type { Logger } from "@bb/logger";
import { createTestAppHarness, testLogger } from "../helpers/test-app.js";

describe("thread list slow API attribution", () => {
  it("logs safe request shape and client kind for slow thread list requests", async () => {
    const harness = await createTestAppHarness();
    const records: Array<{ fields: Record<string, unknown>; message: string }> =
      [];
    const logger = {
      ...testLogger,
      debug(...args: Parameters<Logger["debug"]>): void {
        if (args[1] === "Slow API request") {
          records.push({
            fields: args[0] as Record<string, unknown>,
            message: args[1],
          });
        }
      },
    };
    const serverApp = (await import("../../src/server.js")).createApp(
      { ...harness.deps, logger },
      { slowApiRequestLogThresholdMs: 0 },
    );
    try {
      const privateFilterValue = "thr_private_filter_value";
      const response = await serverApp.app.request(
        `/api/v1/threads?threadIds=${privateFilterValue}&includeHidden=true&limit=7&offset=2`,
        { headers: { "x-bb-app-surface": "cli", "user-agent": "node" } },
      );

      expect(response.status).toBe(200);
      const record = records.find(
        (entry) => entry.message === "Slow API request",
      );
      expect(JSON.stringify(record)).not.toContain(privateFilterValue);
      expect(record?.fields).toMatchObject({
        clientKind: { appSurface: "cli", userAgentKind: "node" },
        method: "GET",
        path: "/api/v1/threads",
        requestShape: {
          archived: "absent",
          filters: ["threadIds"],
          includeHidden: true,
          limit: 7,
          offset: 2,
        },
        status: 200,
      });
    } finally {
      await serverApp.closeWebSockets();
      await harness.cleanup();
    }
  });
});
