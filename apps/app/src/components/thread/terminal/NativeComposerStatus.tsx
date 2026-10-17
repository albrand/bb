import { useEffect, useState } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { WaveformVisualizer } from "@/components/promptbox/WaveformVisualizer";
import { formatElapsed } from "./composer-text-ops";
import type {
  RecentCorrections,
  TypingSuggestion,
} from "./useTypingAssistance";

function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {formatElapsed(now - startedAt)}
    </span>
  );
}

interface DictationStripProps {
  phase: "starting" | "recording" | "finalizing";
  startedAt: number | null;
  stream: MediaStream | null;
  pending: number;
  failure: string | null;
  onCancel: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}

export function DictationStrip({
  phase,
  startedAt,
  stream,
  pending,
  failure,
  onCancel,
  onRetry,
  onDiscard,
}: DictationStripProps) {
  const recording = phase === "recording";
  const label =
    failure !== null
      ? "A part of your dictation could not be transcribed"
      : phase === "starting"
        ? "Starting microphone…"
        : recording
          ? "Listening"
          : pending > 0
            ? "Finishing transcription…"
            : "Finishing…";
  return (
    <div
      className="flex h-8 items-center gap-2 px-1"
      data-native-composer-dictation={phase}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          recording
            ? "bg-destructive motion-safe:animate-pulse"
            : "bg-muted-foreground/50",
        )}
      />
      {startedAt !== null && recording ? (
        <ElapsedTime startedAt={startedAt} />
      ) : null}
      <div className="h-5 min-w-0 flex-1 text-muted-foreground">
        {recording ? (
          <WaveformVisualizer stream={stream} active />
        ) : (
          <span
            className={cn(
              "block truncate text-xs",
              failure === null
                ? "motion-safe:animate-shine-icon"
                : "text-destructive",
            )}
          >
            {label}
          </span>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
      {failure !== null ? (
        <>
          <button
            type="button"
            className="h-7 shrink-0 rounded-md px-2 text-xs text-foreground hover:bg-muted"
            onClick={onRetry}
          >
            Retry
          </button>
          <button
            type="button"
            className="h-7 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted"
            onClick={onDiscard}
          >
            Discard
          </button>
        </>
      ) : null}
      <button
        type="button"
        aria-label="Cancel dictation"
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted pointer-coarse:size-9"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onCancel}
      >
        <Icon name="X" className="size-3.5" />
      </button>
    </div>
  );
}

interface AssistStripProps {
  suggestions: TypingSuggestion[];
  recent: RecentCorrections | null;
  refining: boolean;
  onAccept: (id: number) => void;
  onDismiss: (id: number) => void;
  onUndo: () => void;
}

export function AssistStrip({
  suggestions,
  recent,
  refining,
  onAccept,
  onDismiss,
  onUndo,
}: AssistStripProps) {
  if (suggestions.length === 0 && recent === null && !refining) return null;
  return (
    <div
      className="flex min-h-7 flex-wrap items-center gap-1.5 px-1 text-xs"
      data-native-composer-assist=""
    >
      {refining ? (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Icon
            name="AiContentGenerator01"
            className="size-3.5 motion-safe:animate-pulse"
          />
          <span>Refining</span>
        </span>
      ) : null}
      {recent === null ? null : (
        <span
          className="flex items-center gap-1 text-muted-foreground"
          title={recent.summary}
          role="status"
        >
          <Icon name="Check" className="size-3.5" />
          <span>
            {recent.count === 1
              ? "Fixed 1 issue"
              : `Fixed ${recent.count} issues`}
          </span>
          <button
            type="button"
            className="ml-0.5 flex h-6 items-center gap-1 rounded px-1.5 text-foreground hover:bg-muted pointer-coarse:h-8"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onUndo}
          >
            <Icon name="RotateCcw" className="size-3" />
            Undo
          </button>
        </span>
      )}
      {suggestions.map((suggestion) => (
        <span
          key={suggestion.id}
          className="flex max-w-full items-center rounded-full border border-border/70 bg-muted/40"
          data-writing-suggestion={suggestion.category}
        >
          <button
            type="button"
            className="flex h-6 min-w-0 items-center gap-1 rounded-l-full pr-1 pl-2.5 hover:bg-muted pointer-coarse:h-8"
            aria-label={`Replace “${suggestion.original}” with “${suggestion.replacement}”`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onAccept(suggestion.id)}
          >
            <span className="truncate text-muted-foreground line-through decoration-muted-foreground/60">
              {suggestion.original.trim() || "␣"}
            </span>
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
            <span className="truncate text-foreground">
              {suggestion.replacement.trim() || "␣"}
            </span>
          </button>
          <button
            type="button"
            aria-label="Dismiss suggestion"
            className="flex size-6 shrink-0 items-center justify-center rounded-r-full text-muted-foreground hover:bg-muted pointer-coarse:size-8"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onDismiss(suggestion.id)}
          >
            <Icon name="X" className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
