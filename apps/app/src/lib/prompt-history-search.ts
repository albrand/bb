import { promptHistorySearchTerms } from "@bb/domain";

export interface PromptSearchRange {
  start: number;
  end: number;
}

export interface PromptSearchSnippet {
  text: string;
  ranges: PromptSearchRange[];
}

export const PROMPT_SEARCH_PREVIEW_MAX_CHARS = 20_000;
const SNIPPET_LEAD_CHARS = 24;
const SNIPPET_MAX_CHARS = 240;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function findPromptSearchRanges(
  text: string,
  query: string,
): PromptSearchRange[] {
  const terms = promptHistorySearchTerms(query);
  if (terms.length === 0 || text.length === 0) return [];
  const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "giu");
  const ranges: PromptSearchRange[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: PromptSearchRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function buildPromptSearchSnippet(
  text: string,
  query: string,
): PromptSearchSnippet {
  const firstMatch = findPromptSearchRanges(text, query)[0];
  const start =
    firstMatch === undefined
      ? 0
      : Math.max(0, firstMatch.start - SNIPPET_LEAD_CHARS);
  const body = text
    .slice(start, start + SNIPPET_MAX_CHARS)
    .replace(/\s+/gu, " ")
    .trim();
  const snippet = start > 0 ? `…${body}` : body;
  return { text: snippet, ranges: findPromptSearchRanges(snippet, query) };
}

export function truncatePromptSearchPreview(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= PROMPT_SEARCH_PREVIEW_MAX_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, PROMPT_SEARCH_PREVIEW_MAX_CHARS),
    truncated: true,
  };
}
