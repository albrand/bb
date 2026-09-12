// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStore, getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTENT_MEASURE_CSS_VARIABLE,
  CONTENT_MEASURE_STORAGE_KEY,
  contentMeasureAtom,
  initializeContentMeasure,
  setContentMeasure,
} from "./content-measure";

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

  it("is the only place the column width is written down", () => {
    for (const site of MEASURE_SITES) {
      const source = readFileSync(resolve(__dirname, "..", site), "utf8");
      expect(source, site).not.toMatch(/760px/u);
      expect(source, site).toMatch(/content-measure/u);
    }
  });
});
