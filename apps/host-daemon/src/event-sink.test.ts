import { threadScope, turnScope } from "@bb/domain";
import type { HostDaemonEventEnvelope } from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { createEventSink, type CreateEventSinkOptions } from "./event-sink.js";
import { ServerResponseError } from "./server-client.js";

function permanentRejection(bodyMessage: string): ServerResponseError {
  return new ServerResponseError({
    action: "post events",
    bodyMessage,
    code: "invalid_request",
    retryable: false,
    status: 409,
    statusText: "Conflict",
  });
}

function turnStartPendingRejection(bodyMessage: string): ServerResponseError {
  return new ServerResponseError({
    action: "post events",
    bodyMessage,
    code: "turn_start_pending",
    retryable: true,
    status: 503,
    statusText: "Service Unavailable",
  });
}

function createLogger(): CreateEventSinkOptions["logger"] {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function acceptingPostEvents() {
  return vi.fn<CreateEventSinkOptions["postEvents"]>(async (events) => ({
    acceptedEvents: events.map((event, eventIndex) => ({
      eventIndex,
      sequence: eventIndex + 1,
      threadId: event.threadId,
    })),
    rejectedEvents: [],
  }));
}

function serverRequiringTurnStarts() {
  const startedTurnKeys = new Set<string>();
  const stored: HostDaemonEventEnvelope[] = [];
  const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
    async (events) => {
      const batchStarted = new Set(startedTurnKeys);
      for (const envelope of events) {
        const { scope } = envelope.event;
        if (scope.kind !== "turn") {
          continue;
        }
        const key = `${envelope.threadId}/${scope.turnId}`;
        if (envelope.event.type === "turn/started") {
          batchStarted.add(key);
        } else if (!batchStarted.has(key)) {
          throw new ServerResponseError({
            action: "post events",
            bodyMessage: `Cannot append ${envelope.event.type} for turn ${scope.turnId} before turn/started is stored`,
            code: "turn_start_pending",
            retryable: true,
            status: 503,
            statusText: "Service Unavailable",
            turnStartPending: {
              threadId: envelope.threadId,
              turnId: scope.turnId,
            },
          });
        }
      }
      for (const key of batchStarted) {
        startedTurnKeys.add(key);
      }
      stored.push(...events);
      return {
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: stored.length - events.length + eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      };
    },
  );
  return { postEvents, stored };
}

function agentMessageDeltaEvent(threadId: string, turnId: string) {
  return {
    type: "item/agentMessage/delta",
    threadId,
    providerThreadId: "provider-thread-1",
    itemId: `${turnId}-i1`,
    delta: "working",
    scope: turnScope(turnId),
  } as const;
}

function turnCompletedWithoutProviderThreadEvent(
  threadId: string,
  turnId: string,
) {
  return {
    type: "turn/completed",
    threadId,
    providerThreadId: null,
    status: "completed",
    scope: turnScope(turnId),
  } as const;
}

function systemErrorEvent(threadId: string) {
  return {
    type: "system/error",
    threadId,
    scope: threadScope(),
    message: "boom",
  } as const;
}

describe("event sink", () => {
  it("posts emitted events", async () => {
    const postEvents = acceptingPostEvents();
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("drains successfully skipped diffs without requiring allocated sequences", async () => {
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async () => ({
        acceptedEvents: [],
        rejectedEvents: [],
      }),
    );
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });
    sink.emit({
      threadId: "thr_1",
      event: {
        type: "turn/diff/updated",
        threadId: "thr_1",
        providerThreadId: "provider-1",
        scope: turnScope("turn-1"),
        diff: "discarded snapshot",
      },
    });
    await sink.flush();
    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("holds events while the session is closed and delivers them once it reopens", async () => {
    let sessionOpen = false;
    const postEvents = acceptingPostEvents();
    const sink = createEventSink({
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();

    sessionOpen = true;
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(postEvents).toHaveBeenCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("keeps events queued after a post failure and redelivers them on the next flush", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await expect(sink.flush()).resolves.toBeUndefined();

    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("drops rejected events with a warning without throwing", async () => {
    const logger = createLogger();
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async () => ({
        acceptedEvents: [],
        rejectedEvents: [
          {
            eventIndex: 0,
            reason: "thread_not_owned_by_host",
            threadId: "thr_1",
          },
        ],
      }),
    );
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);

    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);
  });

  it("warns once when a large queue remains undelivered", () => {
    const logger = createLogger();
    let now = 0;
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger,
      now: () => now,
      postEvents: acceptingPostEvents(),
    });

    for (let index = 0; index < 511; index += 1) {
      sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    }
    expect(logger.warn).not.toHaveBeenCalled();

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    expect(logger.warn).not.toHaveBeenCalled();

    now = 5_000;
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueAgeMs: 5_000, queueDepth: 513 }),
      expect.any(String),
    );
  });

  it("warns when even a small queue is stalled for thirty seconds", () => {
    const logger = createLogger();
    let now = 0;
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger,
      now: () => now,
      postEvents: acceptingPostEvents(),
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    now = 30_000;
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueAgeMs: 30_000, queueDepth: 2 }),
      expect.any(String),
    );
  });

  it("drops a permanently rejected event instead of retrying it forever", async () => {
    const logger = createLogger();
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async (events) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection(
            "Cannot append provider/unhandled for turn auto-compact-1 before turn/started is stored",
          );
        }
        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({
      threadId: "thr_poison",
      event: systemErrorEvent("thr_poison"),
    });
    await sink.flush();

    postEvents.mockClear();
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("delivers events queued behind a permanently rejected event", async () => {
    const delivered: string[] = [];
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async (events) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection(
            "Cannot append provider/unhandled for turn auto-compact-1 before turn/started is stored",
          );
        }
        delivered.push(...events.map((event) => event.threadId));
        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );
    let sessionOpen = false;
    const sink = createEventSink({
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({
      threadId: "thr_poison",
      event: systemErrorEvent("thr_poison"),
    });
    sink.emit({ threadId: "thr_a", event: systemErrorEvent("thr_a") });
    sink.emit({ threadId: "thr_b", event: systemErrorEvent("thr_b") });
    sink.emit({ threadId: "thr_a", event: systemErrorEvent("thr_a") });

    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();

    sessionOpen = true;
    await sink.flush();

    expect(delivered).toEqual(["thr_a", "thr_b", "thr_a"]);

    postEvents.mockClear();
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
  });

  it("keeps turn-scoped events queued until the server stores turn/started", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        turnStartPendingRejection(
          "Cannot append provider/unhandled for turn turn_1 before turn/started is stored",
        ),
      )
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const onSettled = vi.fn();
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({
      threadId: "thr_1",
      event: systemErrorEvent("thr_1"),
      delivery: { replayKey: "w1:pending:0", onSettled },
    });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();

    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("retains the whole batch when turn start is pending and drains it on the scheduled retry", async () => {
    const logger = createLogger();
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        turnStartPendingRejection(
          "Cannot append turn/completed for turn turn-1 before turn/started is stored",
        ),
      )
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(postEvents).toHaveBeenCalledTimes(2);
    });

    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
      { threadId: "thr_2", event: systemErrorEvent("thr_2") },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ batchSize: 2, retryDelayMs: 250 }),
      expect.any(String),
    );
  });

  it("does not let a turn whose turn/started never arrives wedge every thread", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const logger = createLogger();
      const server = serverRequiringTurnStarts();
      const sink = createEventSink({
        isSessionOpen: () => true,
        logger,
        now: () => now,
        postEvents: server.postEvents,
      });

      sink.emit({
        threadId: "thr_orphan",
        event: agentMessageDeltaEvent("thr_orphan", "turn-lost"),
      });
      sink.emit({
        threadId: "thr_other",
        event: systemErrorEvent("thr_other"),
      });
      await sink.flush();
      expect(server.stored).toEqual([]);

      now += 29_000;
      await sink.flush();
      expect(server.stored).toEqual([]);

      now += 2_000;
      await sink.flush();

      expect(server.stored).toEqual([
        {
          threadId: "thr_orphan",
          event: {
            type: "turn/started",
            threadId: "thr_orphan",
            providerThreadId: "provider-thread-1",
            scope: turnScope("turn-lost"),
          },
        },
        {
          threadId: "thr_orphan",
          event: agentMessageDeltaEvent("thr_orphan", "turn-lost"),
        },
        { threadId: "thr_other", event: systemErrorEvent("thr_other") },
      ]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thr_orphan",
          turnId: "turn-lost",
        }),
        expect.stringContaining("synthesized"),
      );

      sink.emit({
        threadId: "thr_orphan",
        event: agentMessageDeltaEvent("thr_orphan", "turn-lost"),
      });
      await sink.flush();
      expect(server.stored).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs a lost turn/started on its own retry schedule without another flush", async () => {
    vi.useFakeTimers();
    try {
      const server = serverRequiringTurnStarts();
      const sink = createEventSink({
        isSessionOpen: () => true,
        logger: createLogger(),
        now: () => Date.now(),
        postEvents: server.postEvents,
      });

      sink.emit({
        threadId: "thr_orphan",
        event: agentMessageDeltaEvent("thr_orphan", "turn-lost"),
      });
      sink.emit({
        threadId: "thr_other",
        event: systemErrorEvent("thr_other"),
      });

      await vi.advanceTimersByTimeAsync(25_000);
      expect(server.stored).toEqual([]);

      await vi.advanceTimersByTimeAsync(35_000);
      expect(server.stored.map((envelope) => envelope.event.type)).toEqual([
        "turn/started",
        "item/agentMessage/delta",
        "system/error",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wedge when a turn_start_pending rejection carries no details", async () => {
    vi.useFakeTimers();
    try {
      const stored: HostDaemonEventEnvelope[] = [];
      const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
        async (events) => {
          if (events.some((envelope) => envelope.threadId === "thr_orphan")) {
            throw turnStartPendingRejection(
              "Cannot append item/agentMessage/delta for turn turn-lost before turn/started is stored",
            );
          }
          stored.push(...events);
          return {
            acceptedEvents: events.map((event, eventIndex) => ({
              eventIndex,
              sequence: eventIndex + 1,
              threadId: event.threadId,
            })),
            rejectedEvents: [],
          };
        },
      );
      const sink = createEventSink({
        isSessionOpen: () => true,
        logger: createLogger(),
        now: () => Date.now(),
        postEvents,
      });

      sink.emit({
        threadId: "thr_before",
        event: systemErrorEvent("thr_before"),
      });
      sink.emit({
        threadId: "thr_orphan",
        event: agentMessageDeltaEvent("thr_orphan", "turn-lost"),
      });
      sink.emit({
        threadId: "thr_after",
        event: systemErrorEvent("thr_after"),
      });

      await vi.advanceTimersByTimeAsync(25_000);
      expect(stored).toEqual([]);

      await vi.advanceTimersByTimeAsync(35_000);
      expect(stored).toEqual([
        { threadId: "thr_before", event: systemErrorEvent("thr_before") },
        { threadId: "thr_after", event: systemErrorEvent("thr_after") },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a turn it cannot repair and keeps dropping its later events without stalling", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const logger = createLogger();
      const server = serverRequiringTurnStarts();
      const orphanSettled = vi.fn();
      const laterSettled = vi.fn();
      const sink = createEventSink({
        isSessionOpen: () => true,
        logger,
        now: () => now,
        postEvents: server.postEvents,
      });

      sink.emit({
        threadId: "thr_orphan",
        event: turnCompletedWithoutProviderThreadEvent(
          "thr_orphan",
          "turn-lost",
        ),
        delivery: { replayKey: "w1:orphan:0", onSettled: orphanSettled },
      });
      sink.emit({
        threadId: "thr_other",
        event: systemErrorEvent("thr_other"),
      });
      await sink.flush();
      now += 31_000;
      await sink.flush();

      expect(server.stored).toEqual([
        { threadId: "thr_other", event: systemErrorEvent("thr_other") },
      ]);
      expect(orphanSettled).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: "turn-lost", dropped: 1 }),
        expect.stringContaining("Dropped"),
      );

      const postsBefore = server.postEvents.mock.calls.length;
      sink.emit({
        threadId: "thr_orphan",
        event: turnCompletedWithoutProviderThreadEvent(
          "thr_orphan",
          "turn-lost",
        ),
        delivery: { replayKey: "w1:orphan:1", onSettled: laterSettled },
      });
      sink.emit({
        threadId: "thr_other",
        event: systemErrorEvent("thr_other"),
      });
      await sink.flush();

      expect(laterSettled).toHaveBeenCalledTimes(1);
      expect(server.postEvents.mock.calls.length).toBe(postsBefore + 1);
      expect(server.stored).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still waits for a turn/started that is only late", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const server = serverRequiringTurnStarts();
      const sink = createEventSink({
        isSessionOpen: () => true,
        logger: createLogger(),
        now: () => now,
        postEvents: server.postEvents,
      });

      sink.emit({
        threadId: "thr_1",
        event: agentMessageDeltaEvent("thr_1", "turn-late"),
      });
      await sink.flush();
      now += 5_000;
      await sink.flush();
      expect(server.stored).toEqual([]);

      await server.postEvents([
        {
          threadId: "thr_1",
          event: {
            type: "turn/started",
            threadId: "thr_1",
            providerThreadId: "provider-thread-1",
            scope: turnScope("turn-late"),
          },
        },
      ]);
      await sink.flush();

      expect(server.stored.map((envelope) => envelope.event.type)).toEqual([
        "turn/started",
        "item/agentMessage/delta",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying a batch that fails for a retryable reason", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        new ServerResponseError({
          action: "post events",
          bodyMessage: "database is locked",
          code: "internal_error",
          retryable: true,
          status: 500,
          statusText: "Internal Server Error",
        }),
      )
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("keeps events queued when the session, not the batch, is rejected", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        new ServerResponseError({
          action: "post events",
          bodyMessage: "Session is not active",
          code: "inactive_session",
          retryable: false,
          status: 401,
          statusText: "Unauthorized",
        }),
      )
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);

    await sink.flush();
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
      { threadId: "thr_2", event: systemErrorEvent("thr_2") },
    ]);
  });

  it("never throws from emit regardless of how many events queue up", () => {
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger: createLogger(),
      postEvents: acceptingPostEvents(),
    });

    expect(() => {
      for (let index = 0; index < 1000; index += 1) {
        sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
      }
    }).not.toThrow();
  });

  it("posts a worker line's replay key and settles its delivery once the server answered", async () => {
    let answer: () => void = () => undefined;
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      (events) =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              acceptedEvents: events.map((event, eventIndex) => ({
                eventIndex,
                sequence: eventIndex + 1,
                threadId: event.threadId,
              })),
              rejectedEvents: [],
            });
        }),
    );
    const onSettled = vi.fn();
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({
      threadId: "thr_1",
      event: systemErrorEvent("thr_1"),
      delivery: { replayKey: "w1:7:0", onSettled },
    });
    const flushing = sink.flush();
    await Promise.resolve();

    expect(postEvents).toHaveBeenCalledWith([
      {
        threadId: "thr_1",
        event: systemErrorEvent("thr_1"),
        replayKey: "w1:7:0",
      },
    ]);
    expect(onSettled).not.toHaveBeenCalled();
    answer();
    await flushing;
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("never settles the delivery of an event it did not get to the server", async () => {
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(async () => {
      throw new Error("server unreachable");
    });
    const onSettled = vi.fn();
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({
      threadId: "thr_1",
      event: systemErrorEvent("thr_1"),
      delivery: { replayKey: "w1:8:0", onSettled },
    });
    await sink.flush();
    await sink.dispose();

    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
