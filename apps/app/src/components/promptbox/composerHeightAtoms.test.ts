import { describe, expect, it } from "vitest";
import {
  clampComposerEditorHeight,
  getComposerEditorMaxHeightPx,
  resolveComposerEditorMinHeightCss,
} from "./composerHeightAtoms";

describe("resolveComposerEditorMinHeightCss", () => {
  it("keeps the caller's floor when nothing is remembered or the memory is below it", () => {
    expect(
      resolveComposerEditorMinHeightCss({ floorPx: 68, userHeightPx: null, layout: "thread" }),
    ).toBe("68px");
    expect(
      resolveComposerEditorMinHeightCss({ floorPx: 96, userHeightPx: 80, layout: "thread" }),
    ).toBe("96px");
  });

  it("caps a remembered height by the layout's viewport ceiling in CSS, so a resize needs no JS", () => {
    expect(
      resolveComposerEditorMinHeightCss({ floorPx: 68, userHeightPx: 320.4, layout: "thread" }),
    ).toBe("max(68px, min(320px, calc(50dvh - 3rem)))");
    expect(
      resolveComposerEditorMinHeightCss({
        floorPx: 80,
        userHeightPx: 500,
        layout: "root-compose",
      }),
    ).toBe("max(80px, min(500px, calc(70dvh - 3rem)))");
  });
});

describe("clampComposerEditorHeight", () => {
  it("holds a drag between the floor and the same ceiling the CSS applies", () => {
    expect(getComposerEditorMaxHeightPx("thread", 713)).toBe(308);
    const clamp = (heightPx: number) =>
      clampComposerEditorHeight({ heightPx, floorPx: 68, layout: "thread", viewportHeightPx: 713 });
    expect(clamp(10)).toBe(68);
    expect(clamp(200.6)).toBe(201);
    expect(clamp(900)).toBe(308);
  });

  it("never clamps below the floor on a window shorter than the floor allows", () => {
    expect(
      clampComposerEditorHeight({ heightPx: 300, floorPx: 68, layout: "thread", viewportHeightPx: 100 }),
    ).toBe(68);
  });
});
