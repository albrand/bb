import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { events, setAppSettings } from "@bb/db";
import { defaultAppSettings, threadScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PLUGIN_SECRET = "fake-secret-123";
const CORE_SECRET = "fake-core-secret-456";
const SHELL_PATH = "/fake/shell/bin";

const stockDaemonEntries = [
  { name: "PATH", source: "shell", value: SHELL_PATH },
  {
    name: "FAKE_PLUGIN_TOKEN",
    source: { plugin: "fake-pool" },
    value: PLUGIN_SECRET,
    reason: "Route the agent through the fake pool",
  },
  {
    name: "FAKE_CORE_TOKEN",
    source: { core: "project-environment" },
    value: CORE_SECRET,
  },
] as const;

const maskedEntries = [
  { name: "PATH", source: "shell", value: SHELL_PATH },
  {
    name: "FAKE_PLUGIN_TOKEN",
    source: { plugin: "fake-pool" },
    value: { masked: true },
    reason: "Route the agent through the fake pool",
  },
  {
    name: "FAKE_CORE_TOKEN",
    source: { core: "project-environment" },
    value: { masked: true },
  },
];

function storedEnvironmentData(harness: TestAppHarness, threadId: string) {
  return harness.db
    .select({ data: events.data, type: events.type })
    .from(events)
    .where(eq(events.threadId, threadId))
    .all()
    .filter((row) => row.type === "provider.env-resolved")
    .map((row) => row.data);
}

async function readText(
  harness: TestAppHarness,
  path: string,
): Promise<string> {
  const response = await harness.app.request(path);
  expect(response.status).toBe(200);
  return response.text();
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(PLUGIN_SECRET);
  expect(text).not.toContain(CORE_SECRET);
}

describe("provider environment values", () => {
  it("masks plugin and core values from a stock daemon before they are stored", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-env-masking",
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
      const envelope = {
        threadId: thread.id,
        event: {
          type: "provider.env-resolved",
          threadId: thread.id,
          providerThreadId: "provider-thread",
          entries: [...stockDaemonEntries],
          scope: threadScope(),
        },
      } satisfies HostDaemonEventEnvelope;

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([envelope]),
        }),
      });
      expect(response.status).toBe(200);

      const stored = storedEnvironmentData(harness, thread.id);
      expect(stored).toHaveLength(1);
      expectNoSecrets(stored.join("\n"));
      expect(JSON.parse(stored[0] ?? "{}")).toMatchObject({
        entries: maskedEntries,
      });
    });
  });

  it("never returns values stored before masking through the events, wait or timeline APIs", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "provider-session",
        scope: threadScope(),
        sequence: 1,
        type: "provider.env-resolved",
        data: { entries: [...stockDaemonEntries] },
      });
      expect(storedEnvironmentData(harness, thread.id).join("\n")).toContain(
        PLUGIN_SECRET,
      );

      const eventsText = await readText(
        harness,
        `/api/v1/threads/${thread.id}/events?limit=50`,
      );
      expectNoSecrets(eventsText);
      expect(JSON.parse(eventsText)).toMatchObject([
        { type: "provider.env-resolved", data: { entries: maskedEntries } },
      ]);

      const waitText = await readText(
        harness,
        `/api/v1/threads/${thread.id}/events/wait?type=provider.env-resolved&waitMs=0`,
      );
      expectNoSecrets(waitText);
      expect(JSON.parse(waitText)).toMatchObject({
        data: { entries: maskedEntries },
      });

      setAppSettings(harness.db, {
        ...defaultAppSettings,
        showDiagnosticEvents: true,
      });
      for (const query of ["includeNestedRows=true", ""]) {
        const timelineText = await readText(
          harness,
          `/api/v1/threads/${thread.id}/timeline?${query}`,
        );
        expect(timelineText).toContain("Provider environment resolved");
        expectNoSecrets(timelineText);
        expect(timelineText).toContain(`PATH=${SHELL_PATH} (shell)`);
        expect(timelineText).toContain("FAKE_PLUGIN_TOKEN=•••••• (fake-pool)");
        expect(timelineText).toContain(
          "FAKE_CORE_TOKEN=•••••• (project-environment)",
        );
      }
    });
  });
});
