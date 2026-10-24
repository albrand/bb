import { BbHttpError } from "@bb/sdk/browser";
import { describe, expect, it } from "vitest";
import {
  DICTATION_HARD_MAX_SEGMENT_MS,
  DICTATION_PAUSE_MS,
  DICTATION_TICK_MS,
  DictationSession,
  DictationTranscribeError,
  type DictationEnvironment,
  type DictationSegment,
  type DictationSnapshot,
} from "./dictation-session";

interface Deferred {
  segment: DictationSegment;
  resolve(text: string): void;
  reject(error: unknown): void;
}

function harness(options: { vad?: boolean } = {}) {
  let now = 0;
  let level = 0;
  const intervals = new Map<number, () => void>();
  const timeouts: (() => void)[] = [];
  let nextId = 1;
  const recorders: { stopped: boolean; aborted: boolean }[] = [];
  const meterClosed = { value: false };
  const env: DictationEnvironment = {
    now: () => now,
    setInterval: (callback) => {
      const id = nextId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (callback) => {
      timeouts.push(callback);
      return nextId++;
    },
    createRecorder: () => {
      const state = { stopped: false, aborted: false };
      recorders.push(state);
      return {
        mimeType: "audio/webm",
        start() {},
        stop() {
          state.stopped = true;
          return Promise.resolve(new Blob(["audio"], { type: "audio/webm" }));
        },
        abort() {
          state.aborted = true;
        },
      };
    },
    createLevelMeter: () =>
      options.vad === false
        ? null
        : {
            read: () => level,
            close: () => {
              meterClosed.value = true;
            },
          },
  };
  const calls: Deferred[] = [];
  const texts: string[] = [];
  const snapshots: DictationSnapshot[] = [];
  const autoStops: string[] = [];
  const session = new DictationSession({
    env,
    transcribe: (segment) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ segment, resolve, reject });
      }),
    onText: (text) => texts.push(text),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAutoStop: (message) => autoStops.push(message),
  });
  const advance = (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += DICTATION_TICK_MS) {
      now += DICTATION_TICK_MS;
      for (const callback of intervals.values()) callback();
    }
  };
  const speak = (ms: number) => {
    level = 0.2;
    advance(ms);
    level = 0;
  };
  const tickAfter = (gapMs: number, nextLevel: number) => {
    level = nextLevel;
    now += gapMs;
    for (const callback of intervals.values()) callback();
    level = 0;
  };
  const flush = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };
  return {
    session,
    calls,
    texts,
    snapshots,
    autoStops,
    recorders,
    meterClosed,
    advance,
    speak,
    tickAfter,
    flush,
    runTimeouts: () => timeouts.splice(0).forEach((callback) => callback()),
    last: () => snapshots.at(-1),
  };
}

describe("DictationSession", () => {
  it("cuts a self-contained segment at a pause and keeps recording", async () => {
    const h = harness();
    h.session.start();
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.recorders).toHaveLength(2);
    expect(h.recorders[0]?.stopped).toBe(true);
    expect(h.calls[0]?.segment.file.type).toBe("audio/webm");
    expect(h.last()?.phase).toBe("recording");
  });

  it("never uploads silence", async () => {
    const h = harness();
    h.session.start();
    h.advance(DICTATION_HARD_MAX_SEGMENT_MS + 500);
    await h.flush();
    void h.session.stop();
    await h.flush();
    expect(h.calls).toHaveLength(0);
    expect(h.last()?.phase).toBe("done");
  });

  it("keeps speech that a busy main thread only sampled a few times", async () => {
    const h = harness();
    h.session.start();
    h.tickAfter(470, 0.2);
    h.tickAfter(470, 0.2);
    h.tickAfter(470, 0.2);
    h.tickAfter(470, 0);
    void h.session.stop();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.segment.durationMs).toBe(1_880);
  });

  it("credits speech by the time between samples, not by the number of samples", async () => {
    const h = harness();
    h.session.start();
    h.tickAfter(110, 0.2);
    h.tickAfter(110, 0.2);
    h.tickAfter(110, 0.2);
    void h.session.stop();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.segment.durationMs).toBe(330);
  });

  it("keeps a segment it could not sample densely even when every late sample was quiet", async () => {
    const h = harness();
    h.session.start();
    h.tickAfter(470, 0);
    h.tickAfter(470, 0);
    h.tickAfter(470, 0);
    h.tickAfter(470, 0);
    void h.session.stop();
    await h.flush();
    expect(h.calls).toHaveLength(1);
  });

  it("does not cut at a pause that fell between two late samples", async () => {
    const h = harness();
    h.session.start();
    h.speak(1_500);
    h.tickAfter(DICTATION_PAUSE_MS + 50, 0);
    await h.flush();
    expect(h.calls).toHaveLength(0);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    await h.flush();
    expect(h.calls).toHaveLength(1);
  });

  it("still drops a segment whose samples were all silent", async () => {
    const h = harness();
    h.session.start();
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    h.advance(2_000);
    void h.session.stop();
    await h.flush();
    expect(h.calls).toHaveLength(1);
  });

  it("delivers text in recording order even when replies arrive out of order", async () => {
    const h = harness();
    h.session.start();
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    await h.flush();
    expect(h.calls).toHaveLength(2);
    h.calls[1]?.resolve("second");
    await h.flush();
    expect(h.texts).toEqual([]);
    h.calls[0]?.resolve("first");
    await h.flush();
    expect(h.texts).toEqual(["first", "second"]);
  });

  it("finishes pending segments after stop and only then reports done", async () => {
    const h = harness();
    h.session.start();
    h.speak(2_000);
    void h.session.stop();
    await h.flush();
    expect(h.meterClosed.value).toBe(true);
    expect(h.last()?.phase).toBe("finalizing");
    expect(h.calls).toHaveLength(1);
    h.calls[0]?.resolve("hello");
    await h.flush();
    expect(h.texts).toEqual(["hello"]);
    expect(h.last()?.phase).toBe("done");
  });

  it("retries a failed segment once, then holds the line for retry or discard", async () => {
    const h = harness();
    h.session.start();
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    await h.flush();
    h.calls[0]?.reject(new Error("network down"));
    h.calls[1]?.resolve("after");
    await h.flush();
    h.runTimeouts();
    await h.flush();
    expect(h.calls).toHaveLength(3);
    h.calls[2]?.reject(new Error("network down"));
    await h.flush();
    expect(h.last()?.failure).toBe("network down");
    expect(h.texts).toEqual([]);
    h.session.retryFailed();
    await h.flush();
    h.calls[3]?.resolve("before");
    await h.flush();
    expect(h.texts).toEqual(["before", "after"]);
  });

  it.each([
    [502, "provider_rpc_error", "The voice service failed"],
    [504, "transcription_timeout", "Voice transcription timed out"],
  ])(
    "resends the same clip once when the server fails with %i after receiving it, then only on Retry",
    async (status, code, message) => {
      const h = harness();
      h.session.start();
      h.speak(1_500);
      h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
      await h.flush();
      const failure = () =>
        new BbHttpError({ body: null, code, message, status });
      h.calls[0]?.reject(failure());
      await h.flush();
      h.runTimeouts();
      await h.flush();
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]?.segment.file).toBe(h.calls[0]?.segment.file);
      h.calls[1]?.reject(failure());
      await h.flush();
      h.runTimeouts();
      await h.flush();
      expect(h.calls).toHaveLength(2);
      expect(h.last()?.failure).toBe(`HTTP ${status}: ${message}`);
      h.session.retryFailed();
      await h.flush();
      expect(h.calls).toHaveLength(3);
      expect(h.calls[2]?.segment.file).toBe(h.calls[0]?.segment.file);
    },
  );

  it("stops recording when the daily budget is exhausted", async () => {
    const h = harness();
    h.session.start();
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    await h.flush();
    h.calls[0]?.reject(
      new DictationTranscribeError("Daily dictation limit reached", "budget"),
    );
    await h.flush();
    expect(h.autoStops).toEqual(["Daily dictation limit reached"]);
    expect(h.last()?.phase).toBe("finalizing");
    expect(h.last()?.failure).toBe("Daily dictation limit reached");
    h.session.discardFailed();
    await h.flush();
    expect(h.last()?.phase).toBe("done");
  });

  it("cancel aborts in-flight uploads and drops their text", async () => {
    const h = harness();
    h.session.start();
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    await h.flush();
    const signal = h.calls[0]?.segment.signal;
    h.session.cancel();
    expect(signal?.aborted).toBe(true);
    expect(h.recorders.at(-1)?.aborted).toBe(true);
    h.calls[0]?.resolve("late");
    await h.flush();
    expect(h.texts).toEqual([]);
  });

  it("never resends a clip whose upload fails after dictation was cancelled", async () => {
    const h = harness();
    h.session.start();
    h.speak(1_500);
    h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    h.session.cancel();
    h.calls[0]?.reject(
      new BbHttpError({
        body: null,
        code: "provider_rpc_error",
        message: "failed",
        status: 502,
      }),
    );
    await h.flush();
    h.advance(10_000);
    await h.flush();
    h.session.retryFailed();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.texts).toEqual([]);
    expect(h.last()?.failure ?? null).toBeNull();
  });

  it("sends the whole recording when no level meter is available", async () => {
    const h = harness({ vad: false });
    h.session.start();
    h.advance(3_000);
    void h.session.stop();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.segment.durationMs).toBeGreaterThanOrEqual(3_000);
  });

  it("caps a segment at the hard maximum while the speaker never pauses", async () => {
    const h = harness();
    h.session.start();
    h.speak(DICTATION_HARD_MAX_SEGMENT_MS + 1_000);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.segment.durationMs).toBeLessThanOrEqual(
      DICTATION_HARD_MAX_SEGMENT_MS + DICTATION_TICK_MS,
    );
  });

  it("keeps at most two uploads in flight", async () => {
    const h = harness();
    h.session.start();
    for (let index = 0; index < 4; index += 1) {
      h.speak(1_500);
      h.advance(DICTATION_PAUSE_MS + DICTATION_TICK_MS);
    }
    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(h.last()?.pending).toBe(4);
    h.calls[0]?.resolve("a");
    await h.flush();
    expect(h.calls).toHaveLength(3);
  });
});
