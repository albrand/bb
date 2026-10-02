export interface TokenBreakdownLabels {
  cache: string;
  input: string;
  reasoning: string;
}

export function tokenBreakdownLabels(providerId: string): TokenBreakdownLabels {
  return {
    cache: providerId === "claude-code" ? "Cached (read + write)" : "Cached",
    input: "Input (uncached)",
    reasoning:
      providerId === "claude-code"
        ? "Reasoning included in output"
        : "Reasoning (within output)",
  };
}
