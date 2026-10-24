import { describe, expect, it } from "vitest";
import type { TerminalSession } from "@bb/server-contract";
import {
  getThreadTerminalLayoutSessions,
  omitSupersededDisconnectedSessions,
} from "./terminal-session-visibility";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";


function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "term-1",
    threadId: "thread-1",
    environmentId: "env-1",
    hostId: "host-1",
    title: "Terminal 1",
    initialCwd: "/tmp",
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
    ...overrides,
  };
}

describe("getThreadTerminalLayoutSessions", () => {
  it("accepts live terminals in the requested thread", () => {
    const terminal = session();
    expect(getThreadTerminalLayoutSessions([terminal], [terminal.id], "thread-1")).toEqual([terminal]);
  });

  it.each([
    ["another thread", session({ threadId: "thread-2" })],
    ["an exited session", session({ status: "exited", exitCode: 0 })],
  ])("rejects %s", (_case, terminal) => {
    expect(getThreadTerminalLayoutSessions([terminal], [terminal.id], "thread-1")).toBeNull();
  });
});


describe("omitSupersededDisconnectedSessions", () => {
  const disconnected = makeTerminalSession({
    id: "term_old",
    threadId: "thr_1",
    status: "exited",
    closeReason: "daemon-disconnect",
    createdAt: 1,
  });

  it("hides a daemon-disconnect record once a newer running terminal exists for the thread", () => {
    const current = makeTerminalSession({
      id: "term_new",
      threadId: "thr_1",
      status: "running",
      createdAt: 2,
    });
    expect(
      omitSupersededDisconnectedSessions([disconnected, current]).map(
        (session) => session.id,
      ),
    ).toEqual(["term_new"]);
  });

  it("keeps the record while nothing newer is running for that thread", () => {
    const otherThread = makeTerminalSession({
      id: "term_other",
      threadId: "thr_2",
      status: "running",
      createdAt: 2,
    });
    const alsoExited = makeTerminalSession({
      id: "term_exited",
      threadId: "thr_1",
      status: "exited",
      closeReason: "process-exit",
      createdAt: 3,
    });
    expect(
      omitSupersededDisconnectedSessions([
        disconnected,
        otherThread,
        alsoExited,
      ]).map((session) => session.id),
    ).toEqual(["term_old", "term_other", "term_exited"]);
  });

  it("keeps a process-exit record even when a newer terminal is running", () => {
    const exited = makeTerminalSession({
      id: "term_done",
      threadId: "thr_1",
      status: "exited",
      closeReason: "process-exit",
      createdAt: 1,
    });
    const current = makeTerminalSession({
      id: "term_new",
      threadId: "thr_1",
      status: "running",
      createdAt: 2,
    });
    expect(
      omitSupersededDisconnectedSessions([exited, current]).map(
        (session) => session.id,
      ),
    ).toEqual(["term_done", "term_new"]);
  });

  it("keeps the record when the running terminal on the thread is older", () => {
    const older = makeTerminalSession({
      id: "term_older",
      threadId: "thr_1",
      status: "running",
      createdAt: 0,
    });
    expect(
      omitSupersededDisconnectedSessions([older, disconnected]).map(
        (session) => session.id,
      ),
    ).toEqual(["term_older", "term_old"]);
  });

  it("keeps a daemon-disconnect record that carries a failing exit code", () => {
    const failed = makeTerminalSession({
      id: "term_failed",
      threadId: "thr_1",
      status: "exited",
      closeReason: "daemon-disconnect",
      exitCode: 2,
      createdAt: 1,
    });
    const current = makeTerminalSession({
      id: "term_new",
      threadId: "thr_1",
      status: "running",
      createdAt: 2,
    });
    expect(
      omitSupersededDisconnectedSessions([failed, current]).map(
        (session) => session.id,
      ),
    ).toEqual(["term_failed", "term_new"]);
  });

  it("keeps records that are not tied to a thread", () => {
    const detached = makeTerminalSession({
      id: "term_detached",
      threadId: null,
      status: "exited",
      closeReason: "daemon-disconnect",
      createdAt: 1,
    });
    const alsoDetached = makeTerminalSession({
      id: "term_running",
      threadId: null,
      status: "running",
      createdAt: 2,
    });
    expect(
      omitSupersededDisconnectedSessions([detached, alsoDetached]).map(
        (session) => session.id,
      ),
    ).toEqual(["term_detached", "term_running"]);
  });
});
