// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";

const send = vi.hoisted(() => vi.fn());
const media = vi.hoisted(() => ({
  request: vi.fn<() => Promise<MediaStream>>(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: { send },
    projects: { attachments: { upload: vi.fn() } },
    writingAssistance: {
      view: vi.fn().mockResolvedValue({
        settings: {
          mode: "prompt",
          typingCorrection: "off",
          dictationFormatting: true,
          vocabulary: [],
          dailyCorrectionLimit: 300,
          dailyDictationMinutes: 120,
        },
        usage: {
          day: "2026-10-18",
          corrections: 0,
          formattings: 0,
          dictationSegments: 0,
          audioSeconds: 0,
          inputChars: 0,
          outputChars: 0,
          estimatedCostMicros: 0,
        },
        correctionAvailable: true,
      }),
      correct: vi.fn(),
      transcribeDictationSegment: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: { voiceTranscriptionEnabled: true } }),
}));

vi.mock("@/lib/audio-input-device-preference", () => ({
  requestAudioInputStream: media.request,
  useAudioInputDevicePreferenceValue: () => null,
}));

vi.mock("@/hooks/voice-input-support", () => ({
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

vi.mock("@/lib/attachment-local-previews", () => ({
  registerLocalAttachmentPreview: vi.fn(),
}));

afterEach(cleanup);

describe("NativeTerminalPromptBar with a pending microphone permission", () => {
  it("sends the draft once when Send is pressed before the microphone is granted", async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    let grant: (value: MediaStream) => void = () => {};
    media.request.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
    );
    send.mockResolvedValue({});
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    render(
      <Wrapper>
        <NativeTerminalPromptBar
          projectId="proj-n"
          providerLabel="Native CLI"
          threadId="thr-n"
        />
      </Wrapper>,
    );
    const input = screen.getByLabelText(
      "Message Native CLI",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "deploy the fix" } });
    const mic = screen.getByRole("button", {
      name: "Dictate a message to Native CLI",
    });
    fireEvent.pointerDown(mic, { button: 0 });
    fireEvent.pointerUp(mic);
    fireEvent.click(mic, { detail: 1 });
    expect(media.request).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Send to Native CLI" }));
    await act(async () => {
      grant(stream);
      for (let flush = 0; flush < 3; flush += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thr-n",
      input: [{ type: "text", text: "deploy the fix" }],
    });
    await waitFor(() => expect(input.value).toBe(""));
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says Listening only once the microphone is recording", async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    let grant: (value: MediaStream) => void = () => {};
    media.request.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
    );
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    render(
      <Wrapper>
        <NativeTerminalPromptBar
          projectId="proj-n"
          providerLabel="Native CLI"
          threadId="thr-n"
        />
      </Wrapper>,
    );
    const input = screen.getByLabelText(
      "Message Native CLI",
    ) as HTMLTextAreaElement;
    const mic = screen.getByRole("button", {
      name: "Dictate a message to Native CLI",
    });
    fireEvent.pointerDown(mic, { button: 0 });
    fireEvent.pointerUp(mic);
    fireEvent.click(mic, { detail: 1 });
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(input.placeholder).toBe("Starting microphone…");

    await act(async () => {
      grant(stream);
      for (let flush = 0; flush < 3; flush += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });

    await waitFor(() => expect(input.placeholder).toBe("Listening…"));
  });
});
