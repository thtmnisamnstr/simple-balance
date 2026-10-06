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
 * **The population is every money control, not every `type="number"`.**
 * §17.2 opens by insisting on that, and the reason is directly in play here:
 * written the other way, this check's whole answer would come from the thing it
 * is checking, so a money field that acquired a spinner would be found only if
 * the check already knew to look at it. Deriving the population from the
 * product means a money field added tomorrow is covered the day it is written.
 *
 * And no single sign of money is enough to derive it from. The first version
 * asked only what a control's `value` was called, and the staged queue's
 * click-to-edit amount binds `inline!.value` — one editor shared with the date
 * cell — so the one money field a person edits most often in a row was outside
 * the check while it reported the client clean. So a control is money when the
 * source says so in any of five independent ways, listed at `moneySignals`, and
 * the rules then hold over the union.
 *
 * The guide warns the check "gets deleted on first contact" if it is written
 * unscoped, which is why the reverse test below exists: the `type="number"`
 * controls in the client are integer counts of periods — the recurrence
 * interval, the reminder interval, and the budget's averaging window — where a
 * spinner is arguably right. They are named rather than excluded by line, since
 * two have moved since the guide cited them.
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
 * What one attribute of an element was given: the expression inside its
 * `{...}`, or its quoted string with the quotes kept, or null when it is absent.
 *
 * The quotes stay so the two spellings of a constant read alike —
 * `inputMode="decimal"` and `inputMode={"decimal"}` both come back as
 * `"decimal"`. The name is matched whole, or `label` would be found inside
 * `aria-label` and `value` inside `defaultValue`.
 */
const attribute = (element: string, name: string): string | null => {
  const match = new RegExp(`(?<![\\w-])${name}=`).exec(element);
  if (!match) return null;
  const start = match.index + match[0].length;
  const opener = element[start];
  if (opener === '"' || opener === "'") {
    const close = element.indexOf(opener, start + 1);
    return close === -1 ? null : element.slice(start, close + 1);
  }
  if (opener !== "{") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < element.length; index += 1) {
    const character = element[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && (depth -= 1) === 0) return element.slice(start + 1, index).trim();
  }
  return null;
};

/**
 * What the control is bound to: the expression inside `value={...}`, or inside
 * `defaultValue={...}`. Taken whole, braces and all, because `leg.amount` and
 * `row.draft.amount` are both money and neither is a bare identifier.
 */
const boundTo = (element: string): string | null =>
  attribute(element, "value") ?? attribute(element, "defaultValue");

const MONEY_SUFFIXES = ["amount", "balance", "total", "subtotal", "price", "spent", "cap"];
const namesIn = (expression: string) =>
  [...expression.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]!.toLowerCase());
const isMoney = (name: string) => MONEY_SUFFIXES.some((suffix) => name.endsWith(suffix));
const isMoneyBinding = (expression: string) => {
  // The last name in the expression is what it reads: `leg.amount`, `
  // row.openingBalance`, `amount`. A call or an operator means it is not a
  // plain binding and is not money being typed into.
  const last = namesIn(expression).at(-1);
  return last !== undefined && isMoney(last);
};

/**
 * `type="number"` in any of the three ways a control is given it: the
 * attribute, the attribute as an expression, or a key in an object spread
 * onto the control. The budget form's rule value takes its type from a spread,
 * and a check that knew only the first spelling read it as text.
 */
const SPINS = /(?<![\w-])type(?:=\{?\s*|\s*:\s*)["'`]number["'`]/;

/** `inputMode` decimal, spelled any of those same three ways. */
const takesDecimals = (element: string) => {
  const given = attribute(element, "inputMode");
  return (
    (given !== null && /["'`]decimal["'`]/.test(given)) ||
    /(?<![\w-])inputMode\s*:\s*["'`]decimal["'`]/.test(element)
  );
};

/**
 * The ledger's scale as an input pattern writes it: up to eighteen places,
 * which is `numeric(44,18)`. Nothing but an amount is validated to that.
 */
const LEDGER_SCALE = /\{1,18\}/;

/**
 * The label a control actually gets: its own `aria-label`, or the `label` of
 * the `Field` it sits in. Either comes back as the expression that builds it,
 * which is what the `moneyLabel` rule below reads.
 */
const labelOf = (control: Control): string | null => {
  const own = attribute(control.element, "aria-label");
  if (own !== null) return own;
  const file = files.find((one) => one.path === control.file)!;
  const at = file.code
    .split("\n")
    .slice(0, control.line - 1)
    .join("\n").length;
  const open = file.code.lastIndexOf("<Field", at);
  if (open === -1 || file.code.lastIndexOf("</Field>", at) > open) return null;
  const end = tagEnd(file.code, open);
  return attribute(file.code.slice(open, end + 1), "label");
};

/**
 * Every way the source says a control holds money, as reasons a failure can
 * print.
 *
 * Five, and independent on purpose, because each one misses a control the
 * others find. The binding's name misses a shared editor (`inline!.value`, and
 * the template mass edit's `values[field.key]`); what the change handler
 * writes catches the same thing from the other end, an amount held under a
 * generic name but set through `setAmount`. The input mode misses a field
 * somebody forgot it on, which is half of what this file is for. The pattern
 * misses the budget fields, which have none. The label misses a field written
 * without `moneyLabel`, which is the other half. Any one alone is a population
 * with a hole the shape of its own blind spot.
 *
 * A word in the label is deliberately not one of them: "Amount decided by"
 * labels a `Select` of budget rules, and a check that called that money would
 * be answered with an exception rather than a fix.
 */
const moneySignals = (control: Control): string[] => {
  const signals: string[] = [];
  const binding = boundTo(control.element);
  if (binding !== null && isMoneyBinding(binding)) signals.push(`binds ${binding}`);
  // What the typed text is handed to — `setAmount(event.target.value)`, or the
  // `amount:` key of a leg — rather than any name in the handler: the account
  // pickers call `forgetEchoedReceivedAmount()` on change, which mentions an
  // amount without writing the picker's value into one.
  const onChange = attribute(control.element, "onChange") ?? "";
  for (const write of onChange.matchAll(/([\w$]+)\s*(?:\(|:)\s*event\.target\.value/g)) {
    if (isMoney(write[1]!.toLowerCase())) signals.push(`writes ${write[1]}`);
  }
  if (takesDecimals(control.element)) signals.push("decimal input mode");
  const pattern = attribute(control.element, "pattern");
  if (pattern !== null && LEDGER_SCALE.test(pattern)) signals.push("ledger-scale pattern");
  if (/moneyLabel\(/.test(labelOf(control) ?? "")) signals.push("labelled by moneyLabel");
  return signals;
};

/**
 * Decimal entries that are not money, named by what they bind. The input mode
 * is a signal rather than a definition, and a percentage is the decimal that is
 * not an amount.
 */
const NOT_MONEY: { binding: string; why: string }[] = [
  {
    binding: "ruleValue",
    // The budget rule's parameter: "Increase each period by (%)" or "Share of
    // income (%)", typed as decimal text because a percentage can be
    // fractional, and under the averaging rule a count of periods.
    why: "a percentage, or a count of periods, never an amount",
  },
];

const money = controls.filter(
  (control) =>
    moneySignals(control).length > 0 &&
    !NOT_MONEY.some((entry) => entry.binding === boundTo(control.element)),
);

const where = (control: Control) =>
  `${control.file}:${control.line} binds ${boundTo(control.element) ?? "nothing"}`;

/**
 * The integer counts, named by what they are. A key of file and line would be
 * wrong twice over: two have already moved since `web.md` cited them, and a
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
  {
    binding: "ruleValue",
    // "Months to average", bounded 1 to 24, and given its type by a spread
    // only under that rule; under the other two it is the decimal text
    // `NOT_MONEY` above describes. The first version of this file read only
    // the attribute spelling and so never saw it.
    why: "the averaging rule's window is a count of periods, not an amount",
  },
];

/**
 * Money controls excused from one rule, keyed by file and binding, never by
 * line, each naming the rule it is excused from. Empty: the sweep that widened
 * this population found two — the queue's click-to-edit amount, which named its
 * currency by hand, and the template mass edit's "New amount", which named
 * none — and both go through `moneyLabel` now. Kept as the place a third would
 * have to be argued.
 */
const REPORTED: { file: string; binding: string; rule: "label"; why: string }[] = [];
const reported = (control: Control, rule: "label") =>
  REPORTED.some(
    (entry) =>
      entry.rule === rule &&
      entry.file === control.file &&
      entry.binding === boundTo(control.element),
  );
const labelledByMoneyLabel = (control: Control) => /moneyLabel\(/.test(labelOf(control) ?? "");

describe("controls bound to money", () => {
  /**
   * The scan, before the verdict — §17.2's own rule about where a population
   * comes from. If this found no money controls the tests below would pass on
   * an empty set, and the first thing to break it would be a rename of the
   * shared component or a tag-end walk that stopped at the wrong bracket.
   *
   * The last two assertions are the ones the binding-only version could not
   * have passed: the staged queue's inline amount editor is in the population,
   * and so is more than one control whose binding says nothing about money.
   */
  it("finds the money controls that are there", () => {
    expect(controls.length).toBeGreaterThan(60);
    expect(money.length).toBeGreaterThanOrEqual(16);
    const bindings = new Set(money.map((control) => boundTo(control.element)));
    // One plain, one through a property, one on a page rather than in forms.tsx.
    expect(bindings.has("amount")).toBe(true);
    expect(bindings.has("leg.amount")).toBe(true);
    expect(bindings.has("openingBalance")).toBe(true);
    expect(money.some((control) => control.file.endsWith("BudgetsPage.tsx"))).toBe(true);
    expect(
      money.some(
        (control) =>
          control.file === "src/client/pages/StagingPage.tsx" &&
          boundTo(control.element) === "inline!.value",
      ),
      "the staged queue's inline amount editor",
    ).toBe(true);
    expect(
      money.filter((control) => !isMoneyBinding(boundTo(control.element) ?? "")).length,
    ).toBeGreaterThanOrEqual(2);
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
    const spun = money.filter((control) => SPINS.test(control.element)).map(where);
    expect(spun).toEqual([]);
  });

  /**
   * §8.5's positive half: a money field is a text input in decimal mode. The
   * spinner test above only says what it must not be, and a `Select`, a
   * `type="tel"` or a text box with no input mode all pass that while giving a
   * phone keyboard no decimal point. Nothing asked this before; the rule was
   * stated and the check held only its negation.
   */
  it("takes every one of them as decimal text", () => {
    const wrong = money
      .filter((control) => {
        const type = attribute(control.element, "type");
        return (
          !/^(Input|input)$/.test(control.tag) ||
          (type !== null && type !== '"text"') ||
          !takesDecimals(control.element)
        );
      })
      .map((control) => `${where(control)} (${moneySignals(control).join(", ")})`);
    expect(wrong).toEqual([]);
  });

  /**
   * And the other direction, which is what keeps the first one honest when a
   * money field is marked as money in no way this file can read. Every
   * `type="number"` in the client is on one of the named counts; another one
   * has to be argued for here before it ships.
   */
  it("spins nothing but the counts it has an argument for", () => {
    const allowed = new Set(SPINNER_IS_RIGHT.map((entry) => entry.binding));
    const unexplained = controls
      .filter((control) => SPINS.test(control.element))
      .filter((control) => {
        const binding = boundTo(control.element);
        return binding === null || !allowed.has(binding);
      })
      .map(where);
    expect(unexplained).toEqual([]);
  });

  /**
   * Every register entry has to be excusing something today. A count nobody
   * renders, a non-money decimal that stopped being a decimal, and a reported
   * violation that has since been fixed all fail here, so the registers cannot
   * outlive what they were written about.
   */
  it("keeps no exception that excuses nothing", () => {
    const spinning = new Set(
      controls
        .filter((control) => SPINS.test(control.element))
        .map((control) => boundTo(control.element)),
    );
    expect(SPINNER_IS_RIGHT.filter((entry) => !spinning.has(entry.binding))).toEqual([]);
    const signalled = new Set(
      controls
        .filter((control) => moneySignals(control).length > 0)
        .map((control) => boundTo(control.element)),
    );
    expect(NOT_MONEY.filter((entry) => !signalled.has(entry.binding))).toEqual([]);
    expect(
      REPORTED.filter(
        (entry) =>
          !money.some(
            (control) =>
              control.file === entry.file &&
              boundTo(control.element) === entry.binding &&
              !labelledByMoneyLabel(control),
          ),
      ).map((entry) => `${entry.file} binds ${entry.binding}`),
    ).toEqual([]);
  });

  /**
   * `web.md` 8.5's other half, Binding on SC 3.3.2: the currency is in the
   * label. The transaction form wrote "Amount (USD)" and every other money field
   * wrote "Amount" — templates, recurrences, split legs, the opening balance and
   * six budget fields, two of them in dialogs that showed the currency nowhere —
   * so `moneyLabel` is the one way a money field is labelled, and this finds the
   * label each money control actually gets: its own `aria-label`, or the `label`
   * of the `Field` it sits in.
   */
  it("labels every one of them with its currency", () => {
    // The floor is the population above: a label reader that found nothing
    // would otherwise pass every control.
    expect(money.filter((control) => labelOf(control) !== null).length).toBe(money.length);
    const unlabelled = money
      .filter((control) => !labelledByMoneyLabel(control) && !reported(control, "label"))
      .map(where);
    expect(unlabelled).toEqual([]);
  });
});
