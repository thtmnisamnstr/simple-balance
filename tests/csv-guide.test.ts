import { describe, expect, it } from "vitest";
import {
  APP_CSV_COLUMNS,
  APP_CSV_EXTERNAL_ID_COLUMN,
  APP_CSV_FORMAT,
  APP_CSV_LEGS_COLUMN,
  csvCell,
  isAppExportCsv,
  previewCsv,
  rowsToCsv,
} from "../src/shared/csv.js";

/**
 * The two reading rules `docs/standards/csv.md` states and nothing asserted.
 *
 * Both are read-side behaviour the guide names as deliberate and then admits it
 * cannot show: the BOM bullet in §3 called itself "the single cheapest test
 * missing from this interface", and the trim departure in §2 is one of four
 * departures from RFC 4180 that the guide writes down precisely so nobody
 * corrects them back to the specification. A departure nothing checks is a
 * departure somebody closes as a bug.
 *
 * They live in a file of their own rather than in `tests/domain.test.ts`
 * because the guide is what they answer to: each is the mechanism for a named
 * section, and a reader going from a `*Checked by:*` line to the assertion
 * should land on it.
 */

/**
 * A BOM on read is stripped, whatever wrote the file.
 *
 * The guide read this as the dependency's behaviour alone. It is held twice
 * over, and mutation is what showed it: neutering Papa Parse's own `stripBom`
 * leaves every case below passing, because U+FEFF is ECMAScript WhiteSpace and
 * so departure 1's `trim()` takes it off as well. Removing our two transforms
 * instead leaves the leading-BOM case passing on the parser alone. Only
 * removing both fails it.
 *
 * That is worth a test rather than a note, because the two mechanisms cover
 * different ground: the parser strips one mark at offset zero, and the trim
 * strips one leading any cell or header anywhere in the file. The second case
 * below is the half only our own code holds.
 *
 * The consequence is the assertion, not the byte. A leading U+FEFF left in
 * place makes the first header read `\uFEFFsimple_balance_format`, which is not
 * in `APP_CSV_COLUMNS`, so `isAppExportCsv` stops recognizing this product's
 * own export the moment it has been through Excel — and a file that is not
 * recognized is read as a foreign bank file, with every column mapped by hand
 * or not at all.
 */
describe("a byte-order mark in front of a header", () => {
  // Built from its code point, never written as the character, for the reason
  // `tests/domain.test.ts` gives for the full-width formula spellings:
  // written literally, the thing under test is invisible in the source, and a
  // copy that loses it leaves a test that passes for no reason.
  const BOM = String.fromCodePoint(0xfeff);
  const header = APP_CSV_COLUMNS.join(",");
  const row = APP_CSV_COLUMNS.map(() => "").join(",");

  it("is stripped, so one of our own exports is still recognized", () => {
    const withBom = previewCsv(`${BOM}${header}\r\n${row}\r\n`);

    expect(withBom.headers[0]).toBe("simple_balance_format");
    expect(isAppExportCsv(withBom.headers)).toBe(true);
    // Against the same file without one, so the claim is "the same" rather
    // than "recognized", which would also pass if the mark were renaming some
    // other column.
    expect(withBom.headers).toEqual(previewCsv(`${header}\r\n${row}\r\n`).headers);
  });

  it("is stripped from a cell the mark leads as well as from the header", () => {
    expect(previewCsv(`payee\r\n${BOM}Shop\r\n`).rows[0]).toEqual({ payee: "Shop" });
  });
});

/**
 * Departure 1 of four: we trim, and RFC 4180 rule 4 says not to.
 *
 * Rule 4 is a SHOULD — a leading or trailing space "is considered part of a
 * field and should not be ignored" — and `previewCsv` hands Papa Parse a
 * `transform` and a `transformHeader` that call `trim()` anyway. A trailing
 * space in a bank's header row is common and never meaningful, and a payee cell
 * padded to a column width is the same.
 *
 * The padded cell was already reaching `previewCsv`, in the formula test in
 * `tests/domain.test.ts`: `"  +SUM(1,2)"` goes in and `"'  +SUM(1,2)"` comes
 * back. That proves nothing about the trim. The apostrophe the neutralizer
 * prefixes makes the two spaces interior, so the assertion holds whether the
 * transform is there or not — which is the shape of a test that looks like
 * cover and is not.
 *
 * The second case is the other half of the departure and the one that bounds
 * it: interior whitespace is untouched, so this fails if `trim()` is ever
 * widened into a collapse. The payee is collapsed later, by `cleanHumanName`
 * on the way into the ledger, and doing it here would apply it to every column
 * including a note.
 */
describe("whitespace around a cell", () => {
  it("is trimmed off the header and off the value", () => {
    const preview = previewCsv("  Date  ,\tPayee,Amount \r\n 2026-01-01 ,  Shop  ,\t12.34 \r\n");

    expect(preview.headers).toEqual(["Date", "Payee", "Amount"]);
    expect(preview.rows[0]).toEqual({ Date: "2026-01-01", Payee: "Shop", Amount: "12.34" });
  });

  it("is left alone inside the field, including a newline in a quoted note", () => {
    const preview = previewCsv(rowsToCsv([{ payee: "ACME  Co", notes: "line 1\nline 2" }]));

    expect(preview.rows[0]).toEqual({ payee: "ACME  Co", notes: "line 1\nline 2" });
  });
});

/**
 * §6: column order is not part of the contract.
 *
 * The guide's own ranking calls this "the cheapest to mechanize and the one I
 * would build first", and it has never been asserted. An importer that started
 * reading by position would pass every test in this repository, because every
 * fixture is written in the order the exporter writes — and the first file to
 * break would be one that had been through a spreadsheet with a column dragged,
 * which is the single most likely thing to happen to a CSV between two people.
 *
 * Reversed rather than shuffled, so the file is the same on every machine and a
 * failure is the same failure twice.
 */
describe("the columns of one of our own exports", () => {
  const reversed = [...APP_CSV_COLUMNS].reverse();
  const values: Record<string, string> = {
    ...Object.fromEntries(APP_CSV_COLUMNS.map((column) => [column, ""])),
    simple_balance_format: APP_CSV_FORMAT,
    transaction_id: "11111111-1111-4111-8111-111111111111",
    transaction_type: "withdrawal",
    date: "2026-03-14",
    payee: "Blue Bottle",
    source_amount: "12.34",
    source_currency: "USD",
  };
  const fileOf = (columns: readonly string[]) =>
    `${columns.join(",")}\r\n${columns.map((column) => values[column] ?? "").join(",")}\r\n`;

  it("are recognized in any order, and read by name", () => {
    const written = previewCsv(fileOf(APP_CSV_COLUMNS));
    const dragged = previewCsv(fileOf(reversed));

    expect(isAppExportCsv(written.headers)).toBe(true);
    expect(isAppExportCsv(dragged.headers)).toBe(true);
    // The header row really did move, or the two files are the same file and
    // this asserts nothing.
    expect(dragged.headers).not.toEqual(written.headers);
    expect(new Set(dragged.headers)).toEqual(new Set(written.headers));

    const one = written.rows[0]!;
    const other = dragged.rows[0]!;
    expect(csvCell(other, "date")).toBe(csvCell(one, "date"));
    expect(csvCell(other, "transaction_type")).toBe(csvCell(one, "transaction_type"));
    expect(csvCell(other, "date")).toBe("2026-03-14");
    expect(csvCell(other, "transaction_type")).toBe("withdrawal");
    // And every other column with it, so a reader that got two right by
    // coincidence of position does not pass.
    expect(other).toEqual(one);
  });
});

/**
 * §15, and §16 item 2: the recognition set is never shortened.
 *
 * `isAppExportCsv` asks for every column in `APP_CSV_COLUMNS` to be present, so
 * removing one from the list widens what is recognized and adding one narrows
 * it — and narrowing is the direction that does the damage. A file written by
 * any earlier version carries exactly these nineteen; the moment a twentieth is
 * required, every one of those files stops being recognized as an export and is
 * read as a foreign bank file instead, with its ids and its round-trip text
 * ignored.
 *
 * So the committed list is written out here rather than derived. A test that
 * read the same constant it is checking would agree with any edit, which is the
 * failure `tests/product-facts.test.ts` names: a check that rewrites what it is
 * checking is not a check.
 */
describe("the columns a file must carry to be read as one of ours", () => {
  const SHIPPED = [
    "simple_balance_format",
    "transaction_id",
    "transaction_type",
    "date",
    "payee",
    "description",
    "category_id",
    "category_name",
    "notes",
    "roundtrip_text_json",
    "source_account_id",
    "source_account_name",
    "source_amount",
    "source_currency",
    "destination_account_id",
    "destination_account_name",
    "destination_amount",
    "destination_currency",
    "effective_rate",
  ];

  it("is exactly what has shipped, so no older file stops being recognized", () => {
    // Set equality rather than a superset, because the two directions fail for
    // different reasons and both are defects: a column dropped from the list
    // widens recognition onto files that are not ours, and one added to it
    // makes every file written before today unrecognizable.
    expect([...APP_CSV_COLUMNS].sort()).toEqual([...SHIPPED].sort());
  });

  it("recognizes a file carrying the shipped columns and nothing else", () => {
    expect(isAppExportCsv(SHIPPED)).toBe(true);
    // The two columns an export writes and does not require, named in the
    // module for this reason: a file from a version before splits carries
    // neither, and is still ours.
    expect(SHIPPED).not.toContain(APP_CSV_LEGS_COLUMN);
    expect(SHIPPED).not.toContain(APP_CSV_EXTERNAL_ID_COLUMN);
    expect(isAppExportCsv([...SHIPPED, APP_CSV_LEGS_COLUMN, APP_CSV_EXTERNAL_ID_COLUMN])).toBe(
      true,
    );
    // And one short of the set is not ours, which is what makes the assertion
    // above about recognition rather than about a list.
    expect(isAppExportCsv(SHIPPED.slice(1))).toBe(false);
  });
});
