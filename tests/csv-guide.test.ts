import { describe, expect, it } from "vitest";
import { APP_CSV_COLUMNS, isAppExportCsv, previewCsv, rowsToCsv } from "../src/shared/csv.js";

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
