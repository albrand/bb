import { describe, expect, it, vi } from "vitest";
import { waitForAgentWorkToDrain } from "./server-connection.js";

function harness(states: Array<{ threads: number; background: boolean }>) {
  let tick = 0;
  let clock = 0;
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    logger,
    polls: () => tick,
    args: {
      getActiveThreadCount: async () =>
        states[Math.min(tick, states.length - 1)]!.threads,
      hasOpenBackgroundWork: () =>
        states[Math.min(tick++, states.length - 1)]!.background,
      logger,
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  };
}

describe("self-update drain", () => {
  it("returns at once when nothing is running", async () => {
    const h = harness([{ threads: 0, background: false }]);
    expect(await waitForAgentWorkToDrain(h.args)).toBe("drained");
    expect(h.logger.info).not.toHaveBeenCalled();
  });

  it("waits for background work a finished turn left running", async () => {
    const h = harness([
      { threads: 0, background: true },
      { threads: 0, background: true },
      { threads: 0, background: false },
    ]);
    expect(await waitForAgentWorkToDrain(h.args)).toBe("drained");
    expect(h.polls()).toBe(3);
    expect(h.logger.info).toHaveBeenCalledTimes(1);
  });

  it("gives up at the deadline so a stuck turn cannot pin an old protocol", async () => {
    const h = harness([{ threads: 1, background: false }]);
    expect(await waitForAgentWorkToDrain(h.args)).toBe("timed-out");
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });
});
