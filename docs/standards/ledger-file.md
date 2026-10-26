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

Everything here is grounded in three places. `src/shared/ledger-file.ts` is the
format — schema, reader, whole-file rules, writer, splitter and the export
request — and the browser and the server both use it.
`src/server/services/ledger-file.ts` reads a ledger and writes the file.
`GET /api/v1/ledger-file` (`src/server/api.ts:2181-2189`) and the
`export_ledger_file` tool are the two ways to ask for one, and the Export
section of **Import and export** is the page that asks. This release exports;
reading a file back into a ledger arrives in a later one, and the format
already carries what that needs, because a published format cannot grow a
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
file already carries origins, the deleted flag, archive instants, the reminder
and recurrence watermarks and the balance checks, although the release that
introduced it only exports. [`writing.md`](writing.md#versioning) counts it as
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
end (`serializeLedgerFile`, `src/shared/ledger-file.ts:1357-1375`). Fully
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
one would be one entry in two places. Until a ledger can keep an origin through
an import, an entry's origin is its own id.

*Checked by:* `tests/ledger-file-schema.test.ts` ("an origin"), which refuses
two records with one origin across the entries and the queue together.

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
`src/shared/ledger-file.ts:1535-1604`), strict, so an agent can ask for exactly
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
offset (`historyConditions`, `src/server/services/ledger-file.ts:409-418`).
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
(`src/server/services/ledger-file.ts:222-228`, `:440-470`). The activity history
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
transaction (`src/server/services/ledger-file.ts:163-188`), so the sections of a
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
(`src/shared/ledger-file.ts:1441-1524`) is what cuts them. It ships with the
export so the format and its splitter are tested together before anything reads
a part.

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
- **Two refusals**, and no row cap cures either: a records section larger than a
  part on its own, and a single row too large to fit beside it, which the
  sentence names — an entry by its date and payee.

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

## 12. What is checked, and what is not

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

Not checked:

- That a reader reads a file back into an equal ledger. Nothing reads one yet;
  the fidelity suite arrives with the import.
- That section 7 lists every column a table holds. A column added to the schema
  and to neither table is undefined until somebody adds it here.
