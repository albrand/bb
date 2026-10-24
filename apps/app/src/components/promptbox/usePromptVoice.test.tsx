// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeVoiceInput } from "@/lib/api";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import type { PromptBoxHandle } from "./ComposerBox";
import { usePromptVoice } from "./usePromptVoice";
import type { PromptDraftState } from "@bb/client-core";

vi.mock("@/lib/api", () => ({
  transcribeVoiceInput: vi.fn(),
}));

vi.mock("@/hooks/useVoiceInput", () => ({
  useVoiceInput: vi.fn(),
}));

const voiceInput = {
  state: "transcribing" as const,
  delivery: "insert" as const,
  microphoneWarning: null,
  isSupported: true,
  unsupportedReason: null,
  stream: null,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  failedRecordings: [],
  retry: vi.fn(),
  discard: vi.fn(),
  download: vi.fn(),
};

function createPromptBoxRef() {
  const deliverTranscript = vi.fn();
  const playCompletionTransition = vi.fn();
  return {
    promptBoxRef: {
      current: {
        focusEnd: vi.fn(),
        voice: {
          textBeforeCursor: vi.fn(() => null),
          deliverTranscript,
          playCompletionTransition,
        },
      } satisfies PromptBoxHandle,
    },
    deliverTranscript,
    playCompletionTransition,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("usePromptVoice", () => {
  it("returns the transcript without delivering it from the transcription callback", async () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...voiceInput,
      isRecording: false,
      isProcessing: true,
      isListening: false,
    });
    vi.mocked(transcribeVoiceInput).mockResolvedValue({ text: "Transcript" });

    const { promptBoxRef, deliverTranscript, playCompletionTransition } =
      createPromptBoxRef();

    renderHook(() => usePromptVoice(promptBoxRef, undefined, null));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    const transcription = options?.onTranscribe({
      file: new File([], "recording.webm", { type: "audio/webm" }),
    });

    await expect(transcription).resolves.toBe("Transcript");
    expect(playCompletionTransition).not.toHaveBeenCalled();
    expect(deliverTranscript).not.toHaveBeenCalled();
  });

  it("sends only a successful send transcript, never a cancelled or add-to-draft transcript", () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...voiceInput,
      state: "recording",
      isRecording: true,
      isProcessing: false,
      isListening: true,
    });
    const { promptBoxRef, deliverTranscript } = createPromptBoxRef();
    const { result } = renderHook(() => usePromptVoice(promptBoxRef, undefined, null));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    act(() => {
      result.current.send();
      result.current.send();
    });
    expect(voiceInput.stop).toHaveBeenCalledTimes(2);
    act(() => options?.onTranscript("first transcript", "send"));
    expect(deliverTranscript).toHaveBeenCalledExactlyOnceWith("first transcript", "send");
    act(() => {
      result.current.send();
      result.current.cancel();
      options?.onTranscript("cancelled transcript", "insert");
    });
    expect(deliverTranscript).toHaveBeenCalledTimes(2);
    expect(deliverTranscript).toHaveBeenLastCalledWith("cancelled transcript", "insert");
    act(() => {
      result.current.stop();
      options?.onTranscript("draft transcript", "insert");
    });
    expect(deliverTranscript).toHaveBeenLastCalledWith("draft transcript", "insert");
    expect(deliverTranscript).toHaveBeenCalledTimes(3);
  });

  it("does not carry send intent into another recording after transcription fails", () => {
    let state: "recording" | "error" = "recording";
    vi.mocked(useVoiceInput).mockImplementation(() => ({
      ...voiceInput,
      state,
      isRecording: state === "recording",
      isProcessing: false,
      isListening: state === "recording",
    }));
    const { promptBoxRef, deliverTranscript } = createPromptBoxRef();
    const { result, rerender } = renderHook(() => usePromptVoice(promptBoxRef, undefined, null));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    act(() => result.current.send());
    state = "error";
    rerender();
    state = "recording";
    rerender();
    act(() => options?.onTranscript("later transcript", "insert"));
    expect(deliverTranscript).toHaveBeenCalledExactlyOnceWith("later transcript", "insert");
  });

  it("does not submit into a replacement composer after navigating away", () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...voiceInput,
      state: "recording",
      isRecording: true,
      isProcessing: false,
      isListening: true,
    });
    const { promptBoxRef, deliverTranscript } = createPromptBoxRef();
    const { result, unmount } = renderHook(() => usePromptVoice(promptBoxRef, undefined, null));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    act(() => result.current.send());
    unmount();
    options?.onTranscript("late transcript", "send");
    expect(deliverTranscript).not.toHaveBeenCalled();
  });
  it.each(["send", "stop"] as const)(
    "preserves %s intent for the originating draft after navigating away",
    async (action) => {
      vi.mocked(useVoiceInput).mockReturnValue({
        ...voiceInput,
        state: "recording",
        isRecording: true,
        isProcessing: false,
        isListening: true,
      });
      const { promptBoxRef, deliverTranscript } = createPromptBoxRef();
      let draft: PromptDraftState = {
        text: "Existing",
        mentions: [],
        attachments: [],
      };
      const submit = vi.fn(async () => {
        expect(draft.text).toBe("Existing and later edits late transcript");
      });
      const origin = {
        getCurrent: () => draft,
        setDraft: (next: PromptDraftState) => {
          draft = next;
        },
        submit,
      };
      const { result, unmount } = renderHook(() =>
        usePromptVoice(promptBoxRef, origin, null),
      );
      const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
      act(() => result.current[action]());
      unmount();
      draft = { ...draft, text: "Existing and later edits" };
      await options?.onTranscript("late transcript", action === "send" ? "send" : "insert");
      expect(draft.text).toBe("Existing and later edits late transcript");
      expect(deliverTranscript).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(action === "send" ? 1 : 0);
    },
  );

  it("appends a completed transcript to the originating draft after unmount", () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...voiceInput,
      isRecording: false,
      isProcessing: true,
      isListening: false,
    });
    const promptBoxRef = { current: null };
    let draft: PromptDraftState = {
      text: "Existing",
      mentions: [],
      attachments: [],
    };
    const getCurrent = vi.fn(() => draft);
    const setDraft = vi.fn((next: PromptDraftState) => {
      draft = next;
    });
    renderHook(() => usePromptVoice(promptBoxRef, { getCurrent, setDraft }, null));
    const options = vi.mocked(useVoiceInput).mock.calls[0]?.[0];
    draft = { ...draft, text: "Existing and later edits" };
    options?.onTranscript("new words", "insert");
    expect(draft).toEqual({
      text: "Existing and later edits new words",
      mentions: [],
      attachments: [],
    });
  });
});
