export interface TokenBreakdownLabels {
  cache: string;
  input: string;
  reasoning: string;
}

export function tokenBreakdownLabels(
  reasoningOutputTokens: number | null,
): TokenBreakdownLabels {
  return {
    cache: "Cached",
    input: "Input (uncached)",
    reasoning:
      reasoningOutputTokens === null
        ? "Reasoning unavailable"
        : reasoningOutputTokens === 0
          ? "Reasoning included in output"
          : "Reasoning (within output)",
  };
}
