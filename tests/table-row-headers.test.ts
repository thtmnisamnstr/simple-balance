import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * A table that heads one of its rows heads all of them.
 *
 * `web.md` 9.2 is Binding on WCAG 2.2 SC 1.3.1: `<th scope="row">` on the cell
 * that names a row, so a data cell can be read back with the heading it belongs
 * to. `tests/table-overflow.test.ts` already asks that every `<th>` carries a
 * `scope` — and that check cannot see a cell that is not a `<th>` at all, which
 * is the shape the defect actually took.
 *
 * The register renders two kinds of row into one `<tbody>`: the staged rows,
 * and the committed rows a hundred-odd lines below them. The committed branch
 * opened its payee cell as `<th scope="row">` and the staged branch opened the
 * same column as a bare `<td>`, so a staged row announced "Checking,
 * −$45.00" with nothing tying those cells to anything — on exactly the rows
 * somebody opened the page to repair. Both branches were green: one table, one
 * column, two markup branches, and nothing compared them.
 *
 * So the population is **every `<tbody>` in the client**, and the question is
 * asked of the table rather than of the cell (`web.md` 17.2: a check derives
 * its population from the product, never from the presence of the thing it is
 * checking). A table that heads no row at all is outside this: whether a table
 * has an identifying column is a decision per table, and the raw CSV preview
 * genuinely has none — its columns are whatever the uploaded file named, and
 * the first of them is as often a date as a name.
 *
 * Read from the source, for the reason the checks beside it give: jsdom parses
 * a `<td>` where a `<th>` belongs without complaint and computes no layout, so
 * a rendered assertion would have to name every page and every branch by hand —
 * which is the shape that let this ship.
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

type RowBranch = {
  /** Source offset of the `<tr`, so a failure names the edit rather than the shape. */
  readonly at: number;
  readonly headed: boolean;
  /**
   * True for a row that spans the table rather than holding one record: a
   * "nothing here" line or a totals strip. It has no identifying cell because
   * it names no row, so it neither needs a header nor counts as one missing.
   */
  readonly spanning: boolean;
};

type Body = {
  readonly file: string;
  readonly line: number;
  readonly rows: RowBranch[];
};

function bodies(source: string, file: string): Body[] {
  const found: Body[] = [];
  for (const open of source.matchAll(/<tbody\b/g)) {
    const start = open.index;
    const close = source.indexOf("</tbody>", start);
    const region = source.slice(start, close === -1 ? source.length : close);
    const rows: RowBranch[] = [];
    for (const row of region.matchAll(/<tr\b/g)) {
      const next = region.indexOf("<tr", row.index + 3);
      const branch = region.slice(row.index, next === -1 ? region.length : next);
      rows.push({
        at: start + row.index,
        headed: /<th\s+scope="row"/.test(branch),
        spanning: /\bcolSpan\b/.test(branch),
      });
    }
    found.push({ file, line: source.slice(0, start).split("\n").length, rows });
  }
  return found;
}

describe("a table whose rows are named", () => {
  it("names them in every branch that renders a row", async () => {
    const all: Body[] = [];
    for (const file of await tsxFiles(CLIENT)) {
      all.push(...bodies(await readFile(file, "utf8"), file.pathname.split("/").at(-1)!));
    }
    // An empty population passes every claim made over it, and a population of
    // single-branch tables would pass this one without ever comparing two.
    expect(all.length, "no table bodies were read").toBeGreaterThan(10);
    expect(
      all.filter((body) => body.rows.length > 1).length,
      "no table renders two row branches, so nothing was compared",
    ).toBeGreaterThan(0);

    const mixed: string[] = [];
    for (const body of all) {
      const naming = body.rows.filter((row) => !row.spanning);
      if (!naming.some((row) => row.headed)) continue;
      for (const row of naming) {
        if (row.headed) continue;
        mixed.push(`${body.file}: tbody at line ${body.line}, <tr> at offset ${row.at}`);
      }
    }
    expect(
      mixed,
      'open the identifying cell as <th scope="row"> in this branch too, as the other branch of the same table does',
    ).toEqual([]);
  });

  /**
   * The register by name, because it is the one table in the product with two
   * row branches and the one the defect was found in. Stated separately from
   * the derived check above so that deleting the staged branch — which would
   * make the derived check vacuously true of this file — fails here instead.
   */
  it("heads both of the register's branches, staged and committed", async () => {
    const source = await readFile(new URL("TransactionBrowser.tsx", CLIENT), "utf8");
    const register = bodies(source, "TransactionBrowser.tsx").find((body) => body.rows.length > 1);
    expect(register, "the register no longer renders two kinds of row").toBeDefined();
    expect(register!.rows.every((row) => row.headed)).toBe(true);
    // The staged branch is the one that was bare, and it is the earlier of the
    // two. Pinned so that heading only the committed row reads as a failure
    // here rather than as a pass on a count.
    expect(register!.rows.length).toBe(2);
    expect(register!.rows[0]!.headed).toBe(true);
  });
});
