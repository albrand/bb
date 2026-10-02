import { Link } from "react-router-dom";
import { Icon } from "@bb/shared-ui/icon";
import type {
  ThreadChildSummaryResponse,
  ThreadSpendBreakdownResponse,
} from "@bb/server-contract";
import { useThreadSpendSummary } from "@/hooks/queries/thread-queries";
import { sdk } from "@/lib/sdk";
import { useThreadRoutePath } from "./ThreadTitleMentions";
import { useQuery } from "@tanstack/react-query";

function compactTokens(value: number | null): string {
  if (value === null) return "unavailable";
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function exactTokens(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString("en");
}

function BreakdownDetails({
  breakdown,
  label,
}: {
  breakdown: ThreadSpendBreakdownResponse;
  label: string;
}) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-sm px-1 py-0.5 hover:bg-state-hover">
        <span>{label}</span>
        <span className="font-mono tabular-nums">
          Σ {compactTokens(breakdown.totalTokens)}
        </span>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          In {compactTokens(breakdown.inputTokens)} · Out{" "}
          {compactTokens(breakdown.outputTokens)} · Reasoning{" "}
          {compactTokens(breakdown.reasoningOutputTokens)} · Cached{" "}
          {compactTokens(breakdown.cachedInputTokens)}
        </span>
      </summary>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-2 py-1 font-mono tabular-nums sm:grid-cols-4">
        <span>Input: {exactTokens(breakdown.inputTokens)}</span>
        <span>Output: {exactTokens(breakdown.outputTokens)}</span>
        <span>Reasoning: {exactTokens(breakdown.reasoningOutputTokens)}</span>
        <span>Cached: {exactTokens(breakdown.cachedInputTokens)}</span>
      </div>
    </details>
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
  return <BreakdownDetails breakdown={turn} label="Tokens" />;
}

export function ThreadUsageAndAgents({ threadId }: { threadId: string }) {
  const routeForThread = useThreadRoutePath();
  const { data: spend } = useThreadSpendSummary(threadId);
  const { data: childSummary } = useQuery<ThreadChildSummaryResponse>({
    queryKey: ["threadChildSummary", threadId],
    queryFn: () => sdk.threads.childSummary({ threadId }),
    enabled: Boolean(threadId),
    staleTime: 30_000,
  });
  const count = childSummary?.nonDeletedChildCount ?? 0;
  if (!spend && count === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {spend ? (
        <BreakdownDetails breakdown={spend.total} label="Thread tokens" />
      ) : null}
      {count > 0 && childSummary ? (
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
              {childSummary.failed ?? 0} failed · Σ{" "}
              {compactTokens(childSummary.totalTokens ?? 0)}
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
