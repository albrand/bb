import {
  getThread,
  listEnvironmentReleaseConsents,
  listUnreleasedEnvironmentThreadIds,
  threads,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const API = "/api/v1";
const ACTOR_HEADER = "x-bb-actor-thread-id";

function seedWorkspace(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host_release" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/release-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/release-workspace",
    providerOwnsPath: true,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  return { environment, project, thread };
}

async function archive(
  harness: TestAppHarness,
  threadId: string,
  actor: string | null,
) {
  return harness.app.request(`${API}/threads/${threadId}/archive-all`, {
    method: "POST",
    ...(actor === null ? {} : { headers: { [ACTOR_HEADER]: actor } }),
  });
}

async function remove(
  harness: TestAppHarness,
  threadId: string,
  actor: string | null,
) {
  return harness.app.request(`${API}/threads/${threadId}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...(actor === null ? {} : { [ACTOR_HEADER]: actor }),
    },
    body: JSON.stringify({ childThreadsConfirmed: false }),
  });
}

describe("who released a workspace by archiving or deleting its thread", () => {
  it.each([
    ["the user, with no thread claimed", null, "user", null],
    ["the thread itself", "SELF", "self", "SELF"],
    [
      "another thread (a coordinator)",
      "thr_coordinator",
      "coordinator",
      "thr_coordinator",
    ],
  ] as const)(
    "records an archive by %s",
    async (_name, claim, kind, recorded) =>
      withTestHarness(async (harness) => {
        const { environment, thread } = seedWorkspace(harness);
        const actor = claim === "SELF" ? thread.id : claim;

        expect((await archive(harness, thread.id, actor)).status).toBe(200);

        expect(
          listEnvironmentReleaseConsents(harness.db, environment.id),
        ).toMatchObject([
          {
            threadId: thread.id,
            actorKind: kind,
            actorThreadId: recorded === "SELF" ? thread.id : recorded,
          },
        ]);
        expect(
          listUnreleasedEnvironmentThreadIds(harness.db, environment.id),
        ).toEqual([]);
      }),
  );

  it.each([
    ["the user, with no thread claimed", null, "user", null],
    ["the thread itself", "SELF", "self", "SELF"],
    [
      "another thread (a coordinator)",
      "thr_coordinator",
      "coordinator",
      "thr_coordinator",
    ],
  ] as const)("records a delete by %s", async (_name, claim, kind, recorded) =>
    withTestHarness(async (harness) => {
      const { environment, thread } = seedWorkspace(harness);
      const actor = claim === "SELF" ? thread.id : claim;

      expect((await remove(harness, thread.id, actor)).status).toBe(200);

      expect(
        listEnvironmentReleaseConsents(harness.db, environment.id),
      ).toMatchObject([
        {
          threadId: thread.id,
          actorKind: kind,
          actorThreadId: recorded === "SELF" ? thread.id : recorded,
        },
      ]);
    }),
  );

  it("records a release for every thread the environment archive-threads route archives", async () =>
    withTestHarness(async (harness) => {
      const { environment, project, thread } = seedWorkspace(harness);
      const sibling = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(
        `${API}/environments/${environment.id}/archive-threads`,
        { method: "POST", headers: { [ACTOR_HEADER]: "thr_coordinator" } },
      );

      expect(response.status).toBe(200);
      expect(
        listEnvironmentReleaseConsents(harness.db, environment.id)
          .map((row) => [row.threadId, row.actorKind])
          .sort(),
      ).toEqual(
        [
          [thread.id, "coordinator"],
          [sibling.id, "coordinator"],
        ].sort(),
      );
    }));

  it("withdraws the release when the thread is unarchived", async () =>
    withTestHarness(async (harness) => {
      const { environment, thread } = seedWorkspace(harness);
      await archive(harness, thread.id, null);
      expect(
        listUnreleasedEnvironmentThreadIds(harness.db, environment.id),
      ).toEqual([]);

      const response = await harness.app.request(
        `${API}/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
      expect(
        listUnreleasedEnvironmentThreadIds(harness.db, environment.id),
      ).toEqual([thread.id]);
    }));

  it("ignores a malformed actor claim and records the user", async () =>
    withTestHarness(async (harness) => {
      const { environment, thread } = seedWorkspace(harness);

      await archive(harness, thread.id, "not a thread id; drop table");

      expect(
        listEnvironmentReleaseConsents(harness.db, environment.id),
      ).toMatchObject([{ actorKind: "user", actorThreadId: null }]);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get(),
      ).toBeDefined();
    }));
});
