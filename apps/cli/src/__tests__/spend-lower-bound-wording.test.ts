import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SPEND_COMMAND = readFileSync(
  fileURLToPath(new URL("../commands/spend.ts", import.meta.url)),
  "utf8",
);

/**
 * What the command PRINTS, with comments stripped.
 *
 * The comments explain why the forbidden words are forbidden, so checking the
 * whole file would fail on its own rationale.
 */
const PRINTED = SPEND_COMMAND.split("\n")
  .filter((line) => {
    const trimmed = line.trim();
    return (
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("*") &&
      !trimmed.startsWith("/*")
    );
  })
  .join("\n");

// A thread that spent tokens before this rollup existed reports a LOWER BOUND,
// because bb had already deleted its usage events and deletion leaves no trace.
// There is no missing amount, so any wording that implies one invites the reader
// to imagine a gap bb could have measured and did not. Pinned because it is the
// kind of phrasing a later edit tightens back into "incomplete" without noticing
// it has changed the claim.
describe("spend lower-bound wording", () => {
  it("says at-least rather than naming a deficiency", () => {
    expect(SPEND_COMMAND).toContain("These are at-least figures.");
    expect(SPEND_COMMAND).toContain("At-least figures:");
    expect(SPEND_COMMAND).toContain("Deletion leaves no trace");
  });

  it("says the share of at-least figures falls on its own", () => {
    expect(SPEND_COMMAND).toContain(
      "Threads started from now are counted from their first turn",
    );
  });

  it("names no shortfall, gap or missing amount", () => {
    for (const word of ["shortfall", "missing tokens", "incomplete", "lost"]) {
      expect(PRINTED.toLowerCase()).not.toContain(word);
    }
  });
});
