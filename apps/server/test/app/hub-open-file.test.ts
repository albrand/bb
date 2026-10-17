import { describe, expect, it, vi } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

describe("NotificationHub device handoff routing", () => {
  it("delivers bursts only to clients viewing the origin thread", () => {
    const hub = new NotificationHub();
    const viewing = createMockHubSocket();
    const other = createMockHubSocket();
    hub.subscribe(viewing, { kind: "thread-detail", threadId: "thr_1" });
    hub.subscribe(other, { kind: "thread-detail", threadId: "thr_2" });
    hub.setDeviceHandoffView(viewing, "thr_1");
    hub.setDeviceHandoffView(other, "thr_2");

    expect(
      hub.notifyDeviceHandoff(
        { kind: "copy-text", text: "first", origin: { threadId: "thr_1" } },
        "Thread one",
      ),
    ).toBe(1);
    expect(
      hub.notifyDeviceHandoff(
        {
          kind: "open-url",
          url: "https://example.com/2",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      ),
    ).toBe(1);
    expect(
      hub.notifyDeviceHandoff(
        {
          kind: "open-url",
          url: "https://example.com/3",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      ),
    ).toBe(1);
    expect(
      viewing.messages.map((message) => JSON.parse(message).request),
    ).toEqual([
      { kind: "copy-text", text: "first", origin: { threadId: "thr_1" } },
      {
        kind: "open-url",
        url: "https://example.com/2",
        origin: { threadId: "thr_1" },
      },
      {
        kind: "open-url",
        url: "https://example.com/3",
        origin: { threadId: "thr_1" },
      },
    ]);
    expect(other.messages).toHaveLength(0);
  });

  it("queues an undelivered burst only for its origin thread", () => {
    const hub = new NotificationHub();
    const unrelatedCurrent = createMockHubSocket();
    hub.subscribe(unrelatedCurrent, {
      kind: "thread-detail",
      threadId: "thr_other",
    });
    hub.notifyDeviceHandoff(
      {
        kind: "copy-text",
        text: "first secret",
        origin: { threadId: "thr_1" },
      },
      "Thread one",
    );
    hub.notifyDeviceHandoff(
      {
        kind: "open-url",
        url: "https://example.com/login",
        origin: { threadId: "thr_1" },
      },
      "Thread one",
    );

    const laterElsewhere = createMockHubSocket();
    hub.registerClient(laterElsewhere);
    hub.subscribe(laterElsewhere, {
      kind: "thread-detail",
      threadId: "thr_elsewhere",
    });
    expect(unrelatedCurrent.messages).toHaveLength(0);
    expect(laterElsewhere.messages).toHaveLength(0);

    const laterAtOrigin = createMockHubSocket();
    hub.subscribe(laterAtOrigin, { kind: "thread-detail", threadId: "thr_1" });
    hub.setDeviceHandoffView(laterAtOrigin, "thr_1");

    expect(
      laterAtOrigin.messages.map((message) => JSON.parse(message).request),
    ).toEqual([
      {
        kind: "copy-text",
        text: "first secret",
        origin: { threadId: "thr_1" },
      },
      {
        kind: "open-url",
        url: "https://example.com/login",
        origin: { threadId: "thr_1" },
      },
    ]);
    expect(unrelatedCurrent.messages).toHaveLength(0);
    expect(laterElsewhere.messages).toHaveLength(0);
  });

  it("delivers terminal-scoped handoffs when a matching terminal becomes visible", () => {
    const hub = new NotificationHub();
    const terminalViewer = createMockHubSocket();
    hub.registerTerminalClient("term_1", terminalViewer);
    expect(
      hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "terminal copy",
          origin: { terminalSessionId: "term_1" },
        },
        "Terminal one",
      ),
    ).toBe(0);
    expect(terminalViewer.messages).toHaveLength(0);

    hub.recordTerminalClientVisibility(
      "term_1",
      terminalViewer,
      true,
      Date.now(),
    );
    expect(JSON.parse(terminalViewer.messages[0]!).request).toMatchObject({
      text: "terminal copy",
    });
  });

  it("expires undelivered origin-scoped payloads", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const hub = new NotificationHub();
      hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "expired copy",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      );
      vi.advanceTimersByTime(10 * 60 * 1000);

      const laterAtOrigin = createMockHubSocket();
      hub.subscribe(laterAtOrigin, {
        kind: "thread-detail",
        threadId: "thr_1",
      });
      hub.setDeviceHandoffView(laterAtOrigin, "thr_1");
      expect(laterAtOrigin.messages).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an undelivered item available for the ten-minute sign-in window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const hub = new NotificationHub();
      hub.notifyDeviceHandoff(
        {
          kind: "open-url",
          url: "https://login.example.com/device",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      );
      vi.advanceTimersByTime(3 * 60 * 1000);

      const laterAtOrigin = createMockHubSocket();
      hub.subscribe(laterAtOrigin, {
        kind: "thread-detail",
        threadId: "thr_1",
      });
      hub.setDeviceHandoffView(laterAtOrigin, "thr_1");

      expect(
        laterAtOrigin.messages.map((message) => JSON.parse(message).request),
      ).toEqual([
        {
          kind: "open-url",
          url: "https://login.example.com/device",
          origin: { threadId: "thr_1" },
        },
      ]);
      expect(
        laterAtOrigin.messages.some((message) =>
          message.includes("device-handoff-expired"),
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("broadcasts to every connected client and returns the delivered count", () => {
    const hub = new NotificationHub();
    const viewing = createMockHubSocket();
    const other = createMockHubSocket();
    hub.subscribe(viewing, { kind: "thread-detail", threadId: "thr_1" });
    hub.subscribe(other, { kind: "thread-detail", threadId: "thr_2" });

    const delivered = hub.notifyThreadOpen(
      { projectId: "proj_1", threadId: "thr_1" },
      {
        split: "right",
        file: {
          source: "workspace",
          path: "src/index.ts",
          lineNumber: 42,
        },
      },
    );

    expect(delivered).toBe(2);
    for (const socket of [viewing, other]) {
      expect(socket.messages).toHaveLength(1);
      expect(JSON.parse(socket.messages[0])).toEqual({
        type: "thread-open",
        projectId: "proj_1",
        threadId: "thr_1",
        split: "right",
        file: {
          source: "workspace",
          path: "src/index.ts",
          lineNumber: 42,
        },
      });
    }
  });

  it("broadcasts typed thread-pane actions to every connected client", () => {
    const hub = new NotificationHub();
    const first = createMockHubSocket();
    const second = createMockHubSocket();
    hub.registerClient(first);
    hub.registerClient(second);

    expect(
      hub.notifyThreadPaneAction(
        { projectId: "proj_1", threadId: "thr_1" },
        "clear-spotlight",
      ),
    ).toBe(2);
    for (const socket of [first, second]) {
      expect(JSON.parse(socket.messages[0]!)).toEqual({
        type: "thread-pane-action",
        projectId: "proj_1",
        threadId: "thr_1",
        action: "clear-spotlight",
      });
    }
  });
});
