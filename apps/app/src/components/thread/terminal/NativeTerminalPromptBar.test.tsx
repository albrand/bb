// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializePromptDraftStorage } from "@bb/client-core";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";

const send = vi.hoisted(() => vi.fn());
const upload = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { send }, projects: { attachments: { upload } } },
}));

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

  it("clears the thread's saved composer draft after a native send succeeds", async () => {
    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId: "proj-n",
      threadId: "thr-n",
    });
    draft.setDraft({
      text: "saved composer draft",
      mentions: [],
      attachments: [],
    });
    expect(window.localStorage.getItem(draft.storageKey)).not.toBeNull();
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "native message" } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(draft.getCurrent().text).toBe(""));
    expect(window.localStorage.getItem(draft.storageKey)).toBeNull();
    expect(input.value).toBe("");
  });

  it("keeps a replacement thread draft written while a send is pending", async () => {
    let resolveSend: (() => void) | undefined;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId: "proj-n",
      threadId: "thr-n",
    });
    draft.setDraft({ text: "sent draft", mentions: [], attachments: [] });
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "sent draft" } });
    fireEvent.click(sendButton);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const replacementDraft = {
      text: "replacement draft",
      mentions: [],
      attachments: [],
    };
    const replacementStorageValue =
      serializePromptDraftStorage(replacementDraft);
    if (replacementStorageValue === null) {
      throw new Error("replacement draft should serialize");
    }
    window.localStorage.setItem(draft.storageKey, replacementStorageValue);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: draft.storageKey,
        newValue: replacementStorageValue,
      }),
    );
    resolveSend?.();

    await waitFor(() => expect(input.value).toBe(""));
    expect(draft.getCurrent().text).toBe("replacement draft");
  });

  it("keeps the saved draft when a native send fails", async () => {
    send.mockRejectedValue(new Error("offline"));
    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId: "proj-n",
      threadId: "thr-n",
    });
    draft.setDraft({ text: "retry this draft", mentions: [], attachments: [] });
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "retry this draft" } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sendButton).toHaveProperty("disabled", false));
    expect(draft.getCurrent().text).toBe("retry this draft");
    expect(input.value).toBe("retry this draft");
  });

  it("only clears the sent thread draft and preserves other thread and project drafts", async () => {
    const sentDraft = getPromptDraftAccessor({
      kind: "thread",
      projectId: "proj-n",
      threadId: "thr-n",
    });
    const otherThreadDraft = getPromptDraftAccessor({
      kind: "thread",
      projectId: "proj-n",
      threadId: "thr-other",
    });
    const otherProjectDraft = getPromptDraftAccessor({
      kind: "thread",
      projectId: "proj-other",
      threadId: "thr-n",
    });
    sentDraft.setDraft({ text: "sent draft", mentions: [], attachments: [] });
    otherThreadDraft.setDraft({ text: "thread B", mentions: [], attachments: [] });
    otherProjectDraft.setDraft({ text: "other project", mentions: [], attachments: [] });
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "sent draft" } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sentDraft.getCurrent().text).toBe(""));
    expect(otherThreadDraft.getCurrent().text).toBe("thread B");
    expect(otherProjectDraft.getCurrent().text).toBe("other project");
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
