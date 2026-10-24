// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistStrip, DictationStrip } from "./NativeComposerStatus";

afterEach(cleanup);

function renderStrips() {
  const handlers = {
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    onUndo: vi.fn(),
    onCancel: vi.fn(),
  };
  render(
    <>
      <DictationStrip
        phase="recording"
        startedAt={null}
        stream={null}
        pending={0}
        failure={null}
        onCancel={handlers.onCancel}
        onRetry={() => {}}
        onDiscard={() => {}}
      />
      <AssistStrip
        suggestions={[
          {
            id: 7,
            original: "are",
            replacement: "is",
            category: "grammar",
            explanation: null,
          },
        ]}
        recent={{ count: 1, summary: "are → is" }}
        refining={false}
        onAccept={handlers.onAccept}
        onDismiss={handlers.onDismiss}
        onUndo={handlers.onUndo}
      />
    </>,
  );
  return handlers;
}

describe("composer status buttons", () => {
  it.each([
    ["Undo", "onUndo"],
    ["Replace “are” with “is”", "onAccept"],
    ["Dismiss suggestion", "onDismiss"],
    ["Cancel dictation", "onCancel"],
  ] as const)(
    "%s keeps the composer focused through mousedown without cancelling the touch pointerdown that WebKit needs to fire click",
    (name, handler) => {
      const handlers = renderStrips();
      const button = screen.getByRole("button", { name });
      const pointerAllowed = fireEvent.pointerDown(button, {
        pointerType: "touch",
        button: 0,
      });
      const mouseAllowed = fireEvent.mouseDown(button, { button: 0 });
      fireEvent.click(button);
      expect(pointerAllowed).toBe(true);
      expect(mouseAllowed).toBe(false);
      expect(handlers[handler]).toHaveBeenCalledTimes(1);
    },
  );
});
