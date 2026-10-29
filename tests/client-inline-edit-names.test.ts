import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `web.md` 8.10 rule 6: a click-to-edit trigger's accessible name **leads with
 * its visible text**.
 *
 * SC 2.5.3 Label in Name wants what a voice user reads aloud to be how the
 * control is addressed, and the visible text of these triggers is the value
 * itself — so `30 Jul 2026, edit the date of Corner shop`, never `Edit the
 * date of Corner shop`. 8.10's *Checked by* names
 * `tests/staged-inline-edit-ui.test.tsx`, which holds the PUT, the cancels and
 * the same-value silence; the naming shape was held by nothing, and three of
 * the four triggers followed it while the payee one read its visible text out
 * last.
 *
 * A source check rather than a rendered one, because what the rule is about is
 * the *order* of two things inside one string. A rendered name is already
 * interpolated, so "Corner shop, edit the payee" and "Edit the payee of Corner
 * shop" are both a name containing the visible text, and only the source says
 * which of them leads with it.
 */
const SOURCES = globSync("src/client/**/*.tsx");

/**
 * The props of each `.inline-edit` trigger, as one brace-balanced slice.
 *
 * A line window or a `[^>]*` would both be wrong here, and in opposite ways: a
 * window truncates a multi-line prop, and `[^>]*` cannot cross the `>` in an
 * `onClick={() => …}`. Walking from the opening tag and counting braces is what
 * makes an arrow function, a nested template literal and a comment holding
 * `${…}` all survive the read.
 */
function triggers(source: string, where: string) {
  const found: { at: string; props: string; children: string }[] = [];
  for (const match of source.matchAll(/className="inline-edit[^"]*"/g)) {
    const open = source.lastIndexOf("<button", match.index);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
    }
    // What the button draws: up to its own close, since a trigger holds no
    // button inside it. Empty for a self-closing one.
    const close = source[end - 1] === "/" ? end : source.indexOf("</button>", end);
    found.push({
      at: `${where}:${source.slice(0, open).split("\n").length}`,
      props: source.slice(open, end),
      children: close > end ? source.slice(end + 1, close) : "",
    });
  }
  return found;
}

/** The expression inside `aria-label={…}`, brace-balanced for the same reason. */
function ariaLabel(props: string) {
  const at = props.indexOf("aria-label={");
  if (at < 0) return null;
  const from = at + "aria-label={".length;
  let depth = 1;
  for (let i = from; i < props.length; i += 1) {
    if (props[i] === "{") depth += 1;
    else if (props[i] === "}") {
      depth -= 1;
      if (depth === 0) return props.slice(from, i);
    }
  }
  return null;
}

/**
 * The name itself, following one hop when the attribute names a value.
 *
 * The payee trigger's name is a `const` beside the row rather than at the
 * attribute. It was put there to keep an em dash off an `aria-label=` line,
 * where `common.md` refuses one, and the dash is gone now; the hop stays
 * because a name worked out beside the row is an ordinary way to write one,
 * and a check that read the attribute alone would report it.
 */
function nameExpression(source: string, expression: string) {
  const written = expression.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(written)) return written;
  const declared = new RegExp(`\\bconst ${written}\\s*=\\s*(\`[^\`]*\`)`).exec(source);
  return declared ? declared[1]! : written;
}

/** Leading with the value means a template literal that opens on its hole. */
const leadsWithTheValue = (expression: string) => expression.trimStart().startsWith("`${");

/** The expression in a template literal's first hole, brace-balanced. */
function leadingHole(expression: string) {
  const from = expression.indexOf("${");
  if (from < 0) return "";
  let depth = 1;
  for (let i = from + 2; i < expression.length; i += 1) {
    if (expression[i] === "{") depth += 1;
    else if (expression[i] === "}") {
      depth -= 1;
      if (depth === 0) return expression.slice(from + 2, i);
    }
  }
  return "";
}

/**
 * The names an expression reads, its words and fallbacks left out.
 *
 * Strings go first, because a fallback is allowed to differ — the cell draws
 * "—" for no amount and the name says "No amount", which is the same absence
 * in words. Tags go next, so `<strong>` and a fragment are not read as values.
 * What is left between braces is what the cell renders from.
 */
function valuesRead(expression: string) {
  const code = expression
    .replaceAll(/"[^"]*"|'[^']*'/g, "")
    .replaceAll(/<\/?[A-Za-z]*[^<>{}]*>/g, " ");
  const inBraces = code.includes("{")
    ? [...code.matchAll(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)].map((match) => match[1]!).join(" ")
    : code;
  return new Set(
    [...inBraces.matchAll(/[A-Za-z_$][\w$]*/g)]
      .map((match) => match[0])
      .filter((word) => !["true", "false", "null", "undefined"].includes(word)),
  );
}

/** What the cell renders from and its name's leading hole does not. */
const missingFromTheName = (name: string, children: string) => {
  const named = valuesRead(leadingHole(name));
  return [...valuesRead(children)].filter((value) => !named.has(value));
};

describe("a click-to-edit trigger", () => {
  /**
   * The reader, against a trigger written to be caught.
   *
   * Both halves are proved: that a trailing name is reported, and that the
   * walk survives the two things that truncated earlier versions of scans like
   * this one — a self-closing slash and a multi-line prop.
   */
  it("is read whole, including the shape that is wrong", () => {
    const synthetic = [
      "<button",
      '  type="button"',
      '  className="inline-edit"',
      "  aria-label={`Edit the payee of ${payee}`}",
      "  onClick={() => openInline(stage, 'payee', value)}",
      ">",
      "  <strong>{payee}</strong>",
      "</button>",
      "<button",
      '  className="inline-edit inline-edit-money"',
      "  aria-label={`${",
      "    summary.amount ? formatMoney(summary.amount) : 'No amount'",
      "  }, edit the amount of ${payee}`}",
      "  onClick={() => openInline(stage, 'amount', value)}",
      ">",
      "  {summary.amount}",
      "</button>",
      "const trailingName = `Edit the date of ${payee}`;",
      "const leadingName = `${date}, edit the date of ${payee}`;",
      '<button className="inline-edit" aria-label={trailingName} />',
      '<button className="inline-edit" aria-label={leadingName} />',
    ].join("\n");
    const read = triggers(synthetic, "synthetic.tsx").map((one) =>
      nameExpression(synthetic, ariaLabel(one.props)!),
    );
    expect(read).toHaveLength(4);
    expect(read.map(leadsWithTheValue)).toEqual([false, true, false, true]);
  });

  it("names itself with its visible value first, on every one in the client", () => {
    const trailing: string[] = [];
    let checked = 0;
    for (const relative of SOURCES) {
      for (const trigger of triggers(readFileSync(relative, "utf8"), relative)) {
        const source = readFileSync(relative, "utf8");
        const label = ariaLabel(trigger.props);
        checked += 1;
        expect(label, `${trigger.at} has no accessible name at all`).not.toBeNull();
        const name = nameExpression(source, label!);
        if (!leadsWithTheValue(name)) trailing.push(`${trigger.at} ${name.slice(0, 60)}`);
        // `common.md` §Prose: no em dash in a label. All four joined their two
        // halves with one, and the one-hop `const` was how the payee name kept
        // its dash off the line the label check reads.
        if (name.includes("—")) trailing.push(`${trigger.at} joins with an em dash`);
      }
    }
    expect(checked, "no triggers found, so this examined nothing").toBeGreaterThanOrEqual(4);
    expect(trailing, "SC 2.5.3 wants the visible text first, not last").toEqual([]);
  });

  /**
   * Leading with *a* value is not leading with the one on screen.
   *
   * The check above reads the shape — a name that opens on its hole — and the
   * staged amount passed it for a release while its hole was
   * `formatMoney(amount)` and the cell drew `movementSign(…).sign` in front of
   * it. The queue has no Type column, so on a row with a description the sign
   * is the only thing saying which way the money moves, and a screen reader
   * heard "$45.00, edit the amount" for a deposit and a withdrawal alike. So
   * the leading hole has to read everything the cell renders from; a fallback
   * may be worded differently, because "—" and "No amount" are the same
   * absence.
   */
  it("reads in its name everything the cell draws, the sign included", () => {
    const synthetic = [
      "const signed = `${sign}${formatMoney(amount)}`;",
      "<button",
      '  className="inline-edit inline-edit-money"',
      "  aria-label={`${formatMoney(amount)}, edit the amount of ${payee}`}",
      ">",
      "  {amount ? (",
      "    <>",
      "      {movementSign(type).sign}",
      "      {formatMoney(amount)}",
      "    </>",
      '  ) : ("—")}',
      "</button>",
      "<button",
      '  className="inline-edit"',
      '  aria-label={`${signed ?? "No amount"}, edit the amount of ${payee}`}',
      ">",
      '  {signed ?? "—"}',
      "</button>",
    ].join("\n");
    const read = triggers(synthetic, "synthetic.tsx").map((one) =>
      missingFromTheName(nameExpression(synthetic, ariaLabel(one.props)!), one.children),
    );
    expect(read).toEqual([["movementSign", "type", "sign"], []]);

    const unnamed: string[] = [];
    let checked = 0;
    for (const relative of SOURCES) {
      const source = readFileSync(relative, "utf8");
      for (const trigger of triggers(source, relative)) {
        if (!trigger.children.trim()) continue;
        checked += 1;
        const name = nameExpression(source, ariaLabel(trigger.props) ?? "");
        const missing = missingFromTheName(name, trigger.children);
        if (missing.length) unnamed.push(`${trigger.at} draws ${missing.join(", ")} unnamed`);
      }
    }
    expect(checked, "no trigger draws anything, so this examined nothing").toBeGreaterThanOrEqual(
      4,
    );
    expect(unnamed, "SC 2.5.3: the name leads with the visible text, all of it").toEqual([]);
  });
});
