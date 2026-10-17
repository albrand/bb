// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSegmentedDictation } from "./useSegmentedDictation";

const media = vi.hoisted(() => ({
  request: vi.fn<() => Promise<MediaStream>>(),
}));

vi.mock("@/lib/audio-input-device-preference", () => ({
  requestAudioInputStream: media.request,
  useAudioInputDevicePreferenceValue: () => null,
}));

vi.mock("./voice-input-support", () => ({
  readVoiceSupportEnvironment: () => ({}),
  resolveVoiceSupport: () => ({ isSupported: true, reason: null }),
  voiceUnsupportedMessage: () => "unsupported",
}));

vi.mock("@/lib/dictation/browser-dictation-environment", () => ({
  createBrowserDictationEnvironment: () => ({}),
}));

vi.mock("@/lib/dictation/dictation-session", () => ({
  DictationTranscribeError: class extends Error {},
  DictationSession: class {
    start() {}
    stop() {
      return Promise.resolve();
    }
    cancel() {}
    retryFailed() {}
    discardFailed() {}
  },
}));

function fakeStream() {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function renderDictation() {
  return renderHook(() =>
    useSegmentedDictation({
      transcribe: async () => "",
      onText: () => {},
      onError: () => {},
    }),
  );
}

async function startRecording() {
  const { stream, track } = fakeStream();
  media.request.mockResolvedValue(stream);
  const hook = renderDictation();
  await act(async () => {
    await hook.result.current.start();
  });
  expect(hook.result.current.phase).toBe("recording");
  expect(track.stop).not.toHaveBeenCalled();
  return { hook, track };
}

beforeEach(() => {
  media.request.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useSegmentedDictation microphone release", () => {
  it("stops the microphone track when dictation stops", async () => {
    const { hook, track } = await startRecording();
    act(() => hook.result.current.stop());
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the microphone track when the page is hidden or unloaded", async () => {
    const hidden = await startRecording();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(hidden.track.stop).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    cleanup();

    const unloaded = await startRecording();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(unloaded.track.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the microphone track when the composer unmounts", async () => {
    const { hook, track } = await startRecording();
    hook.unmount();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("stops a stream granted after dictation was already stopped", async () => {
    const { stream, track } = fakeStream();
    let grant: (value: MediaStream) => void = () => {};
    media.request.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
    );
    const hook = renderDictation();
    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = hook.result.current.start();
    });
    act(() => hook.result.current.stop());
    await act(async () => {
      grant(stream);
      await started;
    });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(hook.result.current.phase).toBe("idle");
  });
});
