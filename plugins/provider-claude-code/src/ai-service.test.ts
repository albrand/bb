import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { registerClaudeAiService } from "./ai-service.js";
import type { ClaudeAiStatus, ClaudeAiTextResult } from "./ai/host-contract.js";

function setup(
  answer: (
    call: ExperimentalFakeHostRpcCall,
  ) => ClaudeAiTextResult | ClaudeAiStatus,
  primaryHostId: string | null = "host-1",
  config: () => Promise<{ primaryHostId: string | null }> = async () => ({
    primaryHostId,
  }),
) {
  const { bb, harness } = createFakePluginHost({
    sdk: { system: { config } },
    experimental_callHostRpc: answer,
  });
  registerClaudeAiService(bb);
  const [service] = harness.registrations.aiServiceRegistrations;
  if (service?.complete === undefined || service.status === undefined) {
    throw new Error("Claude did not register a complete service");
  }
  return {
    service,
    complete: service.complete,
    status: service.status,
    calls: harness.inspection.experimental_hostRpcCalls,
  };
}

function modelOf(call: ExperimentalFakeHostRpcCall): unknown {
  return (call.input as { model?: unknown }).model;
}

describe("Claude AI service", () => {
  it("serves text tasks only, so voice stays with a transcriber", () => {
    const claude = setup(() => ({ ok: true, text: "unused" }));
    expect(claude.service.id).toBe("claude");
    expect(claude.service.transcribe).toBeUndefined();
  });

  it("retries with Sonnet after a rate limit", async () => {
    const claude = setup((call) =>
      modelOf(call) === "claude-haiku-5-5"
        ? { ok: false, code: "rate_limited", message: "Slow down" }
        : { ok: true, text: "The user is ready." },
    );
    await expect(
      claude.complete("Fix it", { signal: new AbortController().signal }),
    ).resolves.toBe("The user is ready.");
    expect(claude.calls.map(modelOf)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(claude.calls[0]).toMatchObject({
      hostId: "host-1",
      method: "claude.ai.complete",
    });
  });

  it("gives the Sonnet retry only what the Haiku attempt left of one deadline", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const claude = setup((call) => {
        if (modelOf(call) === "claude-haiku-5-5") {
          vi.setSystemTime(1_000_000 + 6_500);
          return { ok: false, code: "service_unavailable", message: "Busy" };
        }
        return { ok: true, text: "The user is ready." };
      });
      await expect(
        claude.complete("Fix it", { signal: new AbortController().signal }),
      ).resolves.toBe("The user is ready.");
      expect(claude.calls.map((call) => call.input)).toEqual([
        expect.objectContaining({
          model: "claude-haiku-5-5",
          timeoutMs: 8_000,
        }),
        expect.objectContaining({
          model: "claude-sonnet-5-5",
          timeoutMs: 1_500,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the Sonnet retry when less than a second of the deadline is left", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const claude = setup(() => {
        vi.setSystemTime(1_000_000 + 7_500);
        return { ok: false, code: "rate_limited", message: "Slow down" };
      });
      await expect(
        claude.complete("Fix it", { signal: new AbortController().signal }),
      ).rejects.toThrow("Slow down");
      expect(claude.calls.map(modelOf)).toEqual(["claude-haiku-5-5"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the primary machine lookup against the deadline", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const claude = setup(
        () => ({ ok: true, text: "The user is ready." }),
        "host-1",
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ primaryHostId: "host-1" }), 3_000);
          }),
      );
      const done = claude.complete("Fix it", {
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(done).resolves.toBe("The user is ready.");
      expect(claude.calls.map((call) => call.input)).toEqual([
        expect.objectContaining({
          model: "claude-haiku-5-5",
          timeoutMs: 5_000,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers within the deadline and starts no Claude request when the primary machine lookup never answers", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const claude = setup(
        () => ({ ok: true, text: "unused" }),
        "host-1",
        () => new Promise(() => {}),
      );
      const done = claude.complete("Fix it", {
        signal: new AbortController().signal,
      });
      const outcome = expect(done).rejects.toThrow(
        "Claude did not answer in time",
      );
      await vi.advanceTimersByTimeAsync(8_000);
      await outcome;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(claude.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no Claude request when the lookup leaves less than a second of the deadline", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const claude = setup(
        () => ({ ok: true, text: "unused" }),
        "host-1",
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ primaryHostId: "host-1" }), 7_500);
          }),
      );
      const done = claude.complete("Fix it", {
        signal: new AbortController().signal,
      });
      const outcome = expect(done).rejects.toThrow(
        "Claude did not answer in time",
      );
      await vi.advanceTimersByTimeAsync(7_500);
      await outcome;
      expect(claude.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at once and starts no Claude request when the caller cancels during the lookup", async () => {
    let answer: (config: { primaryHostId: string | null }) => void = () => {};
    const claude = setup(
      () => ({ ok: true, text: "unused" }),
      "host-1",
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const controller = new AbortController();
    const done = claude.complete("Fix it", { signal: controller.signal });
    controller.abort();
    await expect(done).rejects.toThrow("The request was cancelled");
    answer({ primaryHostId: "host-1" });
    await Promise.resolve();
    expect(claude.calls).toHaveLength(0);
  });

  it("answers the status check within its deadline when the primary machine lookup never answers", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const claude = setup(
        () => ({ ready: true }),
        "host-1",
        () => new Promise(() => {}),
      );
      const outcome = expect(claude.status()).rejects.toThrow(
        "The Claude status check did not answer in time",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
      expect(claude.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a sign-in failure and surfaces its message", async () => {
    const claude = setup(() => ({
      ok: false,
      code: "auth_required",
      message: "Run `claude auth login` on the primary machine",
    }));
    await expect(
      claude.complete("Fix it", { signal: new AbortController().signal }),
    ).rejects.toThrow("Run `claude auth login` on the primary machine");
    expect(claude.calls).toHaveLength(1);
  });

  it("reports not ready without a primary machine", async () => {
    const claude = setup(() => ({ ready: true }), null);
    await expect(claude.status()).resolves.toEqual({
      ready: false,
      message: "No primary machine is connected",
    });
    expect(claude.calls).toHaveLength(0);
  });

  it("asks the primary machine for its sign-in status", async () => {
    const claude = setup(() => ({ ready: true }));
    await expect(claude.status()).resolves.toEqual({ ready: true });
    expect(claude.calls[0]).toMatchObject({
      hostId: "host-1",
      method: "claude.ai.status",
    });
  });
});
