import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@bb/shared-ui/icon";
import type {
  ThreadChildSummaryResponse,
  ThreadSpendBreakdownResponse,
} from "@bb/server-contract";
import { tokenBreakdownLabels } from "@bb/domain";
import { useThreadSpendSummary } from "@/hooks/queries/thread-queries";
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
}: {
  turn: ThreadSpendBreakdownResponse;
  reasoningDisplayValue: number | null;
}) {
  const labels = tokenBreakdownLabels(reasoningDisplayValue);
  return (
    <TooltipContent
      side="bottom"
      className="max-w-[min(24rem,calc(100vw-1rem))]"
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums">
        <span>{labels.input}</span>
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
      </div>
    </TooltipContent>
  );
}

export function ThreadTurnTokenSummary({
  threadId,
  turnId,
}: {
  threadId: string;
  turnId: string;
}) {
  const { data } = useThreadSpendSummary(threadId);
  const turn = data?.turns.find((item) => item.turnId === turnId);
  if (!turn) return null;
  const reasoningDisplayValue =
    data?.total.reasoningOutputTokens === 0 ? 0 : turn.reasoningOutputTokens;
  const compact = (value: number | null) =>
    value === null ? null : compactTokens(value);
  const tightSummaryValue = turn.totalTokens ?? turn.cachedInputTokens;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-thread-turn-tokens=""
          className="thread-turn-token-breakdown min-w-0 flex-1 flex-wrap items-center gap-x-1 whitespace-normal font-mono text-xs tabular-nums tracking-tight text-muted-foreground"
        >
          {turn.inputTokens === null ? null : (
            <span data-token-part="input">in {compact(turn.inputTokens)}</span>
          )}
          {turn.outputTokens === null ? null : (
            <span data-token-part="output">
              out {compact(turn.outputTokens)}
            </span>
          )}
          {reasoningDisplayValue !== null && reasoningDisplayValue > 0 ? (
            <span data-token-part="reasoning">
              reason {compact(reasoningDisplayValue)}
            </span>
          ) : null}
          {turn.cachedInputTokens === null && tightSummaryValue === null ? null : (
            <span data-token-trailing-group="">
              {turn.cachedInputTokens === null ? null : (
                <span data-token-part="cached">
                  cached {compact(turn.cachedInputTokens)}
                </span>
              )}
              {tightSummaryValue === null ? null : (
                <span data-token-part="total">
                  {turn.totalTokens === null ? null : (
                    <span data-token-total-full>
                      Σ {compact(turn.totalTokens)}
                    </span>
                  )}
                  <span
                    data-token-total-tight
                    aria-label={
                      turn.totalTokens === null
                        ? `Cached ${exactTokens(tightSummaryValue)} tokens`
                        : `Total ${exactTokens(tightSummaryValue)} tokens`
                    }
                  >
                    {compactTokens(tightSummaryValue, 0)}
                  </span>
                </span>
              )}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <ThreadTurnTokenTooltipContent
        turn={turn}
        reasoningDisplayValue={reasoningDisplayValue}
      />
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
        to={routeForThread(child.id, undefined)}
      >
        {child.title ?? child.id} · {child.status}
      </Link>
    </li>
  ));

  if (compact) {
    return childSummary ? (
      <CompactThreadUsageDrawer
        childRows={childRows}
        count={count}
        working={working}
        childSummary={childSummary}
      />
    ) : null;
  }

  return (
    <div
      data-thread-agent-rollup=""
      data-compact-summary={compactSummary ? "true" : "false"}
      className="relative min-w-0 shrink-0 text-xs"
    >
      {childSummary ? (
        <details className="relative min-w-0 text-muted-foreground">
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-x-2 whitespace-nowrap rounded-sm px-1 py-0.5 hover:bg-state-hover">
            <Icon name="Circle" className="size-2 fill-current" />
            <Icon name="Bot" className="size-3.5" />
            {compactSummary ? (
              <span className="tabular-nums">
                {count} {count === 1 ? "agent" : "agents"} · {working} working
              </span>
            ) : (
              <>
                <span>
                  Ran {count} {count === 1 ? "agent" : "agents"}
                </span>
                <span className="tabular-nums">
                  {childSummary.working ?? 0} working · {childSummary.waiting ?? 0}{" "}
                  waiting · {childSummary.idle ?? 0} idle ·{" "}
                  {childSummary.failed ?? 0} failed
                  {childSummary.totalTokens === null
                    ? null
                    : ` · Σ ${compactTokens(childSummary.totalTokens)}`}
                </span>
              </>
            )}
            <span className="text-foreground">View ▸</span>
          </summary>
          {(childSummary.children?.length ?? 0) > 0 ? (
            <ul className="absolute right-0 top-full z-30 mt-1 grid max-h-[min(60dvh,24rem)] w-[min(24rem,calc(100vw-1rem))] gap-1 overflow-y-auto rounded-md border border-border bg-background p-3 text-foreground shadow-lg">
              {compactSummary ? (
                <li className="border-b border-border/70 pb-2 text-muted-foreground">
                  Ran {count} {count === 1 ? "agent" : "agents"} · {working}{" "}
                  working · {childSummary.waiting ?? 0} waiting ·{" "}
                  {childSummary.idle ?? 0} idle · {childSummary.failed ?? 0} failed
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
              · {childSummary.waiting} waiting · {childSummary.idle} idle
              · {childSummary.failed} failed
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
