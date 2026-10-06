// @vitest-environment jsdom

import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerPopupHost } from "./ComposerPopupHost";

const viewport = vi.hoisted(() => ({ compact: true }));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewport.compact,
}));

vi.mock("@/lib/bb-desktop", () => ({
  readWindowFindTopOffset: () => 48,
}));

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

it.each([true, false])(
  "keeps typing suggestions reachable above app chrome after the keyboard shrinks the viewport (compact: %s)",
  (compact) => {
    viewport.compact = compact;
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    let anchorTop = 648;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const form = this.matches("form") ? this : this.querySelector("form");
        if (!form) return new DOMRect();
        const cappedHeight = Number.parseFloat(form.style.maxHeight);
        const toolbar = form.parentElement?.querySelector<HTMLElement>(
          "[data-fixture-toolbar]",
        );
        const toolbarHeight = toolbar?.style.display === "none" ? 0 : 44;
        const formHeight = Number.isFinite(cappedHeight) ? cappedHeight : 136;
        const top = Number.isFinite(cappedHeight)
          ? window.innerHeight - 16 - formHeight - toolbarHeight
          : anchorTop;
        return new DOMRect(
          16,
          top,
          358,
          formHeight + (this === form ? 0 : toolbarHeight),
        );
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-promptbox-typeahead-menu")
          ? Math.min(
              128,
              Number.parseFloat(
                this.style.getPropertyValue("--promptbox-typeahead-max-height"),
              ) || 128,
            )
          : 0;
      },
    );
    const close = vi.fn();
    function Fixture({ open = true }: { open?: boolean }) {
      const composerRef = useRef<HTMLFormElement>(null);
      const popupRef = useRef<HTMLDivElement>(null);
      return (
        <div
          data-promptbox-shell=""
          style={{ overflowY: "auto", maxHeight: 144 }}
        >
          <form ref={composerRef}>
            <input aria-label="Prompt" autoFocus />
            <ComposerPopupHost
              open={open}
              focusKey="suggestions"
              placement="top"
              label="Suggestions"
              interactive={false}
              popupKey={null}
              popupRef={popupRef}
              composerRef={composerRef}
              onClose={close}
            >
              <button type="button">Example suggestion</button>
            </ComposerPopupHost>
          </form>
          <button type="button" data-fixture-toolbar="">
            Composer tools
          </button>
        </div>
      );
    }
    const { rerender } = render(<Fixture />);
    const suggestion = screen.getByRole("button", {
      name: "Example suggestion",
    });
    const menu = suggestion.parentElement;
    if (!menu) throw new Error("Missing suggestions menu");
    expect(menu.closest("form")).toBeNull();
    expect(menu.style.top).toBe("512px");
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Prompt" }),
    );

    height.mockReturnValue(200);
    anchorTop = 56;
    fireEvent(window, new Event("resize"));
    expect(menu.style.top).toBe(compact ? "64px" : "56px");
    expect(
      menu.style.getPropertyValue("--promptbox-typeahead-max-height"),
    ).toBe(compact ? "56px" : "60px");
    const composer = screen
      .getByRole("textbox", { name: "Prompt" })
      .closest("form");
    if (!composer) throw new Error("Missing composer");
    const caret = document.createRange();
    caret.selectNodeContents(composer);
    caret.collapse(false);
    Object.defineProperty(caret, "getBoundingClientRect", {
      value: () =>
        new DOMRect(
          32,
          composer.getBoundingClientRect().bottom + 90 - composer.scrollTop,
          0,
          20,
        ),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    fireEvent(window, new Event("resize"));
    expect(caret.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      composer.getBoundingClientRect().bottom - 8,
    );
    expect(
      Number.parseFloat(menu.style.top) + menu.offsetHeight + 8,
    ).toBeLessThanOrEqual(composer.getBoundingClientRect().top);
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Prompt" }),
    );
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "Prompt" }));
    expect(close).not.toHaveBeenCalled();
    fireEvent.pointerDown(suggestion);
    expect(close).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(close).toHaveBeenCalledWith(false);
    rerender(<Fixture open={false} />);
    expect(composer.getBoundingClientRect().height).toBe(136);
    expect(screen.getByRole("button", { name: "Composer tools" })).toBeTruthy();
  },
);
