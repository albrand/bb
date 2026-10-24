import { nativeActivityRecoveryGuidance } from "@bb/client-core";
import { useHosts } from "@/hooks/queries/host-queries";
import type { NativeActivityNotice as NativeActivityNoticeState } from "@/hooks/useNativeActivityUnconfirmed";
import { formatRelativeTime } from "@/lib/relative-time";

interface NativeActivityNoticeProps {
  hostId: string | null;
  notice: NativeActivityNoticeState;
  pendingPromptCount: number;
  threadId: string;
}

export function NativeActivityNotice({
  hostId,
  notice,
  pendingPromptCount,
  threadId,
}: NativeActivityNoticeProps) {
  const hostsQuery = useHosts();
  if (!notice.unconfirmed || pendingPromptCount > 0) return null;
  const hostName =
    hostId === null
      ? null
      : (hostsQuery.data?.find((host) => host.id === hostId)?.name ?? null);
  const lead =
    notice.evidenceKind === "tool-call" && notice.lastToolCallAt !== null
      ? `Agent tool call seen ${formatRelativeTime({
          timestamp: notice.lastToolCallAt,
          now: notice.now,
        })} — this session has not reported its state.`
      : "Activity not reported — This session is running, but it has not reported recent activity.";
  return (
    <p className="px-3 py-1 text-xs text-muted-foreground" role="status">
      {lead}{" "}
      {nativeActivityRecoveryGuidance({
        hostName,
        threadId,
      }).map((segment, index) =>
        segment.kind === "command" ? (
          <code
            className="rounded bg-muted px-1 font-mono text-foreground"
            key={index}
          >
            {segment.text}
          </code>
        ) : (
          segment.text
        ),
      )}
    </p>
  );
}
