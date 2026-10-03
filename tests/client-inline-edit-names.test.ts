import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `web.md` 8.10 rule 6: a click-to-edit trigger's accessible name **leads with
 * its visible text**.
 *
 * SC 2.5.3 Label in Name wants what a voice user reads aloud to be how the
 * control is addressed, and the visible text of these triggers is the value
 * itself — so `30 Jul 2026 — edit the date of Corner shop`, never `Edit the
 * date of Corner shop`. 8.10's *Checked by* names
 * `tests/staged-inline-edit-ui.test.tsx`, which holds the PUT, the cancels and
 * the same-value silence; the naming shape was held by nothing, and three of
 * the four triggers followed it while the payee one read its visible text out
 * last.
 *
 * A source check rather than a rendered one, because what the rule is about is
 * the *order* of two things inside one string. A rendered name is already
 * interpolated, so "Corner shop — edit the payee" and "Edit the payee of Corner
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
  const found: { at: string; props: string }[] = [];
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
    found.push({
      at: `${where}:${source.slice(0, open).split("\n").length}`,
      props: source.slice(open, end),
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
 * A trigger whose name is a plain string is written as a `const` beside the row
 * rather than at the attribute, because `common.md` reads an em dash on an
 * `aria-label=` line as a label nobody finished deciding — the sibling triggers
 * escape that only because their expressions wrap. So the string this rule is
 * about is one hop away, and a check that read the attribute alone would report
 * every such trigger and be answered by inlining the string again.
 */
function nameExpression(source: string, expression: string) {
  const written = expression.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(written)) return written;
  const declared = new RegExp(`\\bconst ${written}\\s*=\\s*(\`[^\`]*\`)`).exec(source);
  return declared ? declared[1]! : written;
}

/** Leading with the value means a template literal that opens on its hole. */
const leadsWithTheValue = (expression: string) => expression.trimStart().startsWith("`${");

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
      "  } — edit the amount of ${payee}`}",
      "  onClick={() => openInline(stage, 'amount', value)}",
      ">",
      "  {summary.amount}",
      "</button>",
      "const trailingName = `Edit the date of ${payee}`;",
      "const leadingName = `${date} — edit the date of ${payee}`;",
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
      }
    }
    expect(checked, "no triggers found, so this examined nothing").toBeGreaterThanOrEqual(4);
    expect(trailing, "SC 2.5.3 wants the visible text first, not last").toEqual([]);
  });
});
