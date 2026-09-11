import { describe, expect, it } from "vitest";
import { describeQueueWait } from "./actions.js";

describe("describeQueueWait", () => {
  it("says a row failed rather than reading its wait back", () => {
    // `bb thread queue list` renders this string, and a row the drain gave up
    // on used to read as an ordinary healthy wait — the same sentence a
    // message that is about to go gets.
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
