import { afterEach, describe, expect, it, vi } from "vitest";

const conductorThemes = [
  {
    themeId: "conductor",
    cssExport: "conductorThemeCss",
    css: ":root { --canvas: #151110; }",
  },
  {
    themeId: "conductor-black",
    cssExport: "conductorBlackThemeCss",
    css: ":root { --canvas: #000000; }",
  },
] as const;

afterEach(() => {
  vi.doUnmock("./conductor");
  vi.doUnmock("./conductor-black");
  vi.resetModules();
});

describe("Conductor theme loading", () => {
  it.each(conductorThemes)(
    "applies $themeId after its chunk import rejects once",
    async ({ themeId, cssExport, css }) => {
      let attempts = 0;

      const loadConductorTheme = () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Failed to fetch dynamically imported module");
        }
        return { [cssExport]: css };
      };
      if (themeId === "conductor") {
        vi.doMock("./conductor", loadConductorTheme);
      } else {
        vi.doMock("./conductor-black", loadConductorTheme);
      }
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
      const resolvedCss = await resolveAppThemeCss({
        themeId,
        customCss: null,
      });

      expect(resolvedCss).toBe(css);
      expect(attempts).toBe(2);
    },
  );
});
