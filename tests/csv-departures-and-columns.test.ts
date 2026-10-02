import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_CSV_EXTERNAL_ID_COLUMN, previewCsv, rowsToCsv } from "../src/shared/csv.js";

/**
 * Four rules `csv.md` states, marks unchecked, and depends on.
 *
 * Each is held by the product today and none of them is held by anything that
 * would notice it changing. Two are departures from RFC 4180 that the guide
 * writes down "precisely so nobody corrects them back to the specification",
 * which is a sentence that only works if something fails when somebody does.
 */

/**
 * Departure 2: a blank line is not a record.
 *
 * `skipEmptyLines: "greedy"` drops a record that is empty or only separators
 * and whitespace, and the grammar has no such rule. A trailing newline is
 * how most files end and how every editor saves one; read as RFC 4180 says, a
 * bank file ending in one stages a transaction with every field missing, which
 * arrives in the queue as a row somebody has to look at and delete.
 *
 * Interior as well as trailing, because the two come from different mistakes:
 * "greedy" is what covers a line of bare separators in the middle of a file,
 * and plain `true` would not.
 */
describe("a blank line in a CSV file", () => {
  it("is dropped, trailing and interior alike", () => {
    const preview = previewCsv("payee,amount\nShop,10\n\n , \nCafe,20\n\n");

    expect(preview.rows).toEqual([
      { payee: "Shop", amount: "10" },
      { payee: "Cafe", amount: "20" },
    ]);
    // Said separately: a reader that kept the blank rows and also reported them
    // as faults would be a different product, and one whose rows are right
    // while it complains is a preview screen full of red.
    expect(preview.errors).toEqual([]);
  });
});

/**
 * Departure 4: a repeated header name is given a suffix rather than collapsed.
 *
 * Inherited from Papa Parse rather than chosen, which is exactly why it needs
 * a test: nothing in this repository decided it, so nothing in this repository
 * would notice a parser upgrade deciding otherwise. The alternative in a
 * `header: true` parse is one column silently overwriting the other, and the
 * two columns a bank file calls `Amount` twice are usually debit and credit.
 */
describe("two columns with the same header", () => {
  it("arrive under distinct names rather than overwriting each other", () => {
    const preview = previewCsv("Date,Amount,Amount\n2026-03-14,10,20\n");

    expect(preview.headers).toEqual(["Date", "Amount", "Amount_1"]);
    expect(preview.rows[0]).toEqual({ Date: "2026-03-14", Amount: "10", Amount_1: "20" });
  });
});

/**
 * §5: an empty cell means absent, `0` means zero, and neither is a word.
 *
 * The two are one rule because the failure is confusing them. A writer that
 * printed an absent value as `0` would turn "no category budget" into "budget
 * nothing"; a writer that printed a zero as empty would lose a row that says
 * the balance really is nothing. The label is the third form of the same
 * mistake: `Uncategorized` is what a report calls the absence of a category,
 * and a file carrying it re-imports as a category by that name.
 */
describe("an empty value and a zero", () => {
  it("are written as an empty cell and as 0, and never as a word", () => {
    const csv = rowsToCsv([
      { category_name: undefined, amount: "0", notes: null },
      { category_name: "Rent", amount: "10", notes: "" },
    ]);

    expect(csv).toBe("category_name,amount,notes\r\n,0,\r\nRent,10,");
    expect(csv).not.toContain("Uncategorized");
    expect(csv).not.toContain("null");
  });

  it("survive the round trip without becoming each other", () => {
    const rows = previewCsv("category_name,amount\n,0\n").rows;

    expect(rows[0]!.amount, "a zero is a value").toBe("0");
    // Empty rather than missing: Papa fills every declared column, and the
    // reader turns the empty string into `null` with `|| null` at each site.
    // What matters here is that it is distinguishable from "0" — a reader
    // cannot tell absent from zero once they are the same string.
    expect(rows[0]!.category_name, "an empty cell is not a zero").toBe("");
  });
});

/**
 * §16 item 3: the neutralized column list matches the free-text columns.
 *
 * `csv.md` ranks this third among the checks it has not built, and names what
 * it is for: "so a new text column cannot be added unprotected". A cell
 * beginning `=`, `+`, `-` or `@` can execute when the file is opened in a
 * spreadsheet, and the failure lands in somebody else's spreadsheet rather
 * than in this ledger, which is the kind nobody here would ever see.
 *
 * The list is written in three places — the call site, §6's column table and
 * §15's prose — and the check is that all three say the same thing. A column
 * added to the export and to the table without the neutralizer fails here.
 */
describe("the formula-neutralized columns", () => {
  /** The list the exporter actually passes, read off the call site. */
  const neutralizedAtCallSite = (): string[] => {
    const source = readFileSync("src/server/services/import-export.ts", "utf8");
    const call = source.indexOf("rowsToCsv(");
    expect(call, "import-export.ts calls rowsToCsv").toBeGreaterThan(-1);
    const open = source.indexOf("[", call);
    const close = source.indexOf("]", open);
    expect(close, "the neutralized column list is an array literal").toBeGreaterThan(open);
    return source
      .slice(open + 1, close)
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => {
        if (token.startsWith('"')) return token.slice(1, -1);
        // One entry is a constant rather than a literal, because the importer
        // reads the same column by the same name. Resolved rather than
        // skipped, and an unknown identifier fails loudly: a silent skip would
        // quietly shrink the list this whole check compares.
        if (token === "APP_CSV_EXTERNAL_ID_COLUMN") return APP_CSV_EXTERNAL_ID_COLUMN;
        throw new Error(`Unresolved column in the neutralized list: ${token}`);
      });
  };

  /** §6's column table, which says of each column what it is written for. */
  const columnTable = (): { column: string; writtenFor: string; readBack: string }[] => {
    const guide = readFileSync("docs/standards/csv.md", "utf8");
    const table = guide.slice(guide.indexOf("| Column | Written for | Read back |"));
    return [...table.matchAll(/^\| `([a-z_]+)` \| ([^|]+?) \| ([^|]+?) \|$/gm)].map((match) => ({
      column: match[1]!,
      writtenFor: match[2]!.trim(),
      readBack: match[3]!.trim(),
    }));
  };

  /** Every column the reader strips a leading apostrophe back off. */
  const restoredByReader = (): Set<string> => {
    const source = readFileSync("src/server/services/import-export.ts", "utf8");
    return new Set(
      [...source.matchAll(/restoreNeutralizedCell\(\s*row(?:\.|\[)([A-Za-z_]+)/g)].map((match) =>
        match[1] === "APP_CSV_EXTERNAL_ID_COLUMN" ? APP_CSV_EXTERNAL_ID_COLUMN : match[1]!,
      ),
    );
  };

  it("are the same seven at the call site and in the column table", () => {
    const rows = columnTable();
    expect(rows.length, "the column table parsed").toBeGreaterThan(15);

    const fromTable = rows
      .filter((row) => row.writtenFor.includes("formula-neutralized"))
      .map((row) => row.column);
    expect([...neutralizedAtCallSite()].sort(), "one list, two places").toEqual(
      [...fromTable].sort(),
    );
  });

  it("are the same seven in the prose that names them", () => {
    const guide = readFileSync("docs/standards/csv.md", "utf8");
    const bullet = guide.slice(guide.indexOf("It is applied to exactly seven columns"));
    const named = [...bullet.slice(0, 400).matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!);
    // The prose is the sentence a reader meets first and the only one of the
    // three that states a number, so a column added to the code and the table
    // and not here leaves the guide saying seven of eight.
    expect([...new Set(named)].sort(), "one list, three places").toEqual(
      [...neutralizedAtCallSite()].sort(),
    );
  });

  it("cover every column the reader strips an apostrophe back off", () => {
    const restored = restoredByReader();
    expect(restored.size, "the reader restores something").toBeGreaterThan(3);

    const neutralized = new Set(neutralizedAtCallSite());
    // One direction only, and the other is the next assertion. `restoreNeutra-
    // lizedCell` is not injective: on a column nothing ever neutralized it
    // takes a leading apostrophe off a value that was typed with one.
    expect(
      [...restored].filter((column) => !neutralized.has(column)),
      "nothing is un-neutralized that was never neutralized",
    ).toEqual([]);
  });

  it("exceed the restored ones by exactly the columns the table says are never read back", () => {
    const restored = restoredByReader();
    const outputOnly = new Set(
      columnTable()
        .filter((row) => row.readBack === "No")
        .map((row) => row.column),
    );
    // A neutralized column the reader skips is correct exactly when the table
    // says the column is output-only. Anything else is a column written with an
    // apostrophe and read back with it still attached, which is how a category
    // named `-Reimbursements` became a second category on every trip.
    expect(
      neutralizedAtCallSite()
        .filter((column) => !restored.has(column))
        .filter((column) => !outputOnly.has(column)),
      "a neutralized column is restored, or the table says it is never read",
    ).toEqual([]);
  });
});
