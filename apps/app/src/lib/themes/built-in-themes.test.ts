import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_THEME_IDS, builtInThemes } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { resolveAppThemeCss } from "./index";
import { defaultAppTheme } from "@bb/domain";

const VENDORED_FONT_FAMILIES: Record<string, string> = {
  "Inter Variable": "@fontsource-variable/inter",
  "Geist Variable": "@fontsource-variable/geist",
  "Geist Mono Variable": "@fontsource-variable/geist-mono",
};

function cssFor(themeId: string): string {
  return resolveAppThemeCss({ ...defaultAppTheme, themeId });
}

describe("built-in themes", () => {
  it("every registered id has a stylesheet and a menu entry", () => {
    for (const id of BUILTIN_THEME_IDS) {
      expect(typeof cssFor(id), id).toBe("string");
      expect(builtInThemes.some((theme) => theme.id === id), id).toBe(true);
    }
    expect(cssFor("conductor")).toContain("--canvas: #151110");
    expect(cssFor("conductor-black")).toContain("--canvas: #000000");
  });

  it("never reaches the network: no @import, no url(), no scheme in any stylesheet", () => {
    for (const id of BUILTIN_THEME_IDS) {
      const css = cssFor(id);
      expect(css, id).not.toMatch(/@import/u);
      expect(css, id).not.toMatch(/url\(/iu);
      expect(css, id).not.toMatch(/https?:\/\/(?!github\.com\/bottlebrushes)/u);
    }
  });

  it("names only font families the app bundles, and app.css imports each of them", () => {
    const appCss = readFileSync(resolve(__dirname, "../../app.css"), "utf8");
    for (const id of ["conductor", "conductor-black"]) {
      const quoted = [...cssFor(id).matchAll(/--font-(?:sans|mono):\s*([^;]+);/gu)]
        .flatMap((match) => [...match[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]))
        .filter((family) => family.includes("Variable"));
      expect(quoted.length, id).toBeGreaterThan(0);
      for (const family of quoted) {
        const pkg = VENDORED_FONT_FAMILIES[family];
        expect(pkg, `${id}: ${family} is not a vendored family`).toBeDefined();
        expect(appCss, `${family} must be imported in app.css`).toContain(`@import "${pkg}";`);
      }
    }
  });
});
