import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  createTerminalSession,
  getTerminalAttention,
  getThread,
  hasActiveThreadAttention,
  updateThread,
} from "@bb/db";
import {
  createTestAppHarness,
  startTestServer,
  type TestAppHarness,
  withTestHarness,
} from "../helpers/test-app.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";

async function connectRealtime(baseUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function rejectedRealtimeStatus(
  baseUrl: string,
  options: { origin?: string; host?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers = options.host === undefined ? {} : { host: options.host };
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`, {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      headers,
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      if (status === undefined) {
        reject(new Error("WebSocket rejection omitted an HTTP status"));
        return;
      }
      resolve(status);
    });
    socket.once("error", () => {});
  });
}

function nextRealtimeMessage(
  socket: WebSocket,
  type?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for realtime message"));
    }, 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (type !== undefined && parsed.type !== type) return;
      clearTimeout(timer);
      resolve(parsed);
    };
    socket.on("message", onMessage);
  });
}

function sendRealtime(
  socket: WebSocket,
  message: Record<string, unknown>,
): void {
  socket.send(JSON.stringify(message));
}

describe("device handoff route validation", () => {
  let harness: TestAppHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com"])(
    "rejects non-HTTP URL %s with a clear error",
    async (url) => {
      harness = await createTestAppHarness();
      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url,
          origin: { threadId: "thr_example" },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("URL must use http or https");
    },
  );

  it("rejects text larger than 1 MiB by UTF-8 byte size", async () => {
    harness = await createTestAppHarness();
    const response = await harness.app.request("/api/v1/device-handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "copy-text",
        text: "é".repeat(600_000),
        origin: { threadId: "thr_example" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("1 MiB limit");
  });

  it("rejects text larger than the schema character limit", async () => {
    harness = await createTestAppHarness();
    const response = await harness.app.request("/api/v1/device-handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "copy-text",
        text: "x".repeat(1_048_577),
        origin: { threadId: "thr_example" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid device handoff");
  });
});

describe("device handoff pending attention", () => {
  it("raises fixed, payload-free terminal attention and clears it on delivery", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const terminal = createTerminalSession(harness.db, {
        cols: 80,
        environmentId: null,
        hostId: host.id,
        daemonSessionId: session.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: thread.id,
        title: "Handoff terminal",
      });
      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://login.example.com/private-code",
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });

      expect(response.status).toBe(200);
      expect(getTerminalAttention(harness.db, terminal.id)).toMatchObject({
        body: "",
        kind: "osc-9",
        title: "Link waiting for this device",
        clearedAt: null,
      });
      expect(
        JSON.stringify(getTerminalAttention(harness.db, terminal.id)),
      ).not.toContain("private-code");

      const viewer = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(viewer, {
        kind: "thread-detail",
        threadId: thread.id,
      });
      harness.hub.setDeviceHandoffView(viewer, thread.id);
      const handoff = viewer.messages
        .map((message) => JSON.parse(message) as { id?: string; type?: string })
        .find((message) => message.type === "device-handoff");
      expect(handoff?.id).toBeDefined();
      harness.hub.acknowledgeDeviceHandoff(viewer, handoff!.id!);

      expect(
        getTerminalAttention(harness.db, terminal.id)?.clearedAt,
      ).not.toBeNull();
      expect(
        viewer.messages.some((message) =>
          message.includes("device-handoff-expired"),
        ),
      ).toBe(false);
    });
  });

  it("queues a payload-free expiry notice for the originating thread only", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const { thread: unrelatedThread } = seedThreadFixture(harness);
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now());
        const response = await harness.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "private expired text",
            origin: { threadId: thread.id },
          }),
        });
        expect(response.status).toBe(200);
        const unrelated = {
          messages: [] as string[],
          close() {},
          send(data: string) {
            this.messages.push(data);
          },
        };
        harness.hub.subscribe(unrelated, {
          kind: "thread-detail",
          threadId: unrelatedThread.id,
        });

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        const originViewer = {
          messages: [] as string[],
          close() {},
          send(data: string) {
            this.messages.push(data);
          },
        };
        harness.hub.subscribe(originViewer, {
          kind: "thread-detail",
          threadId: thread.id,
        });
        harness.hub.setDeviceHandoffView(originViewer, thread.id);

        const notice = originViewer.messages.find((message) =>
          message.includes("device-handoff-expired"),
        );
        expect(notice).toBeDefined();
        expect(Object.keys(JSON.parse(notice!)).sort()).toEqual([
          "id",
          "threadId",
          "type",
        ]);
        expect(notice).not.toContain("private expired text");
        expect(unrelated.messages.join("\n")).not.toContain(
          "device-handoff-expired",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("marks the source thread unread when no client is viewing it", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { title: "Pending handoff source" },
      });
      const { thread: unrelatedThread } = seedThreadFixture(harness, {
        thread: { title: "Unrelated thread" },
      });
      updateThread(harness.db, harness.hub, thread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      updateThread(harness.db, harness.hub, unrelatedThread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      const unrelatedViewer = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(unrelatedViewer, {
        kind: "thread-detail",
        threadId: unrelatedThread.id,
      });
      const attentionObserver = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(attentionObserver, { kind: "thread-list" });

      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "private copy payload",
          origin: { threadId: thread.id },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      const urlResponse = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://login.example.com/device?code=private-url",
          origin: { threadId: thread.id },
        }),
      });
      expect(urlResponse.status).toBe(200);
      expect(await urlResponse.json()).toEqual({ delivered: 0 });
      expect(
        getThread(harness.db, thread.id)?.latestAttentionAt,
      ).toBeGreaterThan(1);
      const markerAt = getThread(harness.db, thread.id)?.latestAttentionAt;
      expect(getThread(harness.db, unrelatedThread.id)?.latestAttentionAt).toBe(
        1,
      );
      expect(hasActiveThreadAttention(harness.db)).toBe(true);
      expect(unrelatedViewer.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(
        attentionObserver.messages.some((message) =>
          message.includes(thread.id),
        ),
      ).toBe(true);
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private-url",
      );

      const originViewer = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(originViewer, {
        kind: "thread-detail",
        threadId: thread.id,
      });
      harness.hub.setDeviceHandoffView(originViewer, thread.id);

      const handoffMessages = originViewer.messages.filter(
        (message) => JSON.parse(message).type === "device-handoff",
      );
      expect(handoffMessages).toHaveLength(2);
      expect(handoffMessages[0]).toContain("private copy payload");
      expect(handoffMessages[1]).toContain(
        "https://login.example.com/device?code=private-url",
      );
      for (const message of handoffMessages) {
        harness.hub.acknowledgeDeviceHandoff(
          originViewer,
          (JSON.parse(message) as { id: string }).id,
        );
      }
      expect(getThread(harness.db, thread.id)?.latestAttentionAt).toBe(1);
      expect(markerAt).toBeGreaterThan(1);
      expect(unrelatedViewer.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private-url",
      );
    });
  });

  it("clears its attention marker when an undelivered handoff expires", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { title: "Expiring handoff source" },
      });
      updateThread(harness.db, harness.hub, thread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now());
        const response = await harness.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "expire me",
            origin: { threadId: thread.id },
          }),
        });
        expect(response.status).toBe(200);
        expect(
          getThread(harness.db, thread.id)?.latestAttentionAt,
        ).toBeGreaterThan(1);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

        expect(getThread(harness.db, thread.id)?.latestAttentionAt).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("device handoff websocket acknowledgement", () => {
  it("rejects guarded upgrades and delivers a queued handoff to an admitted viewer", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const port = new URL(server.baseUrl).port;

    try {
      await expect(
        rejectedRealtimeStatus(server.baseUrl, {
          origin: "https://untrusted.example",
        }),
      ).resolves.toBe(403);
      await expect(
        rejectedRealtimeStatus(server.baseUrl, {
          host: `untrusted.example:${port}`,
        }),
      ).resolves.toBe(403);

      const admitted = await connectRealtime(server.baseUrl);
      try {
        sendRealtime(admitted, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(admitted, {
          type: "device-handoff-view",
          threadId: null,
        });
        const hiddenViewReady = nextRealtimeMessage(admitted, "pong");
        sendRealtime(admitted, { type: "ping" });
        await hiddenViewReady;

        const response = await server.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "queued for admitted viewer",
            origin: { threadId: thread.id },
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ delivered: 0 });

        const pendingHandoff = nextRealtimeMessage(admitted, "device-handoff");
        sendRealtime(admitted, {
          type: "device-handoff-view",
          threadId: thread.id,
        });
        await expect(pendingHandoff).resolves.toMatchObject({
          type: "device-handoff",
          request: { kind: "copy-text", text: "queued for admitted viewer" },
        });
      } finally {
        admitted.close();
      }
    } finally {
      await server.close();
    }
  });

  it("keeps a handoff pending for a subscribed hidden view until the shown item is acknowledged", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const socket = await connectRealtime(server.baseUrl);
    try {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, { type: "device-handoff-view", threadId: null });
      const hiddenReady = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      await hiddenReady;
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "pending until shown",
          origin: { threadId: thread.id },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      const raisedAttentionAt = getThread(
        server.db,
        thread.id,
      )?.latestAttentionAt;
      expect(raisedAttentionAt).toBeGreaterThan(0);

      const handoff = nextRealtimeMessage(socket, "device-handoff");
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
      });
      const signal = await handoff;
      expect(signal).toMatchObject({
        type: "device-handoff",
        request: { kind: "copy-text", text: "pending until shown" },
      });
      expect(getThread(server.db, thread.id)?.latestAttentionAt).toBe(
        raisedAttentionAt,
      );

      sendRealtime(socket, {
        type: "device-handoff-ack",
        id: signal.id as string,
      });
      const pong = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      expect(await pong).toEqual({ type: "pong" });
      expect(getThread(server.db, thread.id)?.latestAttentionAt).toBeLessThan(
        raisedAttentionAt!,
      );

      const later = await connectRealtime(server.baseUrl);
      try {
        sendRealtime(later, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        const unexpected = nextRealtimeMessage(later, "device-handoff");
        sendRealtime(later, {
          type: "device-handoff-view",
          threadId: thread.id,
        });
        await expect(unexpected).rejects.toThrow(
          "Timed out waiting for realtime message",
        );
      } finally {
        later.close();
      }
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("keeps an unacknowledged websocket item until it expires into a payload-free notice", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const socket = await connectRealtime(server.baseUrl);
    try {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, { type: "device-handoff-view", threadId: null });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(Date.now());
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://private.example/expiring-code",
          origin: { threadId: thread.id },
        }),
      });
      expect(response.status).toBe(200);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const notice = nextRealtimeMessage(socket, "device-handoff-expired");
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
      });
      const expired = await notice;
      expect(expired).toMatchObject({
        type: "device-handoff-expired",
        threadId: thread.id,
      });
      expect(Object.keys(expired).sort()).toEqual(["id", "threadId", "type"]);
      expect(JSON.stringify(expired)).not.toContain("expiring-code");
    } finally {
      vi.useRealTimers();
      socket.close();
      await server.close();
    }
  });

  it("accepts an acknowledgement only from a socket that received the handoff", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const showing = await connectRealtime(server.baseUrl);
    const elsewhere = await connectRealtime(server.baseUrl);
    try {
      for (const socket of [showing, elsewhere]) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
      }
      sendRealtime(showing, {
        type: "device-handoff-view",
        threadId: thread.id,
      });
      sendRealtime(elsewhere, { type: "device-handoff-view", threadId: null });
      const showingReady = nextRealtimeMessage(showing, "pong");
      sendRealtime(showing, { type: "ping" });
      const elsewhereReady = nextRealtimeMessage(elsewhere, "pong");
      sendRealtime(elsewhere, { type: "ping" });
      await Promise.all([showingReady, elsewhereReady]);
      const baselineAttentionAt = getThread(
        server.db,
        thread.id,
      )?.latestAttentionAt;
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "only the shown socket can acknowledge",
          origin: { threadId: thread.id },
        }),
      });
      expect(await response.json()).toEqual({ delivered: 1 });
      const raisedAttentionAt = getThread(
        server.db,
        thread.id,
      )?.latestAttentionAt;
      expect(raisedAttentionAt).toBeGreaterThan(baselineAttentionAt!);
      const signal = await nextRealtimeMessage(showing, "device-handoff");
      expect(signal.type).toBe("device-handoff");

      sendRealtime(elsewhere, {
        type: "device-handoff-ack",
        id: signal.id as string,
      });
      const elsewherePong = nextRealtimeMessage(elsewhere, "pong");
      sendRealtime(elsewhere, { type: "ping" });
      await elsewherePong;
      expect(getThread(server.db, thread.id)?.latestAttentionAt).toBe(
        raisedAttentionAt,
      );

      sendRealtime(showing, {
        type: "device-handoff-ack",
        id: signal.id as string,
      });
      const showingPong = nextRealtimeMessage(showing, "pong");
      sendRealtime(showing, { type: "ping" });
      await showingPong;
      expect(getThread(server.db, thread.id)?.latestAttentionAt).toBeLessThan(
        raisedAttentionAt!,
      );
    } finally {
      showing.close();
      elsewhere.close();
      await server.close();
    }
  });
});
