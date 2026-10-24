import { BbHttpError } from "@bb/sdk";
import { describe, expect, it } from "vitest";
import type { NativeActivityReport } from "../native-activity.js";
import { createNativeActivityWiring } from "../native-activity-wiring.js";

const A = "aaaaaaaa-1111-4222-8333-444455556666";
const B = "bbbbbbbb-1111-4222-8333-444455556666";

function failure(status: number, code: string): BbHttpError {
  return new BbHttpError({ body: null, code, message: code, status });
}

function setup(answers: unknown[]) {
  const attempts: string[] = [];
  const order: string[] = [];
  const transient: boolean[] = [];
  const reports: Array<NativeActivityReport | null> = [];
  const logged: Array<{ event: string; fields: unknown }> = [];
  const rebound: string[] = [];
  let suspended = 0;
  let credential: string | null = "old";
  const wiring = createNativeActivityWiring({
    currentCredential: () => credential,
    log: (event, fields) => logged.push({ event, fields }),
    reader: () => ({
      heartbeat: () => ({ state: "working", prompt: null }),
      sessionRebound: (sessionId) => {
        rebound.push(sessionId);
      },
      suspend: () => {
        suspended += 1;
      },
    }),
    recordSession: async (args) => {
      attempts.push(args.authorization);
      const answer = answers[attempts.length - 1];
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
    report: (next, options) => {
      reports.push(next);
      order.push("heartbeat");
      transient.push(options?.transient === true);
    },
    retryReport: () => {
      order.push("retry");
    },
  });
  return {
    attempts,
    order,
    transient,
    logged,
    rebound,
    reports,
    setCredential: (next: string | null) => {
      credential = next;
    },
    suspended: () => suspended,
    wiring,
  };
}

describe("native activity wiring", () => {
  it.each([
    [
      "the heartbeat tick",
      (w: ReturnType<typeof setup>) => w.wiring.onHeartbeatTick(),
    ],
    [
      "the credential refresh",
      (w: ReturnType<typeof setup>) => {
        w.setCredential("new");
        w.wiring.onCredentialChanged();
      },
    ],
  ])(
    "completes a pending move after a transient refusal on %s",
    async (_name, trigger) => {
      for (const transient of [
        failure(409, "native_terminal_not_live"),
        failure(503, "unavailable"),
      ]) {
        const w = setup([transient]);
        w.wiring.onSessionAdopted(B, A);
        await w.wiring.settled();
        expect(w.attempts).toHaveLength(1);
        expect(w.logged.map((entry) => entry.event)).toEqual([
          "activity-session-adopted",
          "activity-session-rebind-deferred",
        ]);

        trigger(w);
        await w.wiring.settled();
        expect(w.attempts).toHaveLength(2);
        expect(w.reports).toEqual([{ state: "working", prompt: null }]);
        w.wiring.onHeartbeatTick();
        await w.wiring.settled();
        expect(w.attempts).toHaveLength(2);
      }
    },
  );

  it("uses the refreshed credential for the retry", async () => {
    const w = setup([failure(401, "native_terminal_credential_invalid")]);
    w.wiring.onSessionAdopted(B, A);
    await w.wiring.settled();
    w.setCredential("new");
    w.wiring.onCredentialChanged();
    await w.wiring.settled();
    expect(w.attempts).toEqual(["Bearer old", "Bearer new"]);
  });

  it.each([
    failure(409, "native_session_claimed"),
    failure(400, "invalid_request"),
  ])(
    "suspends the reader and logs the refusal on a permanent answer",
    async (permanent) => {
      const w = setup([permanent]);
      w.wiring.onSessionAdopted(B, A);
      await w.wiring.settled();
      expect(w.suspended()).toBe(1);
      expect(w.logged.at(-1)).toEqual({
        event: "activity-session-rebind-refused",
        fields: { code: permanent.code, sessionId: B },
      });
      w.wiring.onHeartbeatTick();
      await w.wiring.settled();
      expect(w.attempts).toHaveLength(1);
    },
  );

  describe("retained report", () => {
    it("is retried on each heartbeat tick and on each credential refresh, before the heartbeat is sent", () => {
      const w = setup([]);
      w.wiring.onHeartbeatTick();
      w.wiring.onCredentialChanged();
      expect(w.order).toEqual(["retry", "heartbeat", "retry", "heartbeat"]);
    });

    it("sends the heartbeat as a transient report", () => {
      const w = setup([]);
      w.wiring.onHeartbeatTick();
      expect(w.transient).toEqual([true]);
    });
  });
});
