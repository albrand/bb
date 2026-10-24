import { BbHttpError } from "@bb/sdk";
import { describe, expect, it } from "vitest";
import { createNativeActivityReporter } from "../native-activity-reporter.js";
import {
  createSessionDiscoverer,
  recordDiscoveredSession,
} from "../native-session-discovery.js";

const ID = "01a1246a-b896-7b71-9895-ce5345f5f623";

function refusal(status: number, code: string): BbHttpError {
  return new BbHttpError({ body: null, code, message: code, status });
}

function discovererFor(answers: unknown[], found: string | null = ID) {
  const sent: Array<{ authorization: string; nativeSessionId: string }> = [];
  const followed: string[] = [];
  const logged: Array<{ event: string; fields: unknown }> = [];
  let suspended = 0;
  let credential: string | null = "current";
  const reports: string[] = [];
  let reportOutcome: () => Promise<unknown> = async () => ({ ok: true });
  const reporter = createNativeActivityReporter({
    currentCredential: () => credential,
    send: async (args) => {
      reports.push(args.state);
      return reportOutcome();
    },
    threadId: "thr_discovery",
  });
  const discoverer = createSessionDiscoverer({
    currentCredential: () => credential,
    discardUnsentReports: () => reporter.discardRetained(),
    find: () => found,
    log: (event, fields) => logged.push({ event, fields }),
    reader: () => ({
      sessionDiscovered: (sessionId) => {
        followed.push(sessionId);
      },
      suspend: () => {
        suspended += 1;
      },
    }),
    recordSession: async (args) => {
      sent.push(args);
      const answer = answers[sent.length - 1];
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
  });
  discoverer.arm(true);
  return {
    discoverer,
    followed,
    logged,
    reporter,
    reports,
    setReportOutcome: (next: () => Promise<unknown>) => {
      reportOutcome = next;
    },
    sent,
    setCredential: (next: string | null) => {
      credential = next;
    },
    suspended: () => suspended,
  };
}

describe("recording a discovered native session", () => {
  it("sends the holder's current credential with the session id", async () => {
    const sent: Array<{ authorization: string; nativeSessionId: string }> = [];
    expect(
      await recordDiscoveredSession({
        currentCredential: () => "current",
        nativeSessionId: ID,
        recordSession: async (args) => {
          sent.push(args);
        },
      }),
    ).toEqual({ kind: "recorded" });
    expect(sent).toEqual([
      { authorization: "Bearer current", nativeSessionId: ID },
    ]);
  });

  it("asks to retry without sending anything while the holder has no credential", async () => {
    let calls = 0;
    expect(
      await recordDiscoveredSession({
        currentCredential: () => null,
        nativeSessionId: ID,
        recordSession: async () => {
          calls += 1;
        },
      }),
    ).toEqual({ kind: "retry" });
    expect(calls).toBe(0);
  });
});

describe("the holder's session discovery", () => {
  it("records the session on the first tick and follows it", async () => {
    const h = discovererFor([]);
    await h.discoverer.discover();
    expect(h.sent).toEqual([
      { authorization: "Bearer current", nativeSessionId: ID },
    ]);
    expect(h.followed).toEqual([ID]);
    await h.discoverer.discover();
    expect(h.sent).toHaveLength(1);
    expect(h.suspended()).toBe(0);
  });

  it("retries a 401 (the credential hash not stored yet), records on the next tick and never suspends", async () => {
    const h = discovererFor([
      refusal(401, "native_terminal_credential_invalid"),
    ]);
    await h.discoverer.discover();
    await h.discoverer.discover();
    await h.discoverer.discover();
    expect(h.sent).toHaveLength(2);
    expect(h.suspended()).toBe(0);
    expect(h.followed).toEqual([ID]);
    expect(h.logged).toEqual([]);
  });

  it.each([
    new TypeError("fetch failed"),
    refusal(503, "unavailable"),
    refusal(409, "native_terminal_not_live"),
  ])("keeps retrying a transient failure", async (failure) => {
    const h = discovererFor([failure]);
    await h.discoverer.discover();
    await h.discoverer.discover();
    expect(h.sent).toHaveLength(2);
    expect(h.suspended()).toBe(0);
  });

  it("stops asking and stops following the session after a permanent refusal such as a session another thread holds", async () => {
    const h = discovererFor([refusal(409, "native_session_claimed")]);
    await h.discoverer.discover();
    await h.discoverer.discover();
    await h.discoverer.discover();
    expect(h.sent).toHaveLength(1);
    expect(h.suspended()).toBe(1);
    expect(h.followed).toEqual([]);
    expect(h.logged).toEqual([
      {
        event: "session-discovery-stopped",
        fields: { code: "native_session_claimed", sessionId: ID },
      },
    ]);
  });

  it("stops and suspends on an unexpected failure that is not a transport error", async () => {
    const h = discovererFor([new Error("boom")]);
    await h.discoverer.discover();
    await h.discoverer.discover();
    expect(h.sent).toHaveLength(1);
    expect(h.suspended()).toBe(1);
    expect(h.logged[0]?.fields).toMatchObject({ code: "unexpected_error" });
  });

  it("neither follows nor sends while the holder has no credential, and keeps looking", async () => {
    const h = discovererFor([]);
    h.setCredential(null);
    await h.discoverer.discover();
    expect(h.sent).toEqual([]);
    expect(h.followed).toEqual([]);
    h.setCredential("current");
    await h.discoverer.discover();
    expect(h.sent).toHaveLength(1);
  });

  it("does nothing when no session was found yet or discovery is not needed", async () => {
    const none = discovererFor([], null);
    await none.discoverer.discover();
    expect(none.sent).toEqual([]);
    const idle = discovererFor([]);
    idle.discoverer.arm(false);
    await idle.discoverer.discover();
    expect(idle.sent).toEqual([]);
  });

  describe("reports of a session the server refused", () => {
    it("control: a report whose delivery failed is resent when nothing was refused", async () => {
      const h = discovererFor([]);
      h.setReportOutcome(async () => {
        throw refusal(503, "unavailable");
      });
      h.reporter.report({ prompt: null, state: "working" });
      await h.reporter.settled();
      h.reporter.retry();
      await h.reporter.settled();
      expect(h.reports).toEqual(["working", "working"]);
    });

    it("never resends a report that was retained from the refused session", async () => {
      const h = discovererFor([refusal(409, "native_session_claimed")]);
      h.setReportOutcome(async () => {
        throw refusal(503, "unavailable");
      });
      h.reporter.report({ prompt: null, state: "working" });
      await h.reporter.settled();
      expect(h.reports).toEqual(["working"]);

      await h.discoverer.discover();
      h.reporter.retry();
      await h.reporter.settled();
      h.reporter.retry();
      await h.reporter.settled();
      expect(h.reports).toEqual(["working"]);
      expect(h.suspended()).toBe(1);
    });

    it("does not retain a report that was in flight when the session was refused", async () => {
      const h = discovererFor([refusal(409, "native_session_claimed")]);
      let fail: () => void = () => undefined;
      h.setReportOutcome(
        () =>
          new Promise((_resolve, reject) => {
            fail = () => reject(refusal(503, "unavailable"));
          }),
      );
      h.reporter.report({ prompt: null, state: "working" });
      await Promise.resolve();
      await h.discoverer.discover();
      fail();
      await h.reporter.settled();
      h.reporter.retry();
      await h.reporter.settled();
      expect(h.reports).toEqual(["working"]);
    });
  });
});
