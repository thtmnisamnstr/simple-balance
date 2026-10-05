import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * Never `Number(amount)`.
 *
 * `typescript.md` §3.4 states the rule for a reader — "never `Number(amount)`,
 * on either side, for anything that is compared, summed, or shown" — and says
 * in the same breath that nothing refuses one: the two tests it cites pin the
 * two exact implementations at cases a float loses, which is evidence that
 * `moneyUnits` and the server's `decimal.js` wrapper agree, and no evidence at
 * all about a `Number(amount)` written somewhere else. `client.md` §4 lists the
 * same gap and says why it was left open: "a lint rule banning `Number(` in
 * `src/client` would fire on legitimate uses; a narrower one keyed on variable
 * names is possible and fiddly".
 *
 * This is that narrower one. It is keyed on names rather than on files, so the
 * twenty-odd legitimate `Number(` calls in the client — a bar width, a chart
 * coordinate, a day read out of a date, a reminder interval — are not in its
 * way, and so it covers the server and `src/shared` too, which a client-scoped
 * lint rule would not. `AGENTS.md`'s first invariant is about every value
 * reaching a posting, a balance, a report or a stored column, and the server is
 * where most of those are.
 *
 * What it refuses is a float appearing where the name says the value is money.
 * That is the shape of the scar `client.md` §2.1 records: a budget row's state
 * was decided with `Number()` on decimal strings, so a row that was exactly
 * spent rendered as "spent" or "within" depending on the amount.
 *
 * What it cannot see, said plainly rather than left to be discovered: money
 * under a name that is not a money name. `fillPercent(limit, actual)` in
 * `src/client/budget-display.ts` takes two decimal strings and calls them
 * `limit` and `actual`, and a `Number(actual)` added there would pass this
 * check. That is the price of keying on names, and the alternative — banning
 * `Number(` outright in `src/client` — is the one `client.md` §4 says fires on
 * legitimate uses. Roughly ninety money-named identifiers are in `src` for this
 * to watch, so the trade is worth taking; it is a floor under the rule, not a
 * proof of it.
 *
 * `formatPrice` (`src/client/pages/PlanPage.tsx`) is the product's one
 * sanctioned money-shaped float and is outside this check without needing an
 * exception, because it divides a number Stripe already sent as a number. This
 * rule is about converting a decimal string, which is the act that loses
 * digits.
 */

/**
 * Comment-blanked source, because this codebase discusses `Number` in prose as
 * often as it calls it. `budget-display.ts` says "Scaled units rather than
 * Number, because these are money", `BudgetsPage.tsx` says `Number("three")` is
 * NaN, and `domain.ts` recalls a route that "handed `Number(c.req.query(...))`
 * to the service". A check reading those as code would open with three false
 * positives and be deleted by the end of the day.
 */
const files = sourceFiles("src");

/**
 * The money names.
 *
 * Suffixes, so the compounds come along without being listed:
 * `sourceAmount`, `destinationAmount`, `openingBalance`, `targetAmount`,
 * `plannedTotal`. Then the handful whose names do not end in one.
 *
 * **Percentages are deliberately absent.** Both guides carve them out in the
 * same words — §3.4's "`Number` appears in this codebase only where the result
 * is a pixel or a percentage that is already approximate", §2.1's "allowed only
 * where the result is already approximate" — so `percentOfIncome`,
 * `percentOfPrevious` and `moneyScalePercent` are outside this rule by its own
 * text. They are inside `tests/mcp-money-arguments.test.ts`'s set, and the
 * difference is not an oversight: what a percentage is *stored and transmitted*
 * as is the money invariant, and what it is *compared* as is this one.
 *
 * Also deliberately absent: `count`, `entries`, `periods`, `interval`,
 * `priority`, `limit`, `page`, `ordinal`, `weekday`, `digits`, `hundredths`,
 * `octet`. Every one of them is counted today with `Number` and every one of
 * them is correct.
 */
const MONEY_SUFFIXES = [
  "amount",
  "balance",
  "total",
  "subtotal",
  "price",
  "spent",
  "assigned",
  "carried",
  "debit",
  "credit",
];
const MONEY_NAMES = new Set(["money", "rate", "rollovercap"]);

const isMoneyName = (name: string) => {
  const lower = name.toLowerCase();
  return MONEY_NAMES.has(lower) || MONEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

/**
 * The register, and it is empty.
 *
 * Nothing in `src` floats a money-named value today, so there is no legitimate
 * exception to list — which is the result rather than a gap. The shape is here
 * because the first real exception will want it, and because an entry somebody
 * has to write an argument for is a decision, where a widened regex is a
 * silence. A key is the file and the argument text rather than a line number,
 * which moves when anything above it does.
 */
const APPROXIMATE_ON_PURPOSE: { key: string; why: string }[] = [];

/**
 * Finds the end of the call that opens at `from`, which is the index of the
 * `(`. Paren-counting rather than a regex, because the argument may itself hold
 * calls, and quote-aware because it may hold a string with a bracket in it.
 */
function closingParen(code: string, from: number): number {
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
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Every float-making call in `src`, with the text of its argument.
 *
 * `Number(` and both spellings of `parseFloat`, which is the same defect
 * written differently. `Number.parseInt` and the `Number.isX` predicates are
 * not calls on a value at all and are excluded by requiring that nothing but
 * whitespace or an operator precedes the word — `Number.parseFloat` is matched
 * by its own alternative instead.
 */
function floatCalls(code: string): { argument: string; at: number }[] {
  const found: { argument: string; at: number }[] = [];
  for (const match of code.matchAll(/(?<![.\w$])(Number|(?:Number\.)?parseFloat)\s*\(/g)) {
    const open = code.indexOf("(", match.index + match[1]!.length);
    const close = closingParen(code, open);
    if (close === -1) continue;
    found.push({ argument: code.slice(open + 1, close).trim(), at: match.index });
  }
  return found;
}

/**
 * Every identifier in the argument, so `Number(total - fee)` is caught as
 * surely as `Number(total)`. String literals are blanked first: `Number("0")`
 * is a constant and `fraction[digits] ?? "0"` holds one, and neither is a name.
 */
const identifiersIn = (argument: string): string[] => {
  const withoutStrings = argument.replaceAll(/"[^"]*"|'[^']*'|`[^`]*`/g, " ");
  return [...withoutStrings.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]!);
};

const lineOf = (code: string, index: number) => code.slice(0, index).split("\n").length;

const scanned = files.flatMap((file) =>
  floatCalls(file.code).map((call) => ({
    file: file.path,
    line: lineOf(file.code, call.at),
    argument: call.argument.replaceAll(/\s+/g, " "),
    key: `${file.path}::${call.argument.replaceAll(/\s+/g, " ")}`,
  })),
);

describe("money is never floated", () => {
  /**
   * The scanner, before the verdict.
   *
   * This check's honest answer today is "no violations", and a scanner that
   * had quietly stopped matching would give the same answer. So it is made to
   * say what it found first: the real count is around forty, and two of the
   * fiddliest arguments in the tree — one holding a nested call with its own
   * commas, one holding a string literal — have to come back whole.
   */
  it("finds the float-making calls that are there", () => {
    expect(scanned.length).toBeGreaterThan(30);
    const arguments_ = new Set(scanned.map((call) => call.argument));
    expect(arguments_.has("moneyScalePercent(value, low, high)")).toBe(true);
    expect(arguments_.has('fraction[digits] ?? "0"')).toBe(true);
    expect(arguments_.has("hundredths")).toBe(true);
    // And it reads the server too, not only the client.
    expect(scanned.some((call) => call.file.startsWith("src/server/"))).toBe(true);
    expect(scanned.some((call) => call.file.startsWith("src/shared/"))).toBe(true);
  });

  it("floats nothing a name calls money", () => {
    const registered = new Set(APPROXIMATE_ON_PURPOSE.map((entry) => entry.key));
    const violations = scanned
      .filter((call) => identifiersIn(call.argument).some(isMoneyName))
      .filter((call) => !registered.has(call.key))
      .map((call) => `${call.file}:${call.line} floats ${call.argument}`);
    expect(violations).toEqual([]);
  });

  /**
   * And no entry in the register outlives what it excused. An exception whose
   * call site has gone is a hole nobody is watching.
   */
  it("keeps no exception that excuses nothing", () => {
    const keys = new Set(scanned.map((call) => call.key));
    expect(APPROXIMATE_ON_PURPOSE.filter((entry) => !keys.has(entry.key))).toEqual([]);
  });
});
