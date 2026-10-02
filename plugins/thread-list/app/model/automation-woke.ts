import { useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";

type AutomationStartMap = ReadonlyMap<string, number>;

let cachedUntil = 0;
let cachedStarts: AutomationStartMap = new Map();
let request: Promise<AutomationStartMap> | null = null;

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

export function useAutomationWokeAt(threadId: string): {
  startedAt: number | null;
  now: number;
} {
  const sdk = useSdk();
  const [state, setState] = useState({
    startedAt: null as number | null,
    now: 0,
  });
  useEffect(() => {
    let mounted = true;
    const update = () => {
      void loadAutomationStarts(sdk).then((starts) => {
        if (mounted) {
          setState({
            startedAt: starts.get(threadId) ?? null,
            now: Date.now(),
          });
        }
      });
    };
    update();
    const timer = setInterval(update, 20_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [sdk, threadId]);
  return state;
}
