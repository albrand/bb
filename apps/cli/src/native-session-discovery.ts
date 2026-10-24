import { permanentRefusal } from "./native-session-rebinder.js";

export type DiscoveredSessionOutcome =
  | { kind: "recorded" }
  | { code: string; kind: "refused" }
  | { kind: "retry" };

export async function recordDiscoveredSession(options: {
  currentCredential(): string | null;
  nativeSessionId: string;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
  }): Promise<unknown>;
}): Promise<DiscoveredSessionOutcome> {
  const credential = options.currentCredential();
  if (credential === null) return { kind: "retry" };
  try {
    await options.recordSession({
      authorization: `Bearer ${credential}`,
      nativeSessionId: options.nativeSessionId,
    });
    return { kind: "recorded" };
  } catch (error) {
    const code = permanentRefusal(error);
    return code === null ? { kind: "retry" } : { code, kind: "refused" };
  }
}

export interface SessionDiscovererReader {
  sessionDiscovered(sessionId: string): void;
  suspend(): void;
}

export function createSessionDiscoverer(options: {
  currentCredential(): string | null;
  discardUnsentReports(): void;
  find(): string | null;
  log(event: string, fields: Record<string, number | string | null>): void;
  reader(): SessionDiscovererReader | null;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
  }): Promise<unknown>;
}): { arm(needed: boolean): void; discover(): Promise<void> } {
  let pending = false;
  return {
    arm(needed) {
      pending = needed;
    },
    async discover() {
      if (!pending) return;
      const sessionId = options.find();
      if (sessionId === null) return;
      if (options.currentCredential() === null) return;
      pending = false;
      const outcome = await recordDiscoveredSession({
        currentCredential: options.currentCredential,
        nativeSessionId: sessionId,
        recordSession: options.recordSession,
      });
      pending = outcome.kind === "retry";
      if (outcome.kind === "recorded") {
        options.reader()?.sessionDiscovered(sessionId);
      }
      if (outcome.kind === "refused") {
        options.reader()?.suspend();
        options.discardUnsentReports();
        options.log("session-discovery-stopped", {
          code: outcome.code,
          sessionId,
        });
      }
    },
  };
}
