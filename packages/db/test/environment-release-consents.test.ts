import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { noopNotifier } from "../src/notifier.js";
import {
  archiveThread,
  createEnvironment,
  createProject,
  createThread,
  listEnvironmentReleaseConsents,
  listUnreleasedEnvironmentThreadIds,
  markThreadDeleted,
  migrate,
  unarchiveThread,
  upsertHost,
  FAILED_CREATE_RELEASE_ACTOR,
  SYSTEM_RELEASE_ACTOR,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";
import { environmentReleaseConsents, threads } from "../src/schema.js";
import { dropEnvironmentRetentionSchema } from "./helpers/rewind.js";

const MIGRATION_WHEN = 1792744408107;

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "host" });
  const { project } = createProject(db, noopNotifier, {
    name: "project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/project-env",
    providerOwnsPath: true,
    status: "ready",
  });
  const thread = () =>
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "provider",
      status: "idle",
      environmentId: environment.id,
    });
  return { db, environment, thread };
}

describe("environment release consents", () => {
  it.each([
    ["user", { kind: "user", threadId: null }],
    ["self", { kind: "self", threadId: "thr_self" }],
    ["coordinator", { kind: "coordinator", threadId: "thr_parent" }],
    ["system", SYSTEM_RELEASE_ACTOR],
    ["failed create", FAILED_CREATE_RELEASE_ACTOR],
  ] as const)("records an archive by the %s with the actor", (_name, actor) => {
    const { db, environment, thread } = setup();
    const archived = thread();
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      archived.id,
    ]);

    archiveThread(db, noopNotifier, archived.id, actor);

    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([]);
    expect(listEnvironmentReleaseConsents(db, environment.id)).toMatchObject([
      {
        environmentId: environment.id,
        threadId: archived.id,
        actorKind: actor.kind,
        actorThreadId: actor.threadId,
      },
    ]);
  });

  it.each([
    ["user", { kind: "user", threadId: null }],
    ["self", { kind: "self", threadId: "thr_self" }],
    ["coordinator", { kind: "coordinator", threadId: "thr_parent" }],
    ["system", SYSTEM_RELEASE_ACTOR],
    ["failed create", FAILED_CREATE_RELEASE_ACTOR],
  ] as const)("records a delete by the %s with the actor", (_name, actor) => {
    const { db, environment, thread } = setup();
    const deleted = thread();

    markThreadDeleted(db, noopNotifier, {
      threadId: deleted.id,
      release: actor,
    });

    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([]);
    expect(listEnvironmentReleaseConsents(db, environment.id)).toMatchObject([
      { threadId: deleted.id, actorKind: actor.kind },
    ]);
  });

  it("does not count a thread that was archived without a record, and withdraws the release on unarchive", () => {
    const { db, environment, thread } = setup();
    const raw = thread();
    db.update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, raw.id))
      .run();
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      raw.id,
    ]);

    const archived = thread();
    archiveThread(db, noopNotifier, archived.id, {
      kind: "user",
      threadId: null,
    });
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      raw.id,
    ]);

    expect(unarchiveThread(db, noopNotifier, archived.id)).not.toBeNull();
    expect(
      listUnreleasedEnvironmentThreadIds(db, environment.id).sort(),
    ).toEqual([raw.id, archived.id].sort());
  });

  it("records no consent for an archive that passes no release, and leaves the thread unreleased", () => {
    const { db, environment, thread } = setup();
    const archived = thread();

    archiveThread(db, noopNotifier, archived.id, null);

    expect(listEnvironmentReleaseConsents(db, environment.id)).toEqual([]);
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      archived.id,
    ]);
  });

  it("records no consent for a delete that passes no release, and leaves the thread unreleased", () => {
    const { db, environment, thread } = setup();
    const deleted = thread();

    markThreadDeleted(db, noopNotifier, {
      release: null,
      threadId: deleted.id,
    });

    expect(listEnvironmentReleaseConsents(db, environment.id)).toEqual([]);
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      deleted.id,
    ]);
  });

  it("cannot be made to grant consent by leaving the release out of an archive or a delete", () => {
    const { db, environment, thread } = setup();
    const archived = thread();
    const deleted = thread();

    Reflect.apply(archiveThread, undefined, [db, noopNotifier, archived.id]);
    Reflect.apply(markThreadDeleted, undefined, [
      db,
      noopNotifier,
      { threadId: deleted.id },
    ]);

    expect(listEnvironmentReleaseConsents(db, environment.id)).toEqual([]);
    expect(
      listUnreleasedEnvironmentThreadIds(db, environment.id).sort(),
    ).toEqual([archived.id, deleted.id].sort());
  });

  it("releases only the threads that were archived, not their siblings on the environment", () => {
    const { db, environment, thread } = setup();
    const first = thread();
    const second = thread();

    archiveThread(db, noopNotifier, first.id, { kind: "user", threadId: null });

    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      second.id,
    ]);
  });

  it("treats threads archived or deleted before the upgrade as released by the upgrade", () => {
    const { db, environment, thread } = setup();
    const archivedBefore = thread();
    const deletedBefore = thread();
    const liveBefore = thread();
    db.update(threads)
      .set({ archivedAt: 5_000 })
      .where(eq(threads.id, archivedBefore.id))
      .run();
    db.update(threads)
      .set({ deletedAt: 6_000 })
      .where(eq(threads.id, deletedBefore.id))
      .run();
    db.delete(environmentReleaseConsents).run();
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(MIGRATION_WHEN);
    dropEnvironmentRetentionSchema(db);

    migrate(db);

    expect(
      listEnvironmentReleaseConsents(db, environment.id)
        .map((row) => ({
          threadId: row.threadId,
          actorKind: row.actorKind,
          grantedAt: row.grantedAt,
        }))
        .sort((a, b) => a.grantedAt - b.grantedAt),
    ).toEqual([
      { threadId: archivedBefore.id, actorKind: "migrated", grantedAt: 5_000 },
      { threadId: deletedBefore.id, actorKind: "migrated", grantedAt: 6_000 },
    ]);
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      liveBefore.id,
    ]);
  });
});
