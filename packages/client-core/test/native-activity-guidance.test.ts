import { describe, expect, it } from "vitest";
import {
  nativeActivityRecoveryGuidance,
  nativeActivityRecoveryText,
} from "../src/thread/native-activity-guidance.js";

describe("native activity recovery guidance", () => {
  it("names the host, the exit command and the reopen command", () => {
    expect(
      nativeActivityRecoveryText({ hostName: "Build box", threadId: "thr_1" }),
    ).toBe(
      "If this session started before bb was updated, update bb on Build box, save your work, type /exit in the terminal, then reopen with bb thread native thr_1. A pending question will need to be asked again.",
    );
  });

  it("falls back to this thread's machine when the host is unknown", () => {
    expect(
      nativeActivityRecoveryText({ hostName: null, threadId: "thr_1" }),
    ).toContain("update bb on this thread's machine, save your work");
  });

  it("marks exactly the two commands as commands", () => {
    expect(
      nativeActivityRecoveryGuidance({ hostName: null, threadId: "thr_9" })
        .filter((segment) => segment.kind === "command")
        .map((segment) => segment.text),
    ).toEqual(["/exit", "bb thread native thr_9"]);
  });
});
