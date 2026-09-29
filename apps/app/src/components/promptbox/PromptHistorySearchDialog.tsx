import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  PROMPT_HISTORY_SEARCH_QUERY_MAX_LENGTH,
  type PromptHistorySearchResult,
} from "@bb/domain";
import {
  getProjectStoredPromptAttachmentPaths,
  promptInputToDraft,
  type PromptDraftState,
} from "@bb/client-core";
import { Dialog, DialogContent, DialogTitle } from "@bb/shared-ui/dialog";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { PaletteShortcut } from "@/components/commands/PaletteShell";
import { appToast } from "@/components/ui/app-toast";
import { usePromptHistorySearch } from "@/hooks/queries/prompt-history-search-queries";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  buildPromptSearchSnippet,
  findPromptSearchRanges,
  truncatePromptSearchPreview,
  type PromptSearchRange,
} from "@/lib/prompt-history-search";
import { sdk } from "@/lib/sdk";

type PromptHistorySearchScope = "everywhere" | "project";

interface PromptHistorySearchDialogProps {
  open: boolean;
  projectId: string;
  onOpenChange: (open: boolean) => void;
  onInsert: (draft: PromptDraftState) => void;
  onAfterClose: () => void;
}

interface PromptHistorySearchOption {
  draft: PromptDraftState;
  entry: PromptHistorySearchResult;
}

function stopReactPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

const HIGHLIGHT_CLASS =
  "rounded-sm bg-[var(--sidebar-search-match)] px-0.5 py-px text-foreground";

function HighlightedText({
  ranges,
  text,
}: {
  ranges: readonly PromptSearchRange[];
  text: string;
}) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark key={`${range.start}:${range.end}`} className={HIGHLIGHT_CLASS}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function attachmentSummary(draft: PromptDraftState): string | null {
  const count = draft.attachments.length;
  if (count === 0) return null;
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

function contextLine(entry: PromptHistorySearchResult): string {
  return [entry.projectName, entry.threadTitle]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
}

async function prepareDraftForProject(
  option: PromptHistorySearchOption,
  projectId: string,
): Promise<PromptDraftState> {
  if (option.entry.projectId === projectId) return option.draft;
  const paths = getProjectStoredPromptAttachmentPaths(option.draft.attachments);
  if (paths.length === 0) return option.draft;
  try {
    await sdk.projects.attachments.copy({
      projectId,
      sourceProjectId: option.entry.projectId,
      paths,
    });
    return option.draft;
  } catch {
    appToast.warning("Attachments left out", {
      description: `${paths.length === 1 ? "An attachment" : `${paths.length} attachments`} from ${option.entry.projectName} could not be copied to this project, so only the text was inserted.`,
    });
    const unavailable = new Set(paths);
    return {
      ...option.draft,
      attachments: option.draft.attachments.filter(
        (attachment) => !unavailable.has(attachment.path),
      ),
    };
  }
}

export function PromptHistorySearchDialog({
  open,
  projectId,
  onOpenChange,
  onInsert,
  onAfterClose,
}: PromptHistorySearchDialogProps) {
  const insertionEpoch = useRef(0);
  useEffect(
    () => () => {
      insertionEpoch.current += 1;
    },
    [],
  );
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) insertionEpoch.current += 1;
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  const beginInsertion = useCallback(() => {
    const epoch = insertionEpoch.current;
    return (draft: PromptDraftState) => {
      if (insertionEpoch.current !== epoch) return false;
      onInsert(draft);
      return true;
    };
  }, [onInsert]);
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        className="top-[12%] max-w-[880px] translate-y-0 gap-0 p-0 shadow-lg sm:rounded-xl"
        onAfterCloseAutoFocus={onAfterClose}
        data-testid="prompt-history-search"
      >
        <DialogTitle className="sr-only">Search prompt history</DialogTitle>
        {open ? (
          <PromptHistorySearchBody
            projectId={projectId}
            onClose={() => handleOpenChange(false)}
            beginInsertion={beginInsertion}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PromptHistorySearchBody({
  projectId,
  onClose,
  beginInsertion,
}: {
  projectId: string;
  onClose: () => void;
  beginInsertion: () => (draft: PromptDraftState) => boolean;
}) {
  const listId = useId();
  const optionIdPrefix = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const isCompact = useIsCompactViewport();
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PromptHistorySearchScope>("everywhere");
  const [activeIndex, setActiveIndex] = useState(0);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const search = usePromptHistorySearch({
    enabled: true,
    projectId: scope === "project" ? projectId : null,
    query,
  });
  const options = useMemo<PromptHistorySearchOption[]>(
    () =>
      (search.data ?? []).map((entry) => ({
        entry,
        draft: promptInputToDraft(entry.input),
      })),
    [search.data],
  );
  const highlightQuery = search.debouncedQuery;
  const clampedIndex =
    options.length === 0 ? -1 : Math.min(activeIndex, options.length - 1);
  const active = clampedIndex < 0 ? undefined : options[clampedIndex];

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex]);

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;
    const firstMark = preview.querySelector("mark");
    if (firstMark === null) {
      preview.scrollTop = 0;
      return;
    }
    firstMark.scrollIntoView({ block: "center" });
  }, [active?.entry.id, highlightQuery]);

  const choose = useCallback(
    async (option: PromptHistorySearchOption) => {
      if (insertingId !== null) return;
      setInsertingId(option.entry.id);
      const commit = beginInsertion();
      try {
        const draft = await prepareDraftForProject(option, projectId);
        if (commit(draft)) onClose();
      } finally {
        setInsertingId(null);
      }
    },
    [beginInsertion, insertingId, onClose, projectId],
  );

  const moveActive = useCallback(
    (delta: number) => {
      if (options.length === 0) return;
      setActiveIndex(
        Math.min(options.length - 1, Math.max(0, clampedIndex + delta)),
      );
    },
    [clampedIndex, options.length],
  );

  const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLowerCase() === "r"
    ) {
      event.preventDefault();
      event.stopPropagation();
      moveActive(event.shiftKey ? -1 : 1);
      inputRef.current?.focus();
    }
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      moveActive(event.key === "PageDown" ? 8 : -8);
      return;
    }
    if (event.key === "Enter" && active !== undefined) {
      event.preventDefault();
      void choose(active);
    }
  };

  const isLoading = search.isPending || (search.isFetching && !search.data);
  const trimmedQuery = query.trim();
  const emptyMessage =
    options.length > 0
      ? null
      : isLoading
        ? "Searching prompts…"
        : search.isError
          ? "Couldn’t load prompt history"
          : trimmedQuery.length > 0
            ? `No prompts match “${trimmedQuery}”`
            : scope === "project"
              ? "No prompts sent in this project yet"
              : "No prompts sent yet";

  return (
    <div
      className="flex min-h-0 flex-col"
      onKeyDownCapture={handleKeyDownCapture}
      onKeyDown={stopReactPropagation}
      onMouseDown={stopReactPropagation}
      onPointerDown={stopReactPropagation}
      onClick={stopReactPropagation}
      onDragOver={stopReactPropagation}
      onDrop={stopReactPropagation}
      onPaste={stopReactPropagation}
    >
      <div
        className="flex h-12 items-center gap-2 rounded-t-[inherit] border-b border-border bg-background px-3"
        data-prompt-history-search-input-band
      >
        <Icon
          name="Search"
          className="size-4 shrink-0 text-subtle-foreground"
          aria-hidden
        />
        <input
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={
            clampedIndex < 0 ? undefined : `${optionIdPrefix}-${clampedIndex}`
          }
          aria-label="Search prompts you have sent"
          autoComplete="off"
          maxLength={PROMPT_HISTORY_SEARCH_QUERY_MAX_LENGTH}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:font-light placeholder:text-subtle-foreground placeholder:opacity-70"
          placeholder="Search prompts you’ve sent…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleInputKeyDown}
        />
        {search.isFetching && search.data !== undefined ? (
          <Icon
            name="Loading"
            className="size-3.5 shrink-0 animate-spin text-subtle-foreground"
            aria-hidden
          />
        ) : null}
        <div
          role="radiogroup"
          aria-label="Search scope"
          className="flex shrink-0 items-center rounded-md bg-state-hover/50 p-0.5 text-xs"
        >
          {(
            [
              ["everywhere", "Everywhere"],
              ["project", "This project"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              className={cn(
                "cursor-pointer rounded-sm px-2 py-1 text-subtle-foreground transition-colors hover:text-foreground",
                scope === value && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => {
                setScope(value);
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex h-[min(26rem,60dvh)] min-h-0">
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Prompts"
          className={cn(
            "min-w-0 overflow-y-auto p-1",
            isCompact ? "flex-1" : "w-[52%] shrink-0 border-r border-border",
          )}
        >
          {emptyMessage !== null ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-sm text-muted-foreground">
              <p role={search.isError ? "alert" : "status"}>{emptyMessage}</p>
              {search.isError ? (
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-foreground hover:bg-state-hover"
                  onClick={search.retry}
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : (
            options.map((option, index) => (
              <PromptHistorySearchRow
                key={option.entry.id}
                id={`${optionIdPrefix}-${index}`}
                isActive={index === clampedIndex}
                isInserting={insertingId === option.entry.id}
                now={now}
                option={option}
                query={highlightQuery}
                onActivate={() => setActiveIndex(index)}
                onSelect={() => void choose(option)}
              />
            ))
          )}
        </div>
        {isCompact ? null : (
          <PromptHistorySearchPreview
            now={now}
            option={active}
            previewRef={previewRef}
            query={highlightQuery}
          />
        )}
      </div>
      {isCompact ? null : (
        <div
          className="flex items-center gap-4 rounded-b-[inherit] border-t border-border px-3 py-2 text-xs text-subtle-foreground"
          data-prompt-history-search-hints
        >
          <span className="flex items-center gap-1.5">
            <PaletteShortcut>↑↓</PaletteShortcut>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <PaletteShortcut>⌃R</PaletteShortcut>
            Older match
          </span>
          <span className="flex items-center gap-1.5">
            <PaletteShortcut>↵</PaletteShortcut>
            Put in composer
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <PaletteShortcut>Esc</PaletteShortcut>
            Close
          </span>
        </div>
      )}
    </div>
  );
}

function PromptHistorySearchRow({
  id,
  isActive,
  isInserting,
  now,
  option,
  query,
  onActivate,
  onSelect,
}: {
  id: string;
  isActive: boolean;
  isInserting: boolean;
  now: number;
  option: PromptHistorySearchOption;
  query: string;
  onActivate: () => void;
  onSelect: () => void;
}) {
  const snippet = useMemo(
    () => buildPromptSearchSnippet(option.draft.text, query),
    [option.draft.text, query],
  );
  const context = contextLine(option.entry);
  const attachments = attachmentSummary(option.draft);
  return (
    <div
      id={id}
      role="option"
      aria-selected={isActive}
      aria-busy={isInserting || undefined}
      className={cn(
        "flex min-h-11 cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 text-left",
        isActive && "bg-state-hover text-foreground",
      )}
      onPointerMove={onActivate}
      onClick={onSelect}
      data-prompt-history-search-row
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {snippet.text.length === 0 ? (
            <span className="text-subtle-foreground">
              {attachments ?? "(empty prompt)"}
            </span>
          ) : (
            <HighlightedText text={snippet.text} ranges={snippet.ranges} />
          )}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">
          {isInserting
            ? "Inserting…"
            : formatRelativeTime({ timestamp: option.entry.lastUsedAt, now })}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-subtle-foreground">
        <Icon name="Folder" className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{context}</span>
        {option.entry.useCount > 1 ? (
          <span className="shrink-0">{` · ${option.entry.useCount}×`}</span>
        ) : null}
        {attachments === null ? null : (
          <span className="shrink-0">{` · ${attachments}`}</span>
        )}
      </span>
    </div>
  );
}

function PromptHistorySearchPreview({
  now,
  option,
  previewRef,
  query,
}: {
  now: number;
  option: PromptHistorySearchOption | undefined;
  previewRef: RefObject<HTMLDivElement | null>;
  query: string;
}) {
  const preview = useMemo(() => {
    if (option === undefined) return null;
    const truncated = truncatePromptSearchPreview(option.draft.text);
    return {
      ...truncated,
      ranges: findPromptSearchRanges(truncated.text, query),
    };
  }, [option, query]);
  if (option === undefined || preview === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-4 text-sm text-subtle-foreground">
        Select a prompt to preview it
      </div>
    );
  }
  const lastUsed = new Date(option.entry.lastUsedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      data-prompt-history-search-preview
    >
      <div className="flex flex-col gap-0.5 border-b border-border px-3 py-2 text-xs text-subtle-foreground">
        <span className="flex min-w-0 items-center gap-1 text-foreground">
          <Icon name="Folder" className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{option.entry.projectName}</span>
        </span>
        {option.entry.threadTitle === null ? null : (
          <span className="flex min-w-0 items-center gap-1">
            <Icon
              name="MessageSquare"
              className="size-3.5 shrink-0"
              aria-hidden
            />
            <span className="truncate">{option.entry.threadTitle}</span>
          </span>
        )}
        <span>
          {`${formatRelativeTime({ timestamp: option.entry.lastUsedAt, now })} · ${lastUsed}`}
          {option.entry.useCount > 1
            ? ` · sent ${option.entry.useCount} times`
            : null}
        </span>
      </div>
      <div
        ref={previewRef}
        className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm text-foreground"
      >
        <HighlightedText text={preview.text} ranges={preview.ranges} />
        {preview.truncated ? (
          <span className="text-subtle-foreground">{"\n…"}</span>
        ) : null}
      </div>
      {option.draft.attachments.length === 0 ? null : (
        <div className="flex flex-wrap gap-1 border-t border-border px-3 py-2">
          {option.draft.attachments.map((attachment) => (
            <span
              key={attachment.path}
              className="max-w-full truncate rounded-sm bg-state-hover/50 px-1.5 py-0.5 text-xs text-subtle-foreground"
              title={attachment.path}
            >
              {attachment.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
