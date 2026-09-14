import { describe, expect, it } from "vitest";
import { describeQueueWait } from "./actions.js";

describe("describeQueueWait", () => {
  it("says a row failed rather than reading its wait back", () => {
    expect(
      describeQueueWait({
        failureReason: "The message could not be sent.",
        sendAt: null,
        waitingOn: { kind: "turn-starting" },
      }),
    ).toBe("failed: The message could not be sent.");
  });

  it("still names the wait on a row that has not failed", () => {
    expect(
      describeQueueWait({
        failureReason: null,
        sendAt: null,
        waitingOn: { kind: "host-offline", hostName: "M4" },
      }),
    ).toBe("waiting for M4 to reconnect");
    expect(describeQueueWait({ sendAt: null, waitingOn: null })).toBe(
      "waiting for the current turn to finish",
    );
  });
});
