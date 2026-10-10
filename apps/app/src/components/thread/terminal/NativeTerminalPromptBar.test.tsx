// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";

const send = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { send } },
}));

function renderBar() {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  render(
    <Wrapper>
      <NativeTerminalPromptBar providerLabel="Native CLI" threadId="thr-n" />
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
});

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
});
