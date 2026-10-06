export type TokenWeather = "clear" | "cloudy" | "stormy" | "unknown";

export interface TokenWeatherTurn {
  cachedInputTokens: number | null;
  inputTokens: number | null;
  model: string | null;
  outputTokens: number | null;
  providerId: string;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  turnId: string;
}

export interface TokenWeatherTurnMetrics {
  cacheReuseShare: number | null;
  freshInputChange: number | null;
  sameModelMedian: number | null;
  weather: TokenWeather;
}

export interface TokenWeatherSummary {
  cacheReuseShare: number | null;
  contextFill: number | null;
  freshInputChange: number | null;
  medianFreshInput: number | null;
  rangeFreshInput: { max: number; min: number } | null;
  totals: Omit<TokenWeatherTurn, "model" | "providerId" | "turnId">;
  turns: Array<TokenWeatherTurn & TokenWeatherTurnMetrics>;
  weather: TokenWeather;
}

export interface CompactionEstimate {
  afterTokens: number | null;
  beforeTokens: number | null;
  compactionCostTokens: number | null;
  likelyPaidForItself: boolean | null;
  observedSavingsTokens: number | null;
  turnId: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function sumKnown(values: Array<number | null>): number | null {
  return values.length === 0 || values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function estimatedContextTokens(turn: TokenWeatherTurn): number | null {
  if (turn.inputTokens === null || turn.cachedInputTokens === null) {
    return null;
  }
  return turn.inputTokens + turn.cachedInputTokens;
}

export function cacheReuseShare(
  inputTokens: number | null,
  cachedInputTokens: number | null,
): number | null {
  if (inputTokens === null || cachedInputTokens === null) return null;
  const total = inputTokens + cachedInputTokens;
  return total > 0 ? cachedInputTokens / total : null;
}

export function tokenWeatherForMetrics(args: {
  cacheReuseShare: number | null;
  contextFill: number | null;
  freshInputChange: number | null;
}): TokenWeather {
  const {
    cacheReuseShare: cache,
    contextFill,
    freshInputChange: growth,
  } = args;
  if (contextFill !== null && contextFill >= 0.85) return "stormy";
  if (growth !== null && growth >= 0.5 && cache !== null && cache < 0.2) {
    return "stormy";
  }
  if (
    (contextFill !== null && contextFill >= 0.7) ||
    (growth !== null && growth >= 0.25) ||
    (cache !== null && cache < 0.35)
  ) {
    return "cloudy";
  }
  if (contextFill === null && growth === null && cache === null)
    return "unknown";
  if (
    cache !== null &&
    cache >= 0.35 &&
    (growth === null || growth < 0.25) &&
    (contextFill === null || contextFill < 0.7)
  ) {
    return "clear";
  }
  return "unknown";
}

export function summarizeTokenWeather(args: {
  contextFill?: number | null;
  totals?: TokenWeatherSummary["totals"];
  turns: TokenWeatherTurn[];
}): TokenWeatherSummary {
  const contextFill = args.contextFill ?? null;
  const turns = [...args.turns];
  const byModel = new Map<string, number[]>();
  const measured = turns.map((turn) => {
    const key = `${turn.providerId}\u0000${turn.model ?? ""}`;
    const previous = byModel.get(key) ?? [];
    const sameModelMedian = turn.model ? median(previous) : null;
    const freshInputChange =
      turn.inputTokens !== null &&
      sameModelMedian !== null &&
      sameModelMedian > 0
        ? turn.inputTokens / sameModelMedian - 1
        : null;
    const cacheShare = cacheReuseShare(
      turn.inputTokens,
      turn.cachedInputTokens,
    );
    if (turn.inputTokens !== null && turn.model) {
      previous.push(turn.inputTokens);
      byModel.set(key, previous);
    }
    return {
      ...turn,
      cacheReuseShare: cacheShare,
      freshInputChange,
      sameModelMedian,
      weather: tokenWeatherForMetrics({
        cacheReuseShare: cacheShare,
        contextFill: null,
        freshInputChange,
      }),
    };
  });
  const knownFresh = measured.flatMap((turn) =>
    turn.inputTokens === null ? [] : [turn.inputTokens],
  );
  const totals = args.totals ?? {
    cachedInputTokens: sumKnown(measured.map((turn) => turn.cachedInputTokens)),
    inputTokens: sumKnown(measured.map((turn) => turn.inputTokens)),
    outputTokens: sumKnown(measured.map((turn) => turn.outputTokens)),
    reasoningOutputTokens: sumKnown(
      measured.map((turn) => turn.reasoningOutputTokens),
    ),
    totalTokens: sumKnown(measured.map((turn) => turn.totalTokens)),
  };
  const overallCacheShare = cacheReuseShare(
    totals.inputTokens,
    totals.cachedInputTokens,
  );
  const medFresh = median(knownFresh);
  const latest = measured.at(-1);
  return {
    cacheReuseShare: overallCacheShare,
    contextFill,
    freshInputChange: latest?.freshInputChange ?? null,
    medianFreshInput: medFresh,
    rangeFreshInput:
      knownFresh.length === 0
        ? null
        : { min: Math.min(...knownFresh), max: Math.max(...knownFresh) },
    totals,
    turns: measured.map((turn) => ({
      ...turn,
      weather: tokenWeatherForMetrics({
        cacheReuseShare: turn.cacheReuseShare,
        contextFill: null,
        freshInputChange: turn.freshInputChange,
      }),
    })),
    weather: tokenWeatherForMetrics({
      cacheReuseShare: overallCacheShare,
      contextFill: null,
      freshInputChange: null,
    }),
  };
}

export function estimateCompactionSavings(args: {
  compactionTurnIds: string[];
  turns: TokenWeatherTurn[];
  lookaheadTurns?: number;
}): CompactionEstimate[] {
  const turns = [...args.turns];
  const compactionTurnIds = new Set(args.compactionTurnIds);
  const lookaheadTurns = args.lookaheadTurns ?? 3;
  return turns.flatMap((turn, index) => {
    if (!compactionTurnIds.has(turn.turnId)) return [];
    const earlier = turns
      .slice(0, index)
      .filter(
        (candidate) =>
          candidate.model === turn.model &&
          candidate.providerId === turn.providerId &&
          estimatedContextTokens(candidate) !== null,
      )
      .map((candidate) => estimatedContextTokens(candidate)!);
    const beforeTokens = median(earlier.slice(-3));
    const later = turns
      .slice(index + 1)
      .filter(
        (candidate) =>
          candidate.model === turn.model &&
          candidate.providerId === turn.providerId &&
          estimatedContextTokens(candidate) !== null,
      )
      .slice(0, lookaheadTurns);
    const afterTokens = later[0] ? estimatedContextTokens(later[0]) : null;
    const observedSavingsTokens =
      beforeTokens === null || later.length === 0
        ? null
        : later.reduce(
            (total, candidate) =>
              total +
              Math.max(0, beforeTokens - estimatedContextTokens(candidate)!),
            0,
          );
    const compactionCostTokens = turn.totalTokens;
    return [
      {
        afterTokens,
        beforeTokens,
        compactionCostTokens,
        likelyPaidForItself:
          observedSavingsTokens === null || compactionCostTokens === null
            ? null
            : observedSavingsTokens > compactionCostTokens,
        observedSavingsTokens,
        turnId: turn.turnId,
      },
    ];
  });
}
