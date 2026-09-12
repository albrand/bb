import type { HostDaemonEventEnvelope } from "@bb/host-daemon-contract";

/**
 * Fork (albrand/bb): event types the server accepts from a daemon and then
 * deliberately does not store, because nothing reads them.
 *
 * Codex hook telemetry (hook/started, hook/completed) was 457,229 rows and
 * 314 MB on a one-month database — 30% of every row — and reaches only a
 * timeline row gated behind a setting that defaults off. The filter is narrow
 * on purpose: codex hook rawTypes, never provider/unhandled as a type, because
 * the claude-code sdk/* events stored under it feed model fallback detection.
 *
 * turn/diff/updated is on the timeline's own exclusion list and has no reader
 * in bb, the plugins, the automations or the CLI.
 *
 * Second-order effect, so nobody re-derives it: turn/diff/updated used to be a
 * member of ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES, and
 * resolveActivePruneCandidates only ever sees events that were stored. Once it is
 * dropped here it can never reach that set, so it has been removed from it rather
 * than left as an entry that can never match — a stale entry invites a later
 * reader to "fix" this filter. Three triggers remain:
 * thread/contextWindowUsage/updated, thread/tokenUsage/updated and
 * item/backgroundTask/progress.
 *
 * Losing it as a trigger is safe for two measured reasons. Pruning does not
 * depend on the in-turn trigger at all: every root turn completion that moves a
 * thread to idle prunes unconditionally, as does archiving, and the in-turn path
 * is only an optimisation for long turns. And it was never the sole trigger — of
 * the 154 threads on the live database that had ever emitted turn/diff/updated,
 * all 154 also emitted one of the other three. That second one is a fact about
 * history rather than an invariant, so the compaction runbook re-checks it
 * against each snapshot, and the fix if it is ever falsified is to accept that
 * such a thread prunes at turn completion instead of mid-turn, which is already
 * the behaviour of every thread emitting none of the trigger types.
 */
const FORK_UNREAD_CODEX_HOOK_RAW_TYPES = new Set<string>([
  "hook/completed",
  "hook/started",
]);

export function isForkUnreadStoredEvent(
  event: HostDaemonEventEnvelope["event"],
): boolean {
  if (event.type === "turn/diff/updated") {
    return true;
  }
  return (
    event.type === "provider/unhandled" &&
    event.providerId === "codex" &&
    FORK_UNREAD_CODEX_HOOK_RAW_TYPES.has(event.rawType)
  );
}

export function dropForkUnreadEvents<
  TEntry extends { envelope: HostDaemonEventEnvelope },
>(entries: TEntry[]): TEntry[] {
  return entries.filter(
    (entry) => !isForkUnreadStoredEvent(entry.envelope.event),
  );
}
