import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * No `type="number"` on a field bound to a decimal-string money value.
 *
 * `web.md` §8.5 and §17.2 item 4. A spinner on a money field is three separate
 * problems at once. The control rounds what it cannot represent, so a browser
 * may hand back `1.1000000000000001` for a figure somebody typed as `1.1`; its
 * step arrows walk a ledger amount by whole units; and a locale that writes a
 * decimal comma gets a control that refuses what the person typed with no error
 * anybody can see. The money invariant in `AGENTS.md` says these values are
 * validated decimal strings end to end, and `type="number"` is the one control
 * that makes the browser disagree.
 *
 * **The population is every money-bound control, not every `type="number"`.**
 * §17.2 opens by insisting on that, and the reason is directly in play here:
 * written the other way, this check's whole answer would come from the thing it
 * is checking, so a money field that acquired a spinner would be found only if
 * the check already knew to look at it. Deriving the population from the
 * product means a money field added tomorrow is covered the day it is written.
 *
 * The guide warns the check "gets deleted on first contact" if it is written
 * unscoped, which is why the second test below exists: the two `type="number"`
 * controls in the client are the recurrence interval and the reminder interval,
 * an integer count of periods bounded 1 to 366, where a spinner is arguably
 * right. They are named rather than excluded by line, since both have moved
 * since the guide cited them.
 */

const files = sourceFiles("src/client");

/** Where the opening tag that begins at `from` ends: the `>` at brace depth 0. */
function tagEnd(code: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < code.length; index += 1) {
    const character = code[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    // Only at depth zero, so a `>` inside an arrow function in an `onChange`
    // does not end the tag — which is what every one of these controls has.
    else if (character === ">" && depth === 0) return index;
  }
  return -1;
}

type Control = { file: string; line: number; tag: string; element: string };

/**
 * Every control in the client, as the whole of its opening tag.
 *
 * `<Input`, `<Select` and `<Textarea` are the three shared components
 * `tests/field-contract.test.tsx` holds every control to, and the bare HTML
 * spellings are here too so that dropping out of the shared component is not a
 * way out of this rule.
 */
const controls: Control[] = files.flatMap((file) => {
  const found: Control[] = [];
  for (const match of file.code.matchAll(
    /<(Input|Select|Textarea|input|select|textarea)(?=[\s/>])/g,
  )) {
    const end = tagEnd(file.code, match.index);
    if (end === -1) continue;
    found.push({
      file: file.path,
      line: file.code.slice(0, match.index).split("\n").length,
      tag: match[1]!,
      element: file.code.slice(match.index, end + 1),
    });
  }
  return found;
});

/**
 * What the control is bound to: the expression inside `value={...}`, or inside
 * `defaultValue={...}`. Taken whole, braces and all, because `leg.amount` and
 * `row.draft.amount` are both money and neither is a bare identifier.
 */
const boundTo = (element: string): string | null => {
  const match = /\b(?:value|defaultValue)=\{/.exec(element);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = open; index < element.length; index += 1) {
    if (element[index] === "{") depth += 1;
    else if (element[index] === "}") {
      depth -= 1;
      if (depth === 0) return element.slice(open + 1, index).trim();
    }
  }
  return null;
};

const MONEY_SUFFIXES = ["amount", "balance", "total", "subtotal", "price", "spent", "cap"];
const isMoneyBinding = (expression: string) => {
  // The last name in the expression is what it reads: `leg.amount`, `
  // row.openingBalance`, `amount`. A call or an operator means it is not a
  // plain binding and is not money being typed into.
  const names = [...expression.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) =>
    match[0]!.toLowerCase(),
  );
  const last = names.at(-1);
  return last !== undefined && MONEY_SUFFIXES.some((suffix) => last.endsWith(suffix));
};

/**
 * The two integer counts, named by what they are. A key of file and line would
 * be wrong twice over: both have already moved since `web.md` cited them, and a
 * line number says nothing about why the exception is allowed.
 */
const SPINNER_IS_RIGHT: { binding: string; why: string }[] = [
  {
    binding: "interval",
    // The recurrence's "every N months". A whole count of periods, bounded 1 to
    // 366 on the control itself, where stepping by one is the actual operation.
    why: "a recurrence interval is a count of periods, not an amount",
  },
  {
    binding: "reminderInterval",
    // The same field on a template's reminder.
    why: "a reminder interval is a count of periods, not an amount",
  },
];

describe("controls bound to money", () => {
  /**
   * The scan, before the verdict — §17.2's own rule about where a population
   * comes from. If this found no money-bound controls the test below would pass
   * on an empty set, and the first thing to break it would be a rename of the
   * shared component or a tag-end walk that stopped at the wrong bracket.
   */
  it("finds the money-bound controls that are there", () => {
    const money = controls.filter((control) => {
      const binding = boundTo(control.element);
      return binding !== null && isMoneyBinding(binding);
    });
    expect(controls.length).toBeGreaterThan(60);
    expect(money.length).toBeGreaterThanOrEqual(12);
    const bindings = new Set(money.map((control) => boundTo(control.element)));
    // One plain, one through a property, one on a page rather than in forms.tsx.
    expect(bindings.has("amount")).toBe(true);
    expect(bindings.has("leg.amount")).toBe(true);
    expect(bindings.has("openingBalance")).toBe(true);
    expect(money.some((control) => control.file.endsWith("BudgetsPage.tsx"))).toBe(true);
  });

  /**
   * And it reads each control whole.
   *
   * Twenty-two of these elements carry a prop *after* an `onChange` arrow, and
   * an arrow contains a `>`. A walk that ended the tag at the first one would
   * truncate every one of them — silently, because `value` is usually written
   * before `onChange`, so the binding would still be found and the verdict
   * would still be green while `type` on the far side went unread. That is the
   * sliced-too-early failure `web.md` §17.2 opens by warning about, and nothing
   * above notices it. So: the split-leg amount, whose `pattern` sits past its
   * arrow, has to come back entire.
   */
  it("reads each control past its onChange", () => {
    const whole = controls.filter((control) => {
      const arrow = control.element.indexOf("=>");
      return (
        arrow !== -1 &&
        /\b(value|type|pattern|placeholder|aria-label)=/.test(control.element.slice(arrow))
      );
    });
    expect(whole.length).toBeGreaterThanOrEqual(15);
    const leg = controls.find((control) => boundTo(control.element) === "leg.amount");
    expect(leg?.element).toContain("pattern=");
    expect(leg?.element.trimEnd().endsWith("/>")).toBe(true);
  });

  it("gives none of them a spinner", () => {
    const spun = controls
      .filter((control) => /type=["{]?["']?number\b/.test(control.element))
      .filter((control) => {
        const binding = boundTo(control.element);
        return binding !== null && isMoneyBinding(binding);
      })
      .map((control) => `${control.file}:${control.line} binds ${boundTo(control.element)}`);
    expect(spun).toEqual([]);
  });

  /**
   * And the other direction, which is what keeps the first one honest when a
   * money field is bound to something this cannot read as money. Every
   * `type="number"` in the client is on one of the two named counts; a third
   * one has to be argued for here before it ships.
   */
  it("spins nothing but the counts it has an argument for", () => {
    const allowed = new Set(SPINNER_IS_RIGHT.map((entry) => entry.binding));
    const unexplained = controls
      .filter((control) => /type=["{]?["']?number\b/.test(control.element))
      .filter((control) => {
        const binding = boundTo(control.element);
        return binding === null || !allowed.has(binding);
      })
      .map(
        (control) =>
          `${control.file}:${control.line} binds ${boundTo(control.element) ?? "nothing"}`,
      );
    expect(unexplained).toEqual([]);
  });

  it("keeps no exception that excuses nothing", () => {
    const bound = new Set(controls.map((control) => boundTo(control.element)));
    expect(SPINNER_IS_RIGHT.filter((entry) => !bound.has(entry.binding))).toEqual([]);
  });

  /**
   * `web.md` 8.5's other half, Binding on SC 3.3.2: the currency is in the
   * label. The transaction form wrote "Amount (USD)" and every other money field
   * wrote "Amount" — templates, recurrences, split legs, the opening balance and
   * six budget fields, two of them in dialogs that showed the currency nowhere —
   * so `moneyLabel` is the one way a money field is labelled, and this finds the
   * label each money-bound control actually gets: its own `aria-label`, or the
   * `label` of the `Field` it sits in.
   */
  const labelOf = (control: Control): string | null => {
    const file = files.find((one) => one.path === control.file)!;
    const own = /aria-label=\{([^}]*)\}|aria-label="([^"]*)"/.exec(control.element);
    if (own) return own[0];
    const at = file.code
      .split("\n")
      .slice(0, control.line - 1)
      .join("\n").length;
    const open = file.code.lastIndexOf("<Field", at);
    if (open === -1 || file.code.lastIndexOf("</Field>", at) > open) return null;
    const end = tagEnd(file.code, open);
    return file.code.slice(open, end + 1);
  };

  it("labels every one of them with its currency", () => {
    const money = controls.filter((control) => {
      const binding = boundTo(control.element);
      return binding !== null && isMoneyBinding(binding);
    });
    // The floor is the population above: a label reader that found nothing
    // would otherwise pass every control.
    expect(money.filter((control) => labelOf(control) !== null).length).toBe(money.length);
    const unlabelled = money
      .filter((control) => !/moneyLabel\(/.test(labelOf(control) ?? ""))
      .map((control) => `${control.file}:${control.line} binds ${boundTo(control.element)}`);
    expect(unlabelled).toEqual([]);
  });
});
