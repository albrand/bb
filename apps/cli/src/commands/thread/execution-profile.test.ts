import { afterEach, describe, expect, it, vi } from "vitest";
import { printExecutionProfile } from "./show.js";

describe("printExecutionProfile (get-bb/bb#1787)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("labels an unreported current model without claiming the request ran", () => {
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
    expect(out).toContain(
      "Last provider report: current model unknown (not reported by the provider)",
    );
    expect(out).not.toContain("accepted");
  });

  it("labels a same-model report as provider-reported session settings", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printExecutionProfile({
      lastRequested: {
        model: "claude-opus-5",
        reasoningLevel: "xhigh",
        permissionMode: "full",
        serviceTier: "default",
        source: "client/turn/requested",
      },
      overrides: { model: null, reasoningLevel: null },
      nextTurn: null,
      executed: {
        model: "claude-opus-5",
        reasoningLevel: "xhigh",
        permissionMode: "full",
        serviceTier: "default",
      },
    });
    const out = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain(
      "Last provider report: last provider-reported session settings: claude-opus-5 · xhigh · full · default",
    );
    expect(out).not.toContain("current model unknown");
    expect(out).not.toContain("current requested model");
  });

  it("marks a different requested model as stale without replacing the report", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printExecutionProfile({
      lastRequested: {
        model: "gpt-6-sol",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        source: "client/turn/requested",
      },
      overrides: { model: null, reasoningLevel: null },
      nextTurn: null,
      executed: {
        model: "gpt-6-terra",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
      },
    });
    const out = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain(
      "Last provider report: stale; current requested model gpt-6-sol is unconfirmed: gpt-6-terra · high · full · default",
    );
    expect(out).toContain(
      "Last requested: gpt-6-sol · medium · full · default",
    );
    expect(out).not.toContain("Executed:");
  });

  it("prints nothing when the server has no execution profile", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printExecutionProfile(null);
    expect(log).not.toHaveBeenCalled();
  });
});
