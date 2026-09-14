import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(
    new URL("../../src/services/threads/thread-runtime-display.ts", import.meta.url),
  ),
  "utf8",
);

describe("workspace sharing is a display detail, not a load requirement", () => {
  it("resolves sharing inside a try that falls back to null", () => {
    const block = source.slice(
      source.indexOf("workspaceSharing:"),
      source.indexOf("function resolveWorkspaceSharing"),
    );
    expect(block).toMatch(/try\s*\{/u);
    expect(block).toMatch(/catch\s*\{\s*return null;/u);
  });

  it("keeps the query that reads the environments table out of the caller", () => {
    expect(source).toMatch(/function resolveWorkspaceSharing\(/u);
  });
});
