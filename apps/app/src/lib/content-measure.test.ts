// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTENT_MEASURE_CSS_VARIABLE,
  CONTENT_MEASURE_STORAGE_KEY,
  contentMeasureAtom,
  initializeContentMeasure,
  setContentMeasure,
} from "./content-measure";

const APP_SRC = resolve(__dirname, "..");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules" && entry !== "generated") out.push(...listSourceFiles(path));
      continue;
    }
    if (!/\.(tsx?|css)$/u.test(entry)) continue;
    if (/\.(test|stories)\./u.test(entry)) continue;
    out.push(path);
  }
  return out;
}

const MEASURE_SITES = [
  "components/ui/page-shell.tsx",
  "components/ui/page-shell-content-style.ts",
  "components/ui/route-loading-skeleton.tsx",
  "components/thread/embedded-chat/EmbeddedThreadChat.tsx",
  "views/RootComposeSecondaryContent.tsx",
  "views/RootComposeCompactHome.tsx",
];

describe("content measure", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.style.removeProperty(CONTENT_MEASURE_CSS_VARIABLE);
    getDefaultStore().set(contentMeasureAtom, "comfortable");
  });

  it("writes the chosen width to the document and remembers it", () => {
    setContentMeasure("wide");
    expect(
      document.documentElement.style.getPropertyValue(CONTENT_MEASURE_CSS_VARIABLE),
    ).toBe("960px");
    expect(window.localStorage.getItem(CONTENT_MEASURE_STORAGE_KEY)).toBe("wide");
    setContentMeasure("comfortable");
    expect(
      document.documentElement.style.getPropertyValue(CONTENT_MEASURE_CSS_VARIABLE),
    ).toBe("760px");
  });

  it("applies a remembered choice at boot and ignores a value it does not know", () => {
    window.localStorage.setItem(CONTENT_MEASURE_STORAGE_KEY, "wide");
    getDefaultStore().set(contentMeasureAtom, "wide");
    initializeContentMeasure();
    expect(
      document.documentElement.style.getPropertyValue(CONTENT_MEASURE_CSS_VARIABLE),
    ).toBe("960px");

    window.localStorage.setItem(CONTENT_MEASURE_STORAGE_KEY, "enormous");
    expect(createStore().get(contentMeasureAtom)).toBe("comfortable");
  });

  it("is the only place the column width is written down, anywhere under src", () => {
    for (const site of MEASURE_SITES) {
      const source = readFileSync(resolve(APP_SRC, site), "utf8");
      expect(source, site).toMatch(/content-measure/u);
    }
    const offenders = listSourceFiles(APP_SRC).filter(
      (path) =>
        !path.endsWith(join("lib", "content-measure.ts")) &&
        /760px/u.test(readFileSync(path, "utf8")),
    );
    expect(offenders.map((path) => path.slice(APP_SRC.length + 1))).toEqual([]);
  });

  it("re-applies a width chosen in another window when the stored value changes", () => {
    initializeContentMeasure();
    window.localStorage.setItem(CONTENT_MEASURE_STORAGE_KEY, "wide");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: CONTENT_MEASURE_STORAGE_KEY,
        newValue: "wide",
        storageArea: window.localStorage,
      }),
    );
    expect(getDefaultStore().get(contentMeasureAtom)).toBe("wide");
    expect(
      document.documentElement.style.getPropertyValue(CONTENT_MEASURE_CSS_VARIABLE),
    ).toBe("960px");
  });
});
