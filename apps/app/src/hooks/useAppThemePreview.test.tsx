// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultResolvedCodeTheme, type AppTheme } from "@bb/domain";
import { applyAppThemeCss, clearAppThemePreview } from "@/lib/app-theme-css";
import { useAppThemePreview } from "./useAppThemePreview";

const mocks = vi.hoisted(() => ({
  resolveTheme: vi.fn(),
  resolveThemeCss: vi.fn(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { theme: { resolve: mocks.resolveTheme } },
}));

vi.mock("@/lib/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/themes")>()),
  resolveAppThemeCss: mocks.resolveThemeCss,
}));

const COMMITTED = ":root { --canvas: white; }";

function customTheme(themeId: string, customCss: string | null): AppTheme {
  return {
    themeId,
    customCss,
    faviconColor: "default",
    resolvedCodeTheme: defaultResolvedCodeTheme,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function styleText(): string | null {
  return document.getElementById("bb-app-theme")?.textContent ?? null;
}

function renderPreviewHook() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useAppThemePreview(), { wrapper });
}

beforeEach(() => {
  mocks.resolveThemeCss.mockImplementation((theme: AppTheme) =>
    Promise.resolve(theme.customCss ?? ""),
  );
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanup();
  clearAppThemePreview();
  applyAppThemeCss("");
  mocks.resolveTheme.mockReset();
  mocks.resolveThemeCss.mockReset();
});

describe("useAppThemePreview", () => {
  it("previews a resolved theme and restores the committed one on clear", async () => {
    applyAppThemeCss(COMMITTED);
    mocks.resolveTheme.mockResolvedValue(customTheme("mine", ".mine {}"));
    const { result } = renderPreviewHook();

    act(() => result.current.previewTheme("mine"));
    await flush();
    expect(styleText()).toBe(".mine {}");
    expect(mocks.resolveTheme).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: "mine" }),
    );

    act(() => result.current.previewTheme(null));
    expect(styleText()).toBe(COMMITTED);
  });

  it("ignores a resolution that lands after the pointer left", async () => {
    applyAppThemeCss(COMMITTED);
    const slow = deferred<AppTheme>();
    mocks.resolveTheme.mockReturnValue(slow.promise);
    const { result } = renderPreviewHook();

    act(() => result.current.previewTheme("slow"));
    act(() => result.current.previewTheme(null));
    slow.resolve(customTheme("slow", ".slow {}"));
    await flush();

    expect(styleText()).toBe(COMMITTED);
  });

  it("keeps the latest hovered theme when an earlier fetch resolves late", async () => {
    applyAppThemeCss(COMMITTED);
    const first = deferred<AppTheme>();
    const second = deferred<AppTheme>();
    mocks.resolveTheme
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderPreviewHook();

    act(() => result.current.previewTheme("first"));
    act(() => result.current.previewTheme("second"));
    second.resolve(customTheme("second", ".second {}"));
    await flush();
    first.resolve(customTheme("first", ".first {}"));
    await flush();

    expect(styleText()).toBe(".second {}");
  });

  it("serves repeat hovers from the query cache and retries after a failure", async () => {
    applyAppThemeCss(COMMITTED);
    mocks.resolveTheme
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(customTheme("mine", ".mine {}"));
    const { result } = renderPreviewHook();

    act(() => result.current.previewTheme("mine"));
    await flush();
    expect(styleText()).toBe(COMMITTED);

    act(() => result.current.previewTheme("mine"));
    await flush();
    expect(styleText()).toBe(".mine {}");

    act(() => result.current.previewTheme(null));
    act(() => result.current.previewTheme("mine"));
    await flush();
    expect(mocks.resolveTheme).toHaveBeenCalledTimes(2);
    expect(styleText()).toBe(".mine {}");
  });

  it("prefetches palettes so the first hover applies from the query cache", async () => {
    applyAppThemeCss(COMMITTED);
    mocks.resolveTheme.mockImplementation(({ themeId }: { themeId: string }) =>
      Promise.resolve(customTheme(themeId, `.${themeId} {}`)),
    );
    const { result } = renderPreviewHook();

    act(() => result.current.prefetchThemes(["one", "two"]));
    await flush();
    expect(mocks.resolveTheme).toHaveBeenCalledTimes(2);

    act(() => result.current.previewTheme("two"));
    await flush();
    expect(styleText()).toBe(".two {}");
    expect(mocks.resolveTheme).toHaveBeenCalledTimes(2);
  });

  it("clears the preview when the owner unmounts", async () => {
    applyAppThemeCss(COMMITTED);
    mocks.resolveTheme.mockResolvedValue(customTheme("mine", ".mine {}"));
    const { result, unmount } = renderPreviewHook();

    act(() => result.current.previewTheme("mine"));
    await flush();
    expect(styleText()).toBe(".mine {}");

    unmount();
    expect(styleText()).toBe(COMMITTED);
  });

  it("ignores a theme stylesheet that resolves after the preview is cleared", async () => {
    applyAppThemeCss(COMMITTED);
    const css = deferred<string>();
    mocks.resolveTheme.mockResolvedValue(customTheme("conductor", null));
    mocks.resolveThemeCss.mockReturnValueOnce(css.promise);
    const { result } = renderPreviewHook();

    act(() => result.current.previewTheme("conductor"));
    await flush();
    expect(mocks.resolveThemeCss).toHaveBeenCalledOnce();

    act(() => result.current.previewTheme(null));
    css.resolve(".conductor {}");
    await flush();

    expect(styleText()).toBe(COMMITTED);
  });
});
