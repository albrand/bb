import type { ThreadEvent } from "./provider-event.js";
import type { ThreadEventRow } from "./stored-thread-event.js";

type ProviderEnvironmentResolvedEvent = Extract<
  ThreadEvent,
  { type: "provider.env-resolved" }
>;

export type ResolvedProviderEnvironmentEntry =
  ProviderEnvironmentResolvedEvent["entries"][number];

const READABLE_SHELL_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "BB_CLI",
  "BB_SERVER_URL",
  "BB_HOST_DAEMON_PORT",
  "PSExecutionPolicyPreference",
  "BB_PROJECT_ID",
  "BB_THREAD_STORAGE",
  "BB_THREAD_ID",
  "BB_ENVIRONMENT_ID",
]);

export function isReadableProviderEnvironmentEntry(
  entry: Pick<ResolvedProviderEnvironmentEntry, "name" | "source">,
): boolean {
  return (
    entry.source === "shell" && READABLE_SHELL_ENVIRONMENT_NAMES.has(entry.name)
  );
}

export function maskResolvedProviderEnvironmentEntries(
  entries: readonly ResolvedProviderEnvironmentEntry[],
): ResolvedProviderEnvironmentEntry[] {
  return entries.map((entry) =>
    isReadableProviderEnvironmentEntry(entry)
      ? entry
      : { ...entry, value: { masked: true } },
  );
}

export function maskResolvedProviderEnvironment<TEvent extends ThreadEvent>(
  event: TEvent,
): TEvent;
export function maskResolvedProviderEnvironment(
  event: ThreadEvent,
): ThreadEvent {
  if (event.type !== "provider.env-resolved") {
    return event;
  }
  return {
    ...event,
    entries: maskResolvedProviderEnvironmentEntries(event.entries),
  };
}

export function maskResolvedProviderEnvironmentRow(
  row: ThreadEventRow,
): ThreadEventRow {
  if (
    row.type !== "provider.env-resolved" ||
    !Array.isArray(row.data.entries)
  ) {
    return row;
  }
  return {
    ...row,
    data: {
      ...row.data,
      entries: maskResolvedProviderEnvironmentEntries(row.data.entries),
    },
  };
}
