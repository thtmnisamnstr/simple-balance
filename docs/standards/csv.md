# CSV

The import and export format. This is the only way a ledger leaves this product
in bulk, so it is the thing that makes the product non-captive, and it is the
one interface whose reader is usually somebody debugging rather than somebody
building. That is why it has its own file.

Read [`common.md`](common.md) first. Money, dates, error sentences, the glossary
and the voice are settled there and are not repeated here. What is here is what
is true of a value once it is a cell in a file that Excel, a bank and our own
importer all have opinions about.

Everything is grounded in three places: `src/shared/csv.ts`, which both the
browser preview and the server use, `src/server/services/import-export.ts`,
which reads and writes files, and `src/server/api.ts:1449-1469`, which is the
transport.

## 1. Why CSV, and why no apology

**House.** CSV is the interchange format. There is no second one and no plan for
one.

Every alternative needs a gatekeeper. OFX is at Banking version 2.3 under the
FDX OFX Work Group and needs a bank relationship. QFX is proprietary; Quicken's
2006 release dropped QIF import for checking, savings and credit card accounts
and pointed at QFX instead. camt.053 is an ISO 20022 bank-to-customer statement
and arrives from a bank or not at all. For a self-hosted ledger with no bank
connection, CSV is not the fallback. It is the only format with nobody in the
middle.

Two of the commercial products surveyed in [`../roadmap.md`](../roadmap.md)
charge for the exit. This format is the answer to that, so it is a feature and
it is documented like one.

*Not checked mechanically.* This is a decision, not a rule.

## 2. RFC 4180, and the four places we depart from it

**Binding.** [`index.md`](index.md) sets the conformance target: RFC 4180, with
the departures named here.

RFC 4180 is Informational and says of itself that "there is no formal
specification in existence, which allows for a wide variety of interpretations
of CSV files". Its grammar is short enough to settle the arguments outright:

```
file    = [header CRLF] record *(CRLF record) [CRLF]
record  = field *(COMMA field)
field   = (escaped / non-escaped)
escaped = DQUOTE *(TEXTDATA / COMMA / CR / LF / 2DQUOTE) DQUOTE
```

Rules 4 and 6 are **SHOULD**, not MUST. Spaces "are considered part of a field
and should not be ignored", and fields containing a comma, CR, LF or a double
quote "should be enclosed in double-quotes". A guide that writes MUST there is
asserting a strictness the document does not carry, which matters because three
of our four departures sit on exactly those two rules.

**The write side conforms.** `rowsToCsv` at `src/shared/csv.ts:496-509` emits
one header record, CRLF between records, no trailing CRLF, and quotes a field
only when it contains `"`, `,`, CR or LF, doubling an internal quote. Nothing
else is quoted, so the file stays readable to a human eye.

*Checked by:* `tests/domain.test.ts` ("round-trips commas, quotes, and line
breaks"), and `tests/integration/splits-roundtrip.integration.test.ts:105-112`,
which splits an exported file on `\r\n` to find its header.

The departures, all on the read side, all deliberate:

1. **We trim.** `previewCsv` and `stageCsv` both hand Papa Parse a `transform`
   and a `transformHeader` that call `trim()` (`src/shared/csv.ts:199-214`,
   `src/server/services/import-export.ts:792-793`). Rule 4 says a leading or
   trailing space is part of the field. A trailing space in a bank's header row
   is common and never meaningful, and a payee cell padded to a column width is
   the same. **House, knowing departure.** Written down so nobody corrects it
   back to the specification. Interior whitespace, including a newline inside a
   quoted note, is untouched. *Not checked mechanically.* No test feeds a padded
   header or a padded cell through `previewCsv`.
2. **We skip blank lines.** `skipEmptyLines: "greedy"` drops a record that is
   empty or only separators and whitespace. The grammar has no such rule. A
   trailing blank line at the end of a bank file is not a transaction with every
   field missing. **House.** *Not checked mechanically.*
3. **We sniff the delimiter on read.** The grammar says comma. See section 4.
   **House.**
4. **Papa Parse renames a repeated header.** Two columns both called `Amount`
   arrive as `Amount` and `Amount_1`. The grammar says nothing about repeated
   names; the alternative in a `header: true` parse is one silently overwriting
   the other. **House, inherited from the parser rather than chosen.** *Not
   checked mechanically.*

## 3. Bytes

- **UTF-8, always.** The export is a JavaScript string, served with a
  `charset=utf-8` media type (`CSV_MEDIA_TYPE`, `src/shared/csv.ts:19`). The
  import is a string by the time it reaches us: the browser decodes the file
  with `file.text()` (`src/client/pages/ImportPage.tsx:172`) and an API or MCP
  caller sends a JSON string, which is UTF-8 by definition. Nothing in this product reads a byte
  stream, so there is no encoding to guess and no `encoding` directive of the
  kind hledger has. **House.**
- **The export writes no BOM.** `rowsToCsv` starts with the first header name.
  **House.**
- **A BOM on read is stripped, unconditionally.** Papa Parse 5.6.0 removes a
  leading U+FEFF from a string input and from a header before either is used, so
  a file that has been through Excel imports the same as one that has not. This
  is load-bearing: without it the first header would read
  `﻿simple_balance_format` and `isAppExportCsv` would not recognise our own
  file. **House**, and load-bearing rather than tasteful: nothing in a
  specification or in `AGENTS.md` requires it, and without it `isAppExportCsv`
  stops recognising this product's own file. *Not checked by us.* The behaviour
  is the dependency's and no test of ours asserts it, which is the single
  cheapest test missing from this interface.
- **CRLF between records, and no trailing newline.** `rowsToCsv` joins with
  `\r\n`. Reading accepts LF or CRLF, because Papa Parse detects it. **House**,
  matching the grammar's `[CRLF]` as optional.

*Checked by:* `tests/integration/splits-roundtrip.integration.test.ts:99`,
which splits an exported file on a literal `\r\n` and counts the records, so a
change of line ending fails it. Encoding and the BOM are not checked
mechanically.

**Contested: whether a browser download should carry a BOM.** Three positions
are defensible. Never write one, which is clean for a program and can leave a
non-ASCII payee mangled in a spreadsheet. Always write one, which round-trips
through our own reader but hands a non-BOM-aware third-party consumer a first
column named with an invisible character. Write one only on the browser download
path, on the argument that a download is a person opening a spreadsheet and an
API response is a program. **This product picked "never", everywhere.** It is
the position the code holds today rather than one that was argued out, and the
evidence that would settle it does not exist: the widely repeated claim that
Excel on Windows decodes a BOM-less CSV with the ANSI code page is folk
knowledge, and the Unicode FAQ, which does say a BOM is "only used as a
signature" and warns that it "will interfere with any protocol or file format
that expects specific ASCII characters at the beginning", says nothing about
Excel at all. Reproduce the Excel behaviour before reopening this.

**House.** RFC 4180's media type registration defines an optional `header`
parameter with the values `present` and `absent`, and it is the parameter that
decides how a reader treats the first record. The export declares it:
`CSV_MEDIA_TYPE` is `text/csv; charset=utf-8; header=present`
(`src/shared/csv.ts:19`), served by the export route in `src/server/api.ts`.
`present` is unconditionally true here because of section 12 — an export
matching nothing is a header-only file rather than the empty string — so this
product has no export whose first record is not a header.

**Settled.** The download filename is dated in the person's own timezone,
through `todayIn(timezone)` like every other "today" in this product
(`src/server/api.ts:1457-1468`). It used to read the server clock, so somebody
at UTC+13 downloading at 09:00 got yesterday's date on the file — the one thing
a dated filename exists to get right.

## 4. The delimiter, and the semicolon problem

**House.** **Import sniffs. Export is always a comma.**

Papa Parse guesses the delimiter and the preview reports what it guessed, both
in the API response (`CsvPreview.delimiter`, `src/shared/csv.ts:167-214`) and on
screen (`src/client/pages/ImportPage.tsx:318-322`). The import screen says so
before a file is chosen: "Comma, semicolon, and tab delimiters are detected
automatically."

A locale-varying export cannot round trip, and the `simple_balance_format` token
claims a specific shape, so the export never varies. Anybody who needs
semicolons has a spreadsheet that will make them.

The reason sniffing is worth having: Excel's CSV delimiter and encoding vary by
locale settings, and semicolon-delimited CSV is ordinary wherever the comma is
the decimal mark. That statement is as strong as the evidence supports. The two
community threads usually cited for a specific Windows setting contradict each
other, one blaming the regional list separator and the other the decimal and
thousands separator, and neither is Microsoft documentation. **Name no setting
in this guide.**

**House.** **The decimal separator is asked, never sniffed.** `decimalSeparator`
is an explicit `"."` or `","` on the stage call, defaulting to `"."`
(`src/server/services/import-export.ts:92-100`), and the import screen offers it as
`1,234.56` or `1.234,56`. Sniffing it would mean deciding whether `12,34` is
twelve or one thousand two hundred and thirty-four from one cell, and
`parseLocalizedAmount` refuses that pair outright rather than picking.

*Checked by:* `tests/domain.test.ts` ("detects delimiters and headers", "parses
US, European, and parenthesized numbers", "rejects malformed or mismatched
thousands separators"), `tests/import-ui.test.tsx`.

**House.** **One of our own exports is locale-independent.** Its amounts are
read straight out of their columns and validated as decimal strings, so
`decimalSeparator` and `dateFormat` decide nothing for it. The import screen
hides both controls when it recognises the file, along with every column
mapping, because a control that decides nothing looked like it decided the
account.

*Checked by:* `tests/import-ui.test.tsx` ("asks for the account and hides the
mapping it would ignore", "stages against the chosen account and sends no
mapping").

## 5. What a cell holds

### Money

**Binding.** `AGENTS.md`: "Never represent money with JavaScript/JSON
floating-point numbers. Use validated decimal strings and PostgreSQL
`numeric(44,18)`." A CSV cell is one of the boundaries `common.md` names, and it
is the boundary where the temptation is strongest, because a spreadsheet will
happily turn the column into a float the moment it opens.

- **An amount in an exported cell is a canonical decimal string.** No thousands
  separator, `.` as the decimal mark, trailing zeros stripped, at most 26
  integer and 18 fractional digits. That is `canonicalDecimal`
  (`src/server/services/helpers.ts:23-28`), the same function the API returns.
- **An exported amount is never negative.** Direction is the `transaction_type`
  column. `positiveDecimalStringSchema` already says it: "Direction comes from
  the transaction type, so this is never negative."
- **No cell holds a figure spanning currencies.** There is no such number in
  this ledger and the format has nowhere to put one. A cross-currency transfer
  states both amounts and lets the rate be implied.

*Checked by:* `tests/domain.test.ts`, `tests/ledger.test.ts`, and the round-trip
integration tests.

### Reading an amount out of a bank file

`parseLocalizedAmount` (`src/shared/csv.ts:216-254`) accepts, for a given
decimal separator: a bare decimal, the configured grouping separator or a space
as a thousands separator but not both, a leading minus, and a parenthesised
negative. It refuses a leading `+`, an interior minus, an inconsistent grouping
run, and anything that is not digits after the point. It returns a decimal
string or nothing. **House.**

*Checked by:* `tests/domain.test.ts`, "parses US, European, and parenthesized
numbers" and "rejects malformed or mismatched thousands separators".

### Direction, stated exactly once

**House.** A file may state direction with a signed amount column, or with a
debit and a credit column. It may not state it twice. This is House rather than
Contested because no published guidance covers the case at all: a comparable
product chose the loose answer and this one chose the strict one, which is a
disagreement between products rather than within a source.

- Both columns mapped, one of them holding a value: the column decides, and a
  minus sign in it is read as redundant rather than contradictory. That is how
  nearly every two-column bank export is written.
- Both columns mapped, both holding a non-zero value: refused.
- One column mapped and its value is signed: refused, and the refusal explains
  why, because in that file the sign is the only other thing that could state
  direction and nothing says which was meant.

The disagreement is real. Actual Budget gives the loose answer, a "Flip amount"
toggle plus a preview, and lets the person look. This product gives the strict
one and refuses the row: "A negative value states a direction the column already
states, and this file has no other column to say which was meant." Since this
product has both a preview and a staging queue, the strict answer may be
stricter than it needs to be. **It is kept because a silently reversed
withdrawal is the one import error nobody catches by eye**, and half of real
files would be reversed by whichever way the guess went. Argue with that
sentence, not with the code.

*Checked by:* `tests/domain.test.ts`, the block "a signed value in a debit or
credit column", eleven cases including a signed zero, which is left alone.

### Dates

**Binding**, deferring to `common.md`. A cell holding a calendar date is
`YYYY-MM-DD` on export, straight from the transaction. On import the order is
chosen by the person as `YMD`, `MDY` or `DMY`
(`src/server/services/import-export.ts:86-91`) and parsed by `parseCsvDate`
(`src/shared/csv.ts:256-317`).

**House.** **No two-digit years, and no inferred order.** `parseCsvDate`
requires a four-digit year and does not attempt to tell `03/04/2026` apart by
looking at the other rows. The person answers. A date the parser cannot read
costs the date and nothing else: the row still stages with its payee, amount and
description.

*Checked by:* `tests/domain.test.ts` ("turns signed bank rows into deposits and
withdrawals", which reads `MDY`, and "keeps what it read from a row it could not
finish"). Two-digit-year refusal is covered by the four-digit-year requirement
in `parseCsvDate` and by no test of its own.

### Currency

**House.** **A currency is never read out of a file.** `source_currency` and
`destination_currency` are written for a person and never read back. The
currency of an imported row is the currency of the account chosen for the
import. Importing a EUR export into a USD account produces USD rows, and the
file cannot stop it, because the alternative is a ledger inventing an account it
was not given.

*Checked by:* `tests/integration/import-export.integration.test.ts:667` for the
account half. The currency half follows from it and has no test of its own.

### Empty and zero

**House**, following `common.md`. An empty cell means absent. `0` means zero. A
row with no category has an empty `category_name` and a JSON `categoryName` of
`null`, not the word `Uncategorized`, which is a report label and never a stored
value.

*Not checked mechanically.*

## 6. The columns

**House.** An export writes these, in this order. Order is not part of the
contract: recognition and reading are both by header name (`isAppExportCsv`
compares a `Set`, `src/shared/csv.ts:67-70`; `appExportDraft` reads every column
by name, `src/server/services/import-export.ts:186-344`).

*Not checked mechanically.* No test shuffles the columns and re-imports.

| Column | Written for | Read back |
| --- | --- | --- |
| `simple_balance_format` | The reader | Yes, per row |
| `transaction_id` | A person tracing a row home | No |
| `transaction_type` | Both | Yes, decides direction |
| `date` | Both | Yes |
| `payee` | A person, formula-neutralised | Fallback only |
| `description` | A person, formula-neutralised | Fallback only |
| `category_id` | Both | Yes, if this ledger owns it |
| `category_name` | A person, formula-neutralised | Fallback only |
| `external_id` | A person, formula-neutralised | Fallback only |
| `legs_json` | The reader | Yes |
| `notes` | A person, formula-neutralised | Fallback only |
| `roundtrip_text_json` | The reader | Yes, first |
| `source_account_id` | A person | No |
| `source_account_name` | A person, formula-neutralised | No |
| `source_amount` | Both | Yes, for a withdrawal and a transfer |
| `source_currency` | A person | No |
| `destination_account_id` | A person | No |
| `destination_account_name` | A person, formula-neutralised | No |
| `destination_amount` | Both | Yes, for a deposit and a transfer |
| `destination_currency` | A person | No |
| `effective_rate` | A person | No, recomputed from the two amounts |

**House.** **A column may be output-only, and this table says which.** All four
account columns are written and none is read: they name accounts in the ledger
the file came from, which a different account, a different person or a fresh
install resolves none of. `transaction_id` is the same, and the comment at
`src/server/services/import-export.ts:307-308` records what happened when it was
not treated that way, which is that the duplicate check keyed on a foreign
ledger's primary key.

*Checked by:* `tests/integration/import-export.integration.test.ts:667`, which
imports an export into a different account and asserts the rows land there
rather than in the account the file names.

**House.** **The recognition set is frozen.** `isAppExportCsv`
(`src/shared/csv.ts:67-70`) returns true when every name in `APP_CSV_COLUMNS` is
present. That list is the recognition test, so adding to it would stop every
file written by an earlier version from being recognised. `legs_json` and
`external_id` are deliberately outside it. **New data goes in a column outside
the recognition set, read when present and missed when absent.**

*Checked by:*
`tests/integration/csv-roundtrip-fidelity.integration.test.ts:212-237`, which
asserts the nineteen shipped names still satisfy `isAppExportCsv` and that
neither new column joined them. It catches an addition. It does not catch a
removal, and it sits behind the integration gate although it needs no database.

**House.** **`simple_balance_format` is a format version in a column, and
nothing standardises that.** Neither CSVW nor Frictionless Data's Table Dialect
defines format evolution, so this is our own invention. The rules for it:

- The token changes only when a file written under the new token cannot be read
  by the old reader.
- Adding a column does not change it. Changing what an existing column means
  does.
- When it changes, the old reader stays reachable.
- The token is checked per row, not per file
  (`src/server/services/import-export.ts:227-237`). A row whose token is missing
  or unrecognised is staged with one issue and nothing else read from it.

Today the token is `simple-balance-csv-1` (`src/shared/csv.ts:5`).

*Not checked mechanically.* Nothing pins `APP_CSV_FORMAT` against a change made
for an additive reason. `tests/integration/import-export.integration.test.ts:630`
asserts the current literal in passing, and the recognition-set test at
`tests/integration/csv-roundtrip-fidelity.integration.test.ts:217-237` catches a
new required column, but neither would notice a token bump the rules above
forbid.

## 7. Shapes across rows

**House.** **One transaction is one row. Always.** No continuation row, no
multi-line posting block. hledger and Beancount write a transaction as several
lines and this format does not, because the file has to survive being opened,
sorted and filtered in a spreadsheet, and a sort destroys any format whose
meaning depends on adjacency.

That decision is what forces JSON into two cells, and the cost is stated rather
than hidden: `legs_json` and `roundtrip_text_json` are not readable at a glance.

*Not checked mechanically.* Nothing stops a future writer emitting a second row,
and nothing would catch it until an importer did.

**House, the per-shape column contract.** **A deposit** fills
`destination_amount` and `destination_currency`; the source columns are empty.
**A withdrawal** fills the source columns. **A transfer** fills both and
`effective_rate` (`src/server/services/transactions.ts:430-531`).

**House, the split contract.** **A split** travels in `legs_json` as an array of
at least two objects, each with `categoryName`, `amount` and `note`
(`parseExportedLegs`,
`src/shared/csv.ts:79-102`). Legs travel by category **name**: a leg id and a
category id mean nothing in the ledger the file is read into, exactly as an
account id does not. The key is written on every row, empty for rows that are
not splits, because the header comes from the first row's keys and a file whose
first transaction happened not to be split would otherwise lose the column for
every row after it. A transfer never has legs.

**House.** **An unreadable split costs the split, not the row.**
`parseExportedLegs` returns nothing when the column is absent and `null` when it
is present and unreadable; `null` stages the row with an issue telling the
person to divide it again or commit it against one category. Returning early
threw away a date, payee, amount and account the file had stated perfectly
clearly.

*Checked by:* `tests/integration/splits-roundtrip.integration.test.ts:105-163`,
`tests/integration/import-export.integration.test.ts:789` ("stages a row whose
split cannot be read, without the split").

**Multi-currency.** A cross-currency transfer exports both amounts and the rate
that transfer actually got. On import the two amounts travel on the staged row
and the rate does not, because the rate is `destination / source` and
recomputing it from the amounts cannot disagree with them. If the two accounts
chosen at commit share a currency, the commit refuses: "Same-currency transfer
amounts must match" (`src/server/services/transactions.ts:504-559`). That is the
right refusal. A rate is a fact about a movement, not a preference.

**Binding.** `AGENTS.md`: "Preserve audit history, transaction provenance, and
cross-currency CSV round trips."

*Checked by:* `tests/integration/import-export.integration.test.ts:601` ("marks
exports explicitly and asks for both accounts of a transfer"), which exports a
110 EUR-for-100 transfer and reads it back. Only the export half. Nothing
commits a restored cross-currency transfer into two accounts of different
currencies and compares the rate, which is the gap section 16 ranks second.

## 8. What a round trip preserves

A round trip means: export, then stage the file into another ledger or a fresh
install, then commit the queue. **Preserved:**

- The date, the type, and the amounts on both sides.
- The description and notes **exactly**, including text a spreadsheet would
  treat as a formula, because they travel in `roundtrip_text_json` where the
  neutraliser cannot reach them.
- The payee to within `cleanHumanName`: NFKC, trimmed, internal whitespace
  collapsed, and rewritten to the receiving ledger's canonical spelling where it
  already has one (section 9). `canonicalizeImportedPayees`
  (`src/server/services/import-export.ts:409-431`) does that on every import, so
  `ACME  Co` comes back as `ACME Co` and a payee the receiving ledger already
  spells its own way comes back in that spelling. Byte-exact payee text is not
  preserved and is not meant to be.
- The bank's own reference, in `external_id` and in the JSON, and never the
  source ledger's primary key.
- The category, by name, matched or created in the receiving ledger. Including
  on a transfer, which stages as a partial rather than a draft and had its
  category silently dropped until the resolver learned to look there
  (`src/server/services/import-export.ts:448-457`).
- The split, leg by leg, by category name, with each leg's note.

*Checked by:* `tests/integration/csv-roundtrip-fidelity.integration.test.ts` end
to end, and `tests/integration/import-export.integration.test.ts:842` ("lets a
different person import an export of someone else's ledger").

**Deliberately not preserved:**

| Not preserved | Because |
| --- | --- |
| The transaction id | It is a foreign ledger's primary key |
| Accounts, by id or by name | An import names one account and that is the only thing deciding where rows land |
| The category id, where this ledger does not own it | It is dropped so the name can resolve instead, rather than importing with no category at all (`src/server/services/import-export.ts:887-900`) |
| Leg ids | Same reason as category ids |
| The currency | It comes from the chosen account |
| `effective_rate` | Recomputed from the two amounts |
| Deleted transactions | Never exported. The format has no column saying an entry is void, so a row indistinguishable from live money would go in front of the importer and reading it back would raise the amount from the dead (`src/server/services/import-export.ts:959-970`) |
| Version, timestamps, audit history, template and recurrence provenance | Not in the format. An import is new provenance |
| Committed status | See below |
| Byte-exact payee capitalisation and spacing | `cleanHumanName` and the canonical rewrite above |

*Not checked mechanically*, except the rows that cite a test above. An addition
to this table is a format decision and there is nothing for a test to compare it
against.

**House.** **An import always lands in the review queue and never in the
books.** There is no bulk write path. The round trip is a three-step operation
and the middle step is a person or an agent looking at it.

*Not checked mechanically.* No test asserts that no route or tool writes a
transaction straight from a CSV. `tests/mcp-parity.test.ts` would catch a new
route, and nothing would catch a new write path inside `stageCsv`.

**House.** **Losslessness is a claim about a named list, not an adjective.** The
two tables above are that list. Anything not in them is undefined, and adding a
row to the second table is a format decision, not a bug fix.

## 9. Matching a name in a file to a record in a ledger

**House.** **A name matches on `normalizeHumanName`: NFKC, trimmed, internal
whitespace collapsed, lowercased** (`src/shared/names.ts`). Capitalisation is
preserved on what gets stored and ignored on what gets matched.

- **Categories.** A file's category name is grouped across every row and leg
  that names it, so two rows and a leg asking for the same new category create
  it once and the preview counts it once. An existing category matches and keeps
  the kind it has: a file holding a purchase and a refund for one name does not
  widen it, because a row running against the category is a reversal rather than
  a statement that the category covers both directions, and widening it would
  stop every later refund from moving the figure it should move. An archived one
  is brought back. A name new to the ledger has nothing to preserve, so the
  file's own rows decide: they vote by direction, the category is created as
  whichever direction most of them are, and a tie goes to expense — a refund is
  the minority direction by construction, so a purchase-and-refund pair makes a
  spending category rather than one covering both. (An earlier rule created
  such names covering both directions, and a category covering both agrees
  with whichever direction it is handed: the refund credited income and the
  budget never moved.)

  A caller that may only stage cannot create a category, so the row is staged
  carrying the name **and the kind the file decided**, and the commit makes it.
  The kind has to travel: a commit sees one row at a time, so without it
  whichever row committed first decided, and a refund landing first made an
  income category that filed every purchase in the file against the income
  counter-account and could not be budgeted at all. Which row commits first is
  not a fact about anybody's money.

  *Checked by:* `tests/integration/budgets.integration.test.ts`, which imports
  one file spending and refunding against one category and asserts the kind
  survives, commits a deferred file in both orders and asserts the same answer,
  and `tests/integration/import-export.integration.test.ts`.
- **Payees.** An imported payee is rewritten to the spelling the payee screen
  already considers canonical, using the same query and the same comparator that
  screen uses (`canonicalizeImportedPayees`,
  `src/server/services/import-export.ts:409-431`). Two copies of "which spelling
  wins" is two places for the answer to drift.
- **What the caller gets back.** `referenceResolution` reports every category as
  `existing`, `new`, `updated` or `deferred`, and every payee as `existing` or
  `new`, before anything is committed. A dry run reports the same thing and
  writes nothing.

**Binding.** `AGENTS.md`: "`ledger:stage` proposes and never decides. Creating a
category, bringing an archived one back, or widening what kind of entry it may
carry are changes to the ledger's own records and need `ledger:write`, wherever
they are reached from, including a CSV import." A `ledger:stage` caller gets
`deferred` with a null `categoryId`, and the row stages carrying the name it
came with. The commit, which needs `ledger:write` anyway, is what makes the
category.

*Checked by:* `tests/integration/import-export.integration.test.ts:142`, `:333`
(concurrent creation of the same normalized name), `:515` (never resolved
through another tenant), and
`tests/integration/mcp-scope-boundaries.integration.test.ts`.

**House.** **A resolved row carries an id or a name, never both.** Once a name
resolves, it is cleared from the draft and from the leg. A staged row holding
both had the name re-applied at commit, which silently undid a mass edit that
had cleared the category.

*Not checked mechanically.* The invariant is held by `assign` and `writeTarget`
in `resolveImportedCategories` clearing `categoryName` alongside every id they
write, and by nothing else.

## 10. Duplicates

**House.** **An import never refuses a row for being a duplicate. It badges it,
and the commit refuses.**

Three mechanisms, and they are deliberately not the same strictness:

1. **The stored fingerprint.** Every staged row gets one key: the external
   reference when the row has one, because that is an identity rather than a
   guess, otherwise a heuristic key over type, date, payee, account and amount
   (`stagedDuplicateKey`, `src/server/services/transactions.ts:2567-2705`).
2. **The advisory badge.** The queue also looks for a committed transaction of
   the same type, account and amount within `LIKELY_DUPLICATE_DAYS`, which is
   three (`src/shared/domain.ts:1288`, `src/server/services/staging.ts:538-614`).
   The payee is ignored outright and the date gets three days of latitude, on
   purpose: the bank posts when it settles rather than when the card was swiped,
   and it names the merchant its own way. This decides nothing. It opens a
   review.
3. **The commit guard.** `findDuplicate` demands the same day and the same
   payee, or an exact external-reference match. A commit that hits it refuses
   the whole batch unless the caller sends `allowDuplicates`.

Loosening the guard to match the badge would start turning down two genuine
coffees bought on one card in one week. Tightening the badge to match the guard
would stop it catching anything real. **They are two different questions and
they get two different answers.**

Actual Budget recommends OFX over CSV precisely because "They provide an id that
we can use to avoid importing duplicates". We read that id when the file has
one: map it to `externalId`, or let one of our own exports carry it.

*Checked by:* `tests/integration/duplicates.integration.test.ts` (the heuristic
guard at `:62`, the staged-against-staged case at `:279`, and rows that repeat
each other at `:639`) and
`tests/integration/csv-roundtrip-fidelity.integration.test.ts:75-123` for the
external reference surviving a round trip.

## 11. Errors, addressing, and what is all-or-nothing

**House.** **A bad row is not an error, it is a queue entry.** Every reader in
`src/shared/csv.ts` and `src/server/services/import-export.ts` returns a row of
`{ draft, issues, rawData, partial }` and keeps every field it could read.
Returning nothing threw away five good fields because a sixth was unreadable and
left somebody retyping a date the importer had already understood.

This sidesteps the partial-success problem that HTTP 207 exists to answer, and
it sidesteps it correctly. [`http.md`](http.md#the-bulk-selection-contract)
carries the argument for why this API never returns 207; the import path is the
case where the alternative is most tempting, because a file really does arrive
part good and part bad, and the queue is what lets it.

**Binding** for the commit, **House** for the other two. Three levels, and each
is all-or-nothing at its own level:

- **The file.** `stageCsv` runs in one transaction. It refuses the whole file
  for a file-level fault: over the byte limit, over the row cap, unterminated
  quotes (`MissingQuotes`, `src/server/services/import-export.ts:789-794`), an
  account the caller does not own, or no mapping for a file we do not recognise.
  It never refuses a file for a bad row.
- **The batch.** One import is one `import_batch`, and the queue can be
  filtered, mass-edited and committed by batch id.
- **The commit.** `AGENTS.md`: "Bulk commits are explicit-ID, validate-first,
  and atomic." A row that fails validation, or repeats another row in the same
  selection, refuses the whole selection.

*Checked by:* `tests/bulk-row-cap.test.ts` for the caps,
`tests/integration/import-export.integration.test.ts:105` for the idempotent
replay that binds a stage to the file and mapping it was run against, and
`tests/integration/duplicates.integration.test.ts:279` ("detects selected staged
duplicates in dry runs and commits atomically only with override") for the
all-or-nothing commit.

**House.** **An issue is addressed by field, with the sentence for a person and
the field for the form**, which is the shape `common.md` sets for errors
everywhere. `{ field, message }`, where `field` is the column name for a file
fault (`simple_balance_format`, `legs_json`) and the draft field for a value
fault (`date`, `amount`, `payee`, `account`).

*Checked by:* `tests/domain.test.ts` ("keeps what it read from a row it could
not finish"), `tests/integration/import-export.integration.test.ts:593`.

**House. A row number is the file's own line.** Rows count from one with the
header as row 1, which is RFC 7111's convention, and `csvFileLine`
(`src/shared/csv.ts:194`) is the single place that says so. It is adopted as a
convention and labelled that way rather than as conformance, because RFC 7111 is
an Independent Submission carrying the disclaimer that it is "not endorsed by
the IETF and has no formal standing in the IETF standards process", and because
the header-as-row-1 half is our inference from one of its examples rather than
something it states.

It needed a helper because Papa Parse reports two bases and neither is that one.
A `FieldMismatch` counts from zero over data records with the header already
removed; a `Quotes` or `MissingQuotes` error counts from zero over physical
records with the header among them. So a file whose fourth line had too few
fields said `Row 3`, and one whose third line opened a quote it never closed
said `Row 2` — two numbers, both wrong, and wrong by different amounts. The
preview's `Row N` sentences and the `row` on the parser errors a refused file
hands back both go through the helper, so an API caller and a person reading the
panel are given the same number for the same fault.

Blank lines are skipped before anything is counted, so an interior blank leaves
the number one low; a trailing blank, which is the common case, comes after
everything it could shift. Nothing else numbers a row at all: the queue shows no
position (`src/client/pages/StagingPage.tsx:846-895`) and a staged row stores no
source row number (`src/server/db/schema.ts:750-862`), so a queue entry is
traceable to a line only through its `raw_data`.

*Checked by:* `tests/domain.test.ts` ("reports the file's own line for a row with
too few fields", "counts the header as row 1, so the first data row is row 2",
"says nothing rather than guessing when the parser gave no row", "shifts a field
mismatch by two and a quote fault by one").

**House. The preview shows the first rows as they will be interpreted**, so a
right preview and a wrong import is a bug rather than a surprise.

Before a dry run the panel shows the file's own cells. A dry run replaces them
with the first rows as the server read them — date, payee, account, category,
amount and the issues each row carries — out of the same `sample` an MCP caller
receives (`src/server/services/import-export.ts:920`), rendered through
`summarizeStagedDraft`, which is the queue's own summariser rather than a second
copy of it. A row that could not be assembled is shown from its `partial`,
exactly as `stageCsv` will store it.

The category is the part that had to be fixed on the server to be shown at all.
A dry run creates nothing, so a category the file names but the ledger does not
have had no id to report and no name either: the row came back saying nothing,
and the panel would have reported "Uncategorized" for precisely the categories
the real stage was about to create. A dry run now defers the name and the kind
onto the draft the same way a `ledger:stage` caller's does, which writes nothing
and is what makes the sample answerable — by the browser and by an agent alike.

`CsvPreview.errors` is shown too, which it never was. It is reported as the rows
the parser could not read among those the preview reads, not as a count over the
file: `previewCsv` takes twenty-five (`src/shared/csv.ts:199`), so a fault past
that one is not in it. The messages are shown as the parser wrote them, `Row N`
and all; what N counts is settled by the item above, which is the file's own
line with the header as row 1.

An interpretation is discarded the moment a control that decides how the file is
read changes — mapping, date format, decimal separator, account — and it is
stamped with those settings when the request is sent rather than when it
returns, because a control touched while a dry run is in flight would otherwise
label a stale reading as current. The counts go with it. What survives is a
completed stage: it describes rows already written, so it is history rather than
a prediction and cannot go stale.

This is the parity rule one level below a route: the dry run's per-row reading
reached an agent and reached a person as two counts, which is the same defect as
a request field only an agent ever sets.

*Checked by:* `tests/import-ui.test.tsx` ("shows the first rows as they will be
read", "names a category the file will create", "stops showing an interpretation
the controls no longer describe", "keeps what a completed stage reported when
the controls change", "stamps an interpretation with the settings it was run
under", "shows the parse errors the preview reported") and
`tests/integration/import-export.integration.test.ts` ("names the category a dry
run has not created, without creating it"). Whether the two screens agree in
substance stays review, and section 16 keeps it there.

## 12. Limits

**Binding.** `AGENTS.md`: "Ten thousand rows is the cap, and it is the same
number everywhere: a mass edit, a mass delete, a commit, and a CSV import. An
import that stages more than one action can clear is a cap doing damage."

`DEFAULT_CSV_MAX_ROWS` is `MAX_BULK_SELECTION_ENTRIES`, by construction rather
than by coincidence (`src/server/config-limits.ts:13`,
`src/shared/domain.ts:1196`). `CSV_MAX_ROWS` may lower it; raising it past the
bulk cap only moves the refusal further along, so the configuration ceiling is
the same number.

- **Bytes.** `CSV_MAX_BYTES`, default 10 MiB, configuration ceiling 100 MiB,
  measured as UTF-8 bytes of the decoded string and enforced at the preview as
  well as at the stage, because a file too large to import should say so before
  somebody maps its columns (`src/server/services/import-export.ts:117-125`).
- **The request envelope.** A CSV route and `/mcp` are sized at six times
  `CSV_MAX_BYTES` plus 64 KiB, the six being the worst case for JSON string
  escaping (`src/server/http-security.ts:62-63`, `:662-665`).
- **Rows.** Counted after blank lines are skipped, so a trailing newline is not
  a row.

*Checked by:* `tests/config-limits.test.ts`, `tests/bulk-row-cap.test.ts:44-95`,
`tests/http-security.test.ts:259-305`.

**Settled, and the gap is deliberate.** An export refuses past
`CSV_EXPORT_MAX_ROWS` — 100,000 — and an import past `configuredCsvMaxRows()`,
ten thousand by default. They are not made equal, and should not be: the import
cap is a fact about what one mass action can then clear, so a file that stages
more rows than a commit can handle is a cap doing damage, while the export is
the way out and capping the way out at what one import can take would mean a
forty-thousand-row ledger cannot leave this product whole.

What closes the gap is both refusals naming the remedy rather than either
number moving. The export says to narrow it with a start and end date; the
import says a larger export can be filtered by date and taken a range at a
time. The import page says the same without a figure, because `CSV_MAX_ROWS`
can lower the server's cap and a browser promising more than the server accepts
is worse than a browser saying nothing, and `export_transactions_csv` tells an
agent the same thing.

*Checked by:* `tests/bulk-row-cap.test.ts` ("the export cap against the import
cap"), which asserts the direction rather than the numbers — an edit that
quietly makes them equal fails — and that both refusals still name the remedy.

**Settled: an empty export is a header-only file.** `rowsToCsv` used to return
the empty string for zero rows, which has no header record, so an export
matching nothing was rejected by RFC 4180 readers and by this product's own
`POST /api/v1/csv/preview` and `stage_csv` on `z.string().min(1)`. The one
export somebody is most likely to want to open — "did it work, or is my filter
wrong?" — was the one that could not be opened.

It now takes its columns from a declared list when there are no rows to take
them from (`src/server/services/import-export.ts:927-952`).

*Checked by:* `tests/integration/import-export.integration.test.ts`, which
asserts the empty file's header is character-for-character the header a
populated export writes. Two sources for one header is the kind of thing that
drifts, so the test compares them rather than trusting them.

## 13. Formula injection

**House.** A cell beginning `=`, `+`, `-`, `@`, tab, CR or LF can execute when
the file is opened in a spreadsheet. It is House rather than Binding because it
rests on an OWASP community page rather than on a specification, and because the
failure lands in somebody else's spreadsheet rather than in this ledger. It is
not optional for that reason.

**Neutralise the human-readable column, carry the exact value in a JSON channel,
and never neutralise the channel.**

- `neutralizeSpreadsheetFormula` (`src/shared/csv.ts:464-485`) prefixes an
  apostrophe to a triggering value.
- It is applied to exactly seven columns, named at the call site
  (`src/server/services/import-export.ts:1075-1085`): `payee`, `description`,
  `category_name`, `external_id`, `notes`, `source_account_name`,
  `destination_account_name`. Free text a person reads, and nothing else.
- It is **not** applied to an amount, a rate, a date or an id. A negative amount
  is a number, not a formula, and prefixing it would break the file for the
  spreadsheet the neutralisation exists to protect.
- `roundtrip_text_json` is never neutralised, and it is what the importer reads
  first. A category named `-Reimbursements` grew an apostrophe on every trip and
  became a second category each time, until the exact value got its own channel.
- `restoreNeutralizedCell` (`src/shared/csv.ts:481-509`) strips the apostrophe
  back off for a file written before that channel existed. It is not injective
  and cannot be: a category genuinely named `'-Reimbursements` and one named
  `-Reimbursements` export identically. It is the best answer available for an
  old file and it beats creating a second category on every trip.

The same split, a neutralised display value beside an exact machine value,
applies wherever text is both read by a person and read back by us.

OWASP is candid that no answer is complete: "Microsoft Excel may remove quotes
or escape characters from CSV cells when a file is saved and re-opened. As a
result, commonly suggested CSV injection mitigations may fail", and "There is no
universal CSV sanitization strategy that is safe for all spreadsheet
applications and all downstream consumers". The guarantee here is therefore
stated narrowly: **the exact value survives our own reader, and the visible cell
is neutralised on a best-effort basis for whatever opens it.**

**Known gap.** `spreadsheetFormulaPattern` does not cover the full-width
variants OWASP names, `＝ ＋ － ＠`. It costs little, because the JSON channel
preserves the exact value regardless and `cleanHumanName` applies NFKC on the
way back in, which folds those forms to their ASCII equivalents. It is still a
gap in the visible cell.

*Checked by:* `tests/domain.test.ts` ("neutralizes spreadsheet formulas only in
designated free-text columns"),
`tests/integration/csv-roundtrip-fidelity.integration.test.ts:164-200`,
`tests/integration/import-export.integration.test.ts:936` ("round-trips
formula-like text without exposing formulas or changing data").

## 14. What the field does, and what we deliberately lack

**House**, every item. Named as decisions, so their absence does not read as an
oversight, and none of them is checked mechanically because an absence cannot
be.

- **No saved, reusable import configuration.** hledger has a rules file, Firefly
  III has a saved configuration, Actual remembers a mapping. Here the browser
  infers a mapping from header aliases each time
  (`src/client/pages/ImportPage.tsx:59-95`), and `import_batch.mapping` is
  stored for the record rather than for reuse
  (`src/server/services/import-export.ts:932`). The inference is also
  browser-only: an MCP caller composes the mapping itself.
- **No conditional rules.** No `if` blocks, no auto-categorisation by pattern.
  The roadmap records why, and records the counter-argument: the agent is the
  rules engine, and the agent is not present during an import unless somebody
  invokes it.
- **No credit/debit indicator column.** Firefly III has a "Bank specific
  credit/debit indicator" role, which is a real shape in real files. This format
  reads direction from a sign or from two columns, and a file using a `D`/`C`
  marker needs a spreadsheet pass first. The cheapest gap here to close.
- **No concatenating several columns into one field.** Firefly III allows it.
  One column feeds one field here.
- **No multiplier or amount flip.** Actual has both.
- **No second file format.** No QIF, no OFX, no camt.053. See section 1.

*Not checked mechanically.* This section records what other tools do and what
this format deliberately lacks. There is no rule here to enforce; it exists so a
gap reads as a decision rather than an oversight.

## 15. Changing the format

**House.** In order, and all of it in one commit:

1. Decide whether the change is additive. Adding a column read when present and
   missed when absent is additive. Changing what an existing column means is
   not.
2. If it is additive, add the column **outside** `APP_CSV_COLUMNS`, and add the
   reason to the comment there, as `legs_json` and `external_id` both do.
3. If it is not additive, change `APP_CSV_FORMAT` and keep the previous reader
   reachable.
4. If the new value is free text a person reads, put it in the neutralised
   visible column **and** in `roundtrip_text_json`. One or the other is a bug.
5. Add it to the column table in section 6, saying whether it is read back.
6. Add it to one of the two tables in section 8. A field in neither is
   undefined.
7. Extend the round-trip test rather than adding a new one, so the fidelity
   claim stays in one file.

*Checked by:* `tests/integration/csv-roundtrip-fidelity.integration.test.ts`,
which pins the round trip the version token protects. *Not checked:* that
`APP_CSV_FORMAT` is left alone for an additive change, and that the recognition
set is never shortened. Both are process, and the second would make every older
file unreadable, so it is the one worth a test.

## 16. What is checked, and what is not

Checked:

| Rule | Test |
| --- | --- |
| Quoting, escaping, embedded newlines | `tests/domain.test.ts` |
| Delimiter and header detection | `tests/domain.test.ts` |
| Localised amounts, including refusals | `tests/domain.test.ts` |
| Direction stated once, eleven cases | `tests/domain.test.ts` |
| A partial row keeps what parsed | `tests/domain.test.ts` |
| Formula neutralisation, by column | `tests/domain.test.ts` |
| An inherited property name is a missing column | `tests/domain.test.ts` |
| The recognition set, against addition | `tests/integration/csv-roundtrip-fidelity.integration.test.ts` |
| External reference, transfer category, formula-named category, same-ledger reimport | `tests/integration/csv-roundtrip-fidelity.integration.test.ts` |
| Splits across a round trip, and the always-present column | `tests/integration/splits-roundtrip.integration.test.ts` |
| Cross-tenant import, idempotent replay, deleted rows never exported | `tests/integration/import-export.integration.test.ts` |
| Scope deferral on a `ledger:stage` import | `tests/integration/mcp-scope-boundaries.integration.test.ts:113-154` |
| Duplicate guard, staged against staged, and the all-or-nothing commit | `tests/integration/duplicates.integration.test.ts` |
| The recognised file hides its mapping controls | `tests/import-ui.test.tsx` |
| A row number is the file's own line, whichever fault it came from | `tests/domain.test.ts` |
| The dry run's rows are shown as read, and dropped when the controls change | `tests/import-ui.test.tsx` |
| A dry run names the category it has not created, and creates nothing | `tests/integration/import-export.integration.test.ts` |
| Row cap, byte cap, request envelope | `tests/bulk-row-cap.test.ts`, `tests/config-limits.test.ts`, `tests/http-security.test.ts` |
| The export route is a named MCP-parity exception | `tests/mcp-parity.test.ts` |

Not checked mechanically, in the order they are worth building:

1. **A BOM is stripped on read**, whatever the exporter writes. One test, and
   the behaviour it depends on belongs to a dependency.
2. **A round-trip property test** over one ledger holding a non-ASCII payee, a
   formula-triggering payee, a mixed-currency transfer and a split. The pieces
   exist in three files; none of them commits a restored cross-currency transfer
   and compares the rate, which is the half of the `AGENTS.md` round-trip
   sentence with no test behind it.
3. **The recognition set against removal**, and out from behind the integration
   gate, since the assertion needs no database.
4. **The neutralised column list matches the free-text columns**, so a new text
   column cannot be added unprotected.
5. **Row and column addressing**, once section 11's convention is adopted.
6. Whether the preview shows what the import will do. That one is review, and it
   stays review, because the thing being judged is whether two screens agree.

A rule that appears in neither list is a rule nobody is responsible for, and that
is a defect in this guide rather than in the code.
