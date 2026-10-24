// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WaveformVisualizer } from "./WaveformVisualizer";

const closedContext = () =>
  Promise.reject(new DOMException("Context is closed", "InvalidStateError"));

class ClosedAudioContext {
  state = "suspended";
  resume = closedContext;
  close = closedContext;
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
  createAnalyser() {
    return {
      fftSize: 0,
      disconnect: () => {},
      getByteTimeDomainData: (data: Uint8Array) => data.fill(128),
    };
  }
}

const noOpContext2d = new Proxy(
  {},
  { get: (_target, key) => (key === "canvas" ? undefined : () => {}) },
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WaveformVisualizer", () => {
  it("handles an audio context that rejects resume and close", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("AudioContext", ClosedAudioContext);
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      noOpContext2d as CanvasRenderingContext2D,
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const stop = vi.fn();
    const stream = {
      getAudioTracks: () => [{ clone: () => ({ stop }) }],
    } as unknown as MediaStream;
    try {
      const view = render(<WaveformVisualizer stream={stream} active />);
      frames.shift()?.(0);
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stop).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
