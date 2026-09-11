import { describe, expect, it } from "vitest";
import { BridgeLineAckTracker } from "./bridge-line-ack-tracker.js";

function createTracker() {
  const acks: number[] = [];
  const tracker = new BridgeLineAckTracker({
    workerId: "w1",
    onAckable: (through) => acks.push(through),
  });
  return { tracker, acks };
}

describe("BridgeLineAckTracker", () => {
  it("acknowledges a line only once every event it produced has been accepted", () => {
    const { tracker, acks } = createTracker();
    tracker.beginLine(1, null);
    const first = tracker.delivery();
    const second = tracker.delivery();
    tracker.endLine(false);
    tracker.beginLine(2, null);
    tracker.endLine(false);

    expect(first?.replayKey).toBe("w1:1:0");
    expect(second?.replayKey).toBe("w1:1:1");
    expect(acks).toEqual([]);
    second?.onSettled();
    expect(acks).toEqual([]);
    first?.onSettled();
    first?.onSettled();
    expect(acks).toEqual([2]);
  });

  it("acknowledges past an unanswered request line but keeps it for replay until the runtime answers it", () => {
    const { tracker, acks } = createTracker();
    tracker.beginLine(1, "req-7");
    tracker.endLine(false);
    tracker.beginLine(2, null);
    tracker.endLine(false);

    expect(acks).toEqual([1, 2]);
    expect(tracker.keptWseqs()).toEqual([1]);
    tracker.responded("req-7");
    expect(tracker.keptWseqs()).toEqual([]);
    expect(acks).toEqual([1, 2, 2]);
  });

  it("never acknowledges past output still held in the assembler, until it is flushed", () => {
    const { tracker, acks } = createTracker();
    tracker.beginLine(1, null);
    tracker.endLine(false);
    tracker.beginLine(2, null);
    tracker.endLine(true);
    tracker.beginLine(3, null);
    tracker.endLine(true);
    expect(acks).toEqual([1]);

    let flushed: ReturnType<BridgeLineAckTracker["delivery"]>;
    tracker.withLastLine(() => {
      flushed = tracker.delivery();
    });
    tracker.releasePendingOutput();
    expect(flushed?.replayKey).toBe("w1:3:0");
    expect(acks).toEqual([1]);
    flushed?.onSettled();
    expect(acks).toEqual([1, 3]);
  });

  it("resolves a settle wait once outstanding events are accepted, or at its timeout", async () => {
    const { tracker } = createTracker();
    tracker.beginLine(1, null);
    const delivery = tracker.delivery();
    tracker.endLine(false);
    let settled = false;
    const waiting = tracker.whenEventsSettled(10_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    delivery?.onSettled();
    await waiting;
    expect(settled).toBe(true);

    tracker.beginLine(2, null);
    tracker.delivery();
    tracker.endLine(false);
    const started = Date.now();
    await tracker.whenEventsSettled(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it("does not acknowledge a line whose held output a later line flushed, until that later line's events are accepted", () => {
    const { tracker, acks } = createTracker();
    tracker.beginLine(1, null);
    tracker.endLine(true);
    tracker.beginLine(2, null);
    const carriesLineOneText = tracker.delivery();
    tracker.endLine(false);

    expect(acks).toEqual([]);
    carriesLineOneText?.onSettled();
    expect(acks).toEqual([2]);
  });
});
