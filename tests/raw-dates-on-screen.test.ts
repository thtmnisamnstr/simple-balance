import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * A date somebody reads is formatted, and that includes the ones only a screen
 * reader reaches.
 *
 * `common.md` §Dates and times, which `web.md` 10.4 defers to: "A raw
 * `2026-03-01` in a sentence is a bug report waiting to be filed by somebody
 * outside the ISO-reading world." Five sites on the budgets page interpolated a
 * `YYYY-MM-DD` string straight into a `.sr-only` `<caption>` or an `aria-label`
 * while the visible heading on the same panel read "June 2026" through
 * `periodName` — so the two surfaces of one panel disagreed, and the one that
 * disagreed was the one nobody looks at.
 *
 * 10.4 proposes a grep for `toLocaleString`, `toLocaleDateString` and
 * `Intl.DateTimeFormat` outside `money.ts` and its two named exceptions. That
 * finds a second formatter; it cannot find NO formatter, which is the shape the
 * defect took. This is the inverse, and it catches the bare interpolation.
 *
 * **Which fields count as dates is derived from the product rather than listed
 * here** (`web.md` 17.2): a field is date-shaped if the client already passes
 * it to `formatDate`, `formatTimestamp`, `formatTime`, `periodName` or
 * `chartBucketLabel` somewhere. So a new date field joins the population the
 * first time anybody formats one, and a list nobody maintains cannot go stale.
 * The name is filtered for a date-shaped spelling on top of that, because an
 * accessor's last segment inside a formatter call can be `length` or
 * `toISOString` and those are not fields.
 *
 * What it reads is the two places a date reaches a reader as text: a JSX text
 * child, and an `aria-label` or `title` template literal. An attribute that is
 * not one of those is markup, and a date in a `value=` is a form field, which
 * `common.md` settles the other way — a date input takes the ISO value.
 */
const CLIENT = new URL("../src/client/", import.meta.url);

const FORMATTERS = [
  "formatDate",
  "formatTimestamp",
  "formatTime",
  "periodName",
  "chartBucketLabel",
];
/** An identifier path: `period.start`, `forecast.data?.from`. */
const ACCESS = /[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+/g;
/** A name that reads as a date: `date`, `start`, `activeFrom`, `createdAt`. */
const DATE_SHAPED = /^(?:date|start|end|from|to|asOf)$|(?:Date|At|From|To|Start|End|Since)$/;

async function tsFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: URL[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(...(await tsFiles(new URL(`${entry.name}/`, directory))));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(new URL(entry.name, directory));
    }
  }
  return found;
}

/** The text between a formatter's parentheses, counting nesting. */
function argumentsOf(source: string, callee: string): string[] {
  const found: string[] = [];
  for (const open of source.matchAll(new RegExp(`\\b${callee}\\(`, "g"))) {
    let depth = 1;
    let at = open.index + open[0].length;
    const start = at;
    while (at < source.length && depth > 0) {
      if (source[at] === "(") depth += 1;
      else if (source[at] === ")") depth -= 1;
      at += 1;
    }
    found.push(source.slice(start, at - 1));
  }
  return found;
}

describe("a date on screen", () => {
  it("goes through a formatter wherever a person reads it", async () => {
    const files = await tsFiles(CLIENT);
    const sources = await Promise.all(
      files.map(async (file) => ({
        path: file.pathname.split("/client/")[1]!,
        code: await readFile(file, "utf8"),
      })),
    );
    expect(sources.length, "no client source was read").toBeGreaterThan(10);

    const dateFields = new Set<string>();
    for (const { code } of sources) {
      for (const callee of FORMATTERS) {
        for (const argument of argumentsOf(code, callee)) {
          for (const access of argument.matchAll(ACCESS)) {
            const last = access[0].split(".").at(-1)!;
            if (DATE_SHAPED.test(last)) dateFields.add(last);
          }
        }
      }
    }
    // A population of nothing passes every claim made over it, and this one is
    // derived, so it can empty itself by a rename rather than by a decision.
    expect(
      [...dateFields],
      "no date-shaped field is formatted anywhere, so nothing was examined",
    ).toContain("start");
    expect(dateFields.size).toBeGreaterThan(5);

    const named = (expression: string) =>
      [...expression.matchAll(ACCESS)].some((access) =>
        dateFields.has(access[0].split(".").at(-1)!),
      );
    const formatted = (expression: string) =>
      FORMATTERS.some((callee) => expression.includes(`${callee}(`));

    const raw: string[] = [];
    for (const { path, code } of sources) {
      const at = (offset: number) => `${path}:${code.slice(0, offset).split("\n").length}`;
      // A JSX text child: the run between an element's `>` and the next `<`.
      // `=>` is excluded by the lookbehind, or every arrow body would read as
      // text.
      for (const region of code.matchAll(/(?<![=!<>-])>([^<>]*)</gs)) {
        for (const hole of region[1]!.matchAll(/\{([^{}]+)\}/g)) {
          if (formatted(hole[1]!) || !named(hole[1]!)) continue;
          raw.push(`${at(region.index + 1 + hole.index)} — ${hole[1]!.trim()}`);
        }
      }
      // And the two attributes that are read aloud rather than drawn.
      for (const label of code.matchAll(/(?:aria-label|title)=\{`([^`]*)`\}/gs)) {
        for (const hole of label[1]!.matchAll(/\$\{([^{}]+)\}/g)) {
          if (formatted(hole[1]!) || !named(hole[1]!)) continue;
          raw.push(`${at(label.index)} — ${hole[1]!.trim()}`);
        }
      }
    }
    expect(
      [...new Set(raw)],
      "wrap this in formatDate, periodName or formatTimestamp; a raw YYYY-MM-DD is only readable to somebody inside the ISO-reading world",
    ).toEqual([]);
  });
});

/**
 * A date in a table cell stays on one line.
 *
 * The register's committed rows always said `nowrap` on the date, and nothing
 * said the rule, so the staged queue, the staged rows above them, the import
 * preview and Recurring's next date each let "Oct 5, 2026" break into three
 * lines the moment the table had to share its width — which at 820px, with
 * the sidebar still showing, is every table in the product. A date read one
 * word a line is a date read wrongly, and the date is the column a person
 * scans a ledger by.
 *
 * Asked of the markup rather than the stylesheet: a cell is in scope when it
 * hands `formatDate` its own content, and it passes when the cell, or the
 * element holding the date, carries `nowrap`. A header cell is a cell: the
 * account register's date is its row header, and the first version of this
 * read `<td>` alone and passed with that one wrapping.
 */
/**
 * Markup with every template literal blanked, nested ones included: a date
 * inside a sentence the cell says is prose, and prose may wrap.
 */
function outsideTemplates(markup: string): string {
  let out = "";
  const stack: ("template" | "expression")[] = [];
  for (let index = 0; index < markup.length; index += 1) {
    const character = markup[index]!;
    const top = stack.at(-1);
    if (top === "template") {
      if (character === "`") stack.pop();
      else if (character === "$" && markup[index + 1] === "{") {
        stack.push("expression");
        index += 1;
      }
      out += " ";
      continue;
    }
    if (top === "expression") {
      if (character === "`") stack.push("template");
      else if (character === "{") stack.push("expression");
      else if (character === "}") stack.pop();
      out += " ";
      continue;
    }
    if (character === "`") stack.push("template");
    out += character === "`" ? " " : character;
  }
  return out;
}

describe("a date in a table cell", () => {
  it("does not wrap", async () => {
    const loose: string[] = [];
    let cells = 0;
    for (const file of await tsFiles(CLIENT)) {
      if (!file.pathname.endsWith(".tsx")) continue;
      const code = await readFile(file, "utf8");
      const name = file.pathname.split("/src/client/")[1];
      for (const cell of code.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
        const [, , attributes, markup] = cell;
        // A date read aloud by a label is not drawn, so it cannot wrap.
        const body = markup!.replace(/(?:aria-label|title)=\{`[\s\S]*?`\}/g, "");
        // A date the cell shows, rather than one inside a sentence it says:
        // "Proposed by Rent for Oct 5, 2026" is prose and may wrap like prose.
        if (!outsideTemplates(body).includes("formatDate(")) continue;
        cells += 1;
        const kept =
          /\bnowrap\b/.test(attributes!) ||
          /className="[^"]*\bnowrap\b[^"]*"[^>]*>(?:(?!<\/)[\s\S])*?formatDate\(/.test(body);
        if (!kept) {
          const line = code.slice(0, cell.index).split("\n").length;
          loose.push(`${name}:${line}`);
        }
      }
    }
    // The register, the staged queue, the import preview, Recurring and the
    // account register at least: a reader that stopped matching passes on none.
    expect(cells).toBeGreaterThanOrEqual(5);
    expect(loose, 'give the cell, or the element holding the date, className="nowrap"').toEqual([]);
  });
});
