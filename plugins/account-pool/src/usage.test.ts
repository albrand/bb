import { describe, expect, it } from "vitest";
import { EMPTY_FAMILY_WEEKLY, quotaSchema } from "./contracts.js";
import { quotaFromUsage } from "./usage.js";

describe("usage quota freshness", () => {
  it("clears expired windows when a refresh omits the window", () => {
    const now = Date.now();
    const expiredReset = now - 10 * 60 * 60 * 1_000;
    const accountId = "00000000-0000-4000-8000-000000000001";
    const previous = quotaSchema.parse({
      accountId,
      usageRestriction: null,
      extraUsage: null,
      fiveHourUtilization: 0.8,
      fiveHourResetAt: expiredReset,
      fiveHourStatus: "allowed",
      sevenDayUtilization: null,
      sevenDayResetAt: null,
      sevenDayStatus: null,
      representativeClaim: null,
      familyWeekly: {
        ...EMPTY_FAMILY_WEEKLY,
        sonnet: {
          utilization: 0.8,
          resetAt: expiredReset,
          status: "allowed",
          observedAt: expiredReset,
          source: "usage",
        },
      },
      limitWindows: [],
      observedAt: expiredReset,
      heldUntil: null,
      error: null,
    });

    const refreshed = quotaFromUsage(
      accountId,
      { extra_usage: null },
      previous,
      now,
    );

    expect(refreshed).toMatchObject({
      fiveHourUtilization: null,
      fiveHourResetAt: null,
      fiveHourStatus: null,
      familyWeekly: { sonnet: null },
      observedAt: now,
    });
  });
});
