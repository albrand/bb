import { and, eq } from "drizzle-orm";
import { events } from "@bb/db";
import { threadScope } from "@bb/domain";
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

describe("daemon event replay keys", () => {
  it("stores a replayed worker line's events once", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-replay-keys",
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
      const warning = (summary: string, replayKey: string) =>
        ({
          threadId: thread.id,
          replayKey,
          event: {
            type: "provider/warning",
            threadId: thread.id,
            providerThreadId: "provider-thread",
            category: "general",
            summary,
            scope: threadScope(),
          },
        }) satisfies HostDaemonEventEnvelope;
      const post = (envelopes: HostDaemonEventEnvelope[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(envelopes),
          }),
        });
      const storedSummaries = () =>
        harness.db
          .select({ data: events.data })
          .from(events)
          .where(
            and(
              eq(events.threadId, thread.id),
              eq(events.type, "provider/warning"),
            ),
          )
          .all()
          .map((row) => (JSON.parse(row.data) as { summary: string }).summary);

      expect(
        (await post([warning("first", "w1:5:0"), warning("second", "w1:5:1")]))
          .status,
      ).toBe(200);
      expect(
        (
          await post([
            warning("first again", "w1:5:0"),
            warning("second again", "w1:5:1"),
            warning("third", "w1:6:0"),
          ])
        ).status,
      ).toBe(200);

      expect(storedSummaries()).toEqual(["first", "second", "third"]);

      const upstreamShapedBatch = {
        sessionId: session.id,
        eventGroups: [
          {
            threadId: thread.id,
            events: [warning("from a stock daemon", "unused").event],
          },
        ],
      };
      expect(Object.keys(upstreamShapedBatch.eventGroups[0] ?? {})).toEqual([
        "threadId",
        "events",
      ]);
      const stock = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify(upstreamShapedBatch),
      });
      expect(stock.status).toBe(200);
      expect(storedSummaries()).toEqual([
        "first",
        "second",
        "third",
        "from a stock daemon",
      ]);
    });
  });
});
