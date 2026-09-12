import { eq } from "drizzle-orm";
import { events } from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { isForkUnreadStoredEvent } from "../../src/internal/fork-unread-events.js";
import { isActivePruneTriggerThreadEventType } from "../../src/services/system/event-pruning.js";

describe("fork ingest drop for event types nothing reads", () => {
  it("drops codex hook telemetry, keeps every other unhandled provider event, and still acks the batch", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-fork-unread-drop",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const unhandled = (
        providerId: string,
        rawType: string,
        method: string,
      ) =>
        ({
          threadId: thread.id,
          event: {
            type: "provider/unhandled",
            threadId: thread.id,
            providerThreadId: "provider-thread",
            providerId,
            rawType,
            rawEvent: { jsonrpc: "2.0", method, params: {} },
            scope: threadScope(),
          },
        }) satisfies HostDaemonEventEnvelope;

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            unhandled("codex", "hook/started", "hook/started"),
            unhandled("codex", "hook/completed", "hook/completed"),
            unhandled("codex", "warning", "warning"),
            unhandled("claude-code", "sdk/message", "sdk/message"),
          ]),
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        acceptedEvents: unknown[];
        rejectedEvents: unknown[];
      };
      expect(body.rejectedEvents).toHaveLength(0);
      expect(body.acceptedEvents).toHaveLength(2);

      const storedRawTypes = harness.db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .map((row) => (JSON.parse(row.data) as { rawType?: string }).rawType)
        .filter((rawType): rawType is string => rawType !== undefined)
        .sort();
      expect(storedRawTypes).toEqual(["sdk/message", "warning"]);
    });
  });

  it("drops turn/diff/updated while storing the rest of the turn", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-fork-turn-diff-drop",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const turnId = "turn-diet-1";
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                scope: turnScope(turnId),
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "turn/diff/updated",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                diff: "x".repeat(50_000),
                scope: turnScope(turnId),
              },
            },
          ] satisfies HostDaemonEventEnvelope[]),
        }),
      });
      expect(response.status).toBe(200);

      const storedTypes = harness.db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .map((row) => row.type);
      expect(storedTypes).toContain("turn/started");
      expect(storedTypes).not.toContain("turn/diff/updated");
    });
  });
});

describe("no dropped event type is listed as an active prune trigger", () => {
  const dropped: HostDaemonEventEnvelope["event"][] = [
    {
      type: "turn/diff/updated",
      threadId: "thr_x",
      providerThreadId: "provider-thread",
      diff: "x",
      scope: turnScope("turn-1"),
    },
    {
      type: "provider/unhandled",
      threadId: "thr_x",
      providerThreadId: "provider-thread",
      providerId: "codex",
      rawType: "hook/started",
      rawEvent: { jsonrpc: "2.0", method: "hook/started", params: {} },
      scope: threadScope(),
    },
  ];

  it("keeps the trigger set free of types the ingest filter throws away", () => {
    for (const event of dropped) {
      expect(isForkUnreadStoredEvent(event)).toBe(true);
      expect(isActivePruneTriggerThreadEventType(event.type)).toBe(false);
    }
  });

  it("still triggers on the three types that do reach the store", () => {
    for (const type of [
      "thread/contextWindowUsage/updated",
      "thread/tokenUsage/updated",
      "item/backgroundTask/progress",
    ] as const) {
      expect(isActivePruneTriggerThreadEventType(type)).toBe(true);
    }
  });
});
