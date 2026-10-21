import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTerminalLatencyDiagnostics,
  recordTerminalInputEnqueued,
  recordTerminalInputWebSocketSent,
  recordTerminalOutputReceived,
  recordTerminalOutputRendered,
} from "./terminal-latency-diagnostics.js";

describe("terminal latency diagnostics", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { innerWidth: 1300 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a fixed-size rolling sample and stores numeric measurements only", () => {
    for (let index = 0; index < 400; index += 1) {
      recordTerminalInputEnqueued("term-a", index + 1, index);
      recordTerminalInputWebSocketSent("term-a", index + 1, index + 1.25);
      recordTerminalOutputReceived("term-a", index + 2);
      recordTerminalOutputRendered("term-a", index + 2, index + 3);
    }

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.desktop.outputRenderMs.count).toBe(256);
    expect(snapshot.desktop.outputRenderMs.totalCount).toBe(400);
    expect(snapshot.desktop.outputRenderMs.p50Ms).toBe(1);
    expect(snapshot.desktop.outputRenderMs.p95Ms).toBe(1);
    expect(snapshot.desktop.inputToFirstOutputReceivedMs.count).toBe(256);
    expect(snapshot.desktop.inputFirstOutputReceivedToRenderMs.count).toBe(256);
    expect(snapshot.desktop.inputFirstOutputReceivedToRenderMs.p50Ms).toBe(1);
    expect(snapshot.desktop.inputToFirstOutputRenderMs.count).toBe(256);
    expect(snapshot.desktop.inputEventToEnqueueMs.count).toBe(256);
    expect(snapshot.desktop.inputEventToEnqueueMs.totalCount).toBe(400);
    expect(snapshot.desktop.inputEventToEnqueueMs.p50Ms).toBe(1);
    expect(snapshot.desktop.inputEnqueueToWebSocketSendMs.count).toBe(256);
    expect(snapshot.desktop.inputEnqueueToWebSocketSendMs.totalCount).toBe(400);
    expect(snapshot.desktop.inputEnqueueToWebSocketSendMs.p50Ms).toBe(0.25);
    expect(
      snapshot.desktop.inputWebSocketSendToFirstOutputReceivedMs.count,
    ).toBe(256);
    expect(
      snapshot.desktop.inputWebSocketSendToFirstOutputReceivedMs.totalCount,
    ).toBe(400);
    expect(
      snapshot.desktop.inputWebSocketSendToFirstOutputReceivedMs.p50Ms,
    ).toBe(0.75);
    const recordedValues = Object.values(snapshot.desktop).flatMap((metric) => [
      metric.count,
      metric.totalCount,
      metric.p50Ms,
      metric.p95Ms,
    ]);
    expect(
      recordedValues.every(
        (value) => typeof value === "number" || value === null,
      ),
    ).toBe(true);
    for (const formFactor of [snapshot.desktop, snapshot.phone]) {
      for (const metric of Object.values(formFactor)) {
        expect(Object.keys(metric)).toEqual([
          "count",
          "totalCount",
          "p50Ms",
          "p95Ms",
        ]);
        expect(
          Object.values(metric).every(
            (value) => typeof value === "number" || value === null,
          ),
        ).toBe(true);
      }
    }
  });

  it("keeps phone and desktop timing samples separate", () => {
    vi.stubGlobal("window", { innerWidth: 390 });
    recordTerminalOutputReceived("term-a", 5);
    recordTerminalOutputRendered("term-a", 5, 11);

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.phone.outputRenderMs.p50Ms).toBe(6);
    expect(snapshot.desktop.outputRenderMs.p50Ms).toBe(1);
  });

  it("attributes a coalesced first output to the first key and stores no terminal text", () => {
    vi.stubGlobal("window", { innerWidth: 390 });
    const keystroke = "private-keystroke-7f31";
    const output = "private-terminal-output-93ad";
    recordTerminalInputEnqueued("term-a", 100);
    recordTerminalInputEnqueued("term-a", 108);
    recordTerminalInputEnqueued("term-a", 116);
    recordTerminalInputWebSocketSent("term-a", 100, 101);
    recordTerminalInputWebSocketSent("term-a", 108, 109);
    recordTerminalInputWebSocketSent("term-a", 116, 117);
    recordTerminalOutputReceived("term-a", 130);
    recordTerminalOutputRendered("term-a", 130, 140);

    const serialized = JSON.stringify(getTerminalLatencyDiagnostics());
    expect(serialized).not.toContain(keystroke);
    expect(serialized).not.toContain(output);
    expect(
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputReceivedMs.p50Ms,
    ).toBe(30);
    expect(
      getTerminalLatencyDiagnostics().phone
        .inputWebSocketSendToFirstOutputReceivedMs.p50Ms,
    ).toBe(29);
    expect(
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputRenderMs.p50Ms,
    ).toBe(40);
    expect(
      getTerminalLatencyDiagnostics().phone.inputFirstOutputReceivedToRenderMs
        .p50Ms,
    ).toBe(10);
    expect(
      getTerminalLatencyDiagnostics().phone.inputToFirstOutputReceivedMs.count,
    ).toBe(1);
  });

  it("pairs output only with input sent by its receive time and keeps unsent input", () => {
    const before = getTerminalLatencyDiagnostics().desktop;
    recordTerminalInputEnqueued("term-before-send", 10_000);
    recordTerminalOutputReceived("term-before-send", 10_005);
    recordTerminalOutputRendered("term-before-send", 10_005, 10_008);

    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before.inputToFirstOutputReceivedMs.totalCount);
    recordTerminalInputWebSocketSent("term-before-send", 10_000, 10_020);
    recordTerminalOutputReceived("term-before-send", 10_025);

    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before.inputToFirstOutputReceivedMs.totalCount + 1);
  });

  it("does not pair output from another terminal with pending input", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount;
    recordTerminalInputEnqueued("term-cross-a", 20_000);
    recordTerminalInputWebSocketSent("term-cross-a", 20_000, 20_001);

    recordTerminalOutputReceived("term-cross-b", 20_005);
    recordTerminalOutputRendered("term-cross-b", 20_005, 20_008);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before);

    recordTerminalOutputReceived("term-cross-a", 20_010);
    recordTerminalOutputRendered("term-cross-a", 20_010, 20_013);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before + 1);
  });

  it("consumes every sent input coalesced into the first output frame", () => {
    const before =
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount;
    for (let index = 0; index < 127; index += 1) {
      const enqueuedAt = 40_000 + index * 100;
      recordTerminalInputEnqueued("term-coalesce-fill", enqueuedAt);
      recordTerminalInputWebSocketSent(
        "term-coalesce-fill",
        enqueuedAt,
        enqueuedAt + 1,
      );
      recordTerminalOutputReceived("term-coalesce-fill", enqueuedAt + 12);
    }
    for (let index = 0; index < 128; index += 1) {
      const enqueuedAt = 60_000 + index * 100;
      recordTerminalInputEnqueued("term-coalesce-fill", enqueuedAt);
      recordTerminalInputWebSocketSent(
        "term-coalesce-fill",
        enqueuedAt,
        enqueuedAt + 1,
      );
      recordTerminalOutputReceived("term-coalesce-fill", enqueuedAt + 20);
    }
    recordTerminalInputEnqueued("term-coalesced", 30_000);
    recordTerminalInputEnqueued("term-coalesced", 30_008);
    recordTerminalInputWebSocketSent("term-coalesced", 30_000, 30_001);
    recordTerminalInputWebSocketSent("term-coalesced", 30_008, 30_009);

    recordTerminalOutputReceived("term-coalesced", 30_020);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before + 256);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .p50Ms,
    ).toBe(20);

    recordTerminalOutputReceived("term-coalesced", 30_030);
    expect(
      getTerminalLatencyDiagnostics().desktop.inputToFirstOutputReceivedMs
        .totalCount,
    ).toBe(before + 256);
  });
});
