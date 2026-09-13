export interface RuleLike {
  readonly selectorText?: string;
  readonly conditionText?: string;
  readonly name?: string;
  readonly cssRules?: RuleListLike;
  deleteRule?(index: number): void;
}

export interface RuleListLike {
  readonly length: number;
  [index: number]: RuleLike;
}

const SCOPE_OPEN = ":where(";

function stripScope(selector: string): string {
  if (!selector.startsWith(SCOPE_OPEN)) return selector;
  let depth = 0;
  for (let index = SCOPE_OPEN.length - 1; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return selector.slice(index + 1).trimStart();
    }
  }
  return selector;
}

function isUtilitiesLayer(rule: RuleLike): boolean {
  return rule.name === "utilities" && rule.cssRules !== undefined;
}

function isConditional(rule: RuleLike): boolean {
  return rule.selectorText === undefined && rule.cssRules !== undefined;
}

function contextKey(context: readonly string[]): string {
  return context.join(" > ");
}

export function utilityKey(context: readonly string[], selector: string): string {
  return `${contextKey(context)} | ${selector.trim()}`;
}

function collectSelectors(
  list: RuleListLike,
  context: readonly string[],
  into: Set<string>,
): void {
  for (let index = 0; index < list.length; index += 1) {
    const rule = list[index]!;
    if (rule.selectorText !== undefined) {
      for (const selector of splitSelectorList(rule.selectorText)) {
        into.add(utilityKey(context, selector));
      }
      continue;
    }
    if (rule.cssRules === undefined) continue;
    const condition = rule.conditionText ?? rule.name ?? "";
    collectSelectors(rule.cssRules, [...context, condition], into);
  }
}

export function collectHostUtilityKeys(
  sheets: Iterable<{ cssRules: RuleListLike }>,
): Set<string> {
  const keys = new Set<string>();
  for (const sheet of sheets) {
    const rules = sheet.cssRules;
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]!;
      if (isUtilitiesLayer(rule)) collectSelectors(rule.cssRules!, [], keys);
    }
  }
  return keys;
}

export function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selectorText.length; index += 1) {
    const char = selectorText[index];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(selectorText.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selectorText.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

export function unscopedSelector(selectorText: string): string {
  const first = splitSelectorList(selectorText)[0] ?? "";
  return stripScope(first).trim();
}

function pruneList(
  parent: RuleLike,
  context: readonly string[],
  hostKeys: ReadonlySet<string>,
): number {
  const list = parent.cssRules;
  if (list === undefined || parent.deleteRule === undefined) return 0;
  let removed = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const rule = list[index]!;
    if (rule.selectorText !== undefined) {
      const base = unscopedSelector(rule.selectorText);
      if (base !== "" && hostKeys.has(utilityKey(context, base))) {
        parent.deleteRule(index);
        removed += 1;
      }
      continue;
    }
    if (!isConditional(rule)) continue;
    const condition = rule.conditionText ?? rule.name ?? "";
    removed += pruneList(rule, [...context, condition], hostKeys);
  }
  return removed;
}

/**
 * Drop every plugin utility the host stylesheet already ships.
 *
 * A plugin stylesheet re-declares Tailwind utilities scoped to the plugin
 * root and loads after the host stylesheet. Same layer, same specificity,
 * later source: the plugin's `.hidden` beat the host's `.md:flex` on every
 * host component rendered inside a plugin, so responsive variants silently
 * stopped working there. Identical utilities carry identical declarations,
 * so removing the duplicate leaves the host's own cascade order intact and
 * keeps only the utilities the host never emitted.
 */
export function prunePluginUtilities(
  sheet: { cssRules: RuleListLike; deleteRule(index: number): void },
  hostKeys: ReadonlySet<string>,
): number {
  let removed = 0;
  const rules = sheet.cssRules;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    if (isUtilitiesLayer(rule)) removed += pruneList(rule, [], hostKeys);
  }
  return removed;
}
