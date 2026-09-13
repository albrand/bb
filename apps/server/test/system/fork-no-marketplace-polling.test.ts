import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const startServerSource = readFileSync(
  fileURLToPath(new URL("../../src/start-server.ts", import.meta.url)),
  "utf8",
);

describe("fork: nothing polls the marketplace on a timer", () => {
  it("does not start the periodic catalog refresh at server start", () => {
    expect(startServerSource).not.toMatch(/startPeriodicRefresh\(\)/u);
  });

  it("still exposes an on-demand refresh", () => {
    const routeSource = readFileSync(
      fileURLToPath(new URL("../../src/routes/plugin-catalog.ts", import.meta.url)),
      "utf8",
    );
    expect(routeSource).toMatch(/refreshMarketplaces\(/u);
  });
});
