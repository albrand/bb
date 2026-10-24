import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";
import {
  claudeAiHostContract,
  type ClaudeAiFailureCode,
  type ClaudeAiTextResult,
} from "./ai/host-contract.js";

export const CLAUDE_TEXT_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
] as const;
const COMPLETE_TIMEOUT_MS = 8_000;
const STATUS_TIMEOUT_MS = 5_000;
const HOST_CALL_GRACE_MS = 1_000;
const MIN_ATTEMPT_MS = 1_000;
const RETRY_WITH_NEXT_MODEL: ReadonlySet<ClaudeAiFailureCode> = new Set([
  "rate_limited",
  "service_unavailable",
  "invalid_response",
]);

function settleWithin<T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error("The request was cancelled"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new Error(message));
      },
      Math.max(0, ms),
    );
    const onAbort = (): void => {
      cleanup();
      reject(new Error("The request was cancelled"));
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function registerClaudeAiService(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: claudeAiHostContract });

  async function primaryHostId(): Promise<string | null> {
    return (await bb.sdk.system.config()).primaryHostId;
  }

  bb.experimental_aiServices.register({
    id: "claude",
    displayName: "Claude",
    async complete(prompt, { signal }) {
      const deadline = Date.now() + COMPLETE_TIMEOUT_MS;
      const hostId = await settleWithin(
        primaryHostId(),
        COMPLETE_TIMEOUT_MS,
        signal,
        "Claude did not answer in time",
      );
      if (hostId === null) throw new Error("No primary machine is connected");
      let last: ClaudeAiTextResult | null = null;
      for (const model of CLAUDE_TEXT_MODELS) {
        const remainingMs = deadline - Date.now();
        if (remainingMs < MIN_ATTEMPT_MS || signal.aborted) break;
        last = await host.call(
          "claude.ai.complete",
          { model, prompt, timeoutMs: remainingMs },
          {
            hostId,
            signal,
            timeoutMs: remainingMs + HOST_CALL_GRACE_MS,
          },
        );
        if (last.ok || !RETRY_WITH_NEXT_MODEL.has(last.code)) break;
        if (signal.aborted) break;
      }
      if (last === null) throw new Error("Claude did not answer in time");
      if (last.ok) return last.text;
      throw new Error(last.message);
    },
    async status(): Promise<PluginAiServiceStatus> {
      const deadline = Date.now() + STATUS_TIMEOUT_MS;
      const hostId = await settleWithin(
        primaryHostId(),
        STATUS_TIMEOUT_MS,
        undefined,
        "The Claude status check did not answer in time",
      );
      if (hostId === null) {
        return { ready: false, message: "No primary machine is connected" };
      }
      return host.call(
        "claude.ai.status",
        {},
        { hostId, timeoutMs: Math.max(1, deadline - Date.now()) },
      );
    },
  });
}
