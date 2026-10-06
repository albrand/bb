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

  it("compares only same-provider, same-model turns and reports measured weather rules", () => {
    const result = summarizeTokenWeather({
      contextFill: 0.72,
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
    expect(result.weather).toBe("stormy");
    expect(
      tokenWeatherForMetrics({
        cacheReuseShare: 0.5,
        contextFill: null,
        freshInputChange: 0,
      }),
    ).toBe("clear");
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
});
