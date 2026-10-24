import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createCliBbSdk } from "../client.js";
import { createNativeActivityReporter } from "../native-activity-reporter.js";
import { createNativeSessionRebinder } from "../native-session-rebinder.js";

const A = "aaaaaaaa-1111-4222-8333-444455556666";
const B = "bbbbbbbb-1111-4222-8333-444455556666";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function closedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function serverBack(
  port: number,
  respond: (path: string) => unknown,
): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(respond(request.url ?? "")));
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return { requests };
}

describe("delivery through the real SDK client against a refused connection", () => {
  it("the reporter keeps an idle report sent while the connection is refused and delivers it exactly once when the server returns", async () => {
    const port = await closedPort();
    const sdk = createCliBbSdk(`http://127.0.0.1:${port}`);
    const reporter = createNativeActivityReporter({
      currentCredential: () => "current",
      send: (args) => sdk.nativeTerminals.reportActivity(args),
      threadId: "thr_real",
    });
    reporter.report({ state: "idle", prompt: null });
    await reporter.settled();

    const back = await serverBack(port, () => ({ ok: true }));
    expect(back.requests).toEqual([]);
    reporter.retry();
    await reporter.settled();
    expect(back.requests).toEqual([
      "POST /api/v1/threads/thr_real/native-terminal/activity",
    ]);
    reporter.retry();
    await reporter.settled();
    expect(back.requests).toHaveLength(1);
  });

  it("the rebinder retries a session move whose connection is refused instead of giving up", async () => {
    const port = await closedPort();
    const sdk = createCliBbSdk(`http://127.0.0.1:${port}`);
    const refused: string[] = [];
    const rebinder = createNativeSessionRebinder({
      currentCredential: () => "current",
      onRefused: (_move, code) => refused.push(code),
      recordSession: (args) =>
        sdk.nativeTerminals.recordSession({ ...args, threadId: "thr_real" }),
    });
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(refused).toEqual([]);
    expect(rebinder.pending()).toBe(1);

    const back = await serverBack(port, () => ({ threadId: "thr_real" }));
    rebinder.retry();
    await rebinder.settled();
    expect(back.requests).toEqual([
      "POST /api/v1/threads/thr_real/native-terminal/session",
    ]);
    expect(rebinder.pending()).toBe(0);
  });

  it("control: a plain error with no cause is dropped by the reporter and never resent", async () => {
    const sent: string[] = [];
    const reporter = createNativeActivityReporter({
      currentCredential: () => "current",
      send: async (args) => {
        sent.push(args.state);
        throw new Error("boom");
      },
      threadId: "thr_real",
    });
    reporter.report({ state: "idle", prompt: null });
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    expect(sent).toEqual(["idle"]);
  });
});
