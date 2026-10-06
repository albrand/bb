// @vitest-environment jsdom

import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerPopupHost } from "./ComposerPopupHost";

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => true,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps typing suggestions outside the scrollable composer and reachable after the keyboard shrinks the viewport", () => {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
  const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
  let anchorTop = 648;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.tagName === "FORM"
        ? new DOMRect(16, anchorTop, 358, 136)
        : new DOMRect();
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-promptbox-typeahead-menu") ? 128 : 0;
    },
  );
  const close = vi.fn();
  function Fixture() {
    const composerRef = useRef<HTMLFormElement>(null);
    const popupRef = useRef<HTMLDivElement>(null);
    return (
      <div style={{ overflowY: "auto", maxHeight: 144 }}>
        <form ref={composerRef}>
          <input aria-label="Prompt" autoFocus />
          <ComposerPopupHost
            open
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
      </div>
    );
  }
  render(<Fixture />);
  const suggestion = screen.getByRole("button", { name: "Example suggestion" });
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
  expect(menu.style.top).toBe("64px");
  expect(menu.style.getPropertyValue("--promptbox-typeahead-max-height")).toBe(
    "128px",
  );
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Prompt" }),
  );
  fireEvent.pointerDown(screen.getByRole("textbox", { name: "Prompt" }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.pointerDown(suggestion);
  expect(close).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(close).toHaveBeenCalledWith(false);
});
