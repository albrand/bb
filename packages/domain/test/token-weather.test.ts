import { describe, expect, it } from "vitest";
import {
  estimateCompactionSavings,
  summarizeTokenWeather,
  tokenWeatherForMetrics,
} from "../src/token-weather.js";

describe("token weather", () => {
  it("keeps unknown measurements unknown in totals and comparisons", () => {
    const result = summarizeTokenWeather({
      turns: [
        {
          cachedInputTokens: 30,
          inputTokens: 70,
          model: "model-a",
          outputTokens: 20,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 120,
          turnId: "turn-1",
        },
        {
          cachedInputTokens: null,
          inputTokens: null,
          model: null,
          outputTokens: null,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: null,
          turnId: "turn-2",
        },
      ],
    });

    expect(result.totals).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });
    expect(result.turns[1]?.freshInputChange).toBeNull();
    expect(result.turns[1]?.weather).toBe("unknown");
  });

  it("keeps an empty thread unavailable instead of reporting zero usage", () => {
    const result = summarizeTokenWeather({ turns: [] });

    expect(result.totals).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });
    expect(result.weather).toBe("unknown");
  });

  it("compares only same-provider, same-model turns and reports measured weather rules", () => {
    const durableTotals = {
      cachedInputTokens: 10,
      inputTokens: 120,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      totalTokens: 200,
    };
    const result = summarizeTokenWeather({
      contextFill: 0.72,
      totals: durableTotals,
      turns: [
        {
          cachedInputTokens: 10,
          inputTokens: 40,
          model: "model-a",
          outputTokens: 10,
          providerId: "provider-a",
          reasoningOutputTokens: 0,
          totalTokens: 110,
          turnId: "turn-1",
        },
        {
          cachedInputTokens: 0,
          inputTokens: 80,
          model: "model-a",
          outputTokens: 10,
          providerId: "provider-a",
          reasoningOutputTokens: 0,
          totalTokens: 90,
          turnId: "turn-2",
        },
      ],
    });

    expect(result.turns[1]?.sameModelMedian).toBe(40);
    expect(result.turns[1]?.freshInputChange).toBe(1);
    expect(result.turns[1]?.weather).toBe("stormy");
    expect(result.weather).toBe("cloudy");
    expect(
      summarizeTokenWeather({
        contextFill: 0.99,
        totals: durableTotals,
        turns: [],
      }).weather,
    ).toBe(result.weather);
    expect(result.medianFreshInput).toBe(60);
    expect(result.rangeFreshInput).toEqual({ min: 40, max: 80 });
    expect(result.totals.totalTokens).toBe(200);
    expect(
      tokenWeatherForMetrics({
        cacheReuseShare: 0.5,
        contextFill: null,
        freshInputChange: 0,
      }),
    ).toBe("clear");
    expect(
      tokenWeatherForMetrics({
        cacheReuseShare: 0.5,
        contextFill: null,
        freshInputChange: 0.3,
      }),
    ).toBe("cloudy");
    expect(
      tokenWeatherForMetrics({
        cacheReuseShare: null,
        contextFill: 0.85,
        freshInputChange: null,
      }),
    ).toBe("stormy");
  });

  it("estimates context change and payback from later same-model turns", () => {
    const result = estimateCompactionSavings({
      compactionTurnIds: ["compact"],
      turns: [
        {
          cachedInputTokens: 0,
          inputTokens: 1000,
          model: "model-a",
          outputTokens: 80,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 1080,
          turnId: "before-1",
        },
        {
          cachedInputTokens: 0,
          inputTokens: 1100,
          model: "model-a",
          outputTokens: 80,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 1180,
          turnId: "before-2",
        },
        {
          cachedInputTokens: 0,
          inputTokens: 200,
          model: "model-a",
          outputTokens: 50,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 250,
          turnId: "compact",
        },
        {
          cachedInputTokens: 0,
          inputTokens: 300,
          model: "model-a",
          outputTokens: 20,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 320,
          turnId: "after-1",
        },
        {
          cachedInputTokens: 0,
          inputTokens: 400,
          model: "model-a",
          outputTokens: 20,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 420,
          turnId: "after-2",
        },
      ],
    });

    expect(result).toEqual([
      {
        afterTokens: 300,
        beforeTokens: 1050,
        compactionCostTokens: 250,
        likelyPaidForItself: true,
        observedSavingsTokens: 1400,
        turnId: "compact",
      },
    ]);
  });

  it("leaves compaction savings unavailable when the model is unknown", () => {
    const turn = (turnId: string, tokens: number) => ({
      cachedInputTokens: 0,
      inputTokens: tokens,
      model: null,
      outputTokens: 0,
      providerId: "provider-a",
      reasoningOutputTokens: null,
      totalTokens: tokens,
      turnId,
    });
    const result = estimateCompactionSavings({
      compactionTurnIds: ["compact-first", "compact-second"],
      turns: [
        turn("before-first", 1000),
        turn("compact-first", 100),
        turn("after-first", 500),
        turn("before-second", 450),
        turn("compact-second", 100),
        turn("after-second", 50),
      ],
    });

    expect(result).toEqual([
      {
        afterTokens: null,
        beforeTokens: null,
        compactionCostTokens: 100,
        likelyPaidForItself: null,
        observedSavingsTokens: null,
        turnId: "compact-first",
      },
      {
        afterTokens: null,
        beforeTokens: null,
        compactionCostTokens: 100,
        likelyPaidForItself: null,
        observedSavingsTokens: null,
        turnId: "compact-second",
      },
    ]);
  });

  it("uses only matching provider and model turns inside adjacent compaction windows", () => {
    const turn = (
      turnId: string,
      tokens: number,
      providerId = "provider-a",
      model = "model-a",
    ) => ({
      cachedInputTokens: 0,
      inputTokens: tokens,
      model,
      outputTokens: 0,
      providerId,
      reasoningOutputTokens: null,
      totalTokens: tokens,
      turnId,
    });
    const result = estimateCompactionSavings({
      compactionTurnIds: ["compact-first", "compact-second"],
      turns: [
        turn("before-first", 9000),
        turn("before-other-model", 80_000, "provider-a", "model-b"),
        turn("compact-first", 100),
        turn("after-first", 400),
        turn("after-other-model", 70_000, "provider-a", "model-b"),
        turn("after-other-provider", 60_000, "provider-b", "model-a"),
        turn("after-first-again", 350),
        turn("compact-second", 50),
        turn("after-second", 100),
      ],
    });

    expect(result).toEqual([
      {
        afterTokens: 400,
        beforeTokens: 9000,
        compactionCostTokens: 100,
        likelyPaidForItself: true,
        observedSavingsTokens: 17_250,
        turnId: "compact-first",
      },
      {
        afterTokens: 100,
        beforeTokens: 375,
        compactionCostTokens: 50,
        likelyPaidForItself: true,
        observedSavingsTokens: 275,
        turnId: "compact-second",
      },
    ]);
  });

  it("includes cached input when estimating compaction context and savings", () => {
    const result = estimateCompactionSavings({
      compactionTurnIds: ["compact"],
      turns: [
        {
          cachedInputTokens: 120_000,
          inputTokens: 45_000,
          model: "model-a",
          outputTokens: 0,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 165_000,
          turnId: "before",
        },
        {
          cachedInputTokens: 20_000,
          inputTokens: 4_500,
          model: "model-a",
          outputTokens: 500,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 25_000,
          turnId: "compact",
        },
        {
          cachedInputTokens: 22_000,
          inputTokens: 8_000,
          model: "model-a",
          outputTokens: 500,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 30_500,
          turnId: "after",
        },
      ],
    });

    expect(result).toEqual([
      {
        afterTokens: 30_000,
        beforeTokens: 165_000,
        compactionCostTokens: 25_000,
        likelyPaidForItself: true,
        observedSavingsTokens: 135_000,
        turnId: "compact",
      },
    ]);
  });

  it("keeps incomplete compaction estimates visible as unknown", () => {
    const result = estimateCompactionSavings({
      compactionTurnIds: ["compact"],
      turns: [
        {
          cachedInputTokens: 0,
          inputTokens: 1000,
          model: "model-a",
          outputTokens: 20,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: 1020,
          turnId: "before",
        },
        {
          cachedInputTokens: null,
          inputTokens: null,
          model: "model-a",
          outputTokens: null,
          providerId: "provider-a",
          reasoningOutputTokens: null,
          totalTokens: null,
          turnId: "compact",
        },
      ],
    });

    expect(result).toEqual([
      {
        afterTokens: null,
        beforeTokens: 1000,
        compactionCostTokens: null,
        likelyPaidForItself: null,
        observedSavingsTokens: null,
        turnId: "compact",
      },
    ]);
  });
});
