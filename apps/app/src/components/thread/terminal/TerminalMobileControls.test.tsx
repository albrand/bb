// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMobileControls } from "./TerminalMobileControls";

afterEach(cleanup);

function renderControls() {
  const onInput = vi.fn();
  render(
    <TerminalMobileControls
      controlActive={false}
      disabled={false}
      onArrow={vi.fn()}
      onControlChange={vi.fn()}
      onInput={onInput}
      onKeyboardToggle={vi.fn()}
      onPaste={vi.fn()}
    />,
  );
  return onInput;
}

describe("TerminalMobileControls", () => {
  it("hides the extra keys until the user expands them", () => {
    renderControls();
    expect(screen.queryByRole("button", { name: "Shift Tab" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));

    expect(screen.getByRole("button", { name: "Shift Tab" })).toBeTruthy();
  });

  it.each([
    ["Shift Tab", "\x1b[Z"],
    ["Interrupt (Control C)", "\x03"],
    ["End of input (Control D)", "\x04"],
    ["Page up", "\x1b[5~"],
    ["Page down", "\x1b[6~"],
    ["Home", "\x1b[H"],
    ["End", "\x1b[F"],
  ])("sends the %s sequence a TUI expects", (label, sequence) => {
    const onInput = renderControls();
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith(sequence);
  });
});
