import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * A column header says `scope="col"` — the value, not just the attribute.
 *
 * `web.md` 9.2, Binding on WCAG 2.2 SC 1.3.1, and item 5 of §17.2, which says
 * what is missing in as many words: `tests/table-overflow.test.ts` "covers the
 * caption and that every `th` carries *a* scope; which one it should be is
 * still uncounted, and a `scope="row"` in a `thead` would pass today". It would:
 * that check asks whether the opening tag contains the string `scope=`.
 *
 * `scope="row"` on a column header is worse than no scope at all. With no
 * scope a screen reader falls back on position and usually guesses right, the
 * cell being in a `thead`. With the wrong one it is told, and it announces every
 * cell in the first column under the heading of whatever row it is in. The
 * register is the table where that costs the most, and 9.2 was broken on it
 * this release in the row direction, which is the same mistake pointing the
 * other way.
 *
 * **The population is every `<thead>`, not every `scope="col"`** (§17.2). And
 * it had to be: five of these fourteen tables write hardly any `<th>` at all.
 * Twenty-five of the product's column headers are `<SortableHeader>`, a shared
 * component carrying the attribute once on everybody's behalf
 * (`src/client/components.tsx:83`) — so a check counting `<th>` in a `thead`
 * would find one cell in the recurrences table, two in the register, and would
 * have nothing to say about the twenty-five that matter most, since those are
 * the interactive ones.
 */

const files = sourceFiles("src/client");

/** The source offsets a region of `tag` covers, as [open, close] pairs. */
function regions(code: string, tag: string): [number, number][] {
  const found: [number, number][] = [];
  for (const match of code.matchAll(new RegExp(`<${tag}(?=[\\s>])`, "g"))) {
    const close = code.indexOf(`</${tag}>`, match.index);
    found.push([match.index, close === -1 ? code.length : close]);
  }
  return found;
}

const within = (spans: [number, number][], index: number) =>
  spans.some(([open, close]) => index > open && index < close);

type Header = {
  file: string;
  line: number;
  /** "th" for literal markup, or the component's name. */
  kind: string;
  scope: string | null;
  section: "thead" | "elsewhere" | "loose";
};

/**
 * Every header cell in the client, each filed under the section it sits in.
 *
 * "loose" is a `<th>` in no table at all, which in this codebase means a shared
 * component's own markup. It is a category rather than a failure, and the
 * register below says which ones are allowed to be loose and what for.
 */
const headers: Header[] = files.flatMap((file) => {
  const heads = regions(file.code, "thead");
  const found: Header[] = [];
  const tableSections = [...regions(file.code, "tbody"), ...regions(file.code, "tfoot"), ...heads];
  for (const match of file.code.matchAll(/<(th|SortableHeader)(?=[\s/>])/g)) {
    const open = file.code.slice(match.index, file.code.indexOf(">", match.index) + 1);
    const scope = /scope=\{?"([a-z]+)"/.exec(open);
    found.push({
      file: file.path,
      line: file.code.slice(0, match.index).split("\n").length,
      kind: match[1]!,
      scope: scope ? scope[1]! : null,
      section: within(heads, match.index)
        ? "thead"
        : within(tableSections, match.index)
          ? "elsewhere"
          : "loose",
    });
  }
  return found;
});

/**
 * A header cell written outside any table, with what it is for.
 *
 * Keyed by the component's name rather than by a line, which has already moved
 * once. `SortableHeader` renders the `<th>` for every sortable column in the
 * product, so its own `scope` is the only copy of the attribute those
 * twenty-five columns have, and it is checked here as if it were in a `thead` —
 * because at every one of its call sites, it is.
 */
const HEADER_COMPONENTS: { file: string; component: string; why: string }[] = [
  {
    file: "src/client/components.tsx",
    component: "SortableHeader",
    // The `<th>` every sortable column is rendered through. Its `scope` is the
    // only copy those twenty-five columns have, so it is held to the thead rule
    // here even though it is written in no table — because at every one of its
    // call sites, it is in one.
    why: "the shared sortable column header; its one scope covers every sortable column",
  },
];

describe("column headers", () => {
  /**
   * The population, before the verdict. §17.2's rule is that a check derives
   * what it looks at from the product, and the way this one breaks is by
   * looking at less of the product than it thinks: a renamed shared component
   * (it is `SortableHeader`, and guessing `SortHeader` reported a confident
   * zero), a `thead` region walk that closes early, or a `scope` pattern that
   * stops matching. So the shape of what was found is asserted first.
   */
  it("finds every column header, including the ones a component writes", () => {
    const inHead = headers.filter((header) => header.section === "thead");
    expect(files.filter((file) => file.code.includes("<thead")).length).toBeGreaterThanOrEqual(9);
    expect(inHead.filter((header) => header.kind === "th").length).toBeGreaterThanOrEqual(50);
    expect(
      inHead.filter((header) => header.kind === "SortableHeader").length,
    ).toBeGreaterThanOrEqual(20);
    // Every `thead` in the product heads at least one column. A table whose
    // header row went missing is a defect this would otherwise call clean.
    for (const file of files) {
      for (const [open] of regions(file.code, "thead")) {
        const line = file.code.slice(0, open).split("\n").length;
        const cells = headers.filter(
          (header) =>
            header.file === file.path && header.section === "thead" && header.line >= line,
        );
        expect(cells.length, `${file.path}:${line} heads no column`).toBeGreaterThan(0);
      }
    }
  });

  it("scopes every one of them to its column", () => {
    const wrong = headers
      .filter((header) => header.section === "thead" && header.kind === "th")
      .filter((header) => header.scope !== "col")
      .map(
        (header) =>
          `${header.file}:${header.line} <${header.kind}> is scope=${header.scope ?? "absent"}`,
      );
    expect(wrong).toEqual([]);
  });

  /**
   * A `<SortableHeader>` carries no `scope` of its own — the component writes
   * it — so the rule at a call site is that it is in a `thead`. One used in a
   * body row would render `scope="col"` on a cell heading a row, which is the
   * defect the test below refuses in its literal spelling.
   */
  it("uses the shared column header only in a header row", () => {
    const misplaced = headers
      .filter((header) => header.kind === "SortableHeader" && header.section !== "thead")
      .map((header) => `${header.file}:${header.line} is in a ${header.section} row`);
    expect(misplaced).toEqual([]);
  });

  /**
   * And the other way round, which is the half the register broke on: a
   * `scope="col"` on a cell that heads a row tells a reader the rest of the row
   * belongs to it.
   */
  it("scopes no body or footer cell to a column", () => {
    const wrong = headers
      .filter((header) => header.section === "elsewhere")
      .filter((header) => header.scope === "col")
      .map((header) => `${header.file}:${header.line} heads a row but says scope="col"`);
    expect(wrong).toEqual([]);
  });

  it("writes a header cell outside a table only where there is an argument for it", () => {
    const explained = new Set(HEADER_COMPONENTS.map((entry) => entry.file));
    const loose = headers.filter((header) => header.section === "loose" && header.kind === "th");
    const unexplained = loose
      .filter((header) => !explained.has(header.file) || header.scope !== "col")
      .map(
        (header) =>
          `${header.file}:${header.line} <th> outside a table, scope=${header.scope ?? "absent"}`,
      );
    expect(unexplained).toEqual([]);
    // And the register is not excusing something that has gone: the shared
    // component has to still be there, writing the cell it is registered for.
    for (const entry of HEADER_COMPONENTS) {
      expect(
        loose.some((header) => header.file === entry.file),
        `${entry.component} no longer writes a header cell of its own`,
      ).toBe(true);
    }
  });
});
