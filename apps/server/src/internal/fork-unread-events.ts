import type { HostDaemonEventEnvelope } from "@bb/host-daemon-contract";

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
