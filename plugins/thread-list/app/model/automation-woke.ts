import { useCallback, useSyncExternalStore } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";

type AutomationStartMap = ReadonlyMap<string, number>;

interface AutomationSnapshot {
  startedAt: number | null;
  elapsedMinutes: number | null;
}

let cachedUntil = 0;
let cachedStarts: AutomationStartMap = new Map();
let request: Promise<AutomationStartMap> | null = null;
const emptySnapshot: AutomationSnapshot = {
  startedAt: null,
  elapsedMinutes: null,
};
const snapshots = new Map<string, AutomationSnapshot>();
const subscribers = new Map<string, Set<() => void>>();
let activeSdk: ReturnType<typeof useSdk> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function loadAutomationStarts(
  sdk: ReturnType<typeof useSdk>,
): Promise<AutomationStartMap> {
  if (Date.now() < cachedUntil) return cachedStarts;
  if (request !== null) return request;
  request = Promise.resolve()
    .then(() =>
      sdk.plugins.callRpc({
        pluginId: "automations",
        method: "automations_overview",
        outputSchema: z.unknown(),
      }),
    )
    .then((value) => {
      const overview = record(value);
      const rows = overview?.automations;
      const starts = new Map<string, number>();
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const automation = record(record(row)?.automation);
          if (
            automation?.lastRunStatus === "running" &&
            typeof automation.lastRunThreadId === "string" &&
            typeof automation.lastRunAt === "number"
          ) {
            starts.set(automation.lastRunThreadId, automation.lastRunAt);
          }
        }
      }
      cachedStarts = starts;
      cachedUntil = Date.now() + 20_000;
      return cachedStarts;
    })
    .catch(() => {
      cachedStarts = new Map();
      cachedUntil = Date.now() + 20_000;
      return cachedStarts;
    })
    .finally(() => {
      request = null;
    });
  return request;
}

async function refreshAutomationSnapshots() {
  if (activeSdk === null) return;
  const starts = await loadAutomationStarts(activeSdk);
  const now = Date.now();
  for (const [threadId, listeners] of subscribers) {
    const startedAt = starts.get(threadId) ?? null;
    const elapsedMinutes =
      startedAt === null
        ? null
        : Math.max(1, Math.floor((now - startedAt) / 60_000));
    const previous = snapshots.get(threadId) ?? emptySnapshot;
    if (
      previous.startedAt === startedAt &&
      previous.elapsedMinutes === elapsedMinutes
    ) {
      continue;
    }
    snapshots.set(threadId, { startedAt, elapsedMinutes });
    for (const listener of listeners) listener();
  }
}

function subscribeToAutomationSnapshot(
  threadId: string,
  listener: () => void,
  sdk: ReturnType<typeof useSdk>,
) {
  let listeners = subscribers.get(threadId);
  if (listeners === undefined) {
    listeners = new Set();
    subscribers.set(threadId, listeners);
  }
  listeners.add(listener);
  activeSdk ??= sdk;
  if (timer === null) {
    void refreshAutomationSnapshots();
    timer = setInterval(() => void refreshAutomationSnapshots(), 20_000);
  }
  return () => {
    const current = subscribers.get(threadId);
    current?.delete(listener);
    if (current?.size === 0) {
      subscribers.delete(threadId);
      snapshots.delete(threadId);
    }
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      activeSdk = null;
    }
  };
}

export function useAutomationWokeAt(
  threadId: string,
  enabled = true,
): AutomationSnapshot {
  const sdk = useSdk();
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled
        ? subscribeToAutomationSnapshot(threadId, listener, sdk)
        : () => {},
    [enabled, sdk, threadId],
  );
  const getSnapshot = useCallback(
    () =>
      enabled ? (snapshots.get(threadId) ?? emptySnapshot) : emptySnapshot,
    [enabled, threadId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
