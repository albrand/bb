import { describe, expect, it } from "vitest";
import {
  getWorkspaceWriteClaim,
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
});
