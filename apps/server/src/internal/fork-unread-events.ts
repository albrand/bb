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
 * Second-order effect, so nobody re-derives it: turn/diff/updated is also a
 * member of ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES, and resolveActivePruneCandidates
 * only sees events that were stored. Dropping it therefore removes one of the
 * four in-turn prune triggers, leaving three — thread/contextWindowUsage/updated,
 * thread/tokenUsage/updated and item/backgroundTask/progress. That is safe for
 * two measured reasons. Pruning does not depend on the in-turn trigger at all:
 * every root turn completion that moves a thread to idle prunes unconditionally,
 * as does archiving, and the in-turn path is an optimisation for long turns.
 * And it is never the sole trigger: of the 154 threads on the live database that
 * have ever emitted turn/diff/updated, all 154 also emit one of the other three.
 * The second of those is a fact about history rather than an invariant, so if it
 * is ever falsified the fix is to keep the event as a prune trigger while still
 * not storing it.
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
