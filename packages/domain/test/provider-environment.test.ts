import { describe, expect, it } from "vitest";
import {
  maskResolvedProviderEnvironmentEntries,
  maskResolvedProviderEnvironmentRow,
  type ThreadEventRow,
} from "../src/index.js";

describe("maskResolvedProviderEnvironmentEntries", () => {
  it("keeps only bb-generated shell variables readable", () => {
    expect(
      maskResolvedProviderEnvironmentEntries([
        { name: "PATH", source: "shell", value: "/fake/shell/bin" },
        { name: "BB_THREAD_ID", source: "shell", value: "thr_fake" },
        { name: "GH_TOKEN", source: "shell", value: "fake-machine-secret-789" },
        {
          name: "FAKE_PLUGIN_TOKEN",
          source: { plugin: "fake-pool" },
          value: "fake-secret-123",
          reason: "Route the agent through the fake pool",
        },
      ]),
    ).toEqual([
      { name: "PATH", source: "shell", value: "/fake/shell/bin" },
      { name: "BB_THREAD_ID", source: "shell", value: "thr_fake" },
      { name: "GH_TOKEN", source: "shell", value: { masked: true } },
      {
        name: "FAKE_PLUGIN_TOKEN",
        source: { plugin: "fake-pool" },
        value: { masked: true },
        reason: "Route the agent through the fake pool",
      },
    ]);
  });
});

describe("maskResolvedProviderEnvironmentRow", () => {
  it("returns a provider environment row without entries unchanged", () => {
    const row = {
      id: "evt-1",
      scope: { kind: "thread" },
      threadId: "thr_fake",
      seq: 1,
      createdAt: 1,
      type: "provider.env-resolved",
      data: { providerThreadId: "provider-thread" },
    } as unknown as ThreadEventRow;

    expect(maskResolvedProviderEnvironmentRow(row)).toBe(row);
  });
});
