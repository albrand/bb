import { describe, expect, it } from "vitest";
import {
  collectHostUtilityKeys,
  prunePluginUtilities,
  unscopedSelector,
  type RuleLike,
} from "./plugin-css-dedupe";

interface FakeRule extends RuleLike {
  cssRules?: FakeRule[] & { length: number };
}

function style(selectorText: string): FakeRule {
  return { selectorText };
}

function group(
  fields: { name?: string; conditionText?: string },
  children: FakeRule[],
): FakeRule {
  const rule: FakeRule = { ...fields, cssRules: children };
  rule.deleteRule = (index) => {
    children.splice(index, 1);
  };
  return rule;
}

function sheet(rules: FakeRule[]) {
  return {
    cssRules: rules,
    deleteRule(index: number) {
      rules.splice(index, 1);
    },
  };
}

const SCOPE =
  ':where([data-bb-plugin="side-chat"], [data-bb-plugin-root]:not([data-bb-plugin]))';

describe("prunePluginUtilities", () => {
  it("removes the plugin copies of utilities the host already ships, in the same conditional context", () => {
    const host = sheet([
      group({ name: "utilities" }, [
        style(".hidden"),
        style(".flex"),
        group({ conditionText: "(width >= 48rem)" }, [style(".md\\:flex")]),
      ]),
    ]);
    const plugin = sheet([
      group({ name: "theme" }, [style(":root")]),
      group({ name: "utilities" }, [
        style(`${SCOPE} .hidden, ${SCOPE}.hidden`),
        style(`${SCOPE} .only-in-plugin, ${SCOPE}.only-in-plugin`),
        group({ conditionText: "(width >= 48rem)" }, [
          style(`${SCOPE} .md\\:flex, ${SCOPE}.md\\:flex`),
          style(`${SCOPE} .md\\:grid, ${SCOPE}.md\\:grid`),
        ]),
        group({ conditionText: "(width >= 64rem)" }, [
          style(`${SCOPE} .hidden, ${SCOPE}.hidden`),
        ]),
      ]),
    ]);

    const removed = prunePluginUtilities(plugin, collectHostUtilityKeys([host]));

    expect(removed).toBe(2);
    const utilities = plugin.cssRules[1]!.cssRules!;
    expect(utilities.map((rule) => rule.selectorText ?? rule.conditionText)).toEqual([
      `${SCOPE} .only-in-plugin, ${SCOPE}.only-in-plugin`,
      "(width >= 48rem)",
      "(width >= 64rem)",
    ]);
    expect(utilities[1]!.cssRules!.map((rule) => rule.selectorText)).toEqual([
      `${SCOPE} .md\\:grid, ${SCOPE}.md\\:grid`,
    ]);
    expect(utilities[2]!.cssRules!.map((rule) => rule.selectorText)).toEqual([
      `${SCOPE} .hidden, ${SCOPE}.hidden`,
    ]);
  });

  it("never touches layers other than utilities", () => {
    const host = sheet([group({ name: "utilities" }, [style(".hidden")])]);
    const plugin = sheet([
      group({ name: "base" }, [style(`${SCOPE} .hidden`)]),
      group({ name: "utilities" }, [style(`${SCOPE} .hidden`)]),
    ]);
    prunePluginUtilities(plugin, collectHostUtilityKeys([host]));
    expect(plugin.cssRules[0]!.cssRules!).toHaveLength(1);
    expect(plugin.cssRules[1]!.cssRules!).toHaveLength(0);
  });
});

describe("unscopedSelector", () => {
  it("strips the scope arm and keeps the utility selector, escapes included", () => {
    expect(unscopedSelector(`${SCOPE} .md\\:flex, ${SCOPE}.md\\:flex`)).toBe(
      ".md\\:flex",
    );
    expect(unscopedSelector(`${SCOPE} .a:hover, ${SCOPE}.a:hover`)).toBe(
      ".a:hover",
    );
  });
});
