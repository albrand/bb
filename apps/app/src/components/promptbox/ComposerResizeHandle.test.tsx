// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComposerResizeHandle } from "./ComposerResizeHandle";
import {
  COMPOSER_EDITOR_HEIGHT_STORAGE_KEY,
  composerEditorHeightAtom,
} from "./composerHeightAtoms";

const FLOOR_PX = 68;
const VIEWPORT_HEIGHT_PX = 713;

function Harness({ containerHeightPx }: { containerHeightPx: number }) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <ComposerResizeHandle
        scrollContainerRef={scrollContainerRef}
        layout="thread"
        floorPx={FLOOR_PX}
      />
      <div
        ref={(node) => {
          scrollContainerRef.current = node;
          if (node) {
            node.getBoundingClientRect = () =>
              ({ height: containerHeightPx }) as DOMRect;
          }
        }}
        data-testid="scroll"
      />
    </div>
  );
}

function renderHandle(containerHeightPx = FLOOR_PX) {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <Harness containerHeightPx={containerHeightPx} />
    </Provider>,
  );
  const handle = view.container.querySelector<HTMLDivElement>(
    "[data-promptbox-resize-handle]",
  );
  if (!handle) throw new Error("handle missing");
  return { ...view, handle, store };
}

describe("ComposerResizeHandle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: VIEWPORT_HEIGHT_PX,
    });
  });
  afterEach(cleanup);

  it("remembers a drag upward as the new editor height, clamped to the viewport ceiling", () => {
    const { handle, store } = renderHandle();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 380 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 380 });
    expect(store.get(composerEditorHeightAtom)).toBe(FLOOR_PX + 120);
    expect(window.localStorage.getItem(COMPOSER_EDITOR_HEIGHT_STORAGE_KEY)).toBe(
      String(FLOOR_PX + 120),
    );

    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientY: 500 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: -2000 });
    expect(store.get(composerEditorHeightAtom)).toBe(
      Math.floor(VIEWPORT_HEIGHT_PX * 0.5 - 48),
    );
  });

  it("previews the height on the editor while dragging and drops the preview on cancel", () => {
    const { handle, getByTestId, store } = renderHandle(200);
    const scroll = getByTestId("scroll");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 450 });
    expect(scroll.style.getPropertyValue("--bb-composer-preview-height")).toBe("250px");
    fireEvent.pointerCancel(handle, { pointerId: 1, clientY: 450 });
    expect(scroll.style.getPropertyValue("--bb-composer-preview-height")).toBe("");
    expect(store.get(composerEditorHeightAtom)).toBeNull();
  });

  it("drops the memory when dragged back to the floor or reset by double-click", () => {
    const { handle, store } = renderHandle(300);
    store.set(composerEditorHeightAtom, 300);
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 900 });
    expect(store.get(composerEditorHeightAtom)).toBeNull();

    store.set(composerEditorHeightAtom, 300);
    fireEvent.doubleClick(handle);
    expect(store.get(composerEditorHeightAtom)).toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem(COMPOSER_EDITOR_HEIGHT_STORAGE_KEY) ?? "null"),
    ).toBeNull();
  });

  it("steps the height from the keyboard", () => {
    const { handle, store } = renderHandle(100);
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(store.get(composerEditorHeightAtom)).toBe(124);
    expect(handle.getAttribute("aria-valuenow")).toBe("124");
  });
});
