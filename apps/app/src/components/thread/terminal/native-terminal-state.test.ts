import { describe, expect, it } from "vitest";
import type {
  NativeTerminalThread,
  TerminalSession,
} from "@bb/server-contract";
import {
  resolveNativeTerminalSession,
  resolveNativeTerminalState,
} from "./native-terminal-state";

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "term_native",
    threadId: "thr_native",
    environmentId: "env_native",
    hostId: "host_native",
    title: "Native CLI",
    initialCwd: "/work",
    cols: 120,
    rows: 36,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
    ...overrides,
  };
}

function view(terminal: TerminalSession | null): NativeTerminalThread {
  return {
    threadId: "thr_native",
    providerId: "native-provider",
    displayName: "Native CLI",
    nativeSessionId: "sess-1",
    terminal,
  };
}

describe("resolveNativeTerminalSession", () => {
  it("prefers the listed session over the cached view", () => {
    const listed = session({ rows: 40 });
    expect(
      resolveNativeTerminalSession({
        listedSessions: [listed],
        listUpdatedAt: 10,
        view: view(session()),
        viewUpdatedAt: 20,
      }),
    ).toBe(listed);
  });

  it("treats a running view as gone once a newer list drops its terminal", () => {
    const resolved = resolveNativeTerminalSession({
      listedSessions: [],
      listUpdatedAt: 20,
      view: view(session()),
      viewUpdatedAt: 10,
    });
    expect(resolved).toBeNull();
    expect(
      resolveNativeTerminalState({
        session: resolved,
        threadIsProvisioning: false,
      }),
    ).toEqual({ kind: "ended", exitCode: null });
  });

  it("trusts a view written after the list, such as a fresh open", () => {
    const opened = session({ id: "term_reopened" });
    expect(
      resolveNativeTerminalSession({
        listedSessions: [],
        listUpdatedAt: 10,
        view: view(opened),
        viewUpdatedAt: 20,
      }),
    ).toBe(opened);
  });

  it("keeps the exit code of an exited view even when the list dropped it", () => {
    const exited = session({ status: "exited", exitCode: 2 });
    const resolved = resolveNativeTerminalSession({
      listedSessions: [],
      listUpdatedAt: 20,
      view: view(exited),
      viewUpdatedAt: 10,
    });
    expect(
      resolveNativeTerminalState({
        session: resolved,
        threadIsProvisioning: false,
      }),
    ).toEqual({ kind: "ended", exitCode: 2 });
  });

  it("uses the view while the terminal list has not loaded", () => {
    const running = session();
    expect(
      resolveNativeTerminalSession({
        listedSessions: undefined,
        listUpdatedAt: 0,
        view: view(running),
        viewUpdatedAt: 10,
      }),
    ).toBe(running);
  });

  it("reports preparing while the thread provisions without a terminal", () => {
    expect(
      resolveNativeTerminalState({
        session: resolveNativeTerminalSession({
          listedSessions: [],
          listUpdatedAt: 10,
          view: view(null),
          viewUpdatedAt: 10,
        }),
        threadIsProvisioning: true,
      }),
    ).toEqual({ kind: "preparing" });
  });
});
