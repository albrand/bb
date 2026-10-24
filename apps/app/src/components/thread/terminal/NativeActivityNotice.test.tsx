// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeActivityNotice as NativeActivityNoticeState } from "@/hooks/useNativeActivityUnconfirmed";
import { NativeActivityNotice } from "./NativeActivityNotice";

const sdkCalls = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/sdk", () => ({
  sdk: new Proxy(
    {},
    {
      get: (_target, area: string) =>
        new Proxy(
          {},
          {
            get: (_areaTarget, method: string) => () => {
              sdkCalls.push(`${area}.${method}`);
              return Promise.resolve(null);
            },
          },
        ),
    },
  ),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({
    data: [
      { id: "host_1", name: "Build box" },
      { id: "host_2", name: "Other machine" },
    ],
  }),
}));

afterEach(() => {
  cleanup();
  sdkCalls.length = 0;
});

const NOW = 1_800_000_000_000;

function notice(
  overrides: Partial<NativeActivityNoticeState> = {},
): NativeActivityNoticeState {
  return {
    evidenceKind: "unknown",
    lastToolCallAt: null,
    now: NOW,
    unconfirmed: true,
    ...overrides,
  };
}

const GUIDANCE =
  "update bb on Build box, save your work, type /exit in the terminal, then reopen with bb thread native thr_n. A pending question will need to be asked again.";

describe("native activity notice in the thread header", () => {
  it("shows the host-aware guidance for an activity that was never reported", () => {
    render(
      <NativeActivityNotice
        pendingPromptCount={0}
        hostId="host_1"
        notice={notice()}
        threadId="thr_n"
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Activity not reported");
    expect(status.textContent).toContain(GUIDANCE);
    expect(
      [...status.querySelectorAll("code")].map((code) => code.textContent),
    ).toEqual(["/exit", "bb thread native thr_n"]);
  });

  it("shows the guidance next to tool-call evidence, which stays an unconfirmed notice", () => {
    render(
      <NativeActivityNotice
        pendingPromptCount={0}
        hostId="host_1"
        notice={notice({
          evidenceKind: "tool-call",
          lastToolCallAt: NOW - 120_000,
        })}
        threadId="thr_n"
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Agent tool call seen");
    expect(status.textContent).toContain("has not reported its state");
    expect(status.textContent).toContain(GUIDANCE);
    expect(screen.queryByText(/working/iu)).toBeNull();
  });

  it("shows nothing for confirmed activity", () => {
    const { container } = render(
      <NativeActivityNotice
        pendingPromptCount={0}
        hostId="host_1"
        notice={notice({ evidenceKind: "holder-report", unconfirmed: false })}
        threadId="thr_n"
      />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("falls back to this thread's machine for an unknown host", () => {
    render(
      <NativeActivityNotice
        pendingPromptCount={0}
        hostId="host_gone"
        notice={notice()}
        threadId="thr_n"
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "update bb on this thread's machine, save your work",
    );
  });

  it("falls back the same way when the thread has no host", () => {
    render(
      <NativeActivityNotice
        pendingPromptCount={0}
        hostId={null}
        notice={notice()}
        threadId="thr_n"
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "update bb on this thread's machine",
    );
  });

  it("renders no notice while a question is waiting, even when activity is unconfirmed", () => {
    const { container } = render(
      <NativeActivityNotice
        hostId="host_1"
        notice={notice()}
        pendingPromptCount={1}
        threadId="thr_n"
      />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers no action and calls no open, reopen, exit or input operation", () => {
    render(
      <NativeActivityNotice
        pendingPromptCount={0}
        hostId="host_1"
        notice={notice()}
        threadId="thr_n"
      />,
    );
    expect(
      screen.getByRole("status").querySelectorAll("button, a, input, textarea"),
    ).toHaveLength(0);
    expect(sdkCalls).toEqual([]);
  });
});
