import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WritingCorrectionRequest,
  WritingCorrectionResponse,
  WritingEdit,
} from "@bb/domain";
import {
  insideCodeFence,
  mapOffset,
  sentenceRanges,
  touchesRange,
  type TextChange,
} from "./composer-text-ops";

export const TYPING_IDLE_MS = 1_100;
export const TRAILING_IDLE_MS = 4_000;
export const MAX_TARGET_CHARS = 500;
export const CONTEXT_CHARS = 500;
export const MAX_SUGGESTIONS = 4;
const MAX_ANALYZED_KEYS = 400;
const RECENT_VISIBLE_MS = 6_000;
const PAUSE_AFTER_UNAVAILABLE_MS = 10 * 60_000;

interface TrackedRange {
  start: number;
  end: number;
  alive: boolean;
}

export interface TypingSuggestion {
  id: number;
  original: string;
  replacement: string;
  category: WritingEdit["category"];
  explanation: string | null;
}

interface TrackedSuggestion extends TypingSuggestion {
  range: TrackedRange;
}

interface AppliedCorrection {
  range: TrackedRange;
  original: string;
  replacement: string;
}

export interface RecentCorrections {
  count: number;
  summary: string;
}

interface UseTypingAssistanceOptions {
  enabled: boolean;
  getText(): string;
  getCaret(): number | null;
  isComposing(): boolean;
  isBusy(): boolean;
  replace(start: number, end: number, text: string): void;
  correct(
    request: WritingCorrectionRequest,
    signal: AbortSignal,
  ): Promise<WritingCorrectionResponse>;
}

function mapRange(change: TextChange, range: TrackedRange): void {
  if (!range.alive) return;
  if (
    touchesRange(change, range.start, range.end) &&
    change.start < range.end &&
    change.removedEnd > range.start
  ) {
    range.alive = false;
    return;
  }
  range.start = mapOffset(change, range.start, "after");
  range.end = mapOffset(change, range.end, "before");
  if (range.end < range.start) range.alive = false;
}

export interface TypingAssistanceController {
  suggestions: TypingSuggestion[];
  recent: RecentCorrections | null;
  pending: boolean;
  onTextChange(change: TextChange, programmatic: boolean): void;
  acceptSuggestion(id: number): void;
  dismissSuggestion(id: number): void;
  undoRecent(): void;
  analyzeRange(start: number, end: number): void;
}

export function useTypingAssistance(
  options: UseTypingAssistanceOptions,
): TypingAssistanceController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const analyzedRef = useRef(new Set<string>());
  const trackedRef = useRef(new Set<TrackedRange>());
  const suggestionsRef = useRef<TrackedSuggestion[]>([]);
  const recentRef = useRef<AppliedCorrection[]>([]);
  const inFlightRef = useRef<{
    controller: AbortController;
    range: TrackedRange;
  } | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const trailingTimerRef = useRef<number | null>(null);
  const recentTimerRef = useRef<number | null>(null);
  const pausedUntilRef = useRef(0);
  const nextIdRef = useRef(1);
  const [suggestions, setSuggestions] = useState<TypingSuggestion[]>([]);
  const [recent, setRecent] = useState<RecentCorrections | null>(null);
  const [pending, setPending] = useState(false);

  const track = useCallback((start: number, end: number): TrackedRange => {
    const range = { start, end, alive: true };
    trackedRef.current.add(range);
    return range;
  }, []);

  const untrack = useCallback((range: TrackedRange) => {
    trackedRef.current.delete(range);
  }, []);

  const publishSuggestions = useCallback(() => {
    const text = optionsRef.current.getText();
    suggestionsRef.current = suggestionsRef.current.filter((suggestion) => {
      const keep =
        suggestion.range.alive &&
        text.slice(suggestion.range.start, suggestion.range.end) ===
          suggestion.original;
      if (!keep) trackedRef.current.delete(suggestion.range);
      return keep;
    });
    setSuggestions((previous) => {
      const next = suggestionsRef.current.map(
        ({ id, original, replacement, category, explanation }) => ({
          id,
          original,
          replacement,
          category,
          explanation,
        }),
      );
      return previous.length === next.length &&
        previous.every((item, index) => item.id === next[index]?.id)
        ? previous
        : next;
    });
  }, []);

  const clearRecent = useCallback(() => {
    for (const applied of recentRef.current)
      trackedRef.current.delete(applied.range);
    recentRef.current = [];
    setRecent(null);
  }, []);

  const showRecent = useCallback((applied: AppliedCorrection[]) => {
    for (const previous of recentRef.current)
      trackedRef.current.delete(previous.range);
    recentRef.current = applied;
    if (recentTimerRef.current !== null)
      window.clearTimeout(recentTimerRef.current);
    setRecent({
      count: applied.length,
      summary: applied
        .map(
          (item) =>
            `${item.original.trim() || "␣"} → ${item.replacement.trim() || "␣"}`,
        )
        .join(", "),
    });
    recentTimerRef.current = window.setTimeout(() => {
      recentTimerRef.current = null;
      setRecent(null);
    }, RECENT_VISIBLE_MS);
  }, []);

  const remember = useCallback((key: string) => {
    const analyzed = analyzedRef.current;
    if (analyzed.size >= MAX_ANALYZED_KEYS) analyzed.clear();
    analyzed.add(key);
  }, []);

  const rememberSentencesIn = useCallback(
    (start: number, end: number) => {
      const text = optionsRef.current.getText();
      for (const range of sentenceRanges(text)) {
        if (range.end > start && range.start < end) {
          remember(text.slice(range.start, range.end));
        }
      }
    },
    [remember],
  );

  const handleEdits = useCallback(
    (region: TrackedRange, target: string, edits: WritingEdit[]) => {
      const current = optionsRef.current;
      const text = current.getText();
      if (
        !region.alive ||
        text.slice(region.start, region.start + target.length) !== target
      ) {
        return;
      }
      const resolved = edits.map((edit) => ({
        edit,
        range: track(region.start + edit.start, region.start + edit.end),
      }));
      const regionStart = region.start;
      let regionEnd = region.start + target.length;
      const applied: AppliedCorrection[] = [];
      for (const { edit, range } of [...resolved].reverse()) {
        if (edit.disposition !== "apply" || !range.alive) continue;
        const caret = current.getCaret();
        const liveText = current.getText();
        if (liveText.slice(range.start, range.end) !== edit.original) {
          untrack(range);
          continue;
        }
        if (caret !== null && caret > range.start && caret < range.end) {
          untrack(range);
          continue;
        }
        const start = range.start;
        regionEnd += edit.replacement.length - (range.end - range.start);
        current.replace(range.start, range.end, edit.replacement);
        untrack(range);
        applied.push({
          range: track(start, start + edit.replacement.length),
          original: edit.original,
          replacement: edit.replacement,
        });
      }
      for (const { edit, range } of resolved) {
        if (edit.disposition !== "suggest") continue;
        suggestionsRef.current.push({
          id: nextIdRef.current++,
          original: edit.original,
          replacement: edit.replacement,
          category: edit.category,
          explanation: edit.explanation,
          range,
        });
      }
      while (suggestionsRef.current.length > MAX_SUGGESTIONS) {
        const dropped = suggestionsRef.current.shift();
        if (dropped !== undefined) untrack(dropped.range);
      }
      if (applied.length > 0) {
        rememberSentencesIn(regionStart, regionEnd);
        showRecent(applied);
      }
      publishSuggestions();
    },
    [publishSuggestions, rememberSentencesIn, showRecent, track, untrack],
  );

  const send = useCallback(
    (start: number, end: number, complete: boolean) => {
      const current = optionsRef.current;
      const text = current.getText();
      const target = text.slice(start, end);
      if (target.trim().length === 0) return;
      inFlightRef.current?.controller.abort();
      const region = track(start, end);
      const controller = new AbortController();
      inFlightRef.current = { controller, range: region };
      setPending(true);
      current
        .correct(
          {
            target,
            context: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
            complete,
          },
          controller.signal,
        )
        .then((response) => {
          if (controller.signal.aborted) return;
          if (response.status === "skipped") {
            if (
              response.reason === "budget" ||
              response.reason === "unavailable" ||
              response.reason === "off"
            ) {
              pausedUntilRef.current = Date.now() + PAUSE_AFTER_UNAVAILABLE_MS;
            }
            return;
          }
          handleEdits(region, target, response.edits);
        })
        .catch(() => {})
        .finally(() => {
          untrack(region);
          if (inFlightRef.current?.controller === controller) {
            inFlightRef.current = null;
            setPending(false);
          }
        });
    },
    [handleEdits, track, untrack],
  );

  const canRun = useCallback(() => {
    const current = optionsRef.current;
    return (
      current.enabled &&
      Date.now() >= pausedUntilRef.current &&
      !current.isComposing() &&
      !current.isBusy()
    );
  }, []);

  const analyzeCompleted = useCallback(() => {
    if (!canRun()) return;
    const current = optionsRef.current;
    const text = current.getText();
    const caret = current.getCaret();
    let groupStart = -1;
    let groupEnd = -1;
    for (const range of sentenceRanges(text)) {
      if (!range.complete) continue;
      if (caret !== null && caret > range.start && caret < range.end) continue;
      if (insideCodeFence(text, range.start)) continue;
      const key = text.slice(range.start, range.end);
      if (analyzedRef.current.has(key)) continue;
      if (groupStart < 0) {
        groupStart = range.start;
      } else if (
        text.slice(groupEnd, range.start).trim().length > 0 ||
        range.end - groupStart > MAX_TARGET_CHARS
      ) {
        break;
      }
      if (range.end - range.start > MAX_TARGET_CHARS) {
        remember(key);
        groupStart = -1;
        continue;
      }
      groupEnd = range.end;
      remember(key);
    }
    if (groupStart >= 0 && groupEnd > groupStart) {
      send(groupStart, groupEnd, true);
    }
  }, [canRun, remember, send]);

  const analyzeTrailing = useCallback(() => {
    if (!canRun() || inFlightRef.current !== null) return;
    const current = optionsRef.current;
    const text = current.getText();
    const last = sentenceRanges(text).at(-1);
    if (last === undefined || last.complete) return;
    if (insideCodeFence(text, last.start)) return;
    const key = text.slice(last.start, last.end);
    if (analyzedRef.current.has(key) || key.split(/\s+/u).length < 5) return;
    if (last.end - last.start > MAX_TARGET_CHARS) return;
    remember(key);
    send(last.start, last.end, false);
  }, [canRun, remember, send]);

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current !== null)
      window.clearTimeout(idleTimerRef.current);
    if (trailingTimerRef.current !== null)
      window.clearTimeout(trailingTimerRef.current);
    idleTimerRef.current = null;
    trailingTimerRef.current = null;
  }, []);

  const onTextChange = useCallback(
    (change: TextChange, programmatic: boolean) => {
      for (const range of trackedRef.current) mapRange(change, range);
      const inFlight = inFlightRef.current;
      if (inFlight !== null && !inFlight.range.alive) {
        inFlight.controller.abort();
        inFlightRef.current = null;
        setPending(false);
      }
      if (suggestionsRef.current.some((s) => !s.range.alive))
        publishSuggestions();
      if (
        !programmatic &&
        recentRef.current.length > 0 &&
        recentRef.current.every((r) => !r.range.alive)
      ) {
        clearRecent();
      }
      if (programmatic || !optionsRef.current.enabled) return;
      clearTimers();
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        analyzeCompleted();
      }, TYPING_IDLE_MS);
      trailingTimerRef.current = window.setTimeout(() => {
        trailingTimerRef.current = null;
        analyzeTrailing();
      }, TRAILING_IDLE_MS);
    },
    [
      analyzeCompleted,
      analyzeTrailing,
      clearRecent,
      clearTimers,
      publishSuggestions,
    ],
  );

  const acceptSuggestion = useCallback(
    (id: number) => {
      const suggestion = suggestionsRef.current.find((item) => item.id === id);
      if (suggestion === undefined) return;
      const text = optionsRef.current.getText();
      const { range } = suggestion;
      suggestionsRef.current = suggestionsRef.current.filter(
        (item) => item.id !== id,
      );
      untrack(range);
      if (
        range.alive &&
        text.slice(range.start, range.end) === suggestion.original
      ) {
        const start = range.start;
        optionsRef.current.replace(
          range.start,
          range.end,
          suggestion.replacement,
        );
        rememberSentencesIn(start, start + suggestion.replacement.length);
      }
      publishSuggestions();
    },
    [publishSuggestions, rememberSentencesIn, untrack],
  );

  const dismissSuggestion = useCallback(
    (id: number) => {
      const suggestion = suggestionsRef.current.find((item) => item.id === id);
      if (suggestion !== undefined) untrack(suggestion.range);
      suggestionsRef.current = suggestionsRef.current.filter(
        (item) => item.id !== id,
      );
      publishSuggestions();
    },
    [publishSuggestions, untrack],
  );

  const undoRecent = useCallback(() => {
    const current = optionsRef.current;
    for (const applied of [...recentRef.current].sort(
      (a, b) => b.range.start - a.range.start,
    )) {
      const text = current.getText();
      if (
        applied.range.alive &&
        text.slice(applied.range.start, applied.range.end) ===
          applied.replacement
      ) {
        current.replace(
          applied.range.start,
          applied.range.end,
          applied.original,
        );
      }
    }
    clearRecent();
  }, [clearRecent]);

  const analyzeRange = useCallback(
    (start: number, end: number) => {
      if (!canRun() || end <= start) return;
      const text = optionsRef.current.getText();
      const clampedStart = Math.max(0, start);
      const clampedEnd = Math.min(
        text.length,
        end,
        clampedStart + MAX_TARGET_CHARS,
      );
      for (const range of sentenceRanges(text)) {
        if (range.start >= clampedStart && range.end <= clampedEnd) {
          remember(text.slice(range.start, range.end));
        }
      }
      send(clampedStart, clampedEnd, true);
    },
    [canRun, remember, send],
  );

  useEffect(
    () => () => {
      clearTimers();
      inFlightRef.current?.controller.abort();
      if (recentTimerRef.current !== null)
        window.clearTimeout(recentTimerRef.current);
    },
    [clearTimers],
  );

  useEffect(() => {
    if (options.enabled) return;
    clearTimers();
    inFlightRef.current?.controller.abort();
    inFlightRef.current = null;
    setPending(false);
  }, [clearTimers, options.enabled]);

  return {
    suggestions,
    recent,
    pending,
    onTextChange,
    acceptSuggestion,
    dismissSuggestion,
    undoRecent,
    analyzeRange,
  };
}
