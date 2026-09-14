import { describe, expect, it } from "vitest";
import {
  getWorkspaceWriteClaim,
  heartbeatWorkspaceWriteClaims,
  listWorkspaceWriteClaimThreadIds,
  releaseWorkspaceWriteClaims,
  tryClaimWorkspaceWrite,
} from "../../src/data/fork-workspace-write-claims.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const target = { hostId: "host-1", workspacePath: "/tmp/shared" };

describe("fork workspace write claims", () => {
  it("admits one thread and reports the holder to the next thread", () => {
    const db = createMigratedConnection();
    expect(
      tryClaimWorkspaceWrite(db, {
        ...target,
        threadId: "thread-1",
        ownerToken: "owner-1",
        now: 100,
      }),
    ).toEqual({ acquired: true });
    expect(
      tryClaimWorkspaceWrite(db, {
        ...target,
        threadId: "thread-2",
        ownerToken: "owner-2",
        now: 101,
      }),
    ).toEqual({ acquired: false, holderThreadId: "thread-1" });
    expect(
      tryClaimWorkspaceWrite(db, {
        hostId: "host-1",
        workspacePath: "/tmp/other",
        threadId: "thread-2",
        ownerToken: "owner-2",
        now: 101,
      }),
    ).toEqual({ acquired: true });
  });

  it("releases a finished holder and admits the queued thread", () => {
    const db = createMigratedConnection();
    tryClaimWorkspaceWrite(db, {
      ...target,
      threadId: "thread-1",
      ownerToken: "owner-1",
      now: 100,
    });
    releaseWorkspaceWriteClaims(db, {
      threadId: "thread-1",
      ownerToken: "owner-1",
    });
    expect(
      tryClaimWorkspaceWrite(db, {
        ...target,
        threadId: "thread-2",
        ownerToken: "owner-2",
        now: 101,
      }),
    ).toEqual({ acquired: true });
  });

  it("releases a holder when the lifecycle transaction commits", () => {
    const db = createMigratedConnection();
    tryClaimWorkspaceWrite(db, {
      ...target,
      threadId: "thread-1",
      ownerToken: "owner-1",
      now: 100,
    });
    db.transaction((tx) => {
      releaseWorkspaceWriteClaims(tx, {
        threadId: "thread-1",
        ownerToken: "owner-1",
      });
    });
    expect(
      tryClaimWorkspaceWrite(db, {
        ...target,
        threadId: "thread-2",
        ownerToken: "owner-2",
        now: 101,
      }),
    ).toEqual({ acquired: true });
  });

  it("creates the claim table when a transaction releases before any claim", () => {
    const db = createMigratedConnection();
    db.transaction((tx) => {
      releaseWorkspaceWriteClaims(tx, {
        threadId: "thread-1",
        ownerToken: "owner-1",
      });
    });
    expect(
      tryClaimWorkspaceWrite(db, {
        ...target,
        threadId: "thread-2",
        ownerToken: "owner-2",
        now: 101,
      }),
    ).toEqual({ acquired: true });
  });

  it("reclaims a dead holder after the bounded lease expires", () => {
    const db = createMigratedConnection();
    tryClaimWorkspaceWrite(db, {
      ...target,
      threadId: "thread-1",
      ownerToken: "dead-owner",
      now: 100,
    });
    expect(
      tryClaimWorkspaceWrite(db, {
        ...target,
        threadId: "thread-2",
        ownerToken: "owner-2",
        now: 90_101,
      }),
    ).toEqual({ acquired: true });
    expect(
      getWorkspaceWriteClaim(db, { ...target, now: 90_101 })?.threadId,
    ).toBe("thread-2");
  });

  it("does not heartbeat an idle holder and lets it expire", () => {
    const db = createMigratedConnection();
    tryClaimWorkspaceWrite(db, {
      ...target,
      threadId: "thread-1",
      ownerToken: "owner-1",
      now: 100,
    });
    expect(
      listWorkspaceWriteClaimThreadIds(db, { ownerToken: "owner-1" }),
    ).toEqual(["thread-1"]);
    heartbeatWorkspaceWriteClaims(db, {
      ownerToken: "owner-1",
      activeThreadIds: [],
      now: 50_000,
    });
    expect(
      getWorkspaceWriteClaim(db, { ...target, now: 50_000 }),
    ).toMatchObject({
      heartbeatAt: 100,
    });
    expect(
      tryClaimWorkspaceWrite(db, {
        ...target,
        threadId: "thread-2",
        ownerToken: "owner-2",
        now: 90_101,
      }),
    ).toEqual({ acquired: true });
  });

  it("heartbeats only an executing holder", () => {
    const db = createMigratedConnection();
    tryClaimWorkspaceWrite(db, {
      ...target,
      threadId: "thread-1",
      ownerToken: "owner-1",
      now: 100,
    });
    heartbeatWorkspaceWriteClaims(db, {
      ownerToken: "owner-1",
      activeThreadIds: ["thread-1"],
      now: 200,
    });
    expect(getWorkspaceWriteClaim(db, { ...target, now: 200 })).toMatchObject({
      heartbeatAt: 200,
    });
  });
});
