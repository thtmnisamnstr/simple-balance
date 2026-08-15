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

Tools an agent has no scope for are left out of discovery entirely, so it never
sees a tool it cannot call. Every tool returns both `structuredContent.result`
and the same thing as JSON text.

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
accounts out and still be right. Deleting is only possible while nothing
references it: no transaction, no staged row, no posting, and no recurrence or
template naming it in its schedule or draft. A category is the same, and its
list of holdouts includes templates too.

## Transactions

`list_transactions`, `get_transaction`, `create_transaction`,
`update_transaction`, `set_transaction_deleted`, and the two bulk tools below.

A transaction can name its category instead of citing an id. Send
`categoryName` and the server matches it against the categories you already
have, ignoring case and surrounding space, and creates one only when nothing
matches; `categoryId` wins if you send both. An existing category that does not
cover the side being posted is widened rather than duplicated, and an archived
one named again comes back. This is the same rule a CSV import follows, so an
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

`bulk_edit_staged_transactions` does the same job on the review queue, with the
same two selection shapes and the same fields. What differs is what happens
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
Ordering by account or category cannot be resumed that way at all, so those
return no cursor and you page them by number.

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

## Knowing where you are

`whoami` reports whose books these are and the client id this call is authorized
under, which is how a client picks itself out of `list_connected_agents`. It
says nothing about how the person signs in.

`get_preferences` reports their timezone and default currency, and reading it
matters more than it sounds. What counts as today is decided by their timezone
rather than the server's, and `get_financial_summary`, `list_accounts`, and
`get_account_balances` all resolve "today" through it. Without reading it an
agent cannot explain the `asOf` it was given or predict which day an entry dated
today will land on. `chosen: false` means nobody has picked yet rather than that
they chose UTC.

`set_preferences` changes either one; what you leave out keeps its current
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

`bucket` is `none`, `week`, `month`, `quarter` or `year`, and defaults to
`month` for the reports that plot over time and `none` for the ones that do not.
`accumulation` in the reply says which of the two questions the numbers answer:
`historical` is the balance a bucket ends on, `change` is what moved during it.
Asking for more than 600 buckets is refused rather than served slowly, with the
count and a suggestion to coarsen in the message.

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
It is built for finding mistakes rather than for analysis: where a balance goes
wrong, this is the row it went wrong on. An archived account ends at zero and
the postings that closed it out to equity are in the list, marked `closing` in
`origin`; an account's first pair is marked `opening`.

## The review queue

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
change nothing. Each row carries `validationIssues` saying what still stops it
being committed, `duplicateOfId` when it matches a transaction already recorded,
and `repeatsStagedRow` when it matches another row still waiting. That last one
is only worked out by the list, so every other tool returns `null` for it,
meaning "not compared" rather than "no".

`validity` filters the list to `valid`, `invalid` or `duplicate`, which is how
you find the rows that need attention without reading the whole queue.
`importBatchId` scopes it to one imported file and `recurrenceId` to one
recurring transaction.

Committing is explicit: name the ids and the version you last saw for each.
A row that fails validation, or that repeats another row in the same selection,
refuses the whole batch rather than committing part of it. `dryRun: true` tells
you what would happen without doing it.

## Imports

`preview_csv` reads the delimiter, headers, and first rows of a file without
staging anything, which is how you work out the column mapping before calling
`stage_csv`. A file carrying every column a Simple Balance export writes needs
no mapping, so `stage_csv` takes one without a `mapping` at all.

`list_import_batches` lists the imports that still have rows waiting in the
review queue. A batch leaves this list once all its rows are committed or
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
agent when it was one. It pages like any other list.

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
