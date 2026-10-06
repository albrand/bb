import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./conductor");
  vi.resetModules();
});

describe("Conductor theme loading", () => {
  it("applies the theme after its chunk import rejects once", async () => {
    let attempts = 0;
    const conductorCss = ":root { --canvas: #151110; }";

    vi.doMock("./conductor", () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Failed to fetch dynamically imported module");
      }
      return { conductorThemeCss: conductorCss };
    });
    vi.doMock("../retryable-chunk-import", async (importOriginal) => {
      const retryable =
        await importOriginal<typeof import("../retryable-chunk-import")>();
      return {
        ...retryable,
        createRetryableChunkImport: <T>(load: () => Promise<T>) =>
          retryable.createRetryableChunkImport(() =>
            load().catch((error: unknown) => {
              if (error instanceof Error && error.cause instanceof Error) {
                throw error.cause;
              }
              throw error;
            }),
          ),
      };
    });

    const { resolveAppThemeCss } = await import("./index");
    const css = await resolveAppThemeCss({
      themeId: "conductor",
      customCss: null,
    });

    expect(css).toBe(conductorCss);
    expect(attempts).toBe(2);
  });
});
