import type { ThreadEvent } from "./provider-event.js";
import type { ThreadEventRow } from "./stored-thread-event.js";

type ProviderEnvironmentResolvedEvent = Extract<
  ThreadEvent,
  { type: "provider.env-resolved" }
>;

export type ResolvedProviderEnvironmentEntry =
  ProviderEnvironmentResolvedEvent["entries"][number];

export function maskResolvedProviderEnvironmentEntries(
  entries: readonly ResolvedProviderEnvironmentEntry[],
): ResolvedProviderEnvironmentEntry[] {
  return entries.map((entry) =>
    entry.source === "shell" ? entry : { ...entry, value: { masked: true } },
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
  if (row.type !== "provider.env-resolved") {
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
