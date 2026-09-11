import { afterEach, describe, expect, it, vi } from "vitest";
import { printExecutionProfile } from "./show.js";

describe("printExecutionProfile (get-bb/bb#1787)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("labels request, overrides and next turn, and never claims what ran", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printExecutionProfile({
      lastRequested: {
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        source: "client/turn/requested",
      },
      overrides: { model: null, reasoningLevel: "max" },
      nextTurn: {
        model: "gpt-5",
        reasoningLevel: "max",
        permissionMode: "full",
        serviceTier: "default",
        source: "client/turn/requested",
      },
      executed: null,
    });
    const out = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain("Next turn:      gpt-5 · max · full · default");
    expect(out).toContain("Overrides:      model default · reasoning max");
    expect(out).toContain("Last requested: gpt-5 · medium · full · default");
    expect(out).toContain("Executed:       not reported by the provider");
  });

  it("prints nothing when the server has no execution profile", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printExecutionProfile(null);
    expect(log).not.toHaveBeenCalled();
  });
});
