import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@bb/shared-ui/icon";
import type {
  ThreadChildSummaryResponse,
  ThreadSpendBreakdownResponse,
} from "@bb/server-contract";
import { tokenBreakdownLabels } from "@bb/domain";
import { estimateCompactionSavings, summarizeTokenWeather } from "@bb/domain";
import {
  useThreadSpendSummary,
  useThreadTimeline,
} from "@/hooks/queries/thread-queries";
import { threadCompactionTurnIdsQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { useThreadRoutePath } from "./ThreadTitleMentions";
import { useQuery } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  PersistentResponsiveDrawerShell,
  useResponsiveDrawerRealization,
} from "@bb/shared-ui/responsive-overlay";

function compactTokens(
  value: number | null | undefined,
  maximumFractionDigits = 1,
): string {
  if (value === null || value === undefined) return "unavailable";
  return new Intl.NumberFormat("en", {
    maximumFractionDigits,
    notation: "compact",
  }).format(value);
}

function exactTokens(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString("en");
}

export function ThreadTurnTokenTooltipContent({
  turn,
  reasoningDisplayValue,
  providerId = "Unknown",
  weatherMetrics,
}: {
  turn: ThreadSpendBreakdownResponse;
  reasoningDisplayValue: number | null;
  providerId?: string;
  weatherMetrics?: {
    cacheReuseShare: number | null;
    freshInputChange: number | null;
    sameModelMedian: number | null;
    weather: string;
  };
}) {
  const labels = tokenBreakdownLabels(reasoningDisplayValue);
  return (
    <TooltipContent
      side="bottom"
      className="max-w-[min(24rem,calc(100vw-1rem))]"
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums">
        <span>Fresh input</span>
        <span>{exactTokens(turn.inputTokens)}</span>
        <span>Output</span>
        <span>{exactTokens(turn.outputTokens)}</span>
        <span>
          {reasoningDisplayValue === null ? "Reasoning" : labels.reasoning}
        </span>
        <span>
          {reasoningDisplayValue === null
            ? "Not reported"
            : reasoningDisplayValue === 0
              ? "Included in output"
              : exactTokens(reasoningDisplayValue)}
        </span>
        <span>Cached (read + write)</span>
        <span>{exactTokens(turn.cachedInputTokens)}</span>
        <span>Total</span>
        <span>{exactTokens(turn.totalTokens)}</span>
        <span>Provider / model</span>
        <span>
          {providerId} / {turn.model ?? "Unknown"}
        </span>
        {weatherMetrics ? (
          <>
            <span>Weather</span>
            <span className="capitalize">{weatherMetrics.weather}</span>
            <span>Cached share</span>
            <span>{formatPercent(weatherMetrics.cacheReuseShare)}</span>
            <span>Fresh input vs same-model median</span>
            <span>
              {weatherMetrics.freshInputChange === null
                ? "Unavailable"
                : `${weatherMetrics.freshInputChange >= 0 ? "+" : ""}${formatPercent(weatherMetrics.freshInputChange)}`}
            </span>
            <span>Reference median</span>
            <span>{exactTokens(weatherMetrics.sameModelMedian)}</span>
            <span className="col-span-2 text-muted-foreground">
              Per-turn rules: stormy at ≥50% fresh-input growth with under 20%
              cache reuse; cloudy at ≥25% growth or under 35% reuse; clear when
              measured reuse is ≥35% and growth is under 25%. The thread panel
              also applies its latest reported context fill.
            </span>
          </>
        ) : null}
      </div>
    </TooltipContent>
  );
}

function formatPercent(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value * 100)}%`;
}

export function ThreadTurnTokenSummary({
  threadId,
  turnId,
}: {
  threadId: string;
  turnId: string;
}) {
  const { data } = useThreadSpendSummary(threadId);
  const [isAnalysisOpen, setIsAnalysisOpen] = useState(false);
  const turn = data?.turns.find((item) => item.turnId === turnId);
  if (!turn) return null;
  const hasTokens = (value: number | null): value is number =>
    value !== null && value > 0;
  if (
    ![
      turn.inputTokens,
      turn.cachedInputTokens,
      turn.outputTokens,
      turn.reasoningOutputTokens,
      turn.totalTokens,
    ].some(hasTokens)
  ) {
    return null;
  }
  const reasoningDisplayValue =
    data?.total.reasoningOutputTokens === 0 ? 0 : turn.reasoningOutputTokens;
  const weatherMetrics = data
    ? summarizeTokenWeather({
        turns: [...data.turns].reverse().map((item) => ({
          cachedInputTokens: item.cachedInputTokens,
          inputTokens: item.inputTokens,
          model: item.model ?? null,
          outputTokens: item.outputTokens,
          providerId: data.providerId ?? "unknown",
          reasoningOutputTokens: item.reasoningOutputTokens,
          totalTokens: item.totalTokens,
          turnId: item.turnId,
        })),
      }).turns.find((item) => item.turnId === turnId)
    : undefined;
  const compact = (value: number) => compactTokens(value);
  const hasTotalTokens = hasTokens(turn.totalTokens);
  const tightSummaryValue = hasTotalTokens
    ? turn.totalTokens
    : hasTokens(turn.cachedInputTokens)
      ? turn.cachedInputTokens
      : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-thread-turn-tokens=""
          aria-label={`Open thread token analysis. Fresh input ${exactTokens(turn.inputTokens)}, cached input ${exactTokens(turn.cachedInputTokens)}, output ${exactTokens(turn.outputTokens)}, reasoning ${exactTokens(reasoningDisplayValue)}, total ${exactTokens(turn.totalTokens)}`}
          className="thread-turn-token-breakdown min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-1 whitespace-normal rounded-md border-0 bg-transparent p-0 text-left font-mono text-xs tabular-nums tracking-tight text-muted-foreground"
          onClick={() => setIsAnalysisOpen(true)}
        >
          {hasTokens(turn.inputTokens) ? (
            <span data-token-part="input">in {compact(turn.inputTokens)}</span>
          ) : null}
          {hasTokens(turn.outputTokens) ? (
            <span data-token-part="output">
              out {compact(turn.outputTokens)}
            </span>
          ) : null}
          {reasoningDisplayValue !== null && reasoningDisplayValue > 0 ? (
            <span data-token-part="reasoning">
              reason {compact(reasoningDisplayValue)}
            </span>
          ) : null}
          {hasTokens(turn.cachedInputTokens) || tightSummaryValue !== null ? (
            <span data-token-trailing-group="">
              {hasTokens(turn.cachedInputTokens) ? (
                <span data-token-part="cached">
                  cached {compact(turn.cachedInputTokens)}
                </span>
              ) : null}
              {hasTotalTokens && tightSummaryValue !== null ? (
                <span data-token-part="total">
                  <span data-token-total-full>
                    Σ {compact(tightSummaryValue)}
                  </span>
                  <span
                    data-token-total-tight
                    aria-label={`Total ${exactTokens(tightSummaryValue)} tokens`}
                  >
                    {compactTokens(tightSummaryValue, 0)}
                  </span>
                </span>
              ) : tightSummaryValue !== null ? (
                <span
                  data-token-total-tight
                  aria-label={`Cached ${exactTokens(tightSummaryValue)} tokens`}
                >
                  {compactTokens(tightSummaryValue, 0)}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <ThreadTurnTokenTooltipContent
        turn={turn}
        reasoningDisplayValue={reasoningDisplayValue}
        providerId={data?.providerId ?? "Unknown"}
        weatherMetrics={weatherMetrics}
      />
      {isAnalysisOpen ? (
        <ThreadTokenWeatherPanel
          open={isAnalysisOpen}
          onOpenChange={setIsAnalysisOpen}
          threadId={threadId}
        />
      ) : null}
    </Tooltip>
  );
}

export function ThreadUsageAndAgents({
  compact = false,
  compactSummary = false,
  threadId,
}: {
  compact?: boolean;
  compactSummary?: boolean;
  threadId: string;
}) {
  const routeForThread = useThreadRoutePath();
  const { data: childSummary } = useQuery<ThreadChildSummaryResponse>({
    queryKey: ["threadChildSummary", threadId],
    queryFn: () => sdk.threads.childSummary({ threadId }),
    enabled: Boolean(threadId),
    staleTime: 30_000,
  });
  const count = childSummary?.nonDeletedChildCount ?? 0;
  if (count === 0) return null;
  const working = childSummary?.working ?? 0;
  const childRows = (childSummary?.children ?? []).map((child) => (
    <li key={child.id} className="min-w-0">
      <Link
        className="block min-w-0 whitespace-normal break-words hover:underline"
        to={routeForThread(child.id, undefined, null)}
      >
        {child.title ?? child.id} · {child.status}
      </Link>
    </li>
  ));

  if (compact) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        {childSummary ? (
          <CompactThreadUsageDrawer
            childRows={childRows}
            count={count}
            working={working}
            childSummary={childSummary}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-thread-agent-rollup=""
      data-compact-summary={compactSummary ? "true" : "false"}
      data-adaptive-summary={compactSummary ? "true" : "false"}
      className="relative min-w-0 shrink-0 text-xs"
    >
      {childSummary ? (
        <details className="relative min-w-0 text-muted-foreground">
          <summary
            aria-label={`${count} ${count === 1 ? "agent" : "agents"}: ${working} working. View agent breakdown`}
            data-agent-summary-trigger=""
            className="flex min-w-0 cursor-pointer list-none items-center gap-x-2 whitespace-nowrap rounded-sm px-1 py-0.5 hover:bg-state-hover"
          >
            <Icon name="Circle" className="size-2 fill-current" />
            <Icon name="Bot" className="size-3.5" />
            <span data-agent-summary-count="" className="tabular-nums">
              {count}
            </span>
            {compactSummary ? (
              <>
                <span data-agent-summary-compact="" className="tabular-nums">
                  {count} {count === 1 ? "agent" : "agents"} · {working} working
                </span>
                <span data-agent-summary-full="" className="tabular-nums">
                  <span>
                    Ran {count} {count === 1 ? "agent" : "agents"}
                  </span>
                  <span className="tabular-nums">
                    {childSummary.working ?? 0} working ·{" "}
                    {childSummary.waiting ?? 0} waiting ·{" "}
                    {childSummary.idle ?? 0} idle · {childSummary.failed ?? 0}{" "}
                    failed
                    {childSummary.totalTokens === null
                      ? null
                      : ` · Σ ${compactTokens(childSummary.totalTokens)}`}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span>
                  Ran {count} {count === 1 ? "agent" : "agents"}
                </span>
                <span className="tabular-nums">
                  {childSummary.working ?? 0} working ·{" "}
                  {childSummary.waiting ?? 0} waiting · {childSummary.idle ?? 0}{" "}
                  idle · {childSummary.failed ?? 0} failed
                  {childSummary.totalTokens === null
                    ? null
                    : ` · Σ ${compactTokens(childSummary.totalTokens)}`}
                </span>
              </>
            )}
            <span data-agent-summary-view="" className="text-foreground">
              View ▸
            </span>
          </summary>
          {(childSummary.children?.length ?? 0) > 0 ? (
            <ul className="absolute right-0 top-full z-30 mt-1 grid max-h-[min(60dvh,24rem)] w-[min(24rem,calc(100vw-1rem))] gap-1 overflow-y-auto rounded-md border border-border bg-background p-3 text-foreground shadow-lg">
              {compactSummary ? (
                <li className="border-b border-border/70 pb-2 text-muted-foreground">
                  Ran {count} {count === 1 ? "agent" : "agents"} · {working}{" "}
                  working · {childSummary.waiting ?? 0} waiting ·{" "}
                  {childSummary.idle ?? 0} idle · {childSummary.failed ?? 0}{" "}
                  failed
                  {childSummary.totalTokens === null
                    ? null
                    : ` · Σ ${compactTokens(childSummary.totalTokens)}`}
                </li>
              ) : null}
              {childRows}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function ThreadTokenWeatherPanel({
  open,
  onOpenChange,
  threadId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
}) {
  const { isContentRealized } = useResponsiveDrawerRealization({
    open,
  });
  const { data: spend } = useThreadSpendSummary(threadId);
  const { data: timeline } = useThreadTimeline(threadId, {
    enabled: open,
    staleTime: 10_000,
  });
  const {
    data: compactionTurnIds = [],
    isError: compactionHistoryFailed,
    isLoading: compactionHistoryLoading,
  } = useQuery({
    queryKey: threadCompactionTurnIdsQueryKey(threadId),
    enabled: open && timeline !== undefined,
    queryFn: async ({ signal }) => {
      let page = timeline;
      const turnIds = new Set<string>();
      const seenCursors = new Set<string>();
      while (page !== undefined) {
        for (const row of page.rows) {
          if (
            row.kind === "system" &&
            row.systemKind === "operation" &&
            row.operationKind === "compaction" &&
            row.turnId !== null
          ) {
            turnIds.add(row.turnId);
          }
        }
        const cursor = page.timelinePage.olderCursor;
        if (cursor === null) break;
        const cursorKey = `${cursor.anchorSeq}:${cursor.anchorId}`;
        if (seenCursors.has(cursorKey)) {
          throw new Error("Thread timeline repeated an older-page cursor");
        }
        seenCursors.add(cursorKey);
        page = await sdk.threads.timeline({
          beforeAnchorId: cursor.anchorId,
          beforeAnchorSeq: String(cursor.anchorSeq),
          threadId,
          signal,
        });
      }
      return [...turnIds];
    },
  });
  const contextFill =
    timeline?.contextWindowUsage &&
    timeline.contextWindowUsage.modelContextWindow > 0
      ? timeline.contextWindowUsage.usedTokens /
        timeline.contextWindowUsage.modelContextWindow
      : null;
  const turns = (spend?.turns ?? []).map((turn) => ({
    cachedInputTokens: turn.cachedInputTokens,
    inputTokens: turn.inputTokens,
    model: turn.model ?? null,
    outputTokens: turn.outputTokens,
    providerId: spend?.providerId ?? "unknown",
    reasoningOutputTokens: turn.reasoningOutputTokens,
    totalTokens: turn.totalTokens,
    turnId: turn.turnId,
  }));
  const chronologicalTurns = [...turns].reverse();
  const weather = spend
    ? summarizeTokenWeather({
        contextFill,
        turns: chronologicalTurns,
      })
    : null;
  const compactions = estimateCompactionSavings({
    compactionTurnIds,
    turns: chronologicalTurns,
  });
  return (
    <PersistentResponsiveDrawerShell
      open={open}
      onOpenChange={onOpenChange}
      srLabel="Token weather and compaction savings"
      contentClassName="max-h-[min(80dvh,42rem)]"
    >
      {isContentRealized ? (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium">Token weather</h2>
            <button
              type="button"
              className="min-h-11 rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-state-hover"
              onClick={() => onOpenChange(false)}
            >
              Close
            </button>
          </div>
          {weather ? (
            <>
              <p className="capitalize">
                {weather.weather} ·{" "}
                {spend?.historyComplete
                  ? "Complete history"
                  : "Partial history"}
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border/70 p-3 tabular-nums">
                <span>Fresh input total</span>
                <span>{exactTokens(weather.totals.inputTokens)}</span>
                <span>Cached input</span>
                <span>{exactTokens(weather.totals.cachedInputTokens)}</span>
                <span>Output</span>
                <span>{exactTokens(weather.totals.outputTokens)}</span>
                <span>Reasoning reported</span>
                <span>{exactTokens(weather.totals.reasoningOutputTokens)}</span>
                <span>Total</span>
                <span>{exactTokens(weather.totals.totalTokens)}</span>
                <span>Cache reuse share (approx.)</span>
                <span>{formatPercent(weather.cacheReuseShare)}</span>
                <span>Context fill (latest report)</span>
                <span>{formatPercent(contextFill)}</span>
                <span>Fresh input median / range</span>
                <span>
                  {weather.medianFreshInput === null
                    ? "Unavailable"
                    : `${exactTokens(weather.medianFreshInput)} / ${exactTokens(weather.rangeFreshInput?.min ?? null)}–${exactTokens(weather.rangeFreshInput?.max ?? null)}`}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Clear: cache reuse ≥35% and same-model fresh-input growth under
                25%, with context fill under 70% when reported. Cloudy: fill
                ≥70%, growth ≥25%, or reuse under 35%. Stormy: fill ≥85%, or
                growth ≥50% with reuse under 20%. Cached input combines reads
                and writes, so reuse is approximate. Reasoning is reported
                metadata and is not added again to total. Missing values remain
                unavailable.
              </p>
              <div className="grid gap-2">
                <h3 className="font-medium">Per-turn changes</h3>
                {weather.turns.map((turn) => (
                  <div
                    key={turn.turnId}
                    className="grid grid-cols-[1fr_auto] gap-x-3 rounded-md border border-border/70 p-3"
                  >
                    <span className="truncate">
                      {turn.providerId} / {turn.model ?? "Unknown model"}
                    </span>
                    <span className="capitalize">{turn.weather}</span>
                    <span>Fresh input {exactTokens(turn.inputTokens)}</span>
                    <span>
                      {turn.freshInputChange === null
                        ? "No same-model baseline"
                        : `${turn.freshInputChange >= 0 ? "+" : ""}${formatPercent(turn.freshInputChange)} vs ${exactTokens(turn.sameModelMedian)}`}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p>Token usage is unavailable.</p>
          )}
          <div className="grid gap-2">
            <h3 className="font-medium">Compaction savings (estimates)</h3>
            {compactionHistoryLoading ? (
              <p className="text-muted-foreground">
                Loading compaction history…
              </p>
            ) : compactionHistoryFailed ? (
              <p className="text-muted-foreground">
                Compaction history is unavailable.
              </p>
            ) : compactions.length === 0 ? (
              <p className="text-muted-foreground">
                No compaction with enough measured turns to estimate savings.
              </p>
            ) : (
              compactions.map((compaction) => (
                <div
                  key={compaction.turnId}
                  className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border/70 p-3 tabular-nums"
                >
                  <span>Context before / after</span>
                  <span>
                    {compactTokens(compaction.beforeTokens)} /{" "}
                    {compactTokens(compaction.afterTokens)}
                  </span>
                  <span>Compaction cost</span>
                  <span>{compactTokens(compaction.compactionCostTokens)}</span>
                  <span>Later observed below trend</span>
                  <span>{compactTokens(compaction.observedSavingsTokens)}</span>
                  <span>Likely paid for itself</span>
                  <span>
                    {compaction.likelyPaidForItself === null
                      ? "Unavailable, estimated"
                      : compaction.likelyPaidForItself
                        ? "Likely, estimated"
                        : "Not yet, estimated"}
                  </span>
                </div>
              ))
            )}
            <p className="text-xs text-muted-foreground">
              Before is the median fresh input from up to three earlier
              same-model turns; after is the first later same-model input.
              Estimated savings compare up to three later inputs against that
              pre-compaction median and subtract no cache-price assumption.
            </p>
          </div>
        </div>
      ) : null}
    </PersistentResponsiveDrawerShell>
  );
}

function CompactThreadUsageDrawer({
  childRows,
  count,
  working,
  childSummary,
}: {
  childRows: ReactNode[];
  count: number;
  working: number;
  childSummary: ThreadChildSummaryResponse;
}) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const { isContentRealized } = useResponsiveDrawerRealization({
    open: isDrawerOpen,
  });
  return (
    <>
      <button
        type="button"
        data-thread-agent-rollup-compact=""
        aria-label={`View ${count} agents: ${working} working`}
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-full border border-border/70 bg-background px-1 py-1 text-xs font-normal leading-none text-muted-foreground sm:px-2"
        onClick={() => setIsDrawerOpen(true)}
      >
        <Icon name="Bot" className="size-3.5" />
        <span className="hidden whitespace-nowrap sm:inline">
          {count} {count === 1 ? "agent" : "agents"}
        </span>
        <span className="whitespace-nowrap sm:hidden">{count}</span>
      </button>
      <PersistentResponsiveDrawerShell
        open={isDrawerOpen}
        onOpenChange={setIsDrawerOpen}
        srLabel="Agent activity"
        contentClassName="max-h-[min(80dvh,36rem)]"
      >
        {isContentRealized ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-hidden px-4 pb-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-medium">Agent activity</h2>
              <button
                type="button"
                className="min-h-11 rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-state-hover"
                onClick={() => setIsDrawerOpen(false)}
              >
                Close
              </button>
            </div>
            <p className="shrink-0 text-sm text-muted-foreground">
              Ran {count} {count === 1 ? "agent" : "agents"} · {working} working
              · {childSummary.waiting} waiting · {childSummary.idle} idle ·{" "}
              {childSummary.failed} failed
              {childSummary.totalTokens === null
                ? null
                : ` · Σ ${compactTokens(childSummary.totalTokens)}`}
            </p>
            {childRows.length > 0 ? (
              <ul className="min-h-0 overflow-y-auto rounded-md border border-border/70 p-3 text-sm">
                {childRows}
              </ul>
            ) : null}
          </div>
        ) : null}
      </PersistentResponsiveDrawerShell>
    </>
  );
}
