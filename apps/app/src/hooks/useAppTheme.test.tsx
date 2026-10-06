// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppTheme, type AppTheme } from "@bb/domain";
import { applyAppThemeCss } from "@/lib/app-theme-css";
import { useAppTheme } from "./useAppTheme";

const mocks = vi.hoisted(() => ({
  appearance: null as AppTheme | null,
  resolveAppThemeCss: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data:
      mocks.appearance === null ? undefined : { appearance: mocks.appearance },
  }),
}));

vi.mock("@/hooks/useTheme", () => ({
  refreshThemeColorMeta: vi.fn(),
}));

vi.mock("@/lib/code-theme", () => ({
  applyResolvedCodeTheme: vi.fn(),
}));

vi.mock("@/lib/themes", () => ({
  resolveAppThemeCss: mocks.resolveAppThemeCss,
}));

function theme(themeId: string): AppTheme {
  return { ...defaultAppTheme, themeId };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function styleText(): string | null {
  return document.getElementById("bb-app-theme")?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  mocks.appearance = null;
  mocks.resolveAppThemeCss.mockReset();
  applyAppThemeCss("");
});

describe("useAppTheme", () => {
  it("does not apply an earlier theme after a newer configuration resolves", async () => {
    const earlier = deferred<string>();
    const latest = deferred<string>();
    mocks.appearance = theme("conductor");
    mocks.resolveAppThemeCss
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(latest.promise);
    const { rerender } = renderHook(() => useAppTheme());

    mocks.appearance = theme("conductor-black");
    rerender();

    await act(async () => {
      latest.resolve(".latest {}");
      await latest.promise;
    });
    expect(styleText()).toBe(".latest {}");

    await act(async () => {
      earlier.resolve(".earlier {}");
      await earlier.promise;
    });
    expect(styleText()).toBe(".latest {}");
  });
});
