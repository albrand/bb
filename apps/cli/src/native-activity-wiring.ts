import { BbHttpError } from "@bb/sdk";
import type { NativeActivityReport } from "./native-activity.js";
import { createNativeSessionRebinder } from "./native-session-rebinder.js";

export interface NativeActivityWiring {
  onCredentialChanged(): void;
  onHeartbeatTick(): void;
  onSessionAdopted(adoptedSessionId: string, previousSessionId: string): void;
  settled(): Promise<void>;
}

export function createNativeActivityWiring(options: {
  currentCredential(): string | null;
  log(event: string, fields: Record<string, number | string | null>): void;
  reader(): {
    heartbeat(): NativeActivityReport | null;
    sessionRebound(sessionId: string): void;
    suspend(): void;
  } | null;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
    replacesNativeSessionId: string;
  }): Promise<unknown>;
  report(
    next: NativeActivityReport | null,
    options?: { transient?: boolean },
  ): void;
  retryReport(): void;
}): NativeActivityWiring {
  const rebinder = createNativeSessionRebinder({
    currentCredential: options.currentCredential,
    onRecorded: (move) => {
      options.reader()?.sessionRebound(move.sessionId);
    },
    onRefused: (move, code) => {
      options.reader()?.suspend();
      options.log("activity-session-rebind-refused", {
        code,
        sessionId: move.sessionId,
      });
    },
    recordSession: async (args) => {
      try {
        return await options.recordSession(args);
      } catch (error) {
        options.log("activity-session-rebind-deferred", {
          code: error instanceof BbHttpError ? error.code : null,
          sessionId: args.nativeSessionId,
          status: error instanceof BbHttpError ? error.status : null,
        });
        throw error;
      }
    },
  });
  const heartbeat = (): void => {
    options.report(options.reader()?.heartbeat() ?? null, { transient: true });
  };
  return {
    onCredentialChanged: () => {
      options.retryReport();
      rebinder.retry();
      heartbeat();
    },
    onHeartbeatTick: () => {
      options.retryReport();
      rebinder.retry();
      heartbeat();
    },
    onSessionAdopted: (adoptedSessionId, previousSessionId) => {
      options.log("activity-session-adopted", {
        previousSessionId,
        sessionId: adoptedSessionId,
      });
      rebinder.enqueue({ previousSessionId, sessionId: adoptedSessionId });
    },
    settled: () => rebinder.settled(),
  };
}

export function createNativeActivityPump(options: {
  reader(): { read(): NativeActivityReport[] } | null;
  report(next: NativeActivityReport): void;
}): () => void {
  return () => {
    for (const next of options.reader()?.read() ?? []) options.report(next);
  };
}
