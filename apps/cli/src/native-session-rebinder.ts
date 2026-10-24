import { BbHttpError, BbRequestTimeoutError } from "@bb/sdk";

export interface NativeSessionMove {
  previousSessionId: string;
  sessionId: string;
}

export interface NativeSessionRebinder {
  enqueue(move: NativeSessionMove): void;
  pending(): number;
  retry(): void;
  settled(): Promise<void>;
}

const RETRYABLE_CLIENT_STATUSES = new Set([401, 408, 429]);
const RETRYABLE_CODES = new Set(["native_terminal_not_live"]);

const UNDICI_TRANSPORT_MESSAGES = new Set(["fetch failed", "terminated"]);

const SYSTEM_ERROR_CODE = /^(?:E(?!RR_)[A-Z0-9_]+|UND_ERR_[A-Z_]+)$/u;

function hasSystemErrorCode(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    SYSTEM_ERROR_CODE.test(cause.code)
  );
}

const MAX_TRANSPORT_CAUSE_DEPTH = 3;

function isTransportFailure(error: unknown, depth = 0): boolean {
  if (error instanceof BbRequestTimeoutError) return true;
  if (
    error instanceof TypeError &&
    (UNDICI_TRANSPORT_MESSAGES.has(error.message) ||
      hasSystemErrorCode(error.cause))
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    depth < MAX_TRANSPORT_CAUSE_DEPTH &&
    isTransportFailure(error.cause, depth + 1)
  );
}

export function permanentRefusal(error: unknown): string | null {
  if (!(error instanceof BbHttpError)) {
    return isTransportFailure(error) ? null : "unexpected_error";
  }
  if (error.status < 400 || error.status >= 500) return null;
  if (RETRYABLE_CLIENT_STATUSES.has(error.status)) return null;
  if (error.code !== null && RETRYABLE_CODES.has(error.code)) return null;
  return error.code ?? `http_${error.status}`;
}

export function createNativeSessionRebinder(options: {
  currentCredential(): string | null;
  onRecorded?(move: NativeSessionMove): void;
  onRefused(move: NativeSessionMove, code: string): void;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
    replacesNativeSessionId: string;
  }): Promise<unknown>;
}): NativeSessionRebinder {
  const queue: NativeSessionMove[] = [];
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const credential = options.currentCredential();
      const move = queue[0];
      if (credential === null || move === undefined) return;
      try {
        await options.recordSession({
          authorization: `Bearer ${credential}`,
          nativeSessionId: move.sessionId,
          replacesNativeSessionId: move.previousSessionId,
        });
        queue.shift();
        options.onRecorded?.(move);
      } catch (error) {
        const code = permanentRefusal(error);
        if (code === null) return;
        queue.length = 0;
        options.onRefused(move, code);
        return;
      }
    }
  };

  const retry = (): void => {
    if (running !== null || queue.length === 0) return;
    running = drain().finally(() => {
      running = null;
    });
  };

  return {
    enqueue(move) {
      queue.push(move);
      retry();
    },
    pending: () => queue.length,
    retry,
    settled: async () => {
      while (running !== null) await running;
    },
  };
}
