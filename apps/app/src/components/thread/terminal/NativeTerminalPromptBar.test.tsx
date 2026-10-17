// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  WritingAssistanceView,
  WritingCorrectionResponse,
  WritingEdit,
} from "@bb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";

const send = vi.hoisted(() => vi.fn());
const upload = vi.hoisted(() => vi.fn());
const correct = vi.hoisted(() => vi.fn());
const writingView = vi.hoisted(() => vi.fn());
const dictationHook = vi.hoisted(() => ({
  options: null as null | {
    onText(text: string): void;
    onFinished?(): void;
  },
  phase: "idle" as "idle" | "recording" | "finalizing",
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: { send },
    projects: { attachments: { upload } },
    writingAssistance: {
      view: writingView,
      correct,
      transcribeDictationSegment: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: { voiceTranscriptionEnabled: true } }),
}));

vi.mock("@/hooks/useSegmentedDictation", () => ({
  useSegmentedDictation: (options: typeof dictationHook.options) => {
    dictationHook.options = options;
    return {
      phase: dictationHook.phase,
      pending: 0,
      failure: null,
      speaking: false,
      startedAt: null,
      stream: null,
      start: dictationHook.start,
      stop: dictationHook.stop,
      cancel: dictationHook.cancel,
      retry: vi.fn(),
      discardFailed: vi.fn(),
    };
  },
}));

function view(
  overrides: Partial<WritingAssistanceView["settings"]> = {},
): WritingAssistanceView {
  return {
    settings: {
      mode: "prompt",
      typingCorrection: "automatic",
      dictationFormatting: true,
      vocabulary: [],
      dailyCorrectionLimit: 300,
      dailyDictationMinutes: 120,
      ...overrides,
    },
    usage: {
      day: "2026-10-16",
      corrections: 0,
      formattings: 0,
      dictationSegments: 0,
      audioSeconds: 0,
      inputChars: 0,
      outputChars: 0,
      estimatedCostMicros: 0,
    },
    correctionAvailable: true,
  };
}

vi.mock("@/lib/attachment-local-previews", () => ({
  registerLocalAttachmentPreview: vi.fn(),
}));

function renderBar() {
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
  return {
    input: screen.getByLabelText("Message Native CLI") as HTMLTextAreaElement,
    sendButton: screen.getByRole("button", { name: "Send to Native CLI" }),
  };
}

beforeEach(() => {
  writingView.mockReset();
  writingView.mockResolvedValue(view({ typingCorrection: "off" }));
  correct.mockReset();
  dictationHook.options = null;
  dictationHook.phase = "idle";
  dictationHook.start.mockReset();
  dictationHook.stop.mockReset();
  dictationHook.cancel.mockReset();
  send.mockReset();
  send.mockResolvedValue({});
  upload.mockReset();
  upload.mockImplementation(({ clientFile }: { clientFile: File }) =>
    Promise.resolve({
      type: "localImage",
      sourceProjectId: "proj-n",
      path: `stored-${clientFile.name}`,
      name: clientFile.name,
      mimeType: clientFile.type,
      sizeBytes: clientFile.size,
    }),
  );
});

function pasteFiles(target: HTMLElement, files: File[]) {
  fireEvent.paste(target, { clipboardData: { files, getData: () => "" } });
}

afterEach(cleanup);

describe("NativeTerminalPromptBar", () => {
  it("sends the trimmed message on Enter and clears the field", async () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "  fix the build  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input.value).toBe(""));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      threadId: "thr-n",
      input: [{ type: "text", text: "fix the build", mentions: [] }],
      mode: "auto",
    });
  });

  it("keeps the composer focused when Send is pressed and sends on the click", async () => {
    const { input, sendButton } = renderBar();
    input.focus();
    fireEvent.change(input, { target: { value: "ship it" } });
    expect(fireEvent.mouseDown(sendButton)).toBe(false);
    expect(document.activeElement).toBe(input);
    fireEvent.click(sendButton);

    await waitFor(() => expect(input.value).toBe(""));
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });

  it("keeps Shift+Enter and IME composition as editing keys", () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(send).not.toHaveBeenCalled();
    expect(input.value).toBe("line one");
  });

  it("does not send blank input", () => {
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "   " } });

    expect(sendButton).toHaveProperty("disabled", true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the message when the send fails", async () => {
    send.mockRejectedValue(new Error("offline"));
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "retry me" } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sendButton).toHaveProperty("disabled", false));
    expect(send).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("retry me");
  });

  it("uploads a pasted image and sends it as an attachment with the text", async () => {
    const { input, sendButton } = renderBar();
    pasteFiles(input, [new File(["png"], "shot.png", { type: "image/png" })]);

    await screen.findByText("shot.png");
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-n" }),
    );
    fireEvent.change(input, { target: { value: "what is this?" } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      threadId: "thr-n",
      input: [
        {
          type: "localImage",
          path: "stored-shot.png",
          sourceProjectId: "proj-n",
        },
        { type: "text", text: "what is this?", mentions: [] },
      ],
      mode: "auto",
    });
    await waitFor(() => expect(screen.queryByText("shot.png")).toBeNull());
  });

  it("sends an image on its own and lets a pasted text through untouched", async () => {
    const { input, sendButton } = renderBar();
    pasteFiles(input, []);
    expect(upload).not.toHaveBeenCalled();
    expect(sendButton).toHaveProperty("disabled", true);

    const picker = screen.getByLabelText(
      "Attach images for Native CLI",
    ) as HTMLInputElement;
    fireEvent.change(picker, {
      target: {
        files: [new File(["jpg"], "photo.jpg", { type: "image/jpeg" })],
      },
    });
    await screen.findByText("photo.jpg");
    fireEvent.click(sendButton);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: [{ type: "localImage", path: "stored-photo.jpg" }],
    });
  });

  it("reports a failed upload and does not send while uploads are pending", async () => {
    let finishUpload: (() => void) | undefined;
    upload.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          finishUpload = () => reject(new Error("too big"));
        }),
    );
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "hold on" } });
    pasteFiles(input, [new File(["x"], "huge.png", { type: "image/png" })]);

    await screen.findByText("Attaching…");
    expect(sendButton).toHaveProperty("disabled", true);
    finishUpload?.();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Failed to attach huge.png",
    );
    expect(sendButton).toHaveProperty("disabled", false);
    expect(send).not.toHaveBeenCalled();
  });

  it("attaches an image delivered only through clipboard items", async () => {
    const { input } = renderBar();
    const image = new File(["webkit"], "image.png", { type: "image/png" });
    fireEvent.paste(input, {
      clipboardData: {
        files: [],
        items: [
          { kind: "string", type: "text/plain", getAsFile: () => null },
          { kind: "file", type: "image/png", getAsFile: () => image },
        ],
        getData: () => "",
      },
    });

    await screen.findByText("image.png");
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ clientFile: image, projectId: "proj-n" }),
    );
  });

  it("keeps an image and text added while a send is in flight", async () => {
    let resolveSend: (() => void) | undefined;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { input, sendButton } = renderBar();
    pasteFiles(input, [new File(["a"], "first.png", { type: "image/png" })]);
    await screen.findByText("first.png");
    fireEvent.change(input, { target: { value: "look at this" } });
    fireEvent.click(sendButton);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    pasteFiles(input, [new File(["b"], "second.png", { type: "image/png" })]);
    await screen.findByText("second.png");
    fireEvent.change(input, { target: { value: "and this one" } });
    resolveSend?.();

    await waitFor(() => expect(screen.queryByText("first.png")).toBeNull());
    expect(screen.getByText("second.png")).toBeTruthy();
    expect(input.value).toBe("and this one");
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: [
        { type: "localImage", path: "stored-first.png" },
        { type: "text", text: "look at this" },
      ],
    });
  });
});

function startDictation() {
  const mic = screen.getByRole("button", {
    name: "Dictate a message to Native CLI",
  });
  fireEvent.pointerDown(mic, { button: 0 });
  fireEvent.pointerUp(mic);
  fireEvent.click(mic, { detail: 1 });
  expect(dictationHook.start).toHaveBeenCalledTimes(1);
}

function deliver(text: string) {
  act(() => {
    dictationHook.options?.onText(text);
  });
}

function edit(overrides: Partial<WritingEdit>): WritingEdit {
  return {
    start: 0,
    end: 0,
    original: "",
    replacement: "",
    category: "grammar" as const,
    confidence: "high" as const,
    semanticImpact: "none" as const,
    explanation: null,
    disposition: "apply" as const,
    ...overrides,
  };
}

async function renderWithAssistance() {
  writingView.mockResolvedValue(view());
  const rendered = renderBar();
  await waitFor(() => expect(writingView).toHaveBeenCalled());
  await act(async () => {
    await writingView.mock.results[0]?.value;
    for (let flush = 0; flush < 3; flush += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  return rendered;
}

describe("NativeTerminalPromptBar push-to-talk", () => {
  function pressMic(at: number) {
    vi.spyOn(performance, "now").mockReturnValue(at);
    const mic = screen.getByRole("button", {
      name: "Dictate a message to Native CLI",
    });
    fireEvent.pointerDown(mic, { button: 0, pointerId: 7 });
  }

  function releaseAt(at: number, type: "pointerUp" | "pointerCancel") {
    vi.spyOn(performance, "now").mockReturnValue(at);
    fireEvent[type](document.body, { pointerId: 7 });
  }

  beforeEach(() => {
    dictationHook.start.mockClear();
    dictationHook.stop.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops a held recording when the pointer is released off the button", () => {
    renderBar();
    pressMic(1_000);
    expect(dictationHook.start).toHaveBeenCalledTimes(1);
    releaseAt(1_600, "pointerUp");
    expect(dictationHook.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the recording it started when the press is cancelled", () => {
    renderBar();
    pressMic(1_000);
    releaseAt(1_050, "pointerCancel");
    expect(dictationHook.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps a tapped recording running and stops listening after the tap", () => {
    renderBar();
    pressMic(1_000);
    releaseAt(1_100, "pointerUp");
    releaseAt(5_000, "pointerUp");
    releaseAt(5_100, "pointerCancel");
    expect(dictationHook.stop).not.toHaveBeenCalled();
  });

  function micButton() {
    return screen.getByRole("button", {
      name: "Dictate a message to Native CLI",
    });
  }

  it("still toggles from the keyboard after a cancelled press", () => {
    renderBar();
    pressMic(1_000);
    releaseAt(1_050, "pointerCancel");
    fireEvent.click(micButton(), { detail: 0 });
    expect(dictationHook.start).toHaveBeenCalledTimes(2);
  });

  it("still toggles from the keyboard and the mouse after releasing off the button", () => {
    renderBar();
    pressMic(1_000);
    releaseAt(1_100, "pointerUp");
    fireEvent.click(micButton(), { detail: 0 });
    expect(dictationHook.start).toHaveBeenCalledTimes(2);
    pressMic(5_000);
    releaseAt(5_100, "pointerUp");
    fireEvent.click(micButton(), { detail: 1 });
    expect(dictationHook.start).toHaveBeenCalledTimes(4);
  });

  it("does not toggle twice for one pointer press on the button", () => {
    renderBar();
    pressMic(1_000);
    vi.spyOn(performance, "now").mockReturnValue(1_100);
    fireEvent.pointerUp(micButton(), { pointerId: 7 });
    fireEvent.click(micButton(), { detail: 1 });
    expect(dictationHook.start).toHaveBeenCalledTimes(1);
    fireEvent.click(micButton(), { detail: 0 });
    expect(dictationHook.start).toHaveBeenCalledTimes(2);
  });

  it("toggles from the keyboard when a press on the button produced no click", () => {
    renderBar();
    pressMic(1_000);
    vi.spyOn(performance, "now").mockReturnValue(1_100);
    fireEvent.pointerUp(micButton(), { pointerId: 7 });
    fireEvent.click(micButton(), { detail: 0 });
    expect(dictationHook.start).toHaveBeenCalledTimes(2);
  });

  it("stops listening for the release when the composer unmounts", () => {
    renderBar();
    pressMic(1_000);
    cleanup();
    releaseAt(2_000, "pointerUp");
    expect(dictationHook.stop).not.toHaveBeenCalled();
  });
});

describe("NativeTerminalPromptBar dictation", () => {
  it("appends dictated phrases in order and keeps edits made while dictating", () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "Fix the login. " } });
    startDictation();
    deliver("Then add tests.");
    expect(input.value).toBe("Fix the login. Then add tests.");
    fireEvent.change(input, {
      target: { value: "Please fix the login. Then add tests." },
    });
    deliver("Finally deploy.");
    expect(input.value).toBe(
      "Please fix the login. Then add tests. Finally deploy.",
    );
  });

  it("inserts at the caret and spaces it from the following text", () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "existing words" } });
    input.focus();
    input.setSelectionRange(0, 0);
    startDictation();
    deliver("Hello.");
    expect(input.value).toBe("Hello. existing words");
    deliver("1. Check auth.");
    expect(input.value).toBe("Hello.\n1. Check auth. existing words");
  });

  it("puts a numbered list on its own line", () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "Plan:" } });
    startDictation();
    deliver("1. Check authentication.\n2. Verify refresh tokens.");
    expect(input.value).toBe(
      "Plan:\n1. Check authentication.\n2. Verify refresh tokens.",
    );
  });

  it("waits for the last phrase before sending when Send is pressed mid-dictation", async () => {
    dictationHook.phase = "recording";
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.click(sendButton);
    expect(dictationHook.stop).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    deliver("and the rest.");
    act(() => {
      dictationHook.options?.onFinished?.();
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: [{ type: "text", text: "draft and the rest." }],
    });
  });

  it("never sends dictation on its own", () => {
    const { input } = renderBar();
    startDictation();
    deliver("Delete the production database.");
    act(() => {
      dictationHook.options?.onFinished?.();
    });
    expect(input.value).toBe("Delete the production database.");
    expect(send).not.toHaveBeenCalled();
  });
});

describe(
  "NativeTerminalPromptBar typing assistance",
  { timeout: 20_000 },
  () => {
    it("applies a safe fix to a finished sentence and lets Undo restore it", async () => {
      correct.mockResolvedValue({
        status: "ok",
        edits: [
          edit({ start: 9, end: 12, original: "are", replacement: "is" }),
        ],
      });
      const { input } = await renderWithAssistance();
      fireEvent.change(input, { target: { value: "The user are here. " } });
      await waitFor(() => expect(input.value).toBe("The user is here. "), {
        timeout: 8_000,
      });
      expect(correct).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "The user are here.",
          context: "",
          complete: true,
        }),
      );
      expect(screen.getByText("Fixed 1 issue")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
      expect(input.value).toBe("The user are here. ");
    });

    it("keeps the caret where the user left it through a fix and its Undo", async () => {
      correct.mockImplementation(async (request: { target: string }) => ({
        status: "ok",
        edits:
          request.target === "The user are here."
            ? [edit({ start: 9, end: 12, original: "are", replacement: "is" })]
            : [],
      }));
      const { input } = await renderWithAssistance();
      const typed = "Check the logs now. The user are here. ";
      input.focus();
      fireEvent.change(input, { target: { value: typed } });
      input.setSelectionRange(4, 4);
      await waitFor(
        () =>
          expect(input.value).toBe("Check the logs now. The user is here. "),
        { timeout: 8_000 },
      );
      expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);
      fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
      expect(input.value).toBe(typed);
      expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);
    });

    it("moves the caret by the size of a fix made before it and back on Undo", async () => {
      correct.mockResolvedValue({
        status: "ok",
        edits: [
          edit({ start: 9, end: 12, original: "are", replacement: "is" }),
        ],
      });
      const { input } = await renderWithAssistance();
      const typed = "The user are here. ";
      input.focus();
      fireEvent.change(input, { target: { value: typed } });
      input.setSelectionRange(typed.length, typed.length);
      await waitFor(() => expect(input.value).toBe("The user is here. "), {
        timeout: 8_000,
      });
      expect(input.selectionStart).toBe(typed.length - 1);
      fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
      expect(input.value).toBe(typed);
      expect(input.selectionStart).toBe(typed.length);
    });

    it("does not send a corrected sentence back for another correction", async () => {
      correct.mockImplementation(async (request: { target: string }) => ({
        status: "ok",
        edits: request.target.includes("user are")
          ? [edit({ start: 9, end: 12, original: "are", replacement: "is" })]
          : [],
      }));
      const { input } = await renderWithAssistance();
      fireEvent.change(input, { target: { value: "The user are here. " } });
      await waitFor(() => expect(input.value).toBe("The user is here. "), {
        timeout: 8_000,
      });
      fireEvent.change(input, { target: { value: "The user is here. And" } });
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      const targets = correct.mock.calls.map((call) => call[0].target);
      expect(targets).toContain("The user are here.");
      expect(targets).not.toContain("The user is here.");
    });

    it("drops a correction when the user edited that sentence meanwhile", async () => {
      let resolve: ((value: WritingCorrectionResponse) => void) | undefined;
      correct.mockImplementation(
        () =>
          new Promise<WritingCorrectionResponse>((done) => {
            resolve = done;
          }),
      );
      const { input } = await renderWithAssistance();
      fireEvent.change(input, { target: { value: "The user are here. " } });
      await waitFor(() => expect(correct).toHaveBeenCalled(), {
        timeout: 8_000,
      });
      fireEvent.change(input, { target: { value: "The users are here. " } });
      await act(async () => {
        resolve?.({
          status: "ok",
          edits: [
            edit({ start: 9, end: 12, original: "are", replacement: "is" }),
          ],
        });
      });
      expect(input.value).toBe("The users are here. ");
      expect(screen.queryByText("Fixed 1 issue")).toBeNull();
    });

    it("offers meaning changes as suggestions the user can accept", async () => {
      correct.mockResolvedValue({
        status: "ok",
        edits: [
          edit({
            start: 19,
            end: 26,
            original: "talking",
            replacement: "token",
            category: "speech-recognition",
            semanticImpact: "possible",
            disposition: "suggest",
          }),
        ],
      });
      const { input } = await renderWithAssistance();
      const text = "The authentication talking expires. ";
      fireEvent.change(input, { target: { value: text } });
      const chip = await screen.findByRole(
        "button",
        { name: "Replace “talking” with “token”" },
        { timeout: 8_000 },
      );
      expect(input.value).toBe(text);
      fireEvent.click(chip);
      expect(input.value).toBe("The authentication token expires. ");
    });

    it("keeps typing and sending working while a correction is pending", async () => {
      correct.mockImplementation(() => new Promise(() => undefined));
      const { input } = await renderWithAssistance();
      fireEvent.change(input, { target: { value: "First sentence. " } });
      await waitFor(() => expect(correct).toHaveBeenCalled(), {
        timeout: 8_000,
      });
      fireEvent.change(input, { target: { value: "First sentence. Second" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        input: [{ type: "text", text: "First sentence. Second" }],
      });
    });

    it("does not ask for corrections when typing correction is off", async () => {
      writingView.mockResolvedValue(view({ typingCorrection: "off" }));
      const { input } = renderBar();
      await waitFor(() => expect(writingView).toHaveBeenCalled());
      fireEvent.change(input, { target: { value: "The user are here. " } });
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(correct).not.toHaveBeenCalled();
    });
  },
);
