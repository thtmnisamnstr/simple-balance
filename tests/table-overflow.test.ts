import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ruleFor } from "./support/css.js";

/**
 * Every wide table sits in something that scrolls.
 *
 * `.data-table` carries a 760px `min-width`, so on a narrow panel it is wider
 * than the space it has. Wrapped in a container that scrolls, the far columns
 * stay reachable; wrapped in one that does not, they spill past the panel's
 * edge and cannot be reached at all. That is what `.table-wrap` was for on the
 * templates and recurrences pages, where the class was used but never written,
 * so both had silently overflowed since they shipped.
 *
 * Checked by reading the source, because jsdom computes no layout and would
 * report the overflowing version and the fixed one identically.
 */
const CLIENT = new URL("../src/client/", import.meta.url);

async function tsxFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: URL[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...(await tsxFiles(new URL(`${entry.name}/`, directory))));
    } else if (entry.name.endsWith(".tsx")) {
      found.push(new URL(entry.name, directory));
    }
  }
  return found;
}

describe("wide tables", () => {
  it("are wrapped in a container that scrolls", async () => {
    const styles = await readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");
    const scrolls = new Set(
      [...styles.matchAll(/^\.([\w-]+)\s*\{[^}]*overflow-x:\s*auto/gms)].map((match) => match[1]!),
    );
    expect(scrolls.size).toBeGreaterThan(0);

    const unwrapped: string[] = [];
    for (const file of await tsxFiles(CLIENT)) {
      const source = await readFile(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!/className="data-table\b/.test(line)) return;
        const above = lines.slice(Math.max(0, index - 3), index).join("\n");
        const wrapper = [...above.matchAll(/className="([\w- ]+)"/g)]
          .flatMap((match) => match[1]!.split(/\s+/))
          .some((name) => scrolls.has(name));
        if (!wrapper) {
          unwrapped.push(
            `${file.pathname.split("/client/")[1]}:${index + 1} — no scrolling wrapper`,
          );
        }
      });
    }
    expect(unwrapped).toEqual([]);
  });

  /**
   * `.table-card` brings a card's own border, background and shadow. Inside a
   * panel, which carries the same three, it draws a second card around the
   * first, so the two classes are not interchangeable.
   */
  it("keep the panel wrapper free of a second card's chrome", async () => {
    const styles = await readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");
    // Asked for by selector. Finding the group by the exact line text
    // `.table-card,` made this fail if anybody reordered or resplit the selector
    // list, which is not what the test is about.
    expect(
      ruleFor(styles, ".table-card").length,
      ".table-card carries the card chrome",
    ).toBeGreaterThan(0);

    const wrapRule = ruleFor(styles, ".table-wrap")
      .map((rule) => rule.body)
      .join("\n");
    expect(wrapRule).toContain("overflow-x: auto");
    expect(wrapRule).not.toContain("border");
    expect(wrapRule).not.toContain("background");
    expect(wrapRule).not.toContain("box-shadow");
  });
});

/**
 * Every table says what it is, and every header cell says which way it heads.
 *
 * A `<caption>` is how a table announces itself to somebody moving between
 * tables with a screen reader; without one the announcement is "table, nine
 * columns" and nothing about what is in it. `scope` is how a header cell says
 * whether it heads a column or a row, which is what lets each data cell be read
 * back with the heading it belongs to.
 *
 * Four of the tables people live in had neither — the register, the review
 * queue, templates and recurrences — while the reports and budget tables did.
 * Read from the source for the same reason as the check above: jsdom would
 * report the version with a caption and the version without identically,
 * because neither has a layout and both parse.
 */
describe("table semantics", () => {
  it("gives every data table a caption", async () => {
    const missing: string[] = [];
    for (const file of await tsxFiles(CLIENT)) {
      const source = await readFile(file, "utf8");
      const tables = source.split(/<table\b/).slice(1);
      for (const [index, table] of tables.entries()) {
        // The caption must be the table's first child per the HTML spec, so
        // looking at the opening of the element is the whole check.
        if (!table.slice(0, 400).includes("<caption")) {
          missing.push(`${file.pathname.split("/").at(-1)} table ${index + 1}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives every header cell a scope", async () => {
    const bare: string[] = [];
    for (const file of await tsxFiles(CLIENT)) {
      const source = await readFile(file, "utf8");
      // Offsets come from the whole source rather than from a line lookup: two
      // header cells indented the same way are the same string, so finding one
      // by its text measures whichever came first.
      for (const match of source.matchAll(/<th(?![a-z])/g)) {
        const element = source.slice(match.index, match.index + 400);
        if (!element.slice(0, element.indexOf(">") + 1).includes("scope=")) {
          bare.push(`${file.pathname.split("/").at(-1)} at ${match.index}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });
});
