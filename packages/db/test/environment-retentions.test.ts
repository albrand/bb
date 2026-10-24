import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedConnection } from "../src/testing.js";
import {
  closeEnvironmentRetention,
  deleteEnvironmentRetentionIntents,
  findOpenEnvironmentRetentionOverlapping,
  listEnvironmentRetentionTransitions,
  listEnvironmentRetentionTransitionsForEnvironment,
  listOpenEnvironmentRetentionsForHost,
  listOpenEnvironmentRetentionsForProject,
  markEnvironmentRetentionsUnresolved,
  recordEnvironmentRetention,
} from "../src/data/index.js";
import { environmentRetentions } from "../src/schema.js";

const base = {
  environmentId: "env_a",
  projectId: "proj_a",
  hostId: "host_a",
  ownerThreadId: "thr_a",
  providerId: "provider",
  originalPath: "/work/a",
  keptPath: "/work/a",
  message: "kept",
} as const;

function closeCurrent(
  db: ReturnType<typeof createMigratedConnection>,
  id: string,
  proof: string,
) {
  const current = db
    .select()
    .from(environmentRetentions)
    .where(eq(environmentRetentions.id, id))
    .get();
  return closeEnvironmentRetention(db, {
    id,
    proof,
    expectedUpdatedAt: current?.updatedAt ?? -1,
  });
}

describe("environment retentions", () => {
  it("outlives the environment and project rows, because it has no foreign keys", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, { ...base, state: "retained" });
    expect(listOpenEnvironmentRetentionsForHost(db, "host_a")).toHaveLength(1);
    expect(listOpenEnvironmentRetentionsForProject(db, "proj_a")).toHaveLength(
      1,
    );
  });

  it("updates the row for the same environment and path instead of adding another", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, { ...base, state: "intent" });
    recordEnvironmentRetention(db, { ...base, state: "retained" });
    const rows = db.select().from(environmentRetentions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("retained");
  });

  it("turns an intent unresolved and deletes only intents", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, { ...base, state: "intent" });
    recordEnvironmentRetention(db, {
      ...base,
      keptPath: "/work/b",
      state: "retained",
    });
    markEnvironmentRetentionsUnresolved(db, "env_a", "no result");
    expect(
      db
        .select()
        .from(environmentRetentions)
        .all()
        .map((row) => [row.keptPath, row.state])
        .sort(),
    ).toEqual([
      ["/work/a", "unresolved"],
      ["/work/b", "retained"],
    ]);
    recordEnvironmentRetention(db, {
      ...base,
      environmentId: "env_b",
      keptPath: "/work/c",
      state: "intent",
    });
    deleteEnvironmentRetentionIntents(db, "env_b");
    expect(db.select().from(environmentRetentions).all()).toHaveLength(2);
  });

  it("finds a retention at, above or below a path and none elsewhere", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, { ...base, state: "retained" });
    for (const path of ["/work/a", "/work/a/src/x.ts", "/work"]) {
      expect(
        findOpenEnvironmentRetentionOverlapping(db, { hostId: "host_a", path }),
        path,
      ).not.toBeNull();
    }
    expect(
      findOpenEnvironmentRetentionOverlapping(db, {
        hostId: "host_a",
        path: "/work/ab",
      }),
    ).toBeNull();
    expect(
      findOpenEnvironmentRetentionOverlapping(db, {
        hostId: "other",
        path: "/work/a",
      }),
    ).toBeNull();
  });

  it("never downgrades a retained or unresolved row to an intent, and reopens a closed one", () => {
    const db = createMigratedConnection();
    const retained = recordEnvironmentRetention(db, {
      ...base,
      state: "retained",
    });
    expect(
      recordEnvironmentRetention(db, { ...base, state: "intent" }).state,
    ).toBe("retained");
    recordEnvironmentRetention(db, { ...base, state: "unresolved" });
    expect(
      recordEnvironmentRetention(db, { ...base, state: "retained" }).state,
    ).toBe("unresolved");
    expect(closeCurrent(db, retained.id, "absent")).toBe("closed");
    expect(listOpenEnvironmentRetentionsForHost(db, "host_a")).toEqual([]);
    expect(
      recordEnvironmentRetention(db, { ...base, state: "intent" }).state,
    ).toBe("intent");
  });

  it("keeps one pathless intent per environment and lets it be resolved or deleted", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, {
      ...base,
      originalPath: null,
      keptPath: null,
      state: "intent",
    });
    recordEnvironmentRetention(db, {
      ...base,
      originalPath: null,
      keptPath: null,
      state: "intent",
    });
    expect(db.select().from(environmentRetentions).all()).toHaveLength(1);
    markEnvironmentRetentionsUnresolved(db, "env_a", "no answer");
    expect(db.select().from(environmentRetentions).all()[0]?.state).toBe(
      "unresolved",
    );
    expect(
      findOpenEnvironmentRetentionOverlapping(db, {
        hostId: "host_a",
        path: "/work/a",
      }),
    ).toBeNull();
  });

  it("records the closure proof and time on the row and stops blocking", () => {
    const db = createMigratedConnection();
    const row = recordEnvironmentRetention(db, { ...base, state: "retained" });
    expect(closeCurrent(db, row.id, "lstat ENOENT on host_a")).toBe("closed");
    const closed = db.select().from(environmentRetentions).all()[0];
    expect(closed).toMatchObject({
      state: "closed",
      closedProof: "lstat ENOENT on host_a",
    });
    expect(closed?.closedAt).toBeGreaterThan(0);
    expect(closeCurrent(db, row.id, "again")).toBe("not_open");
  });

  it("appends a transition for every change and keeps the closure after the row is reopened", () => {
    const db = createMigratedConnection();
    const row = recordEnvironmentRetention(db, { ...base, state: "intent" });
    recordEnvironmentRetention(db, {
      ...base,
      state: "retained",
      message: "kept",
    });
    closeCurrent(db, row.id, "lstat ENOENT on host_a");
    recordEnvironmentRetention(db, {
      ...base,
      state: "intent",
      message: "again",
    });

    expect(
      listEnvironmentRetentionTransitions(db, row.id).map((entry) => [
        entry.fromState,
        entry.toState,
      ]),
    ).toEqual([
      [null, "intent"],
      ["intent", "retained"],
      ["retained", "closed"],
      ["closed", "intent"],
    ]);
    const closing = listEnvironmentRetentionTransitions(db, row.id)[2];
    expect(closing).toMatchObject({
      detail: "lstat ENOENT on host_a",
      hostId: "host_a",
      path: "/work/a",
    });
    expect(closing?.at).toBeGreaterThan(0);
  });

  it("logs a deleted intent and a merged path-less intent instead of dropping them silently", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, {
      ...base,
      originalPath: null,
      keptPath: null,
      state: "intent",
    });
    recordEnvironmentRetention(db, { ...base, state: "intent" });
    expect(db.select().from(environmentRetentions).all()).toHaveLength(1);
    deleteEnvironmentRetentionIntents(db, "env_a", "nothing kept");

    expect(
      listEnvironmentRetentionTransitionsForEnvironment(db, "env_a").map(
        (entry) => entry.toState,
      ),
    ).toEqual(["intent", "intent", "merged", "deleted"]);
  });

  it("merges a path-less intent into a path row when a create throws, and leaves a path-less unresolved row alone otherwise", () => {
    const db = createMigratedConnection();
    recordEnvironmentRetention(db, {
      ...base,
      originalPath: null,
      keptPath: null,
      state: "unresolved",
    });
    recordEnvironmentRetention(db, {
      ...base,
      environmentId: "env_b",
      originalPath: null,
      keptPath: null,
      state: "intent",
    });
    markEnvironmentRetentionsUnresolved(db, "env_b", "threw");
    expect(
      db
        .select()
        .from(environmentRetentions)
        .all()
        .map((row) => [row.environmentId, row.keptPath, row.state])
        .sort(),
    ).toEqual([
      ["env_a", null, "unresolved"],
      ["env_b", null, "unresolved"],
    ]);
  });

  describe("atomicity", () => {
    const failTransitions = (db: ReturnType<typeof createMigratedConnection>) =>
      db.$client.exec(
        "CREATE TRIGGER fail_transition BEFORE INSERT ON environment_retention_transitions BEGIN SELECT RAISE(ABORT, 'transition insert failed'); END;",
      );

    it("rolls a new row back when its transition cannot be written", () => {
      const db = createMigratedConnection();
      failTransitions(db);
      expect(() =>
        recordEnvironmentRetention(db, { ...base, state: "retained" }),
      ).toThrow("transition insert failed");
      expect(db.select().from(environmentRetentions).all()).toEqual([]);
    });

    it("leaves a row open and unchanged when its closure transition cannot be written", () => {
      const db = createMigratedConnection();
      const row = recordEnvironmentRetention(db, {
        ...base,
        state: "retained",
      });
      failTransitions(db);
      expect(() => closeCurrent(db, row.id, "absent")).toThrow(
        "transition insert failed",
      );
      expect(db.select().from(environmentRetentions).all()[0]).toMatchObject({
        state: "retained",
        closedProof: null,
      });
    });

    it("keeps an intent when the transition for deleting it cannot be written", () => {
      const db = createMigratedConnection();
      recordEnvironmentRetention(db, { ...base, state: "intent" });
      failTransitions(db);
      expect(() => deleteEnvironmentRetentionIntents(db, "env_a")).toThrow(
        "transition insert failed",
      );
      expect(db.select().from(environmentRetentions).all()).toHaveLength(1);
    });

    it("keeps an intent as it was when the transition for marking it unresolved cannot be written", () => {
      const db = createMigratedConnection();
      recordEnvironmentRetention(db, { ...base, state: "intent" });
      failTransitions(db);
      expect(() =>
        markEnvironmentRetentionsUnresolved(db, "env_a", "threw"),
      ).toThrow("transition insert failed");
      expect(db.select().from(environmentRetentions).all()[0]?.state).toBe(
        "intent",
      );
    });
  });

  describe("freshness of a re-recorded row", () => {
    it("refreshes the time of an intent that is recorded again, so it is not judged by its old age", () => {
      const db = createMigratedConnection();
      const first = recordEnvironmentRetention(db, {
        ...base,
        originalPath: null,
        keptPath: null,
        state: "intent",
      });
      db.update(environmentRetentions)
        .set({ updatedAt: 1000 })
        .where(eq(environmentRetentions.id, first.id))
        .run();

      const again = recordEnvironmentRetention(db, {
        ...base,
        originalPath: null,
        keptPath: null,
        state: "intent",
      });

      expect(again.id).toBe(first.id);
      expect(again.updatedAt).toBeGreaterThan(1000);
      expect(Date.now() - again.updatedAt).toBeLessThan(5_000);
    });

    it("refuses a stale close after a same-state re-record, changing neither the row nor the transition log", () => {
      const db = createMigratedConnection();
      const read = recordEnvironmentRetention(db, {
        ...base,
        state: "retained",
      });
      const versionRead = read.updatedAt;
      const reRecorded = recordEnvironmentRetention(db, {
        ...base,
        state: "retained",
      });
      expect(reRecorded.updatedAt).not.toBe(versionRead);
      const rowBefore = JSON.stringify(
        db.select().from(environmentRetentions).all(),
      );
      const transitionsBefore = listEnvironmentRetentionTransitions(
        db,
        read.id,
      );

      expect(
        closeEnvironmentRetention(db, {
          id: read.id,
          proof: "stale",
          expectedUpdatedAt: versionRead,
        }),
      ).toBe("stale");

      expect(
        JSON.stringify(db.select().from(environmentRetentions).all()),
      ).toBe(rowBefore);
      expect(listEnvironmentRetentionTransitions(db, read.id)).toEqual(
        transitionsBefore,
      );
      expect(listOpenEnvironmentRetentionsForHost(db, "host_a")).toHaveLength(
        1,
      );

      expect(
        closeEnvironmentRetention(db, {
          id: read.id,
          proof: "fresh",
          expectedUpdatedAt: reRecorded.updatedAt,
        }),
      ).toBe("closed");
      const transitions = listEnvironmentRetentionTransitions(db, read.id);
      expect(transitions).toHaveLength(transitionsBefore.length + 1);
      expect(transitions.at(-1)).toMatchObject({
        fromState: "retained",
        toState: "closed",
        detail: "fresh",
      });
      expect(db.select().from(environmentRetentions).all()[0]).toMatchObject({
        state: "closed",
        closedProof: "fresh",
      });
    });

    it("refuses a stale close after a re-record that changed the state, and a close of a row that is not open", () => {
      const db = createMigratedConnection();
      const read = recordEnvironmentRetention(db, {
        ...base,
        state: "retained",
      });
      recordEnvironmentRetention(db, { ...base, state: "unresolved" });
      const transitionsBefore = listEnvironmentRetentionTransitions(
        db,
        read.id,
      );
      expect(
        closeEnvironmentRetention(db, {
          id: read.id,
          proof: "stale",
          expectedUpdatedAt: read.updatedAt,
        }),
      ).toBe("stale");
      expect(listEnvironmentRetentionTransitions(db, read.id)).toEqual(
        transitionsBefore,
      );
      expect(db.select().from(environmentRetentions).all()[0]?.state).toBe(
        "unresolved",
      );
      const open = db.select().from(environmentRetentions).all()[0];
      expect(
        Reflect.apply(closeEnvironmentRetention, undefined, [
          db,
          { id: open?.id, proof: "no version" },
        ]),
      ).toBe("stale");
      expect(db.select().from(environmentRetentions).all()[0]?.state).toBe(
        "unresolved",
      );
      expect(
        closeEnvironmentRetention(db, {
          id: "missing",
          proof: "none",
          expectedUpdatedAt: 1,
        }),
      ).toBe("not_open");
    });
  });

  describe("every write advances the version, even within one millisecond", () => {
    const FROZEN_AT = 1_800_000_000_000;
    type TestDb = ReturnType<typeof createMigratedConnection>;
    interface Writer {
      name: string;
      seed: (db: TestDb) => string;
      write: (db: TestDb) => void;
    }
    const retained = (db: TestDb) =>
      recordEnvironmentRetention(db, { ...base, state: "retained" }).id;
    const writers: Writer[] = [
      {
        name: "recording the same state again",
        seed: retained,
        write: (db) =>
          void recordEnvironmentRetention(db, { ...base, state: "retained" }),
      },
      {
        name: "recording an intent for a retained row",
        seed: retained,
        write: (db) =>
          void recordEnvironmentRetention(db, { ...base, state: "intent" }),
      },
      {
        name: "recording retained for an unresolved row",
        seed: (db) =>
          recordEnvironmentRetention(db, { ...base, state: "unresolved" }).id,
        write: (db) =>
          void recordEnvironmentRetention(db, { ...base, state: "retained" }),
      },
      {
        name: "recording a different state",
        seed: (db) =>
          recordEnvironmentRetention(db, { ...base, state: "intent" }).id,
        write: (db) =>
          void recordEnvironmentRetention(db, {
            ...base,
            state: "retained",
            message: "kept after all",
          }),
      },
      {
        name: "marking an intent unresolved",
        seed: (db) =>
          recordEnvironmentRetention(db, { ...base, state: "intent" }).id,
        write: (db) =>
          markEnvironmentRetentionsUnresolved(db, "env_a", "threw"),
      },
    ];

    afterEach(() => {
      vi.useRealTimers();
    });

    const versionOf = (db: TestDb, id: string) =>
      db
        .select()
        .from(environmentRetentions)
        .where(eq(environmentRetentions.id, id))
        .get()?.updatedAt;
    const tableJson = (db: TestDb) =>
      JSON.stringify(db.select().from(environmentRetentions).all());

    it.each(writers)(
      "refuses a close made with the version read before $name, changing neither the row nor the transition log",
      ({ name, seed, write }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(FROZEN_AT);
        const db = createMigratedConnection();
        const id = seed(db);
        const versionRead = versionOf(db, id) ?? -1;
        write(db);
        expect(Date.now()).toBe(FROZEN_AT);
        const rowBefore = tableJson(db);
        const transitionsBefore = listEnvironmentRetentionTransitions(db, id);

        const result = closeEnvironmentRetention(db, {
          id,
          proof: "stale",
          expectedUpdatedAt: versionRead,
        });

        const rowAfter = tableJson(db);
        const transitionsAfter = listEnvironmentRetentionTransitions(db, id);
        const observation = JSON.stringify({
          writer: name,
          versionRead,
          versionOfRow: versionOf(db, id),
          result,
          rowBefore: JSON.parse(rowBefore),
          rowAfter: JSON.parse(rowAfter),
          transitionsBefore: transitionsBefore.length,
          transitionsAfter: transitionsAfter.length,
        });
        expect(result, `stale-close observation: ${observation}`).toBe("stale");
        expect(rowAfter, `stale-close observation: ${observation}`).toBe(
          rowBefore,
        );
        expect(
          transitionsAfter,
          `stale-close observation: ${observation}`,
        ).toEqual(transitionsBefore);
      },
    );

    it.each(writers)(
      "gives the row a new version after $name, and a close with that version writes exactly one transition",
      ({ seed, write }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(FROZEN_AT);
        const db = createMigratedConnection();
        const id = seed(db);
        const versionRead = versionOf(db, id) ?? -1;
        write(db);
        const currentVersion = versionOf(db, id) ?? -1;
        const transitionsBefore = listEnvironmentRetentionTransitions(db, id);

        expect(currentVersion).toBeGreaterThan(versionRead);
        expect(
          closeEnvironmentRetention(db, {
            id,
            proof: "fresh",
            expectedUpdatedAt: currentVersion,
          }),
        ).toBe("closed");
        expect(listEnvironmentRetentionTransitions(db, id)).toHaveLength(
          transitionsBefore.length + 1,
        );
      },
    );

    it("refuses a close made with a version read before the row was closed and recorded again within one millisecond", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_AT);
      const db = createMigratedConnection();
      const id = retained(db);
      const versionRead = versionOf(db, id) ?? -1;
      expect(
        closeEnvironmentRetention(db, {
          id,
          proof: "absent",
          expectedUpdatedAt: versionRead,
        }),
      ).toBe("closed");
      const closedVersion = versionOf(db, id) ?? -1;
      recordEnvironmentRetention(db, { ...base, state: "retained" });
      const rowBefore = tableJson(db);
      const transitionsBefore = listEnvironmentRetentionTransitions(db, id);

      const results = [versionRead, closedVersion].map((expectedUpdatedAt) =>
        closeEnvironmentRetention(db, {
          id,
          proof: "stale",
          expectedUpdatedAt,
        }),
      );

      const observation = JSON.stringify({
        versionRead,
        closedVersion,
        versionOfRow: versionOf(db, id),
        results,
        transitionsBefore: transitionsBefore.length,
        transitionsAfter: listEnvironmentRetentionTransitions(db, id).length,
      });
      expect(results, `stale-close observation: ${observation}`).toEqual([
        "stale",
        "stale",
      ]);
      expect(tableJson(db), `stale-close observation: ${observation}`).toBe(
        rowBefore,
      );
      expect(
        listEnvironmentRetentionTransitions(db, id),
        `stale-close observation: ${observation}`,
      ).toEqual(transitionsBefore);
    });

    it("leaves a closed row with a version past the one the close was made at, and a reopened row past that", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_AT);
      const db = createMigratedConnection();
      const id = retained(db);
      const versionRead = versionOf(db, id) ?? -1;
      closeEnvironmentRetention(db, {
        id,
        proof: "absent",
        expectedUpdatedAt: versionRead,
      });
      const closedVersion = versionOf(db, id) ?? -1;
      recordEnvironmentRetention(db, { ...base, state: "retained" });
      const reopenedVersion = versionOf(db, id) ?? -1;

      expect(closedVersion).toBeGreaterThan(versionRead);
      expect(reopenedVersion).toBeGreaterThan(closedVersion);
    });

    it("answers not_open to a close of an intent that was deleted", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_AT);
      const db = createMigratedConnection();
      const id = recordEnvironmentRetention(db, {
        ...base,
        state: "intent",
      }).id;
      const versionRead = db
        .select()
        .from(environmentRetentions)
        .get()?.updatedAt;
      deleteEnvironmentRetentionIntents(db, "env_a");
      const transitions = listEnvironmentRetentionTransitions(db, id);

      expect(
        closeEnvironmentRetention(db, {
          id,
          proof: "stale",
          expectedUpdatedAt: versionRead ?? -1,
        }),
      ).toBe("not_open");
      expect(listEnvironmentRetentionTransitions(db, id)).toEqual(transitions);
    });
  });
});
