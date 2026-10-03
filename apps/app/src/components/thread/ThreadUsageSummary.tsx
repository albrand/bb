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

function compactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unavailable";
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-thread-turn-tokens=""
          className="thread-turn-token-breakdown inline-flex min-w-0 flex-1 items-center gap-x-1.5 overflow-hidden whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground"
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
          {turn.cachedInputTokens === null ? null : (
            <span data-token-part="cached">
              cached {compact(turn.cachedInputTokens)}
            </span>
          )}
          <span data-token-part="total">Σ {compact(turn.totalTokens)}</span>
        </span>
      </TooltipTrigger>
      <ThreadTurnTokenTooltipContent
        turn={turn}
        reasoningDisplayValue={reasoningDisplayValue}
      />
    </Tooltip>
  );
}

export function ThreadUsageAndAgents({ threadId }: { threadId: string }) {
  const routeForThread = useThreadRoutePath();
  const { data: childSummary } = useQuery<ThreadChildSummaryResponse>({
    queryKey: ["threadChildSummary", threadId],
    queryFn: () => sdk.threads.childSummary({ threadId }),
    enabled: Boolean(threadId),
    staleTime: 30_000,
  });
  const count = childSummary?.nonDeletedChildCount ?? 0;
  if (count === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {childSummary ? (
        <details className="min-w-0 text-muted-foreground">
          <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-sm px-1 py-0.5 hover:bg-state-hover">
            <Icon name="Circle" className="size-2 fill-current" />
            <Icon name="Bot" className="size-3.5" />
            <span>
              Ran {count} {count === 1 ? "agent" : "agents"}
            </span>
            <span className="font-mono tabular-nums">
              {childSummary.working ?? 0} working · {childSummary.waiting ?? 0}{" "}
              waiting · {childSummary.idle ?? 0} idle ·{" "}
              {childSummary.failed ?? 0} failed
              {childSummary.totalTokens === null
                ? null
                : ` · Σ ${compactTokens(childSummary.totalTokens)}`}
            </span>
            <span className="text-foreground">View ▸</span>
          </summary>
          {(childSummary.children?.length ?? 0) > 0 ? (
            <ul className="mt-1 grid gap-1 pl-5">
              {(childSummary.children ?? []).map((child) => (
                <li key={child.id}>
                  <Link
                    className="hover:underline"
                    to={routeForThread(child.id, undefined)}
                  >
                    {child.title ?? child.id} · {child.status}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
