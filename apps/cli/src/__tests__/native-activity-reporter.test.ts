import { BbHttpError, BbRequestTimeoutError } from "@bb/sdk";
import { describe, expect, it } from "vitest";
import { createNativeActivityReporter } from "../native-activity-reporter.js";

interface Sent {
  authorization: string | undefined;
  state: string;
}

function setup(initial: string | null) {
  let credential = initial;
  const sent: Sent[] = [];
  const reporter = createNativeActivityReporter({
    currentCredential: () => credential,
    send: async (args) => {
      sent.push({ authorization: args.authorization, state: args.state });
      return { ok: true };
    },
    threadId: "thr_1",
  });
  return {
    reporter,
    sent,
    setCredential: (next: string | null) => {
      credential = next;
    },
  };
}

describe("native activity reporter", () => {
  it("reads the holder's current credential when each report is sent", async () => {
    const { reporter, sent, setCredential } = setup("first");
    reporter.report({ state: "working", prompt: null });
    await reporter.settled();
    setCredential("second");
    reporter.report({ state: "working", prompt: null });
    await reporter.settled();
    expect(sent).toEqual([
      { authorization: "Bearer first", state: "working" },
      { authorization: "Bearer second", state: "working" },
    ]);
  });

  it("picks up a credential that changes while an earlier report is in flight", async () => {
    let credential: string | null = "first";
    const sent: Array<string | undefined> = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reporter = createNativeActivityReporter({
      currentCredential: () => credential,
      send: async (args) => {
        sent.push(args.authorization);
        if (sent.length === 1) await gate;
        return { ok: true };
      },
      threadId: "thr_1",
    });
    reporter.report({ state: "working", prompt: null });
    reporter.report({ state: "idle", prompt: null });
    await Promise.resolve();
    expect(sent).toEqual(["Bearer first"]);
    credential = "second";
    releaseFirst();
    await reporter.settled();
    expect(sent).toEqual(["Bearer first", "Bearer second"]);
  });

  it("sends no authorization when the holder has no credential", async () => {
    const { reporter, sent } = setup(null);
    reporter.report({ state: "working", prompt: null });
    await reporter.settled();
    expect(sent).toEqual([{ authorization: undefined, state: "working" }]);
  });

  it("does not send an empty report", async () => {
    const { reporter, sent } = setup("first");
    reporter.report(null);
    await reporter.settled();
    expect(sent).toEqual([]);
  });

  describe("a report the server rejects for its credential", () => {
    const rejection = () =>
      new BbHttpError({
        body: null,
        code: "native_terminal_credential_invalid",
        message: "invalid",
        status: 401,
      });

    function rejecting(rejectFirst: number) {
      const sent: Array<{ authorization: string | undefined; state: string }> =
        [];
      let credential: string | null = "old";
      const reporter = createNativeActivityReporter({
        currentCredential: () => credential,
        send: async (args) => {
          sent.push({ authorization: args.authorization, state: args.state });
          if (sent.length <= rejectFirst) throw rejection();
          return { ok: true };
        },
        threadId: "thr_1",
      });
      return {
        reporter,
        sent,
        setCredential: (next: string | null) => {
          credential = next;
        },
      };
    }

    it("is kept and resent once, with the credential current then, when the holder retries", async () => {
      const { reporter, sent, setCredential } = rejecting(1);
      reporter.report({ state: "idle", prompt: null });
      await reporter.settled();
      expect(sent).toEqual([{ authorization: "Bearer old", state: "idle" }]);

      setCredential("new");
      reporter.retry();
      await reporter.settled();
      expect(sent).toEqual([
        { authorization: "Bearer old", state: "idle" },
        { authorization: "Bearer new", state: "idle" },
      ]);
      reporter.retry();
      await reporter.settled();
      expect(sent).toHaveLength(2);
    });

    it("keeps only the latest report: a newer one replaces the retained one", async () => {
      const { reporter, sent } = rejecting(2);
      reporter.report({ state: "idle", prompt: null });
      reporter.report({ state: "working", prompt: "next" });
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual(["idle", "working"]);
      reporter.retry();
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual([
        "idle",
        "working",
        "working",
      ]);
    });

    it("drops the retained report when a newer report is accepted, so a stale state is never resent after it", async () => {
      const { reporter, sent } = rejecting(1);
      reporter.report({ state: "idle", prompt: null });
      await reporter.settled();
      reporter.report({ state: "working", prompt: "next" });
      await reporter.settled();
      reporter.retry();
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual(["idle", "working"]);
    });

    it("does not retain an older report that fails after a newer one was already queued", async () => {
      const { reporter, sent } = rejecting(1);
      reporter.report({ state: "idle", prompt: null });
      reporter.report({ state: "working", prompt: "next" });
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual(["idle", "working"]);
      reporter.retry();
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual(["idle", "working"]);
    });

    it("does not keep a heartbeat", async () => {
      const { reporter, sent } = rejecting(1);
      reporter.report({ state: "working", prompt: null }, { transient: true });
      await reporter.settled();
      reporter.retry();
      await reporter.settled();
      expect(sent).toHaveLength(1);
    });

    it("keeps the report through repeated rejections until it is accepted", async () => {
      const { reporter, sent } = rejecting(3);
      reporter.report({ state: "idle", prompt: null });
      await reporter.settled();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        reporter.retry();
        await reporter.settled();
      }
      expect(sent).toHaveLength(4);
      reporter.retry();
      await reporter.settled();
      expect(sent).toHaveLength(4);
    });

    it("does not keep a report rejected for any other reason", async () => {
      const sent: string[] = [];
      const reporter = createNativeActivityReporter({
        currentCredential: () => "c",
        send: async (args) => {
          sent.push(args.state);
          throw new Error("down");
        },
        threadId: "thr_1",
      });
      reporter.report({ state: "idle", prompt: null });
      await reporter.settled();
      reporter.retry();
      await reporter.settled();
      expect(sent).toEqual(["idle"]);
    });
  });

  describe("question closure and the non-confirming marker (INJECTED responses: the rejections below are hand-built; the wording against the real pre-change schema is pinned in apps/server/test/threads/native-activity-delivery.test.ts)", () => {
    const rejection = (fields: string = '"confirms", "closes"') =>
      new BbHttpError({
        body: null,
        code: "invalid_request",
        message: `Unrecognized key: ${fields}`,
        status: 400,
      });
    const unavailable = () =>
      new BbHttpError({
        body: null,
        code: "unavailable",
        message: "unavailable",
        status: 503,
      });
    const working = { prompt: null, state: "working" } as const;
    const marked = { confirms: false, prompt: null, state: "working" } as const;
    const asking = (...ids: string[]) =>
      ({
        prompt: null,
        questions: ids.map((id) => ({ id, prompt: `Question ${id}?` })),
        state: "waiting",
      }) as const;

    interface Call {
      authorization: string | undefined;
      closes: string[] | undefined;
      confirms: boolean | undefined;
      prompt: string | undefined;
      questions: string[] | undefined;
      state: string;
    }

    function closureSetup(answers: Array<() => Promise<unknown>>) {
      const calls: Call[] = [];
      const logged: Array<{ event: string; fields: unknown }> = [];
      let credential = "c";
      const reporter = createNativeActivityReporter({
        currentCredential: () => credential,
        log: (event, fields) => logged.push({ event, fields }),
        send: async (args) => {
          calls.push({
            authorization: args.authorization,
            closes: args.closes,
            confirms: args.confirms,
            prompt: args.prompt,
            questions: args.questions?.map((question) => question.id),
            state: args.state,
          });
          credential = "rotated-after-an-attempt";
          const answer = answers[calls.length - 1];
          return answer === undefined ? { ok: true } : answer();
        },
        threadId: "thr_1",
      });
      return { calls, logged, reporter };
    }

    const closesOf = (calls: Array<{ closes: string[] | undefined }>) =>
      calls.map((call) => call.closes);

    it("omits empty closes and includes IDs only when a report closes questions", async () => {
      const { calls, reporter } = closureSetup([]);
      reporter.report(asking("q1"));
      reporter.report(working);
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"], undefined]);
    });

    it("omits empty close lists on every report kind", async () => {
      const { calls, reporter } = closureSetup([]);
      reporter.report(asking("q1", "q2"));
      reporter.report(asking("q2"));
      reporter.report(working);
      reporter.report(marked);
      reporter.report({ prompt: null, state: "idle" });
      reporter.report(asking("q3"));
      reporter.report({ prompt: null, state: "idle" });
      await reporter.settled();
      expect(calls.map((call) => call.state)).toEqual([
        "waiting",
        "waiting",
        "working",
        "working",
        "idle",
        "waiting",
        "idle",
      ]);
      expect(closesOf(calls)).toEqual([
        undefined,
        ["q1"],
        ["q2"],
        undefined,
        undefined,
        undefined,
        ["q3"],
      ]);
    });

    it("lets an opening report replace the questions it does not list, and never names the ones it opens", async () => {
      const { calls, reporter } = closureSetup([]);
      reporter.report(asking("q1"));
      reporter.report(asking("q2"));
      reporter.report(asking("q2", "q3"));
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"], undefined]);
    });

    it("carries a close whose delivery timed out in the next report, so a late delivery of the first one has nothing left to take", async () => {
      const { calls, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw new BbRequestTimeoutError(75_000);
        },
      ]);
      reporter.report(asking("q1"));
      reporter.report(working);
      await reporter.settled();
      reporter.report(asking("q2"));
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"], ["q1"]]);
    });

    it("treats a question as possibly open from the moment its report is attempted", async () => {
      const { calls, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw new BbRequestTimeoutError(75_000);
        },
      ]);
      reporter.report(working);
      reporter.report(asking("q1"));
      await reporter.settled();
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, undefined, ["q1"]]);
    });

    const faults: Array<[string, () => Error]> = [
      ["a client timeout", () => new BbRequestTimeoutError(75_000)],
      ["a 503", unavailable],
    ];
    const newer: Array<
      [string, typeof working | { prompt: null; state: "idle" }]
    > = [
      ["an idle report", { prompt: null, state: "idle" }],
      ["a working report", working],
    ];

    describe.each(faults)(
      "a waiting report whose response is %s",
      (_, fault) => {
        it.each(newer)(
          "is still listed as open by %s that supersedes it, whether or not the server applied it",
          async (_label, next) => {
            const { calls, reporter } = closureSetup([
              async () => {
                throw fault();
              },
            ]);
            reporter.report(asking("q1"));
            reporter.report(next);
            await reporter.settled();
            expect(closesOf(calls)).toEqual([undefined, ["q1"]]);
            reporter.report(next);
            await reporter.settled();
            expect(closesOf(calls)).toEqual([undefined, ["q1"], undefined]);
          },
        );

        it("is closed by a successful waiting report that opens another question, which names the lost one and never its own", async () => {
          const { calls, reporter } = closureSetup([
            async () => {
              throw fault();
            },
          ]);
          reporter.report(asking("q1"));
          reporter.report(asking("q2"));
          await reporter.settled();
          expect(calls.map((call) => call.questions)).toEqual([["q1"], ["q2"]]);
          expect(closesOf(calls)).toEqual([undefined, ["q1"]]);
          reporter.report(working);
          await reporter.settled();
          expect(closesOf(calls)).toEqual([undefined, ["q1"], ["q2"]]);
        });

        it("is listed as open by a report that supersedes it while it is retained, and the retained copy is not resent afterwards", async () => {
          const { calls, reporter } = closureSetup([
            async () => {
              throw fault();
            },
          ]);
          reporter.report(asking("q1"));
          await reporter.settled();
          reporter.report(working);
          await reporter.settled();
          reporter.retry();
          await reporter.settled();
          expect(calls.map((call) => call.state)).toEqual([
            "waiting",
            "working",
          ]);
          expect(closesOf(calls)).toEqual([undefined, ["q1"]]);
        });

        it("is not listed twice when the retained copy is resent, and the next report still closes it", async () => {
          const { calls, reporter } = closureSetup([
            async () => {
              throw fault();
            },
          ]);
          reporter.report(asking("q1"));
          await reporter.settled();
          reporter.retry();
          await reporter.settled();
          reporter.report(working);
          await reporter.settled();
          expect(calls.map((call) => call.state)).toEqual([
            "waiting",
            "waiting",
            "working",
          ]);
      expect(closesOf(calls)).toEqual([undefined, undefined, ["q1"]]);
        });
      },
    );

    it("still lists a question opened by a report the server refused before it committed anything, so the next report closes it", async () => {
      const { calls, reporter } = closureSetup([
        async () => {
          throw new BbHttpError({
            body: null,
            code: "rate_limited",
            message: "slow down",
            status: 429,
          });
        },
        async () => {
          throw unavailable();
        },
      ]);
      reporter.report(asking("q1"));
      reporter.report(asking("q2"));
      reporter.report({ prompt: null, state: "idle" });
      await reporter.settled();
      expect(closesOf(calls)).toEqual([
        undefined,
        ["q1"],
        ["q1", "q2"],
      ]);
    });

    it("sends confirms false only on a report that carries the marker", async () => {
      const { calls, reporter } = closureSetup([]);
      reporter.report(working);
      reporter.report(marked);
      await reporter.settled();
      expect(calls.map((call) => call.confirms)).toEqual([undefined, false]);
    });

    it("blocks a report that closes X and opens Y when the server rejects closes", async () => {
      const { calls, logged, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw rejection('"closes"');
        },
        async () => {
          throw rejection('"closes"');
        },
      ]);
      reporter.report(asking("x"));
      reporter.report(asking("y"));
      await reporter.settled();
      expect(calls).toHaveLength(2);
      expect(closesOf(calls)).toEqual([undefined, ["x"]]);
      expect(calls[1]?.authorization).toBe("Bearer rotated-after-an-attempt");
      expect(logged).toEqual([
        {
          event: "activity-closure-field-rejected",
          fields: { closes: 1, confirms: 0 },
        },
        {
          event: "activity-closure-fallback-skipped",
          fields: {
            closes: 1,
            reason: "legacy_server_does_not_support_closes",
          },
        },
      ]);
    });

    it("blocks an unsupported close report and only retries the newest report after supersession", async () => {
      const calls: Array<{
        questions: string[] | undefined;
        state: string;
      }> = [];
      const logged: string[] = [];
      let rejectFirstClose: () => void = () => undefined;
      let releaseFirstClose: () => void = () => undefined;
      const firstCloseSeen = new Promise<void>((resolve) => {
        rejectFirstClose = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseFirstClose = resolve;
      });
      const reporter = createNativeActivityReporter({
        currentCredential: () => "c",
        log: (event) => logged.push(event),
        send: async (args) => {
          calls.push({
            questions: args.questions?.map((question) => question.id),
            state: args.state,
          });
          if (calls.length === 2) {
            rejectFirstClose();
            await release;
            throw rejection('"closes"');
          }
          if (calls.length === 3) throw rejection('"closes"');
          return { ok: true };
        },
        threadId: "thr_1",
      });

      reporter.report(asking("x"));
      await reporter.settled();
      reporter.report(working);
      await firstCloseSeen;
      reporter.report(asking("y"));
      releaseFirstClose();
      await reporter.settled();

      expect(calls.map(({ state, questions }) => [state, questions])).toEqual([
        ["waiting", ["x"]],
        ["working", undefined],
        ["waiting", ["y"]],
      ]);
      reporter.retry();
      await reporter.settled();
      expect(calls).toHaveLength(3);
      expect(logged).toContain("activity-closure-fallback-skipped");
    });

    it("keeps a rejected close blocked until a newer report supersedes it", async () => {
      const { calls, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw rejection('"closes"');
        },
        async () => ({ ok: true }),
      ]);
      reporter.report(asking("q1", "q2"));
      await reporter.settled();
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1", "q2"]]);
      reporter.retry();
      await reporter.settled();
      expect(calls).toHaveLength(2);
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([
        undefined,
        ["q1", "q2"],
        ["q1", "q2"],
      ]);
      expect(calls.at(-1)?.state).toBe("working");
    });

    it("never retries a rejected non-empty close without its IDs", async () => {
      const { calls, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw new BbHttpError({
            body: null,
            code: "invalid_request",
            message: "invalid close identifier",
            status: 400,
          });
        },
        async () => ({ ok: true }),
      ]);
      reporter.report(asking("q1"));
      await reporter.settled();
      reporter.report(working);
      await reporter.settled();

      expect(closesOf(calls)).toEqual([undefined, ["q1"]]);
      reporter.retry();
      await reporter.settled();
      expect(calls).toHaveLength(2);

      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"], ["q1"]]);
    });

    it("retains possibly-open IDs through a blocked legacy close for the next supported report", async () => {
      const { calls, reporter } = closureSetup([
        async () => {
          throw new BbHttpError({
            body: null,
            code: "temporarily_unavailable",
            message: "response lost after possible apply",
            status: 503,
          });
        },
        async () => {
          throw rejection('"closes"');
        },
        async () => ({ ok: true }),
      ]);
      reporter.report(asking("q1"));
      await reporter.settled();
      reporter.report(working);
      await reporter.settled();
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"], ["q1"]]);
    });

    it("keeps a non-confirming report queued instead of retrying without confirms", async () => {
      const { calls, logged, reporter } = closureSetup([
        async () => {
          throw rejection('"confirms"');
        },
      ]);
      reporter.report({ confirms: false, prompt: "kept", state: "working" });
      await reporter.settled();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ confirms: false });
      expect(calls[0]?.closes).toBeUndefined();
      expect(logged).toEqual([
        {
          event: "activity-confirmation-fallback-skipped",
          fields: { confirms: 1, reason: "legacy_server_defaults_true" },
        },
      ]);
      reporter.retry();
      await reporter.settled();
      expect(calls).toHaveLength(1);
    });

    it("keeps only the newest unsupported-close report in the bounded retry slot", async () => {
      const { calls, logged, reporter } = closureSetup([
        async () => {
          throw rejection('"closes"');
        },
        async () => {
          throw rejection('"closes"');
        },
      ]);
      reporter.report(working);
      await reporter.settled();
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, undefined]);
      expect(
        logged.filter(
          (entry) => entry.event === "activity-closure-fallback-skipped",
        ),
      ).toHaveLength(2);
    });

    it.each([
      [
        "a 400 that does not name a field",
        () =>
          new BbHttpError({
            body: null,
            code: "invalid_request",
            message: "Required",
            status: 400,
          }),
      ],
      [
        "an unrelated validation error",
        () =>
          new BbHttpError({
            body: null,
            code: "invalid_request",
            message: "Too big: expected string to have <=4000 characters",
            status: 400,
          }),
      ],
      [
        "a 400 with another code that names a field",
        () =>
          new BbHttpError({
            body: null,
            code: "native_terminal_question_refused",
            message: 'Unrecognized key: "closes"',
            status: 400,
          }),
      ],
      [
        "a lookalike that is not a BbHttpError",
        () =>
          Object.assign(new Error('Unrecognized key: "closes"'), {
            code: "invalid_request",
            status: 400,
          }),
      ],
      [
        "a credential refusal",
        () =>
          new BbHttpError({
            body: null,
            code: "native_terminal_credential_invalid",
            message: "A valid credential is required",
            status: 401,
          }),
      ],
      [
        "a 403",
        () =>
          new BbHttpError({
            body: null,
            code: "invalid_request",
            message: 'Unrecognized key: "closes"',
            status: 403,
          }),
      ],
      [
        "a refusal that names a field",
        () =>
          new BbHttpError({
            body: null,
            code: "invalid_request",
            message: 'Unrecognized key: "closes"',
            status: 409,
          }),
      ],
      ["a 5xx", unavailable],
      ["a transport failure", () => new TypeError("fetch failed")],
    ])("does not fall back on %s", async (_name, failure) => {
      const { calls, logged, reporter } = closureSetup([
        async () => {
          throw failure();
        },
      ]);
      reporter.report(marked);
      await reporter.settled();
      expect(calls).toHaveLength(1);
      expect(logged).toEqual([]);
    });

    it("does not retry for a field it did not send", async () => {
      const { calls, reporter } = closureSetup([
        async () => {
          throw rejection('"confirms"');
        },
      ]);
      reporter.report(working);
      await reporter.settled();
      expect(calls).toHaveLength(1);
    });

    it("keeps a report for a later resend when delivery fails transiently", async () => {
      const { calls, reporter } = closureSetup([
        async () => {
          throw unavailable();
        },
        async () => {
          throw unavailable();
        },
        async () => ({ ok: true }),
      ]);
      reporter.report(marked);
      await reporter.settled();
      expect(calls).toHaveLength(1);
      reporter.retry();
      await reporter.settled();
      expect(calls).toHaveLength(2);
      reporter.retry();
      await reporter.settled();
      expect(calls).toHaveLength(3);
      expect(closesOf(calls)).toEqual([undefined, undefined, undefined]);
    });
  });
});
