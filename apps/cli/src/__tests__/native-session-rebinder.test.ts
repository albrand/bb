import { BbHttpError, BbRequestTimeoutError } from "@bb/sdk";
import { describe, expect, it } from "vitest";
import { createNativeSessionRebinder } from "../native-session-rebinder.js";

function withCode(code: unknown): TypeError {
  return new TypeError("x", {
    cause: Object.assign(new Error("underlying"), { code }),
  });
}

const A = "aaaaaaaa-1111-4222-8333-444455556666";
const B = "bbbbbbbb-1111-4222-8333-444455556666";
const C = "cccccccc-1111-4222-8333-444455556666";

function refusal(status: number, code: string): BbHttpError {
  return new BbHttpError({ body: null, code, message: code, status });
}

interface Attempt {
  authorization: string;
  nativeSessionId: string;
  replacesNativeSessionId: string;
}

function setup(
  initial: string | null,
  answer: (attempt: Attempt, index: number) => unknown = () => ({}),
) {
  let credential = initial;
  const attempts: Attempt[] = [];
  const refused: Array<{ code: string; sessionId: string }> = [];
  const rebinder = createNativeSessionRebinder({
    currentCredential: () => credential,
    onRefused: (move, code) =>
      refused.push({ code, sessionId: move.sessionId }),
    recordSession: async (attempt) => {
      attempts.push(attempt);
      const outcome = answer(attempt, attempts.length - 1);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  return {
    attempts,
    rebinder,
    refused,
    setCredential: (next: string | null) => {
      credential = next;
    },
  };
}

describe("native session rebinder", () => {
  it("sends the move with the holder's current credential", async () => {
    const { attempts, rebinder } = setup("first");
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(attempts).toEqual([
      {
        authorization: "Bearer first",
        nativeSessionId: B,
        replacesNativeSessionId: A,
      },
    ]);
    expect(rebinder.pending()).toBe(0);
  });

  it("keeps the move while the server cannot accept it yet and retries it with the refreshed credential", async () => {
    const { attempts, rebinder, refused, setCredential } = setup(
      "old",
      (attempt) =>
        attempt.authorization === "Bearer old"
          ? refusal(409, "native_terminal_not_live")
          : {},
    );
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(rebinder.pending()).toBe(1);
    rebinder.retry();
    await rebinder.settled();
    expect(attempts).toHaveLength(2);
    expect(rebinder.pending()).toBe(1);

    setCredential("new");
    rebinder.retry();
    await rebinder.settled();
    expect(attempts.at(-1)?.authorization).toBe("Bearer new");
    expect(rebinder.pending()).toBe(0);
    expect(refused).toEqual([]);
  });

  it.each([
    [
      "an invalid credential",
      refusal(401, "native_terminal_credential_invalid"),
    ],
    ["a terminal that is not live", refusal(409, "native_terminal_not_live")],
    ["a request timeout", refusal(408, "request_timeout")],
    ["a rate limit", refusal(429, "rate_limited")],
    ["a server error", refusal(503, "unavailable")],
    ["a network failure", new TypeError("fetch failed")],
    ["a connection that was terminated", new TypeError("terminated")],
    ["a reset connection", withCode("ECONNRESET")],
    ["a refused connection", withCode("ECONNREFUSED")],
    ["a transient DNS failure", withCode("EAI_AGAIN")],
    ["an undici socket error", withCode("UND_ERR_SOCKET")],
    [
      "a transport error whose cause carries a system code",
      new TypeError("other side closed", {
        cause: Object.assign(new Error("connect failed"), {
          code: "ECONNREFUSED",
        }),
      }),
    ],
    ["a client request timeout", new BbRequestTimeoutError(10_000)],
  ])("treats %s as retryable", async (_name, failure) => {
    const { rebinder, refused } = setup("c", (_attempt, index) =>
      index === 0 ? failure : {},
    );
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(rebinder.pending()).toBe(1);
    rebinder.retry();
    await rebinder.settled();
    expect(rebinder.pending()).toBe(0);
    expect(refused).toEqual([]);
  });

  it.each([
    [400, "invalid_request"],
    [403, "forbidden"],
    [404, "not_found"],
    [422, "unprocessable"],
  ])(
    "gives up for good on an unexpected %s answer instead of retrying it silently",
    async (status, code) => {
      const { attempts, rebinder, refused } = setup("c", () =>
        refusal(status, code),
      );
      rebinder.enqueue({ previousSessionId: A, sessionId: B });
      await rebinder.settled();
      expect(refused).toEqual([{ code, sessionId: B }]);
      rebinder.retry();
      await rebinder.settled();
      expect(attempts).toHaveLength(1);
    },
  );

  it.each([
    ["a response that cannot be parsed", new SyntaxError("Unexpected token")],
    ["any other unexpected failure", new Error("boom")],
    ["a programming error", new TypeError("x is not a function")],
    [
      "a wrapped programming error without a system code",
      new TypeError("x", { cause: new Error("y") }),
    ],
    [
      "a wrapped error whose code is an arbitrary string",
      withCode("not a system code"),
    ],
    ["a wrapped error whose code is lower case", withCode("econnrefused")],
    ["a wrapped Node argument error", withCode("ERR_INVALID_ARG_TYPE")],
    ["a wrapped error whose code is a bare E", withCode("E")],
    ["a wrapped error whose code is numeric", withCode(1)],
    [
      "a wrapped plain object, not an Error, with a system code",
      new TypeError("x", { cause: { code: "ECONNREFUSED" } }),
    ],
  ])(
    "gives up for good on %s instead of retrying it silently",
    async (_name, failure) => {
      const { attempts, rebinder, refused } = setup("c", () => failure);
      rebinder.enqueue({ previousSessionId: A, sessionId: B });
      await rebinder.settled();
      expect(refused).toEqual([{ code: "unexpected_error", sessionId: B }]);
      rebinder.retry();
      await rebinder.settled();
      expect(attempts).toHaveLength(1);
    },
  );

  describe("unit cases with hand-built errors wrapping a cause", () => {
    const wrap = (cause: unknown) => new Error("wrapped", { cause });
    const deep = (levels: number, bottom: unknown) => {
      let error: unknown = bottom;
      for (let index = 0; index < levels; index += 1) error = wrap(error);
      return error;
    };

    it.each([
      ["a wrapped fetch failure", wrap(new TypeError("fetch failed"))],
      [
        "a doubly wrapped fetch failure",
        wrap(wrap(new TypeError("fetch failed"))),
      ],
      [
        "three wrappers above a fetch failure",
        deep(3, new TypeError("fetch failed")),
      ],
      ["a wrapped client timeout", wrap(new BbRequestTimeoutError(10_000))],
    ])("retries %s", async (_name, failure) => {
      const { rebinder, refused } = setup("c", (_attempt, index) =>
        index === 0 ? failure : {},
      );
      rebinder.enqueue({ previousSessionId: A, sessionId: B });
      await rebinder.settled();
      expect(rebinder.pending()).toBe(1);
      expect(refused).toEqual([]);
    });

    it.each([
      ["a plain error with a plain cause", wrap(new Error("boom"))],
      ["a plain error with no cause", new Error("boom")],
      [
        "a transport failure below the depth bound",
        deep(4, new TypeError("fetch failed")),
      ],
      [
        "a wrapped programming TypeError",
        wrap(new TypeError("x is not a function")),
      ],
    ])("gives up for good on %s", async (_name, failure) => {
      const { attempts, rebinder, refused } = setup("c", () => failure);
      rebinder.enqueue({ previousSessionId: A, sessionId: B });
      await rebinder.settled();
      expect(refused).toEqual([{ code: "unexpected_error", sessionId: B }]);
      rebinder.retry();
      await rebinder.settled();
      expect(attempts).toHaveLength(1);
    });

    it("terminates on a cyclic cause chain and treats it as unexpected_error", async () => {
      const a = new Error("a");
      const b = new Error("b", { cause: a });
      Object.defineProperty(a, "cause", { value: b });
      const { rebinder, refused } = setup("c", () => a);
      rebinder.enqueue({ previousSessionId: A, sessionId: B });
      await rebinder.settled();
      expect(refused).toEqual([{ code: "unexpected_error", sessionId: B }]);
    });
  });

  it("names an unexpected answer without a code by its status", async () => {
    const { rebinder, refused } = setup(
      "c",
      () =>
        new BbHttpError({
          body: null,
          code: null,
          message: "bad",
          status: 400,
        }),
    );
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(refused).toEqual([{ code: "http_400", sessionId: B }]);
  });

  it("does not try while it holds no credential", async () => {
    const { attempts, rebinder, setCredential } = setup(null);
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(attempts).toEqual([]);
    expect(rebinder.pending()).toBe(1);
    setCredential("c");
    rebinder.retry();
    await rebinder.settled();
    expect(attempts).toHaveLength(1);
  });

  it("applies chained moves in order and never sends a later one before the earlier is accepted", async () => {
    const { attempts, rebinder } = setup("c", (attempt, index) =>
      index === 0 ? refusal(409, "native_terminal_not_live") : {},
    );
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    rebinder.enqueue({ previousSessionId: B, sessionId: C });
    await rebinder.settled();
    expect(attempts.map((attempt) => attempt.nativeSessionId)).toEqual([B]);
    rebinder.retry();
    await rebinder.settled();
    expect(attempts.map((attempt) => attempt.nativeSessionId)).toEqual([
      B,
      B,
      C,
    ]);
    expect(rebinder.pending()).toBe(0);
  });

  it.each([
    "native_session_claimed",
    "native_session_rebind_stale",
    "native_session_already_bound",
  ])(
    "gives up for good on a permanent refusal (%s) and reports it once",
    async (code) => {
      const { attempts, rebinder, refused } = setup("c", () =>
        refusal(409, code),
      );
      rebinder.enqueue({ previousSessionId: A, sessionId: B });
      rebinder.enqueue({ previousSessionId: B, sessionId: C });
      await rebinder.settled();
      expect(refused).toEqual([{ code, sessionId: B }]);
      expect(rebinder.pending()).toBe(0);
      rebinder.retry();
      await rebinder.settled();
      expect(attempts).toHaveLength(1);
      expect(refused).toHaveLength(1);
    },
  );

  it("sends one request at a time", async () => {
    let release: (() => void) | undefined;
    let inFlight = 0;
    let highest = 0;
    const rebinder = createNativeSessionRebinder({
      currentCredential: () => "c",
      onRefused: () => undefined,
      recordSession: async () => {
        inFlight += 1;
        highest = Math.max(highest, inFlight);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        inFlight -= 1;
        return {};
      },
    });
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    rebinder.retry();
    rebinder.retry();
    await Promise.resolve();
    release?.();
    await rebinder.settled();
    expect(highest).toBe(1);
  });
});
