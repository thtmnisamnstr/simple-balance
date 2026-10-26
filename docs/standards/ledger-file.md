# The Simple Balance file

The file a whole ledger moves in: one JSON document, `simple-balance-ledger-1`,
holding everything a person wrote — accounts, categories and groups, entries
with their splits, templates with their reminders, recurring transactions,
budgets, rows still waiting in Staged transactions, and their settings — so a
ledger can go from a copy somebody hosts to the service and back, or some of
its accounts can go on their own. It is called the ledger file in code and a
Simple Balance file on screen, and never an archive, a backup or a restore.

Read [`common.md`](common.md) first. Money, dates, the error sentence and the
voice are settled there and not repeated here. [`csv.md`](csv.md) is the other
file format, and the two answer different questions: a CSV is for a spreadsheet,
a bank or another tool, and this is for another copy of this product.

Everything here is grounded in four places. `src/shared/ledger-file.ts` is the
format — schema, reader, whole-file rules, writer, splitter and the export
request — and the browser and the server both use it.
`src/shared/ledger-file-import.ts` decides what a file's records become in a
ledger that may already hold some of them, and both use that too.
`src/server/services/ledger-file.ts` reads a ledger and writes the file, and
adds a file to a ledger. `GET /api/v1/ledger-file`,
`POST /api/v1/ledger-file:preview` and `POST /api/v1/ledger-file:add`
(`src/server/api.ts:2179-2214`), and the `export_ledger_file`,
`preview_ledger_file` and `add_ledger_file` tools, are the ways in, and the
Import a Simple Balance file and Export sections of **Import and export** are
the page that uses them. Adding a file is the one way to read it back so far
(sections 12 to 16). Moving a whole ledger straight into the books of an empty
one arrives in a later change, and the format already carries what that needs
— deleted entries, archive instants — because a published format cannot grow a
required field afterwards.

## 1. Why a second file, and why it is not interchange

**House.** JSON, one document, one schema at both ends. A ledger is nested where
a CSV is flat — a template's draft, a recurrence's shape, a split's legs, a
budget aimed at a category or a group — and the two alternatives both flattened
it badly: CSVs per kind in a ZIP needed a dependency on both sides and JSON
inside cells anyway, and the transaction CSV has nowhere to put an account, a
budget or a template at all.

It is not a second interchange format, which
[`csv.md`](csv.md#1-why-csv-and-why-no-apology) rules out, because nothing
outside this product reads it or writes it. It is this product's own record of
a ledger, for moving that ledger between two copies of it. The CSV import and
export go on existing, unchanged, for everything else.

**House, and the three words it is never called.** Never "archive", on screen or
in a path: archiving is what this product does to an account it retires, and
`tests/http-route-table.test.ts` refuses a route ending in `/archive` for that
reason. Never "Restore" for what reads one back, which already means bringing
back an archived account or a deleted entry. And never "backup": a backup here
is the operator's nightly dump of the database, every person and every
credential in it, put back with `pg_restore`, and a file one person chose the
contents of is neither that nor a promise of it. The glossary in
[`common.md`](common.md#the-glossary) carries the word.

*Not checked mechanically*, except the path, which the route-table test above
refuses. The choice of JSON is a decision rather than a rule, and the words on
screen are review against the glossary.

## 2. The document

**Binding, because the format token is a published contract.** `AGENTS.md`: "A
release upgrades cleanly from the one before it." A file written today has to
import into a copy upgraded years from now, so every release reads every token
ever published, a field added under a token is added as optional, and anything
that is not additive is a new token with the old reader kept. That is why the
file carried origins, the deleted flag, archive instants, the reminder and
recurrence watermarks and the balance checks from the first export, before
anything read a file back: adding one uses the origins and the watermarks
(sections 14 and 16), and the deleted flag and the archive instants wait for
the move that will use them. [`writing.md`](writing.md#versioning) counts it as
the fifth surface somebody can depend on.

The top level is strict and is written in this order:

| Key | Holds |
| --- | --- |
| `format` | `simple-balance-ledger-1` (`src/shared/ledger-file.ts:66`) |
| `exportedAt` | The instant it was made, RFC 3339 |
| `throughDate` | The day the balance checks describe: today where the person lives, or the range's last day when that is earlier |
| `producer` | `{version}`, the release that wrote it |
| `scope` | `{kinds, accounts: "all" \| "chosen", start, end}`, what was asked for, so a reader can tell a kind left out from one the ledger had none of |
| `preferences` | Timezone, default currency and theme, or `null` when left out or never chosen |
| `groups`, `categories`, `accounts`, `templates`, `recurrences` | The records, each with a `key` |
| `budgets` | `{plans, entries}` |
| `entries`, `staged` | The rows, entries sorted by date and then origin |
| `history` | The activity log, present only when it was asked for, and never read back |

**Every record uses its API create schema's field names**, with a uuid
reference `xId` becoming `x` and naming a key, and every field schema is the
API's own, so a value the file accepts is one a create accepts. The two account
sides are the one departure, `from` and `to`, because they are on every line and
a side can only ever name an account.

**House. The layout is fixed, so the bytes are.** The top level indented two
spaces, every record of every list on a line of its own, an empty list as `[]`,
keys within a record in the order the schema declares them, and a newline at the
end (`serializeLedgerFile`, `src/shared/ledger-file.ts:1383-1401`). Fully
indented, one entry is fifteen lines; on one line, a diff of two exports is one
changed line of forty megabytes. One record per line is what lets somebody find
an entry by its payee and read it whole. And because the reader hands keys back
in the order the writer puts them, a parsed file serializes to the bytes it was
read from, and two exports of an unchanged ledger made on the same day differ
only in `exportedAt`.

*Checked by:* `tests/ledger-file-schema.test.ts`, which holds the round trip to
the byte ("survives a round trip unchanged, to the byte"), the layout and the
sort order, and was mutation-checked against each.

## 3. The records

**House.** Every field a file may carry, in the order it is written. A field
marked `?` may be left out; every other one is always there, as `null` where it
may be one and has nothing to say. The schema (`ledgerFileSchema`,
`src/shared/ledger-file.ts:745-776`) is the authority, and this table is held to
it rather than copied from it.

| Record | Fields |
| --- | --- |
| The file | `format`, `exportedAt`, `throughDate`, `producer`, `scope`, `preferences`, `groups`, `categories`, `accounts`, `templates`, `recurrences`, `budgets`, `entries`, `staged`, `history?` |
| Producer | `version` |
| Scope | `kinds`, `accounts`, `start`, `end` |
| Settings | `timezone`, `defaultCurrency`, `theme` |
| Category group | `key`, `name`, `detail`, `policy` |
| Category, whole | `key`, `name`, `detail`, `kind`, `group`, `archivedAt` |
| Category, reference | `key`, `name`, `detail`, `kind`, `group` |
| Account, whole | `key`, `name`, `detail`, `type`, `currency`, `openingDate`, `openingBalance`, `institution?`, `notes?`, `inBudget`, `archivedAt`, `inUse`, `carriedForward?`, `balance?` |
| Account, reference | `key`, `name`, `detail`, `type`, `currency` |
| Template, whole | `key`, `name`, `detail`, `draft`, `notification?` |
| Template, reference | `key`, `name`, `detail` |
| Template draft | `type?`, `date?`, `from?`, `to?`, `amount?`, `destinationAmount?`, `payee?`, `description?`, `category?`, `categoryName?`, `legs?`, `notes?` |
| Template draft leg | `category?`, `categoryName?`, `amount?`, `note?` |
| Reminder | `frequency?`, `interval?`, `anchorDate`, `monthPolicy?`, `weekendPolicy?`, `position?`, `time`, `repeats?`, `lastNotifiedDate?`, `nextNotificationDate?` |
| Recurring transaction | `key`, `name`, `shape`, `schedule`, `notifyOnCreate`, `lastOccurrenceDate` |
| Shape of a recurring deposit | `type`, `to`, `amount?`, `payee`, `description?`, `category?`, `categoryName?`, `categoryKind?`, `legs?`, `notes?` |
| Shape of a recurring withdrawal | `type`, `from`, `amount?`, `payee`, `description?`, `category?`, `categoryName?`, `categoryKind?`, `legs?`, `notes?` |
| Shape of a recurring transfer | `type`, `from`, `to`, `amount?`, `destinationAmount?`, `payee`, `description?`, `category?`, `categoryName?`, `categoryKind?`, `legs?`, `notes?` |
| Recurring leg | `category?`, `categoryName?`, `amount`, `note?` |
| Schedule | `frequency`, `interval?`, `anchorDate`, `monthPolicy?`, `weekendPolicy?`, `position?` |
| Budget plan | `category?`, `group?`, `currency`, `periodUnit`, `amount`, `activeFrom`, `activeTo?`, `rollover?`, `rolloverCap?`, `targetAmount?`, `targetDate?`, `lookbackPeriods?`, `percentOfPrevious?`, `percentOfIncome?`, `priority?` |
| Budget amount | `category?`, `group?`, `currency`, `periodUnit`, `periodStart`, `amount` |
| Deposit | `id`, `type`, `date`, `to`, `amount`, `payee`, `description?`, `category?`, `legs?`, `notes?`, `externalId?`, `template?`, `deleted?`, `postedAs?` |
| Withdrawal | `id`, `type`, `date`, `from`, `amount`, `payee`, `description?`, `category?`, `legs?`, `notes?`, `externalId?`, `template?`, `deleted?`, `postedAs?` |
| Transfer | `id`, `type`, `date`, `from`, `to`, `sourceAmount`, `destinationAmount`, `payee`, `description?`, `category?`, `notes?`, `externalId?`, `template?`, `deleted?` |
| Entry leg | `category`, `amount`, `note?` |
| Staged row | `id`, `draft`, `rawData?` |
| Staged draft | `type?`, `date?`, `from?`, `to?`, `amount?`, `sourceAmount?`, `destinationAmount?`, `payee?`, `description?`, `category?`, `categoryName?`, `categoryKind?`, `legs?`, `notes?`, `externalId?`, `template?` |
| Staged leg | `category?`, `categoryName?`, `categoryKind?`, `amount?`, `note?` |
| History event | `createdAt`, `actorSource`, `entityType`, `entityId`, `operation`, `before?`, `after?`, and anything else |

What the names alone do not say:

- **`detail` is `full` or `reference`**, on the four kinds something else names:
  groups, categories, accounts and templates. A reference is what keeps a kind
  left out from breaking the file (section 5). Recurring transactions, budgets,
  entries and staged rows have no `detail`, because nothing in a file names one
  of them, so each is whole or absent.
- **Three fields on a whole account are not the account's data.** `balance`
  and `carriedForward` are checks, what a reader compares with rather than what
  it writes, and `inUse` is information that nothing reads as a choice; section 8
  says where each comes from and when it is there.
- **A template's draft is the template draft's own schema**, blank meaning
  absent, so a template that never mentioned a field still does not.
- **The reminder is the API's `notification`, read-back fields and all**, under
  that name rather than a second word for one concept. The exporter writes the
  rule and `lastNotifiedDate` and never `repeats` or `nextNotificationDate`: one
  restates `frequency` and the other is the scheduler's to work out. A file that
  carries them is read anyway, for the reason the API reads them — so a reminder
  can be sent back the way it came. `lastNotifiedDate` is the watermark, and is
  held to being a date here although the API takes any string, because a write
  ignores it and a file seeds one from it.
- **A recurring transaction's shape is read with the stored-shape rules**, not
  the stricter ones a create meets, so a recurrence made before a check existed
  still parses. `lastOccurrenceDate` is the last occurrence it decided — proposed,
  or passed over by a weekend or month-length policy — under the name its read
  view already gives it.
- **A budget names a category or a group, never both** and never neither, and
  carries no `amount_rule`: that is derived from which parameter a row sets and
  is never asked for (`AGENTS.md`).
- **An entry carries its own amounts.** A deposit or a withdrawal has `amount`;
  a transfer has both `sourceAmount` and `destinationAmount`, always, including
  where the currencies match, because a conversion's rate is implied by the two
  and never stored. `legs` are the split's non-zero legs in order, two to fifty,
  and an entry has them or a `category`, never both. A transfer may have a
  category and never has legs. `deleted` appears only as `true`. `postedAs` is in
  section 8.
- **A staged row is unfinished work and its mistakes travel with it.** Every
  value in its draft keeps the queue's anything-goes schema except two: a
  reference is a key or `null`, never a uuid, and an amount is anything but a
  JSON number. The draft is strict all the same, and that is the one departure
  from the queue's own schema: a key the format does not know could be a uuid
  from the ledger it came from, which means nothing anywhere else.
- **A history event is loose where everything else is strict.** Nothing reads
  it back, so a copy refusing a whole file over a field a newer release logged
  would be losing somebody's ledger over a section nothing uses. It is the one
  place a source id travels, because the log is about them.

*Checked by:* `tests/ledger-file-guide.test.ts`, which reads the table above and
holds every row to the schema — each record's fields by name, in written order,
and which of them may be left out — so a field renamed, removed, reordered or
made required cannot reach the format without this table changing beside it.
What each field means is review.

## 4. Money, dates and text

**Binding.** `AGENTS.md`: "Never represent money with JavaScript/JSON
floating-point numbers." A JSON number in any amount position — an entry's, a
leg's, an opening balance, a carried-forward balance, a budget's, a percentage,
even a staged row's — is refused with one sentence and never coerced: by the
time anything reads it, `JSON.parse` has already turned the digits into a binary
float, so "0.1" written as a number is already not 0.1
(`src/shared/ledger-file.ts:163-184`). Amounts are the API's canonical decimal
strings, never padded.

A staged row is allowed to be wrong, and keeps whatever its queue held — an
amount of `"12,50 €"` survives for somebody to fix. A number stored in one is
written as the text JSON spelled it with, which is what the row said without
the claim that it was exact.

Dates are `YYYY-MM-DD` and instants RFC 3339 with an offset, as
[`common.md`](common.md#dates-and-times) has them. Text is exact: formula
neutralizing is a spreadsheet's defense and this is not a spreadsheet.

*Checked by:* `tests/ledger-file-schema.test.ts` for the refusal in every
amount position ("a JSON number where money goes"), and
`tests/ledger-file-export.test.ts` for a staged number written as text ("carries
a staged row's mistakes, but never a number or a stray uuid").

## 5. Keys and references

**House.** A record's `key` is its name, so a file reads the way the ledger
does: `"from":"Checking"`. `key` and `name` are separate fields for two reasons.
An older ledger can hold two names that fold together under
`normalizeHumanName`, which today's rules refuse and yesterday's did not; the
exporter gives the later one the first free suffix, `"Checking (2)"`, and leaves
its `name` alone (`assignLedgerKeys`, `src/shared/ledger-file.ts:1291-1308`). A
suffix never takes a name somebody actually used, because every first-of-its-fold
name is reserved before any suffix is handed out. And a rename on the way into
another ledger changes a `name` and touches no reference.

Keys are handed out over every record of a kind in the order the records were
created, whether or not each one is in the file, so the same ledger exports the
same keys whichever kinds are ticked.

**Every reference names a key of the right kind that is in the file**, whole or
as a reference, exactly — not under its folded form — and a file with one that
is not is refused. A kind left out is not a broken file: anything that names one
of its records carries that record as a reference — an account's name, type and
currency; a category's name, kind and group; a group's name and policy; a
template's name — so a reader can find the one that is already there, or ask
about the one that is not. A category reference carries its kind for the reason
a whole one does: the kind is what decides whether an entry filed under it is
income or a refund.

**A uuid that no longer resolves is dropped, not carried.** A template or a
staged row naming an account or a category deleted since keeps everything else
in its draft; an entry made from a template deleted since loses only that
provenance, which is what the missing foreign key already does to it in the
ledger. A recurring transaction whose own account is gone cannot propose
anything, so it is left out whole, and nothing it named is carried for it.

*Checked by:* `tests/ledger-file-schema.test.ts` for keys and dangling
references ("a reference", "a key"), and `tests/ledger-file-export.test.ts` and
`tests/integration/ledger-file-export.integration.test.ts` for what the exporter
names, drops and suffixes.

## 6. Origins

**House.** An entry's `id`, and a staged row's, is its origin: the id it was
first written under. It is identity and nothing else — never a primary key
anywhere it lands — and it is what lets a reader recognize the same entry
arriving twice, a transfer in two accounts' files or a ledger moved away and
back, and skip the second. Two coffees bought the same morning have two
origins, so neither is mistaken for the other. Origins are one identity across
the entries and the queue together, because an entry and a staged row sharing
one would be one entry in two places. An entry written here has its own id as
its origin; one that arrived in a Simple Balance file keeps the origin it
arrived with, in `import_origin` (`drizzle/0026_ledger_file_origins.sql`), and
is exported under it, so a ledger moved on a second time is still recognized
by the copy it started in. A staged row is the same.

**A row committed from the queue keeps the row's identity.** A staged row with
no origin of its own is exported under its own id, and committing it gives the
entry a new one. So an entry committed from such a row is exported under the
row's id (`readCommittedFrom`, `src/server/services/ledger-file.ts:663-686`),
and a file written while the row still waited is skipped once the row is in
the books, whether or not the entry was deleted since. The id is worked out
from the queue at export rather than stored in `import_origin`, because an
entry with an origin reads as having come from a file — to the duplicate
check, which then stands aside for it, and to whether a ledger qualifies to be
moved whole — and an entry somebody typed into Staged did not.

*Checked by:* `tests/ledger-file-schema.test.ts` ("an origin"), which refuses
two records with one origin across the entries and the queue together,
`tests/ledger-file-export.test.ts` ("writes the origin an entry or a staged row
arrived with"), and
`tests/integration/ledger-file-add.integration.test.ts` ("keeps a waiting
row's identity once it is committed, so a later file adds nothing").

## 7. What a file preserves, and what it leaves behind

| Preserved | How |
| --- | --- |
| Accounts | Name, type, currency, institution, notes, whether the budget sees it, opening date and balance, and the instant it was archived |
| Categories and groups | Name, the exact kind, the group, the instant it was archived, the group's budget policy |
| Entries | Type, date, payee, description, notes, external id, both sides by key, both native amounts, the category or the split's legs, the template it came from, and whether it is deleted |
| Templates | The draft with keys for its references, and the reminder with the date the last one went out |
| Recurring transactions | The shape with keys, the whole schedule, whether it emails, and the last occurrence it decided |
| Budgets | Every plan and every one-period amount, aimed at a category or a group by key |
| Staged rows | The draft as the queue holds it, with keys where it could resolve them, and the raw row it came from |
| Settings | Timezone, default currency and theme, when the person chose them |
| Activity history | When asked for, every event as stored, without the owner's id on every snapshot or which agent did it |

| Not preserved | Why |
| --- | --- |
| Postings, counter-accounts, rates, leg tombstones | Derived. The copy a file lands in posts them itself, which is the check |
| Versions, timestamps other than archive instants, ids other than origins and those inside the activity history | They belong to one deployment |
| The active-account choice | Freezing is worked out from the plan the copy is on. `inUse` says how it stood and nothing reads it as a choice |
| Committed and discarded staged rows, import batches, idempotency records | History with no write path |
| A staged row's recurrence provenance | Only the scheduler may write it, so nobody can forge "the scheduler proposed this" |
| Users, sessions, passwords, agents and their tokens, billing | Credentials and the deployment's own state. A plan does not move with the data |

*Not checked mechanically* as a list. Each preserved row is held by
`tests/integration/ledger-file-export.integration.test.ts` against a ledger
holding it.

## 8. The export

**House.** All of these, and each one for a reason.

**The request is the page's own selection.** One schema for the page, the route
and the tool (`ledgerFileSelectionSchema`,
`src/shared/ledger-file.ts:1575-1644`), strict, so an agent can ask for exactly
what the page can. `kinds` names the kinds that travel whole, from
`preferences`, `categories`, `accounts`, `entries`, `deletedEntries`,
`templates`, `recurrences`, `budgets`, `staged` and `history`, and the page
starts with every one but `history` ticked. `deletedEntries` is a narrowing of
`entries` rather than a record of its own, and needs it. On the route `kinds`
and `accountIds` are comma-separated, as [`http.md`](http.md#requests) asks,
and any other parameter is refused by name.

**"Some accounts" is one query over the set.** `accountIds` names one to a
hundred of the person's own accounts, archived ones included, and an id that is
not one — a stranger's, or a counter-account's, which is never found — is a 404
naming it. The file carries every entry whose source or destination is chosen,
each once, so a transfer between two chosen accounts is one entry; the account
on its far side travels as a reference, and `categories` means only the
categories and groups those entries name, whole. Templates, recurring
transactions, budgets, staged rows, settings and history belong to the ledger
rather than to any account, so a chosen-accounts file refuses them. At most a
hundred because the request is a `GET` and the ids are in its query string
(`src/shared/ledger-file.ts:92`).

**A range narrows the entries and the activity history, and the file still
adds up.** `start` and `end` are days. Entries are kept by their own date, and
history events by the instant they happened, from the start of `start` to the
start of the day after `end` where the person lives — worked out by
`startOfDayIn` rather than by asking the database what day an event fell on,
which `calendarDayIn` answers and PostgreSQL answers differently for a bare
offset (`historyConditions`, `src/server/services/ledger-file.ts:475-484`).
With entries ranged, **every** whole account carries `carriedForward`, dated
`start`, whatever its opening date: its `amount` is what the account's postings
summed to the day before, future-dated ones included, since those entries are
not in the file either. It is keyed to the range rather than the opening
because nothing stops an entry predating its account's opening — an account
opened today and filled from last year's statements is the ordinary case — and
money dated before both is in the balance and in no entry. With no range, or a range on the history
alone, it is `null`.

**The checks come from the postings.** `throughDate` is today where the person
lives, or `end` when that is earlier. `balance` is what each whole account's
postings hold at the end of it, written only when the entries are in the file —
an "account details only" file carries none, because no reader of it could
reach the figure — and left out when the range starts after `throughDate`,
because an account rebuilt from the range holds nothing yet on that earlier
day, and a check moved past today would describe money that has not moved.
`carriedForward` is what `listAccounts` holds the day before the range. `inUse`
is true for an account that is neither archived nor frozen where it came from,
and is information only. `postedAs` is which counter-account a live deposit or
withdrawal's postings actually net to, written only where it is not what
`resolveEntrySide` would decide from the categories now — a refund filed under
spending, in a category widened to `both` afterwards, which reposted nothing —
or where the categories no longer resolve to a side at all. None of the four is
arithmetic of the exporter's own; a file whose checks came from a second
implementation of the ledger would be checking a reader against it.

**Counted first, and capped twice.** Entries, staged rows, budget amounts and,
when asked for, history events are counted before anything large is read, and a
sum over the cap is refused with both numbers in `details` as `limit` and
`count`. The sentence is built from what was asked for, so it names only the
moves that would work: narrow with a start and end date whatever a range
narrows, export the staged rows, budgets or history separately when they are
beside something else, and failing both, commit or discard some staged rows —
or, for budget amounts alone, say that no one export can carry that many
(`src/server/services/ledger-file.ts:284-290`, `:506-536`). The activity history
has a second limit, on the bytes of its before and after snapshots, because rows
do not bound it the way they bound everything else: an event about an edited
split is ten times an entry's line. Its refusal carries `limit` and `bytes` and
names the range. Each transport chooses both limits:

| | Rows | History |
| --- | --- | --- |
| The download | 100,000, `CSV_EXPORT_MAX_ROWS`, because the way out should never be narrower than the way in | 16 MiB, `LEDGER_FILE_HISTORY_MAX_BYTES` (`src/server/config-limits.ts:48`) |
| The MCP tool | 10,000, one import part, because the reply is serialized twice and cannot stream | 4 MiB, `MCP_LEDGER_FILE_HISTORY_MAX_BYTES` (`:56`) |

The largest file the download's two limits allow together came to 33 MiB and
peaked under 400 MiB resident in the heap a one-gibibyte container gives Node,
measured on 2026-10-25.

**One snapshot.** Every read happens in one `REPEATABLE READ, READ ONLY`
transaction (`src/server/services/ledger-file.ts:225-250`), so the sections of a
file agree with each other. Several reads at the default isolation could name
an account created between two of them.

**Buffered, then sent.** The file is assembled, validated and serialized after
the snapshot has closed, so the connection is back in the pool before the first
byte goes out. A streamed body would hold one for as long as the slowest
download took, which on a one-connection pool is the deployment.

**Read back before it is written out.** The exporter runs its own file through
`parseLedgerFile` and answers 500 if it is refused, naming the field paths and
nothing else, because the sentences quote keys and keys are names.

**It writes nothing**, not even a record that it was asked.

**Settings travel only when somebody chose them.** A default nobody picked is
not a decision another copy should take on.

**The file is named for the day and for what it holds**:
`simple-balance-<today>.json`, or `simple-balance-accounts-<today>.json` for
chosen accounts, dated where the person lives, so a file made at nine in the
morning in Auckland does not carry yesterday's date. The route serves it as
`application/json; charset=utf-8`, an attachment; the tool returns the same text
as `ledgerFile`, beside `rowCount` and `fileName`.

*Checked by:* `tests/integration/ledger-file-export.integration.test.ts`, which
compares every check field with postings summed by hand rather than with the
read the exporter uses, carries a balance into a range for accounts opened
before it, inside it and after it, writes no balance for a range starting after
today, narrows the history to the range's days in Los Angeles time,
refuses at both caps with their numbers and passes under them, finds another
person's account and a counter-account not found, and asserts the audit log and
the postings are unchanged by an export;
`tests/integration/ledger-file-export-route.integration.test.ts` for the media
type, the dated name, the refusals, a request with no session, and that the
tool's file is the download's; `tests/ledger-file-schema.test.ts` ("an export's
selection") for the request; `tests/ledger-file-export.test.ts` for references,
`postedAs`, `inUse` and every stored value's conversion; and
`tests/bulk-row-cap.test.ts` for the four limits and their refusals. Each
assertion that names a rule above was mutation-checked against the code it
holds.

## 9. Parts

**House.** The ten-thousand-row cap is the same number everywhere, so a file
larger than that is read in parts, and `splitLedgerFile`
(`src/shared/ledger-file.ts:1473-1564`) is what cuts them. It shipped with the
export, so the format and its splitter were tested together before anything
read a part, and the import page cuts every file it is given with it (section
15).

- **A part is at most ten thousand rows and sixteen mebibytes**
  (`LEDGER_FILE_PART_MAX_BYTES`, `:80`). A row is an entry, a budget amount or a
  staged row, which is what `rowCount` counts; the bytes are counted as UTF-8
  without encoding anything, and the estimate can only overstate a part.
- **Entries go first, in date order**, so a part never names a day earlier than
  one the part before it already wrote. Budget amounts and staged rows follow
  every entry, so they fill the last part or parts.
- **Every part carries every record** — settings, groups, categories, accounts,
  templates, recurring transactions and budget plans. They are small, a reader
  matches rather than duplicates them, and it means any part can be read on its
  own, including the second after the browser closed during the first. **Every
  part is a valid file.**
- **The balance checks travel in the last part only**, because a balance as of
  the file's last day is only true once every entry before it is in.
- **History is in no part**, because nothing reads it back.
- **Three refusals**, and no row cap cures any of them: more than ten thousand
  records — groups, categories, accounts, templates, recurring transactions and
  budget plans, references included — which every part would carry, so no
  number of parts makes it fit an import's cap on them (`ledgerFileRecordCount`,
  `:1327-1341`); a records section larger than a part on its own; and a single
  row too large to fit beside it, which the sentence names — an entry by its
  date and payee.

*Checked by:* `tests/ledger-file-split.test.ts`, which holds each of these,
counts UTF-8 against a real encoder, surrogate pairs included, and was
mutation-checked.

## 10. Refusals

**House.** A file is read in four steps, and reading stops at the first that
fails (`parseLedgerFile`, `src/shared/ledger-file.ts:854-891`):

1. **Is it JSON.** Text that is not is far more often a CSV chosen in the wrong
   place, or a download cut short, than anything else, so the sentence says
   both: *This is not a Simple Balance file: it could not be read as JSON. A CSV
   export goes through the CSV import instead, and a file that was cut short has
   to be exported again.*
2. **Does it say it is one.** A newer token is named, with the remedy: *This
   file was made by a newer Simple Balance (simple-balance-ledger-2). Upgrade
   this copy to import it.* Anything else, or nothing, is not a Simple Balance
   file. The token is read first and on its own because it decides which reader
   applies.
3. **Does it fit the schema.** Strict everywhere but the history: an unknown
   key is *"x" is not part of a Simple Balance file (simple-balance-ledger-1).*,
   a missing one *This is missing.*, a `type` or a `detail` it does not know
   *This type is not one a Simple Balance file knows.*, naming whichever of the
   two it is, and a JSON number where money goes the sentence in section 4.
   When the schema fails on a file whose `producer.version` is newer than this
   copy, an extra first problem says to upgrade, because a newer release may
   add an optional field under the same token and a strict reader refusing it
   by name would read as a damaged file.
4. **Does it hold together**, which no one record can say (`ledgerFileProblems`,
   `:973-1133`): keys unique within a kind once case and spacing are set aside;
   every reference naming a key of its kind that is there; origins unique across
   the entries and the queue; an entry filed under a category or split, not
   both; a budget about exactly one target, once per target, currency, period
   and start; a reminder's watermark a date; and the sections agreeing with the
   scope — a kind left out carrying nothing whole, deleted entries only where
   the scope has them, references exactly where a kind was left out, a
   chosen-accounts file only of the kinds it allows, every entry inside the
   range, a carried-forward balance on every whole account of a ranged file and
   on no other, and no balance check on a day before the range starts. The
   scope itself names each kind once, deleted entries only beside the entries,
   and a range only beside the entries or the history, never ending before it
   starts or before the day its checks describe.

Every problem is `{field, message}`, the field a dotted path into the file **as
it was given**, counting from zero — `entries.12.from` is the thirteenth entry
before any sorting, because that is the line somebody opening the file would
have to find. At most fifty are listed, then one more saying how many like them
there are: a file whose every amount was written as a number has one problem a
hundred thousand times, and a list that long is a page that will not render.

*Checked by:* `tests/ledger-file-schema.test.ts`, which pins every sentence
above, the paths, and the summary past fifty.

## 11. Changing the format

**House.** In this order, and all of it in one commit:

1. Decide whether the change is additive. A field a file may leave out, read
   when present, is. Anything a file written by an earlier release would not
   carry, or a field whose meaning changes, is not.
2. If it is additive, add it as optional under the same token, and say in the
   schema's comment what an older file means by leaving it out.
3. If it is not, add `simple-balance-ledger-2` and keep the reader for every
   token before it, upgrading what it reads to the newest shape so nothing
   after the reader has to know.
4. Add it to the table in section 3 and to the tables in section 7. A field in
   none of them is undefined.
5. Extend `tests/ledger-file-schema.test.ts` and the export suite rather than
   adding new ones, so the fidelity claim stays in two files.

*Checked by:* `tests/ledger-file-schema.test.ts` for both upgrade refusals, and
`tests/ledger-file-guide.test.ts` for the half of step 1 a machine can see: a
field removed, renamed, reordered or made required changes the section 3 table,
and that edit is in front of whoever reviews it. *Not checked:* that a change
was additive in meaning, which is review.

## 12. Adding a file to a ledger

**Binding.** `AGENTS.md`: "A Simple Balance file's transactions stage like any
import — complete where every reference resolves, with both sides of a
transfer filled in — and its deleted entries are not added at all. Its records
that are not transactions — accounts, categories and groups, templates,
recurring transactions, budgets — are created directly when nothing like them
is here, because a new record raises none of the questions the queue is for:
whether it is already here is the only one, and the preview asks it."

The review queue exists for the questions outside data raises about money:
does this row repeat something already in the books, which category is it,
which account did it leave. Every transaction in a file raises them again in
the ledger it arrives in, so every one stages, and the house rule in
[`csv.md`](csv.md#8-what-a-round-trip-preserves) holds for them unchanged. An
account, a category, a template or a budget raises one question, whether this
ledger already has it, and that is answerable by name before anything is
written. So the preview asks it, and a record nothing here is like is created
at once. The two obvious alternatives are both worse. Staging the records too
has nowhere to put them — the queue holds proposed transactions and has no row
for an account — and a staged entry cannot commit against an account that is
itself only proposed, so "bring my accounts across first" would become
creating each one by hand. Creating every record unasked, a same-named one
taken for the one here, is a guess: "Checking" in one ledger and "Checking" in
another can be two banks, and a guess never overwrites a decision.

**House. One planner, at both ends.** What decides every record is
`planLedgerFileAdd` (`src/shared/ledger-file-import.ts:1304-2363`), pure, and
the page and the server both run it. The page runs it over the whole file each
time somebody decides something; the server runs it again over each part, on
what it reads under the locks its writes will hold, and refuses with the very
problems the preview listed: the first one's sentence as the message and its
numbers as fields beside it, and every one, with its own numbers, in
`details.issues`. A record here is compared with the file's in the form a file
writes it: the destination is read by the exporter's own snapshot and assembly
(`readLedgerFileFacts`, `src/server/services/ledger-file.ts:1387-1443`), so "the
same record" means "would export to the same record". That is what makes a
record an earlier part created read as the same one when the next part arrives,
and a file added twice write nothing the second time, without anything keeping a
list of what an import made.

**Two routes and two tools, and no `dryRun`.**
`POST /api/v1/ledger-file:preview` and `preview_ledger_file` need `ledger:read`
and write nothing, not even an audit row. `POST /api/v1/ledger-file:add` and
`add_ledger_file` need `ledger:write`, because they create records rather than
propose them, and `ledger:stage` proposes and never decides; a stage-only agent
keeps `stage_csv`. The add takes the part as text, `fileName`, `idempotencyKey`,
`part`, `decisions`, `arriveArchived` and `preferences`, and streams progress
frames when asked, as the CSV stage does. It has no `dryRun`, which every bulk
route in [`http.md`](http.md#the-bulk-selection-contract) carries, because the
preview is that question already: it runs the planner the add runs, on the same
reads, and an add refuses with exactly its problems. Every record the add
creates and every row it stages is audited as `create_from_ledger_file`, the way
a CSV's say `create_from_csv`, so Activity says where a record came from.

*Checked by:* `tests/ledger-file-import.test.ts` for the planner, by outcome, by
count and by sentence; `tests/integration/ledger-file-add.integration.test.ts`
("previews an empty ledger as everything new, and writes nothing to do it",
"adds a whole ledger to an empty one: records at once, entries to Staged",
"writes nothing the second time the same file is added", and "is two tools over
a real connection, the add only behind ledger:write"); and
`tests/integration/ledger-file-add-route.integration.test.ts` for the colon
paths and the frames.

## 13. What each record meets here

**House.** Every record the file carries whole, every record it only names,
every budget plan and every budget's per-period amounts meets one of five
things, and is planned in the order records can name each other — groups,
categories, accounts, templates, recurring transactions, budgets — because
whether a category here is the same depends on what its group became, and
whether a budget can come at all on what its category did.

| Outcome | When | What happens |
| --- | --- | --- |
| `create` | Nothing here has its name, once case and spacing are set aside (`normalizeHumanName`) | Created, with nothing asked |
| `exists` | Something here has its name and is the same in every field the file carries | That one is used, and nothing is written |
| `duplicate` | Something here has its name and differs, or another record of its kind in the file folds to the same name | The person decides |
| `missing` | A record the file only names, and nothing here answers to it | The person decides, except about a template, below |
| `refused` | It cannot come in as it stands | Left out with its reason, and nothing to decide |

"The same" is asked of each kind in its own terms, and blank counts as absent
throughout:

| Kind | The same as the one here when |
| --- | --- |
| Category group | Its budget policy matches |
| Category | Its kind matches, and its group is coming in under the name of the group the one here is in |
| Account | Its currency, type, opening day and opening balance (as the file's opening works out here, below), institution, notes and whether the budget is about it all match. Whether either is archived or in use is not compared |
| Template | Its draft matches, with the accounts and categories it names compared by the name each is coming in under and the amounts by value, and so does its reminder's rule, leaving out the three fields the scheduler owns |
| Recurring transaction | Its shape matches as a template's draft does, and so do its schedule and whether it emails. The last occurrence it decided is not compared |
| Budget plan | The same target, as it resolves here, currency and period, over a window that overlaps one here: the same in every field is `exists`, anything else `duplicate` |
| A budget's per-period amounts | Period by period on the resolved target: the same amount is already here, a different one, or a period another budget in the file already filled, is a conflict, and the rest are new |

**What the person can decide is exactly the record's `choices`, and nothing is
decided for them.**

- **A duplicate** takes `use_existing` (use the one here, and everything the
  file files under its own lands under it), `skip` (leave the file's out) or
  `rename` (bring it in as a new one under another name). Four narrow that. An
  account in another currency can never be the one here, so it takes only
  `skip` and `rename`, with a sentence naming both currencies. A recurring
  transaction takes the same two, because nothing in a file names one, so
  using the one here and leaving the file's out would be the same thing. Two
  records of one kind in the file that fold together take the same two. A
  budget plan that overlaps a different one here takes `skip` alone, asked as
  one answer to acknowledge, because nothing here is ever replaced.
- **A budget's amounts** are decided once per budget, under a key such as
  `category:Groceries|EUR|month`, rather than period by period, because ten
  years of months is the same question a hundred and twenty times. With new
  periods beside the conflicting ones it takes `use_existing` (keep the
  amounts here and add the new ones) or `skip` (leave all of the file's out);
  with none, `skip` alone. Periods that match are passed over either way.
- **A record the file only names** takes `match` (use another one here),
  `create` (make it from what the file says about it) or `leave_staged` (leave
  what names it for review). `match` is offered only where something here
  could be chosen — for an account, one in the same currency, the only match a
  decision is accepted for. A group takes `skip` in place of `leave_staged`,
  because nothing staged names a group: left out, its categories come in
  without one, and the record says so before anybody chooses. A template is
  never asked about: it is only ever provenance on an entry, so one nothing
  here answers to is dropped, which is what a deleted template already leaves
  behind.
- **A name is stated, never invented.** A rename has to differ from the
  record's own name once folded, meet its kind's own name rule, and be free
  here and among everything else coming in; a name taken here by a record that
  is the same in every field is that record, made by an earlier part, and is
  used. The page offers a name only once somebody picks a copy —
  `suggestLedgerRename`'s first free `"Name (2)"`, or, where exactly one record
  here under another name is the same as the file's (`copy` on the planned
  record), that name, so a resumed import finds the copy it made rather than
  making a third.

**A reference resolves by name, and an account by name and currency.** A
category or group reference matches by name alone, and a category that takes
another kind here is used and the difference said, because the entries filed
under it post by the kind it has here. A reference whose name another record in
the same file carries whole is `missing` rather than matched, because where the
file came from those were two records, and the one here may be the other one,
made by an earlier part. An account created from a reference opens at zero on
the earliest day a live entry or a staged row in the part names it, or the
file's last day when none does (`ledgerReferenceOpeningDate`,
`src/shared/ledger-file-import.ts:849-862`), and a file sent in parts sends
`openingDate` on the decision, worked out over the whole file, so the account
opens on the same day whichever part creates it. Once `create` is chosen the
record says so, and that its balance will be only what the file's entries move:
adding a file that carries the account whole first is what brings its opening.

**An account opens as the file's opening works out here.** Without a
carried-forward balance, the file's own. An account opened before a ranged
file's first day opens on that day at what it held the day before; one opened
inside the range keeps its own day, and the money dated before the range,
which no entry carries, is added to its opening balance
(`ledgerAccountOpening`, `src/shared/ledger-file-import.ts:816-834`). An
account has one opening, so one of the two figures has to move, and moving the
money keeps the day the person sees and makes every balance from it on exact.
A duplicate account whose opening differs says both openings and what using
the one here does to the gap, rather than "it differs", because that is the
difference that decides a balance and using the one here keeps its own.

**Some records are left out, with the reason, and nothing to decide.** A
recurring transaction whose account is not coming in; an account, a template
or a recurring transaction whose create would refuse it, in the create's own
sentence; a budget on a category or group that is not coming in, on a category
that takes only income, or on a group budgeted as the sum of its categories; a
second budget in the file overlapping the first on the same target; and a
budget plan the create would refuse, held to `budgetPlanRefusal`, the rule the
create itself calls, so the preview never says ready for a part the server then
refuses whole. A record whose category, group or account is still an open
question waits on it rather than being called left out, because what it needs
may yet come in.

**What a record here is like is said beside it.** One that is archived here,
or an account that is frozen, is used, and the entries naming it wait in
Staged until it is restored or back in use. A category archived where the file
came from arrives in use, unlike an account: a row filed under an archived
category cannot be committed, and a category takes no place, so nothing is
saved by making somebody restore it first. The record says to archive it again
once its entries are in.

**A ledger keeps at most 200 templates and 200 recurring transactions**, and a
file that would carry it past either is refused with `limit`, `current`,
`more` and `over`, naming only the moves that work.

*Checked by:* `tests/ledger-file-import.test.ts`, whose describes are this
section's paragraphs — "a record already here in another form", "an account
here in another currency", "a record the file only names", "a group brought in
under another name", "a group the file only names", "budgets", "caps",
"recurring transactions", "a record waiting on another's question" and "an
account's opening" — each mutation-checked against the planner; and
`tests/integration/ledger-file-add.integration.test.ts` ("asks about every
record already here that differs, and writes nothing until it is told", "says
what using the account here does to its opening, and an opening edit makes it
right", "opens an account made from a reference on the same day in parts as in
one").

## 14. Entries, staged rows and origins

**Binding.** `AGENTS.md`: "An entry's origin is the id it was first written
under. It travels in every ledger file, and the same entry arriving twice —
from two accounts' files, or back from the copy it moved to — is skipped rather
than flagged. Two entries with different origins are never duplicates of each
other: not at stage, at commit, on an edit or a restore, or in a mass edit."

**House. Every live entry stages as a complete draft wherever its references
resolve** (`ledgerEntryDraft`, `src/shared/ledger-file-import.ts:1020-1065`). A
transfer carries both sides and both amounts, always, so a transfer in two
accounts' files stages whole the first time and is skipped by its origin the
second, and a conversion arrives with the two figures that moved. A category is
its id, or — for one left for review — its name and the kind the commit should
create it as, which is the `categoryKind` rule; a skipped one leaves the row
uncategorized. A split's legs are filed the same way. The template it was made
from is kept where the template resolves, and dropped where it does not, because
it is provenance and nothing else. An account that does not resolve is left out
and the row stages partial, keeping the side that is known, so the queue raises
its usual issue. The file's own staged rows stage again, with their keys turned
back into ids and their raw data kept. Each part's rows go under an import batch
of their own, of kind `ledger_file`, which the Staged page's batch filter names
as a Simple Balance file; a part that stages nothing makes no batch. Neither
origin is ever sent in a view of an entry or a staged row, or accepted in a
draft: a field the API sends has to be rendered
([`web.md`](web.md#119-a-field-the-api-sends-is-rendered-or-its-absence-is-argued)),
and an origin is for recognizing an entry rather than for showing one.

**An origin found here is skipped and counted, never flagged.** One statement
looks in five places (`findImportOrigins`,
`src/server/services/ledger-file.ts:1314-1341`), so a commit landing between
two lookups cannot slip an origin past both: an entry's own id, which is what a
file re-imported into the ledger it left carries; an entry's `import_origin`,
deleted entries included, because deleting an entry is a decision about it and
importing it again would undo that; a waiting row's own id and its
`import_origin`; and the id of a row with no origin that has been committed
(section 6). Every branch leads with the owner, so a forged origin can at worst
make somebody's own import skip an entry of their own. A discarded row is no
decision about the entry, so a row discarded here stages again. The preview
reports what was found as `rows.alreadyHere` and `rows.stagedAlreadyHere`, and
what will stage as `rows.toStage`.

**The database holds the skip, because a read can race.** Two tabs, two parts,
or a commit landing between the lookup and the write could each slip one
through, so 0026 makes "one entry per origin per ledger" and "one waiting row
per origin" unique indexes. The commit copies a row's origin onto the entry it
becomes, and a violation is a sentence rather than a constraint: from the
commit, *This entry is already in the ledger, so it was not committed again.*,
and from the add, *Another import staged this file's transactions a moment
ago. Check the file again.*, with an agent told to call `preview_ledger_file`
again. On a Citus cluster the index's name carries a shard
suffix, so the violation is recognized by the name it starts with.

**Different origins are never duplicates, and no origin is compared as it always
was.** `importOriginsDiffer` (`src/shared/ledger-file-import.ts:2409-2414`) is
true only when both rows carry an origin and the two differ: two coffees bought
the same morning and committed apart are two entries, so nothing pairs them —
not the check at stage or at commit, on an edit or a restore, in a mass edit, or
behind the badge on Staged that marks a possible duplicate. A row without one —
typed here, or read from a CSV — is compared by the duplicate check exactly as
before, because nothing else can tell it from a look-alike.

**A refund whose other half landed elsewhere is reported, not reproduced.**
`rows.postedAsDiffers` counts the entries whose `postedAs` says their postings
netted to the other counter-account from the one `resolveEntrySide` will choose
here, because a category was widened after they were written. Overriding the
side would be a second rule beside `resolveEntrySide`, and `AGENTS.md` keeps it
one function. Account balances are unaffected; income and spending move by the
stated amount.

*Checked by:* `tests/ledger-file-import.test.ts` ("what an entry stages as",
"tells two entries apart by origin only when both have one"),
`tests/unique-violation.test.ts` for the violation under both names, and
`tests/integration/ledger-file-add.integration.test.ts` ("makes the same books
once its entries are committed, and copies each origin", "skips an entry
already here by origin, deleted or not, and stages a discarded row again", "is
skipped by the ledger it came from, all the way round", "lands a transfer once
from two accounts' files", "refuses an entry already in the books at commit
with a sentence, not a constraint", "matches and touches nothing of anybody
else's", and "never sends an origin in a view of an entry or a staged row"),
with `tests/integration/ledger-file-add-route.integration.test.ts` ("sends no
origin in a staged row or an entry") for the same over HTTP.

## 15. Parts, places and settings

**House. A part at a time, each all or nothing.** A part is at most 10,000
rows, the cap `AGENTS.md` fixes for every bulk write, and at most 10,000
records apart from its rows, because every part carries all of them and its
one transaction creates or matches each under every namespace lock; a part
over either is refused with `limit` and `count` before the ledger is read
(`readPart`, `src/server/services/ledger-file.ts:1256-1285`). The splitter
never cuts a part over the row cap, and refuses up front a file whose records
alone are over the other. So the part that meets the row refusal is one nobody
cut: a file made by hand, or the browser's download — up to 100,000 rows —
handed whole to an agent, which holds the file and not the page that cuts it.
That is why the refusal states section 9's rules rather than only pointing at
the page: every part carries every record section whole, the entries go
across the parts in date order with budget amounts and then staged rows after
them, history goes in no part, and only the last keeps the balances — and that
every part goes with the same decisions, its own key and its number. Each part
takes every lock up front, in the order
`helpers.ts` sets, reads the facts under them, plans, and writes, so what it
planned against cannot move before it writes; an account the plan would use
that was not locked can only have appeared or been renamed in between, and is
refused with *This ledger changed while the file was being read. Check the
file again.*, the page's own button, and an agent is told to call
`preview_ledger_file` again.

- **Idempotent twice over.** By its key, bound to a hash of the part, its name,
  its number and everything decided, so a part sent again replays and the key
  with another request is a 409; and by its origins and its records, so a part
  applied again after its key has expired writes nothing new either.
- **The same decisions travel with every part.** Every part carries every
  record, so one about a record that needs none in this part — because an
  earlier part created it — is passed over rather than refused, and one naming
  no record in the file is refused, because that is a key somebody typed
  wrong. A budget's amounts are the one kind a part carries only some of, so a
  decision about them is passed over in a part that does not hold them, and
  "leave all of them out" is honored in every part, including one that did not
  ask.
- **Resuming is checking again.** The file as a whole is not atomic. A
  fresh preview after a part failed finds what earlier parts created as
  `exists` and their entries as already here, and offers the rest; a record an
  earlier part brought in renamed is asked about again, with the copy's name
  offered, since the decisions are gone with the browser that held them.

**Binding, places.** `AGENTS.md`: "Archived accounts are outside all of it:
they already refuse every write, so they are never frozen and use up none of
the places." So on a plan that keeps a limited number of accounts in use,
the accounts a file would create live are counted against the free places, and
the person names which of them arrive archived (`arriveArchived`). None is
named for them. `places` carries the arithmetic — `needed` is the accounts
arriving live less the places free, never below zero — and the add is refused
with `limit`, `current`, `arriving` and `needed` while fewer are named. An
account archived where the file came from arrives archived anyway and costs
nothing. An agent's refusal says what it can send and that only the person can
raise the limit, from the browser, because an agent cannot buy anything. The
choice is offered where nothing limits the places too, so a person can do what
an agent can, and costs nothing there.

An account that arrives archived is created, opened and closed out to equity
on today's date where the person lives, as archiving any account closes it
(`createAccount`'s `arriveArchived`, an argument rather than a field, so no form
or tool can ask for it). It holds its full history, and restoring it posts the
balance back. Its entries still stage, with the archived account's usual
issue, and commit once it is restored into a free place. Adding a file is one
of the paths that changes the live set, so it holds `lockAccountNamespace` like
the rest.

**Binding, settings.** `AGENTS.md`: "A guess never overwrites a decision." A
file's timezone, default currency and theme are applied where this copy has
none of its own (`chosen` false), written with `ifUnchosen` so a choice made
since the preview wins. Where it has and the file's differ, the add needs
`preferences`, `file` or `keep`, and the page asks with nothing preselected;
where they match, or the file has none, it is passed over. `file` replaces
settings somebody has, and the timezone decides what today means, which is why
`add_ledger_file` is annotated destructive and says to confirm it. **One gap,
stated rather than solved:** the browser's own guess, written the first time a
new account is opened, makes `chosen` true like any choice, because the column
cannot tell the two apart, so a new sign-up whose browser set a timezone is
asked rather than given the file's. Telling them apart needs a column of its
own, which is a migration and a change to `AGENTS.md`'s rule about guesses, and
the page's hint says where the settings came from instead.

*Checked by:* `tests/ledger-file-import.test.ts` ("a free plan's places",
"settings", "decisions", "a file in parts, every part planned with the whole
file's decisions"); `tests/integration/ledger-file-add.integration.test.ts`
("applies a file in parts, each all or nothing, and resumes after a part
fails", "replays a part sent again with its key, and refuses the key with
another request", "refuses a part with more records than one part may carry,
before reading the ledger", "applies the file's settings over a choice made
here only when asked", and "takes the same budget decision with every part,
from the service and over MCP");
`tests/integration/ledger-file-add-plan.integration.test.ts` for a free plan's
places end to end, an account archived at the source among them; and
`tests/ledger-file-split.test.ts` ("tell an agent handed a file over them how
to cut it the way the splitter does"), which sends a part over the row cap
through the preview and holds the refusal to every rule `splitLedgerFile` is
itself held to.

## 16. What adding does not do

**House.** Each of these is a decision, and each has its reason.

- **Deleted entries are not added.** A staged row cannot be voided money, and
  a deleted entry changes no figure. They are counted in `rows.deleted` and
  said on the page. Moving a whole ledger is what will bring them, and it
  arrives in a later change.
- **An account keeps no archive day.** One archived where the file came from
  arrives archived, closed today rather than on the day it was archived there:
  the instant travels in the file, and only a move, writing the account's
  history before it closes, can honor it.
- **Nothing here is changed by an import.** No record is updated, renamed or
  merged, no decision means "replace", and no `version` moves, except the
  settings, through their own service and only as section 15 says. No posting
  is written but the opening and archive-close postings the account service
  writes for a new account.
- **Nothing is written at all while the plan has a problem**, and nothing of a
  part is left when a service refuses something the plan did not foresee.
- **The import sends nothing.** A reminder arrives with the date its last
  email went out, so a one-time reminder already sent stays sent, and a
  recurring transaction starts proposing after the last occurrence it decided
  and never before today, so arriving on an occurrence day does not propose it
  twice. Both are arguments to the creates, never fields.
- **The activity history is never read**, and a staged row's recurrence
  provenance never travels (section 7).

**Moving a ledger is not built yet, and the preview already knows when it
would be offered.** `move.qualifies` is true where every entry and waiting
staged row in this ledger came from a Simple Balance file — a new sign-up, a
fresh install, a ledger part-way through a move — and `move.reason` says why
not otherwise. A deleted entry typed by hand counts, because it is still
somebody having typed into this ledger. Adding is all that is carried out
today.

*Checked by:* `tests/ledger-file-import.test.ts` ("count what the rows will
do"), and `tests/integration/ledger-file-add.integration.test.ts`: "previews an
empty ledger as everything new, and writes nothing to do it" counts the deleted
entry its seeded ledger holds, leaves it out of what will stage and finds the
ledger qualifying to be moved; "adds a whole ledger to an empty one: records at
once, entries to Staged" stages the live entries and the queue and nothing
else; and "brings the templates' reminders and the recurrences' watermarks with
them" holds the last bullet but one. *Not checked:* that no service an import
reaches overwrites a record, beyond those suites asserting the destination's
records unchanged where they say so.

## 17. What is checked, and what is not

Checked:

- The format, every refusal sentence, the round trip and the layout:
  `tests/ledger-file-schema.test.ts`.
- This guide's field table against the schema: `tests/ledger-file-guide.test.ts`.
- The splitter a reader will cut a file with: `tests/ledger-file-split.test.ts`.
- What the exporter carries, references, drops and converts:
  `tests/ledger-file-export.test.ts`.
- A real ledger exported whole, by chosen accounts and over a range, its checks
  against the postings, its scoping and its caps:
  `tests/integration/ledger-file-export.integration.test.ts`.
- The download and the tool:
  `tests/integration/ledger-file-export-route.integration.test.ts`,
  `tests/mcp-parity.test.ts` and `tests/mcp-measurements.test.ts`.
- The page that asks for one: `tests/import-export-page.test.tsx`, and
  `tests/browser/ledger-file-export.spec.ts` for what only a browser does with
  it — a keyboard alone, implicit submission, a real download.
- What adding one decides, by outcome and by sentence:
  `tests/ledger-file-import.test.ts`.
- Adding one into an empty ledger, into one holding records of the same names,
  part by part, twice, and back into the ledger it came from; the books its
  entries make once committed; the origins, the watermarks, the settings, the
  scopes and both tools over a real connection:
  `tests/integration/ledger-file-add.integration.test.ts`. A free plan's
  places: `tests/integration/ledger-file-add-plan.integration.test.ts`. The two
  routes, the colon and the frames:
  `tests/integration/ledger-file-add-route.integration.test.ts`. A body past
  the MCP SDK's own four mebibytes reaching both tools:
  `tests/mcp-request-body-limit.test.ts`.
- The page that adds one, part by part, with its questions, its places, its
  settings and its stops: `tests/ledger-file-import-page.test.tsx`, and
  `tests/browser/ledger-file-import.spec.ts` for the keyboard alone, a real
  two-part file and the focus a file input keeps while it is checked.

Not checked:

- That moving a whole ledger straight into the books, with its deleted entries
  and archive days, reproduces it exactly. Adding is the only import so far,
  and its own suite commits the rows it stages and compares every account's
  postings with the ledger the file came from
  (`tests/integration/ledger-file-add.integration.test.ts`); the move's
  fidelity suite arrives with the move.
- That section 7 lists every column a table holds. A column added to the schema
  and to neither table is undefined until somebody adds it here.
