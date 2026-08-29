# MCP server

The stateless Streamable HTTP endpoint is:

```text
https://simple-balance.example.com/mcp
```

A trailing slash works too. `/mcp` is the canonical form and the one discovery
advertises, but `/mcp/` reaches the same endpoint, because a client configured
with one used to complete the whole OAuth flow and then get a 404 on every call.

Agent clients get the same ledger validation, review workflow, duplicate
protection, and audit trail the browser gets. Nothing is relaxed for automation.

OAuth discovery is available at:

```text
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
```

The embedded Better Auth provider supports authorization-code flow, PKCE, dynamic
client registration, consent, access/refresh tokens, and protected-resource
metadata. MCP clients should discover configuration from the server rather than
hard-code authorization endpoints.

The MCP OAuth flow uses whichever interactive sign-in methods `AUTH_MODE`
enables. In the default `local` mode, the MCP client opens the browser
authorization page, the person signs in with the same email and password they
use for the web app, approves the requested scopes, and the client completes
PKCE token exchange. The token is bound to whoever signed in, and reaches their
books alone. Google credentials are not involved. In `google` mode the same browser
flow uses Google; `both` presents both methods.

Registration is open, as RFC 7591 intends, but bounded: the text fields are
clamped to lengths a real client has no trouble with, and a registration that
after a day nobody has approved and that has never been issued a token is swept
away.

Every authorization request is routed through the consent screen, including
requests from already signed-in users and clients that omit `prompt=consent`.
The server decides that approval is required. A dynamically registered client
cannot waive it.

OAuth access tokens returned to clients are RS256 JWTs with issuer, subject,
client, scope, expiry, and an audience fixed to this deployment's `/mcp` resource.
The public key is exposed at the discovery document's `jwks_uri`. Signing keys
persist in PostgreSQL, so tokens remain valid across container restarts. After JWT
verification, the server also checks Better Auth's revocable access-token record
and whether the user still has an authentication method enabled by the current
`AUTH_MODE` before a tool can run.

## Scopes

- `ledger:read`: accounts, categories, payees, transactions, staging,
  summaries, CSV export, and audit history.
- `ledger:stage`: read access plus staged transaction and CSV-stage mutations.
- `ledger:write`: every ledger operation, including direct and staged commits.

Both discovery documents advertise all seven scopes — the three above plus
`openid`, `profile`, `email` and `offline_access` — so a client that reads them
and asks for everything arrives with write access it may have no use for. That
is more than a first connection needs, and narrowing it is a change this release
does not make: a client written against an older SDK, or by hand, may not
implement the RFC 6750 step-up, so anybody re-authorising after the upgrade
would come back read-only with nothing on screen saying why. Taking a capability
away quietly is not something an upgrade here does.

What did land is the half that costs nobody anything. A call to a tool the
connection has no scope for answers with an `insufficient_scope` challenge
naming the tier that would have worked, so a client that *does* ask for less has
a way back up, and narrowing the first ask becomes a later release's job once
the step-up has been in the field.

Tools an agent has no scope for are left out of discovery entirely, so it never
sees a tool it cannot call, and calling one anyway comes back as a 403 naming
the scope that would have worked rather than as a missing name. A call that
reaches a tool returns both `structuredContent.result` and the same thing as
JSON text, whether it succeeded or was refused: a refusal comes back as
`result.error` with a code, a message and sometimes details, and `isError` set.
An argument that fails a tool's published input schema never reaches the tool.
The protocol refuses it first, and that refusal is a text block reading
`MCP error -32602: Input validation error: ...` naming the field, with no
`structuredContent` and no code. Read the field it names, fix the argument, and
call again.

Money is always a decimal string, never a JSON number, because binary floating
point cannot hold these values exactly. Dates are `YYYY-MM-DD`. Writes take an
idempotency key you choose: send the same key again and you get the original
result back rather than a second transaction. Fields carry descriptions, so an
agent reading the schema learns the conventions that matter, including the one
that catches people out: a credit card or loan opens at a negative balance,
because that is money owed.

## Accounts

`list_accounts`, `get_account`, `get_account_balances`, `create_account`,
`update_account`, `archive_account`, and `delete_account`.

An account's `balance` is every posting it holds, future-dated ones included,
which is what the accounts page shows. `get_account_balances` is what separates
them: it reports the beginning and ending balance of a range, what has actually
moved by today, and what is still to come. Reach for it before telling somebody
what they have.

An archived account still comes back from `get_account`, so read `archivedAt`
rather than treating a result as proof the account is in use. Archiving posts
whatever the account still holds out to equity, so it closes at zero and
restoring posts the balance back; that is what lets a total leave archived
accounts out and still be right. Deleting is only possible while the
account is not archived — unarchive it first — and while nothing references it:
no transaction, no staged row, no posting, and no recurrence or template naming
it in its schedule or draft. A category answers to the same list of holdouts, and
to templates as well, but not to the archived rule: an archived category with
nothing pointing at it can be deleted where an archived account cannot.

## Transactions

`list_transactions`, `get_transaction`, `create_transaction`,
`update_transaction`, `set_transaction_deleted`, and the two bulk tools below.

A transaction can name its category instead of citing an id. Send
`categoryName` and the server matches it against the categories you already
have, ignoring case and surrounding space, and creates one only when nothing
matches; `categoryId` wins if you send both. `categoryKind` says which kind to
create it as when the name is genuinely new, which is how a refund into a
spending category nobody has created yet is expressed: without it a deposit
makes an income category and the refund credits that instead of lowering the
spending. It is ignored when the category already exists. A category naming the
opposite side is kept as it is, because that is what a refund looks like: "Groceries" on a
deposit lowers grocery spending rather than turning Groceries into a category
that covers both. One already covering both sides stays that way, and an
archived one named again comes back. This is the same rule a CSV import follows, so an
agent writing "groceries" cannot start a second spelling of "Groceries".

Deleting posts the reversal rather than erasing anything, which is why the tool
is `set_transaction_deleted` and takes a boolean: the same call restores it. A
deleted entry nets to zero, so nothing filters it out of a balance.

## Splitting one entry across categories

One transaction can be split across several categories. Send `legs`, a list of
at least two, each with its own `amount` and its own `categoryId` or
`categoryName`, and leave the entry-level category off: sending both is refused
rather than merged, because guessing which you meant would file money under a
category you did not choose. The amounts must add up to the transaction's own,
and a transfer cannot be split, having no counter-account side to partition.

Every transaction comes back with a `legs` list, empty for the ordinary
single-category case. Each leg carries an `id`, and that id is how an edit says
which leg it means: send it back to change that leg, leave it off for a new one,
and leave a leg out to remove it. Matching legs by position instead would make
reordering two rows look like rewriting both. Sending an `id` that is not
already a leg of that transaction is refused rather than treated as a new leg,
so a copied identifier fails loudly instead of quietly rewriting the entry.

Mass edits refuse to set a category or a type on a split rather than flattening
it, and the refusal fails the whole call rather than skipping the row.
`preview_bulk_transaction_selection` reports `splitCount`, so an agent can know
before it asks.

## Changing many rows at once

There are two ways to say which rows you mean. An explicit selection lists each
id with the `expectedVersion` you last saw, so a row someone else changed makes
the request stale instead of silently taking your value. A filter selection says
"everything matching this", and starts with
`preview_bulk_transaction_selection` (or `preview_bulk_staged_selection` for the
queue), which returns a count and a fingerprint of the exact `id:version` set
that matched. Send that fingerprint back with the change. If anything in the set
moved in between, the request is refused rather than quietly covering a
different set of rows than you were shown.

`bulk_edit_transactions` changes the date, payee, category, account,
description, notes, or deposit/withdrawal type. Fields you leave out stay as
they are. Transfers accept only the shared text, date, and category fields, and
moving a transaction to another account cannot change its currency. Duplicate
checks run against the final state of the whole selection before a single row is
written.

`bulk_delete_transactions` takes the same two selection shapes. Deleting posts
the reversal rather than erasing anything, so a deleted transaction stops
counting toward balances and reports while the record of it remains.

`bulk_edit_staged_transactions` does the same job on Staged transactions, with
the same two selection shapes and the same fields. What differs is what happens
afterwards, and it is simpler: a staged row is a draft, so nothing posts,
reverses, or moves a balance. Every row it touches is validated again, so
filling in the account or category an import could not resolve clears the issues
that were blocking a commit, and the reply says how many of the rows are ready
now and how many still need attention. Account and type are refused on a
transfer, which has two accounts and no single one to move. Setting an account
on a row that does not yet say whether the money came in or went out is refused
too, unless the same call sets the type; there is otherwise no side to write it
to. Both are refused rather than skipped, so the number of rows changed always
matches the selection.

Any of them covers at most 10,000 rows per request. Split larger work across
calls; each stands or falls on its own.

Pass `dryRun: true` to `bulk_edit_transactions`, `bulk_delete_transactions`,
`bulk_edit_staged_transactions`, `bulk_edit_transaction_templates`,
`bulk_delete_transaction_templates`, `stage_csv`, or `commit_staged_transactions`
to find out what a change would do without doing it.

## Paging and ordering

Lists page two ways. A `cursor` walks forward through a stable keyset, which is
what you want for reading a whole ledger. A `page` number jumps straight to a
page and comes back with the total row count, which is what the browser uses.
Send both and the cursor wins.

Lists also take `sort` and `direction`. A cursor belongs to the ordering it was
issued under and is refused if you change the ordering underneath it, because
resuming a keyset walk in a different order silently skips and repeats rows.
Which orderings can be resumed differs by list. On the transactions list,
account and category cannot be, so those return no cursor and you page them by
number. On the staged queue only `date` can, and the other five page by
number.

## Categories

`list_categories`, `get_category`, `list_duplicate_categories`,
`merge_categories`, `create_category`, `update_category`, `archive_category`,
and `delete_category`.

Listing reports how many committed transactions and how many staged rows use
each category, and the two added together, the same three numbers `list_payees`
gives. `list_payee_suggestions` completes a partial name against the payees
already there, which is how an entry gets filed under the spelling in use rather
than a new one. Read them before creating one: the most common way a ledger ends up with
three spellings of the same category is an agent adding one it could have
reused, and a usage count is what tells you which spelling is the established
one and which is the stray to merge away. A category nothing uses comes back at
zero rather than being left out, because that is the one worth archiving.

The counts cover the whole ledger, not a date range, and leave out deleted
transactions and staged rows already committed or discarded. A row that has been
committed is counted once, as a transaction, not again as the staged row it came
from.

**A category can disappear as a side effect of an edit.** Recategorising the last
transaction off a category deletes that category, in the same transaction, and
writes an audit event for the deletion. It happens on `update_transaction`,
`bulk_edit_transactions`, `update_staged_transaction` and
`bulk_edit_staged_transactions`, and only for a category the edit itself moved
off: one that was already standing empty is left alone, so a category made ahead
of time survives. Anything else still naming it keeps it — another transaction, a
staged row, a recurrence, or a template — and a caller holding only
`ledger:stage` never triggers it, on the same rule that stops that scope creating
a category. If you cached a category id before an edit, read it back afterwards
rather than assuming it is still there.

## Knowing where you are

`whoami` reports whose books these are and the client id this call is authorized
under, which is how a client picks itself out of `list_connected_agents`. It
says nothing about how the person signs in. It does say whether this deployment
can send mail at all, as `notificationsAvailable`: reminders and proposal notices
are stored whether or not it can, so this is how to tell somebody that the
reminder they just asked for will not arrive until an operator configures SMTP,
rather than leaving them to notice the silence.

It also reports `scopes`, which is what the token in hand may do. A tool outside
that grant is not in the tool list at all, so this is how to tell a capability
you were not granted from one that does not exist, and what to name when asking
somebody to reconnect the client with more.

`get_preferences` reports their timezone, default currency and colour theme, and
reading the first of those matters more than it sounds. What counts as today is
decided by their timezone rather than the server's, and `get_financial_summary`
and `get_account_balances` resolve "today" through it. Without reading it an agent
cannot explain the `asOf` it was given or predict which day an entry dated today
will land on. `chosen: false` means nobody has picked yet rather than that they
chose UTC.

`theme` is `system`, `light` or `dark`. `system` is not a colour but a standing
instruction — follow whatever this person's own machine is set to, and keep
following it when it changes — which is why it is the default and why nothing
detects a theme and stores the answer. It affects nothing but what their screen
looks like, so set it when asked and not otherwise.

`set_preferences` changes any of the three; what you leave out keeps its current
value. There is no version to check on this record and no undo beyond setting it
back, so confirm it with the person first.

`summarize_own_data` counts everything in the ledger.

`get_financial_summary` answers a question about money rather than about a row.
It computes balances, deposits, withdrawals and
spending separately per currency, never mixing them, and it stops at today
whatever `end` you ask for: money dated in the future has not moved yet, and
`asOf` says which day the figures are really as of. Archived accounts are left
out by default, because archiving posts an account's balance out to equity and
counting it again would double it; `includeArchived` puts the account and its
past activity back in. It is the dashboard's own figures; `get_report` in
[Reports](#reports) answers the same questions over time and in more detail.

## Reports

`get_report` runs one report over a date range and returns a matrix: named rows
against time buckets, separately per currency. Pass `report`, and optionally
`start`, `end`, `bucket` and `includeArchived`. Every figure is a decimal
string, and nothing is ever added across currencies.

| `report` | Rows | Answers |
| --- | --- | --- |
| `net-worth` | your accounts | what each held at the end of each bucket |
| `income-expense` | income and expenses | what came in and went out during it |
| `categories` | your categories | the same, split by what you filed it under, income as well as expense |
| `cash-flow` | where the money came from | movements in and out of spendable accounts, by counterpart |
| `balance-sheet` | your accounts | what they hold as of one date |
| `trial-balance` | every account, counter-accounts included | the same, and it totals zero when the books are whole |

`includeArchived` does different things on different reports. On
`income-expense`, `categories` and `cash-flow` it decides whether an archived
account's activity is counted at all. On `net-worth`, `balance-sheet` and
`trial-balance` it changes no figure: an archived account held what it held for
every bucket before it closed, and archiving posts that balance out to equity, so
it reads zero from the day it closed and needs no filtering to say so. Leaving it
out of those reports altogether took its money out of the months it was open too,
which is history the report had right the day before. So there the flag only
decides whether a row that is flat at zero across the whole window is listed —
and a currency with nothing left to list is left out entirely rather than coming
back as an empty section. Each row carries `archived`, so a closed account's
history is not mistaken for money still held.

The trial balance goes further and always lists archived accounts, whatever the
flag says: leaving one out would drop its side of the closing posting and keep
equity's, and the one report whose claim is that the rows total zero would stop
totalling zero for every date before the archive.

`bucket` is `none`, `week`, `month`, `quarter` or `year`. The default is
`month` for `net-worth`, `income-expense` and `cash-flow`, and `none` for
`categories`, `balance-sheet` and `trial-balance` — so a `categories` report
asked for without a bucket comes back as one column covering the whole range,
not as a monthly series.
`accumulation` in the reply says which of the two questions the numbers answer:
`historical` is the balance a bucket ends on, `change` is what moved during it.
It also says what a row's `total` means. Movements add up, so on a `change`
report the total is the sum of the row's buckets; balances do not, so on a
`historical` one it is the balance the range closes on. Asking for more than 600
buckets is refused rather than served slowly.

A range that has not happened yet reports nothing: no buckets and no currencies,
with the range you asked for echoed back. Today's figures are never presented
under a future heading.

`buckets` gives each column's `start` and `end` clipped to the range you asked
for, so a range that opens mid-quarter reports a first column covering the part
of it you asked about rather than a whole quarter that came up short.

There is no total across currencies anywhere in the reply, and that is on
purpose. This ledger records no exchange rates. A single number spanning
currencies could only be built from the rates implied by transfers already made,
which says what those transfers cost, not what the money is worth now.

`cash-flow` needs one warning before you report it to anyone. It will not agree
with `income-expense`, and the gap is widest for whoever uses a credit card
most: a card purchase is an expense the day it is made, while the cash leaves on
the day the bill is paid, in a different bucket and under `financing`. Both
numbers are right and they answer different questions. Its rows are `operating`
(earning and spending), `investing`, `financing`, `internal` (between your own
spendable accounts, which nets to zero), `exchange` and `opening`. Spendable
means an account typed `checking`, `savings` or `cash`.

`get_account_register` lists one account's postings in date order with the
balance before and after each, plus the balance the window opens and closes on.
At most ten thousand postings; a wider window is refused rather than truncated,
because a register cut short would close on a balance its own last row does not
reach.
It is built for finding mistakes rather than for analysis: where a balance goes
wrong, this is the row it went wrong on. An archived account ends at zero and
the postings that closed it out to equity are in the list, marked `closing` in
`origin`; an account's first pair is marked `opening`.

## Budgets

A budget sits over the ledger and never inside it. Nothing here writes a
posting, so a budget that is deleted leaves the books exactly as they were, and
no balance or report moves when one changes.

Amounts resolve in three steps. An explicit entry for the period wins, otherwise
the plan's rule says the amount — which for most plans is the fixed number on
it — otherwise the category is unbudgeted and the report says what was spent
against no limit.

A plan carries how it behaves as well as how much. `rollover` makes it an
envelope, where what a period does not spend belongs to the next one and an
overspend is owed by it, with `rolloverCap` holding that carry inside a number
in both directions. `targetAmount` with `targetDate` makes it a sinking fund,
which works out each period's figure from what is still needed and how many
periods are left. `lookbackPeriods`, `percentOfPrevious` and `percentOfIncome`
each make it work its amount out a different way, and only one of them may be
named at a time. `priority` decides which budgets a short period funds first.
None of these is a mode anybody picks: the parameter is the choice, and
`get_budget_report` is where the worked-out figures appear.

`list_category_groups`, `create_category_group`, `update_category_group` and
`delete_category_group` handle one level of grouping over categories. A group
either holds a budget of its own (`standalone`) or is whatever its categories
add up to (`sum_of_children`), and that is declared when it is created because
both are defensible and the wrong one silently makes every figure on the page
wrong in the same direction. Put a category in a group with `update_category`'s
`groupId`; budget a standalone group by sending `groupId` instead of
`categoryId` to `create_budget_plan`. Deleting a group leaves its categories
alone and takes the group's own budget with it.

`list_budget_plans`, `get_budget_plan`, `create_budget_plan`,
`update_budget_plan` and `delete_budget_plan` handle the standing amounts. One
plan covers every period in its window, so a budget that runs all year is one
row rather than twelve, and nothing materialises the months nobody has reached.
Windows for one category may not overlap: raising a budget means ending the old
plan and starting another from the next period, which is also what keeps last
March answering with what last March intended.

`get_forecast` projects the balances forward from the recurrences that already
have dates and amounts. Nothing it returns is a balance: money dated in the
future has not moved, and a projection reported as a balance would make the
ledger claim something happened because somebody expected it to. Say
"projected". The projection uses recurrences alone unless `basis` asks for the
budgets as well, and a recurrence with no amount comes back in `unprojectable`
rather than being counted as nothing.

`list_budget_entries`, `set_budget_entry` and `delete_budget_entry` handle a
single period. Use one for a one-off, such as a larger food budget in December.
`periodStart` is truncated to the period unit, so any day inside the period
names it.

`get_budget_report` is the figure anybody actually wants: what each budgeted
category was allowed and what it spent, period by period. Spending is signed, so
a refund is negative and lowers the category it came back to. A category
budgeted at two hundred and spent nothing on still appears, because the report
joins from the budget to the spending rather than the other way. Figures stop at
today where this person lives whatever end date is asked for, and `asOf` reports
the day used. A period appears once per currency, and there is no total across
currencies because this ledger holds no exchange rate that is not one some
transfer actually got.

`includeArchived` is on by default here and off everywhere else. A budget's
limit was never scoped to an account, so spending that ran through a card since
closed is spending the budget covered, and leaving it out makes a budget spent
to the penny read as underspent. Every other report defaults the other way
because an archived account's balance is genuinely closed out.

Reading a budget needs `ledger:read`. Setting one needs `ledger:write`, and
`ledger:stage` is not enough: a budget is a change to the ledger's own records
rather than a proposal about money, which is the same line categories already
sit on. Budgeting an income category is refused, because it has no spending for
a limit to be compared against.

## Staged transactions

The review queue in front of the books. Nothing on it has been posted and nothing
on it counts, which is what `ledger:stage` exists to reach.

`list_staged_transactions`, `get_staged_transaction`,
`create_staged_transaction`, `update_staged_transaction`,
`delete_staged_transactions`, `commit_staged_transactions`, and
`bulk_edit_staged_transactions`. Reading the queue is part of `ledger:read`, so
`list_staged_transactions` and `get_staged_transaction` need nothing more than
that. The four that change a row take `ledger:stage`, which is the scope to
grant an agent you want proposing work rather than posting it, and the commit
takes `ledger:write` because it is what puts the row in the books.

A staged row is a draft. Nothing about it affects a balance or a report until it
is committed, so an agent holding only `ledger:stage` can propose anything and
change nothing. Each row says three separate things about whether it repeats
something:

| Field | Means |
| --- | --- |
| `duplicateOfId` | A committed transaction it matches on the same day, the same payee, the same account and the same amount. This is the strict test, and it is the one that refuses a commit. |
| `likelyDuplicateOfId` | A committed transaction that looks like the same money without matching that exactly: same account, same direction, same amount, within three days. Payee and category are ignored, being the two most likely to differ between a bank's record of a purchase and yours. Advisory — it does not refuse anything. |
| `repeatsStagedRow` | Another row still waiting in the queue carries the same fingerprint. |

`repeatsStagedRow` is only worked out by the list. `likelyDuplicateOfId` is
worked out by the list and, on the row you asked about, by
`get_staged_duplicate`. Everywhere else both come back `null`, meaning "not
compared" rather than "no".

`validity` filters the list to `valid`, `invalid` or `duplicate`. `duplicate`
covers all three of the above, so one filter finds everything worth a second
look. `importBatchId` scopes it to one imported file and `recurrenceId` to one
recurring transaction.

`get_staged_duplicate` opens a row beside the one thing it repeats, which is what
the browser's side-by-side review reads. The pair comes back oldest last, whichever
of the two you asked about: a committed transaction is always `second`, and of
two staged rows the older one is. `second` is `null` when nothing matches any
more. Each side names its `kind` and fills either
`staged` or `committed`, never both.

Resolving a duplicate means editing one side or dropping one. Only a staged side
can be dropped: a committed transaction is already in the books, so the copy to
remove is the one that has not been recorded yet.

Committing is explicit: name the ids and the version you last saw for each.
A row that fails validation, or that repeats another row in the same selection,
refuses the whole batch rather than committing part of it. `dryRun: true` tells
you what would happen without doing it.

## Imports

`preview_csv` reads the delimiter, headers, and first rows of a file without
staging anything, which is how you work out the column mapping before calling
`stage_csv`. A file carrying every column a Simple Balance export writes needs
no mapping, so `stage_csv` takes one without a `mapping` at all.

`list_import_batches` lists the imports that still have rows waiting on Staged
transactions. A batch leaves this list once all its rows are committed or
discarded, so an empty result means the queue is clear rather than that the
import failed. The id is what scopes a staged listing or a bulk edit to one
file, which is how a whole import gets corrected in one go.

## Recurring transactions

`list_recurrences`, `get_recurrence`, `create_recurrence`, `update_recurrence`,
and `delete_recurrence`. The two reads take `ledger:read`; the three writes take
`ledger:write`, which is where template editing already sits. A recurrence is a
template plus a standing instruction to keep proposing after the conversation
has ended, so nothing short of full write access can leave one behind.

A recurrence proposes and never posts. On each due date it writes an ordinary
staged row and somebody commits it from the queue like anything else. The row
carries two dates: `occurrenceDate` is where it sits in the schedule and never
moves, and the draft's `date` is where the weekend and month-length policies put
it. With the default `allow` policy they are the same day. The shape refuses a `date`, a `templateId` and an `externalId`:
the schedule supplies the date, and a bank reference copied onto every proposal
would make the next real import of that row look like one already seen.

The schedule is a frequency, an interval, an anchor date, and a policy for each
kind of awkward date. Monthly and yearly may name a relative day instead of a
day of the month. `position: { ordinal: 2, weekday: 2 }` is the second Tuesday,
and ordinal `-1` is the last one. There is no fifth ordinal, because a month has
four of some weekdays and five of others; anybody who means the fifth means the
last. `monthPolicy` decides what a schedule anchored to the 31st does in
February, and `weekendPolicy` decides what happens when a date lands on a
Saturday or Sunday. **A business day means Monday to Friday. Public holidays are
not modelled**, so a proposal can land on one.

Two refusals worth knowing before you hit them. A daily schedule of one or two
days cannot use either business-day policy: a policy moves a date up to two
days, so two occurrences would land on one, and the queue refuses to commit rows
that alike. Three days apart is the first gap that survives. And a split needs
an amount on the recurrence, with legs that add up to it exactly, unlike a
template, where the amounts are left blank and filled in on use.

Updating merges the schedule rather than replacing it, so changing the frequency
does not silently reset the policies, and the merged result goes back through
every refusal above. `list_recurrences` reports what each one has proposed,
committed and discarded, and an `overdue` flag: overdue with nothing proposed
means whatever runs the schedule has stopped.

Nothing is ever proposed dated before the day the recurrence was created, so an
anchor set years back fills in no history, and moving it back later does not
either. Deleting a recurrence leaves every row it proposed alone; those rows
keep its name, so a queue entry can still say where it came from. To find them,
`list_staged_transactions` takes a `recurrenceId` filter.

`notifyOnCreate` sends an email when the scheduler proposes from this recurrence.
One message per proposal however many rows it holds, sent to the address on the
account, naming the dates and pointing at the queue. It says nothing on a tick
that proposes nothing, and nothing at all on a deployment with no mail server —
the setting is still stored, so it starts working when one is configured. It is
set beside the schedule rather than inside it, so changing the notice does not
look like changing the dates.

## Transaction templates

`list_transaction_templates`, `get_transaction_template`,
`create_transaction_template`, `update_transaction_template`,
`delete_transaction_template`, `bulk_edit_transaction_templates`, and
`bulk_delete_transaction_templates`.

A template is a saved starting point for a transaction, not a record of one: it
posts nothing and moves no balance. Its draft is partial on purpose, and a field
it does not carry is one to fill in each time. Reading them is how you record
something the way this person usually records it rather than guessing at their
shape.

Every field is optional, including the type: only the name identifies a
template. A field it does not carry is one the form leaves alone, so applying a
template to an entry that already exists changes only what the template names.

One key the draft refuses rather than ignores: `externalId`, the reference a
bank statement row was imported under. Copied onto every transaction made from
the template, it would make the next real import of that row look like one
already seen. A `date` and a `categoryName` are both stored, and each behaves
the way it does on a transaction: an absent date means the day the template is
applied, and a category name is matched case-insensitively against the
categories already there and created only when nothing matches.

`list_transaction_templates` reports how many committed transactions and how
many staged rows came from each template, and the two added together, the same
three numbers `list_categories` and `list_payees` give. `list_transactions`
takes a `templateId` filter, which is how you read back what a template was
actually used for. A transaction records the template it was started from in
`templateId`; it is provenance and changes nothing about the entry, and a
template that is deleted simply stops being counted rather than taking its
transactions with it.

Updating replaces the draft whole rather than merging, so a field left out of
the new draft is dropped. The account and category a template names carry no
foreign key, so a template outlives them and holds an id that is resolved when it
is used and dropped when it no longer resolves.

The two bulk tools change many at once, atomically. Each names every template
outright with the version it was read at, so one template that moved underneath
refuses the whole call rather than overwriting it; there is no filtered selection
and no fingerprint, because a person can hold two hundred templates and naming
them all is cheaper than describing them. The patch is three-valued: a key left
out leaves that field alone, a value sets it, and `null` clears it back to blank
so the person fills it in on use. An empty string is refused rather than read as
a clear. Changing `type` drops whichever account side the new type cannot hold,
and only then: a patch that does not mention the type leaves both sides alone,
because it never asked about them. Setting a side the type cannot hold is refused
instead, and names the templates that could not take it, as is a received amount
on anything that is not a transfer. References are checked only where the patch
introduces them, so a template naming an account since deleted can still have its
payee changed. A row whose next draft matches what it already holds is left
alone and not counted in `changedCount`.

A template can also carry a reminder, as `notification`, and null is none. It is
a recurrence's schedule with two differences: a `time`, as `HH:MM` on the
person's own clock, and a `frequency` that may be null, which is a reminder that
happens once on its `anchorDate`. A one-off refuses `interval`, the two policies
and `position` rather than ignoring them, because a reminder arriving on a day
nobody chose is worse than a refusal. `repeats` in the reply is `frequency` not
being null, said outright.

The reminder asks and never writes: a template is filled in by hand, so the mail
points at the template and records nothing. `nextNotificationDate` is when the
next one goes, and null means nothing further is owed — which for a one-off is
how it says it has already been sent. A backlog collapses into one message, so
coming back from a week of downtime brings one reminder rather than seven.

On an update, `notification` left out keeps whatever is stored and null removes
it. Given a new one it replaces the old one whole rather than merging, because
the rule is refused or accepted whole: a stored monthly rule merged with an
incoming null frequency would be a one-off still carrying a month policy.
Deleting the template deletes the reminder with it.

## Payees

`list_payees`, `list_duplicate_payees`, and `merge_payees`. There is no payee
record to fetch: a payee is text on a transaction, read back out of committed
and staged entries, so MCP and the browser share one spelling and one audit
trail.

The two listings answer different questions. `list_payees` is every spelling the
ledger holds, one row each as it was typed, which is why one shop entered two
ways is two rows. `list_duplicate_payees` groups the spellings that collide once
Unicode form, whitespace and case are normalised, and that normalisation is the
server's own rather than something an agent can reproduce from the spellings.
Reach for the grouping before a merge, and for the flat list when you want
everything.

## CSV

`export_transactions_csv` writes the round-trip format: a file it produces reads
back into another ledger, or a fresh install, as the same transactions,
including their splits, which travel by category name. It takes the same filters
`list_transactions` does and exports the whole matching set rather than a page.
A deleted entry is never exported whatever is asked for, because the format has
no column to say an entry is void and reading it back would raise the amount
from the dead.

`stage_csv` accepts the same payload the browser import does, bounded by
`CSV_MAX_BYTES` and `CSV_MAX_ROWS`. The MCP request envelope allows extra room
for JSON string escaping, while the decoded CSV is still measured against the
real limits.

`defaultAccountId` is the account every row is posted against, and it is the
only thing that decides where they land. No account is ever read out of the
file, including out of one of our own exports, whose account columns name the
ledger it came from. A transfer needs two accounts and an import names one, so
those rows stage with everything else they carry and an issue asking for both.

A CSV names its categories by name, and matching them to the ones this ledger
already has needs no permission. Making one does. Creating a category, bringing
an archived one back, or widening what kind of entry it may carry are changes to
the ledger's own records, so they need `ledger:write`; with only `ledger:stage`
the row is staged under the name it came with and the entry in
`referenceResolution.categories` comes back as `deferred` with a null
`categoryId`. Committing the row, which needs `ledger:write` anyway, is what
makes the category.

With `ledger:write` each one is written to the audit log as `create_from_csv` or
`update_from_csv`, so they are visible in Activity and can be merged or deleted
afterwards.

## Audit history

`list_audit_events` reports what was done to this ledger, by whom, and through
what: `actorSource` is `web`, `mcp`, or `schedule`, and `clientId` names the
agent when it was one. It pages forward by cursor only: no page number, no
total count, and no `sort` or `direction`. Sending those does not fail, it is
simply ignored, so a request for page two comes back as page one.

This is how an agent checks its own work, and how a person sees an agent's.
Every write goes in, including the ones a scheduler makes on its own, so a row
that appeared without anybody asking can always be traced to the recurrence that
proposed it.

## What an agent cannot do

Two things, and the line between them and everything else is the same one: an
agent does the bookkeeping, and the account itself belongs to the person.

**Delete the account.** It destroys every account, transaction, posting,
category, payee, staged row, import, session, agent grant, and the audit trail
that would otherwise record what happened. Nothing restores any of it. Every
other write an agent can make is recoverable, from the audit trail or by
restoring a deleted row; this one is not, so it stays something a person does
while signed in.

**Set a sign-in password.** Adding a credential to an account is account
management rather than bookkeeping, and an agent cannot undo it from its side.

Everything else the browser can do, an agent can do. A test compares the two
surfaces route by route and fails if a capability lands on one without reaching
the other, so this list is the whole of it rather than the part somebody
remembered to write down.

## Revoking access

`ALLOWED_EMAILS` governs who may register, not who may keep signing in. Removing
an address does not revoke the tokens or sessions of an account that already
exists, over MCP or over the web.

Turning a sign-in method off does revoke it. An account that only ever had
Google loses both web and MCP access when `AUTH_MODE` drops to `local`, and an
account that also set a local password keeps working through that.

An agent can see and manage this too. `list_connected_agents` needs only
`ledger:read` and returns every client this person has approved, including the
one asking. `revoke_connected_agent` needs `ledger:write`, so a token granted
read alone cannot lock the other agents out, and an agent can pass its own
client id to disconnect itself cleanly. Every revocation is written to the audit
log whoever did it.

To cut off one client rather than a person, open **Settings > Connected
agents**. Every client you have approved is listed with what it may do, and
revoking one deletes its tokens instead of waiting for them to lapse, so it
loses access on its very next call. The refresh token lives on the same row, so
it cannot mint a replacement, and the approval goes too: the client has to ask
again, and you have to say yes again.

Revoking is per person. Another account that approved the same client keeps
working, and the client's registration itself is left alone, because it is not
yours to delete.

Changing or resetting your password revokes every agent's access at once, along
with the approvals behind it, because recovering an account has to mean
recovering all of it. Changing `AUTH_SECRET` invalidates every web session but
leaves MCP tokens alone, so it is not a way to do this. Access tokens expire an
hour after they are issued if you do nothing.

The access token an agent holds is a JWT bound to this deployment and to `/mcp`,
and the grant it stands for is named inside it by row id rather than carried as
a credential. A JWT is signed and not encrypted, so anything that handles one
reads every claim in it; there is nothing in these that works on its own, and a
revoked grant stops one working immediately rather than at expiry.
