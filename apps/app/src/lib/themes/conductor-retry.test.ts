import { afterEach, describe, expect, it, vi } from "vitest";

const themeImport = vi.hoisted(() => ({
  active: null as {
    themeId: string;
    css: string;
    attempts: number;
  } | null,
}));

vi.mock("./conductor", async (importOriginal) => {
  const original = await importOriginal<typeof import("./conductor")>();
  const active = themeImport.active;
  if (!active || active.themeId !== "conductor") return original;
  active.attempts += 1;
  if (active.attempts === 1) {
    throw new Error("Failed to fetch dynamically imported module");
  }
  return { ...original, conductorThemeCss: active.css };
});

vi.mock("./conductor-black", async (importOriginal) => {
  const original = await importOriginal<typeof import("./conductor-black")>();
  const active = themeImport.active;
  if (!active || active.themeId !== "conductor-black") return original;
  active.attempts += 1;
  if (active.attempts === 1) {
    throw new Error("Failed to fetch dynamically imported module");
  }
  return { ...original, conductorBlackThemeCss: active.css };
});

const conductorThemes = [
  {
    themeId: "conductor",
    css: ":root { --canvas: #151110; }",
  },
  {
    themeId: "conductor-black",
    css: ":root { --canvas: #000000; }",
  },
] as const;

afterEach(() => {
  themeImport.active = null;
  vi.doUnmock("../retryable-chunk-import");
  vi.resetModules();
});

describe("Conductor theme loading", () => {
  it.each(conductorThemes)(
    "applies $themeId after its chunk import rejects once",
    async ({ themeId, css }) => {
      const attempt = { themeId, css, attempts: 0 };
      themeImport.active = attempt;
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

      expect(attempt.attempts).toBe(2);
      expect(resolvedCss).toBe(css);
    },
  );
});
