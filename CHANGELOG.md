# Changelog

Notable changes, newest first.

## 0.1.4 - 2026-08-13

### Added

Recurring transactions. Rent, a salary, a subscription: anything that arrives on
a schedule can be set up once and left. Daily, weekly, monthly or yearly, every
N of those, on a day of the month or on a relative day such as the second
Tuesday or the last Friday. You choose what a schedule anchored to the 31st does
in February, and what happens when a date lands on a weekend.

On each due date it puts an ordinary row in the review queue, dated its own
occurrence rather than the day the scheduler ran, and posts nothing. Leave the
amount out and each proposal waits in the queue for a number, which is what the
electricity bill wants. A recurrence naming an account that has since been
deleted still proposes its row, flagged and saying which field, rather than
failing where nobody would see it. Deleting a recurrence leaves every row it
proposed alone.

Open the menu on any row, on the transactions list or the review queue, and save
it as a recurring transaction, beside where you would save it as a template. The
row fills the form in, and the date it fell on becomes the day of the month the
schedule keeps to, rather than whatever today happens to be. What it does not
carry is the reference it was imported under, for the reason a template does not
carry one: on every proposal, it would make the next real import of that
statement row look like one already seen. Two accounts in different currencies
say so before you save, since the rate belongs to the day it was got and each
proposal has to wait in the queue for it.

The scheduler runs inside the server process and is on by default, so the
documented single container keeps working with nothing added to it. Set
`RECURRENCE_SCHEDULER=false` to switch it off on replicas that serve the API.
Running several with it on is safe: each recurrence is claimed with `for update
skip locked`, so replicas divide the due list rather than wait on one another,
and a per-occurrence unique key refuses a duplicate proposal even if a claim
were bypassed. Public holidays are not modelled; a business day means Monday to
Friday.

Four settings control it: `RECURRENCE_SCHEDULER`, `RECURRENCE_TICK_SECONDS`,
`RECURRENCE_CATCH_UP_LIMIT` and `RECURRENCE_CLAIM_LIMIT`. Only the first is
likely to matter to you, and only if you split the deployment up.

Three Dockerfiles under `deploy/docker/` split the single container into a
server, an nginx frontend, and a scheduler, for running this under Kubernetes.
Each publishes alongside the single container, on the same tags, as
`simple-balance-server`, `simple-balance-frontend` and
`simple-balance-scheduler`. The single container remains the supported way to
run this. See [deployment](docs/deployment.md).

One transaction can now be split across several categories. The grocery receipt
that is partly food, partly household and partly something for the dog is one
entry with three legs, and each leg is attributed to its own category in
spending reports, on category pages, and over the MCP.

A split is the counter-account side of the entry cut into pieces rather than a
second record of the money, so nothing is counted twice: the categories add up
to exactly the cash that left the account. Every existing rule holds unchanged.
The entry still settles to zero in each currency it touches, postings are still
append-only, a correction still costs the difference and nothing more, and
deleting still voids the entry a leg at a time.

Relabelling a leg writes no postings at all, because the label lives on the leg
and the leg's identity does not change when you rename what it is for. Changing
what a leg is worth writes two, which is right: the money was divided
differently.

Splits work on committed transactions, on rows waiting in the staging queue, and
on templates, where the categories are stored and the amounts left for you to
fill in. A CSV export carries a split by category name and reads back as the
same split in a different ledger or a fresh install. Mass editing category or
type is refused on a split rather than flattening it, and the panel says why.

Upgrading runs two new migrations, 0005 for splits and 0006 for recurrences.
Both are schema changes rather than data migrations: nothing existing is
rewritten, no row is backfilled, and every figure reads the same the moment they
finish.

### Security

`NODE_ENV` was compared against one string, so any other spelling, and leaving
it unset, read as development: no first-run setup code, no sign-in rate
limiting, no secure cookies, and nothing to say it had happened. It is parsed
against a closed set now, and a process outside production that has been given a
real `APP_BASE_URL` refuses to start rather than warning about it.

`AUTH_SECRET` clearing 32 characters said nothing about whether it was secret.
The value this project falls back to outside production and the one
`.env.example` carried both cleared it, so a deployment could sign every session
with a published string. Production names and refuses them, and the example file
now ships no placeholder to leave in place. If you copied that line, generate a
real one: `openssl rand -base64 32`.

The agent consent screen read the client name and the scopes it displayed out of
the query string, which is written by whoever wants the grant. A link could show
a familiar client and read-only access while approving a stored request for
something else. Both now come from the record the consent code names.

Guessing the first-run setup code cost nothing: a wrong one was refused before
the rate limiter ever saw the attempt. Attempts are counted per caller now, five
to a fifteen-minute window.

Adding a sign-in password to an account that has only ever used Google took a
session and nothing else, so a borrowed cookie could mint a second permanent
credential in silence. It now needs a session created in the last fifteen
minutes.

Changing or resetting your password revokes every agent's access along with the
approvals behind it. Before, an MCP token an agent already held kept working for
its hour and its refresh token kept minting replacements for a week.

`stage_csv` created categories, brought archived ones back, and widened what
kind of entry a category may carry, all under `ledger:stage` — the scope for an
agent that may propose and never decide. Those three need `ledger:write` now;
with only staging authority the row is staged under the category's name and
committing it is what makes the category.

The MCP access token carried the opaque grant token as a readable claim. A JWT
is signed and not encrypted, so a proxy or a log holding one held a credential
good for seven days. It names the grant by row id now, which opens nothing on
its own, and a revoked grant stops working immediately rather than at expiry.

The frontend container served the application shell with no content security
policy, no `nosniff` and no framing policy, because those headers are set by the
API process the static files never reach. It also appended to `X-Forwarded-For`
rather than replacing it, against the trust model its own deployment guide
documents, so with `TRUST_PROXY=true` sign-in attempts counted against an
address the caller chose.

Signing in returned to the path in the address bar unfiltered, and
`//elsewhere.example` is a legal path that a browser sends to another origin.

### Fixed

A staged split can now be found under a category one of its legs names. The
queue's filter read only the entry's own category, so a split showed in the
count on the category page and then was missing from the list that count links
to.

Merging a category carries recurring transactions through with everything else,
and deleting one now counts them as a use rather than destroying the category
underneath them. Deleting your whole account also names the recurring
transactions it is about to take.

A stored timezone that has stopped being recognisable, after an ICU update or a
hand-edited row, no longer throws when the dashboard works out what day it is.
It falls back to UTC. The value is free text checked only when it was written,
and the scheduler now reads it in a loop that serves everybody, where one bad
row must not be able to stop the rest.

Deleting a category a template refers to, or an account a recurring transaction
names, is refused rather than leaving a template that cannot be saved or a
schedule that proposes a flagged row every month with nothing saying why.
Neither reference has a foreign key, because both live inside JSON.

The audit trail records a split's legs. Relabelling one is a single update to
the leg: it writes no posting and changes no column on the transaction, so
Activity showed a before and after that were identical for the change most worth
looking up later.

A mass edit no longer drops the record of which template a transaction was
started from.

A search containing `%` or `_` searches for those characters instead of treating
them as wildcards, and the search box waits for you to stop typing rather than
querying the ledger on every keystroke.

The review queue shows a staged row's category even when that category has since
been archived, instead of rendering it as Uncategorized with a blank field in
its editor.

One import stages at most what one action can then commit, edit or delete. The
CSV row limit was 25,000 by default and up to a million, while every mass action
caps at 10,000, so a large import produced a queue nothing could clear in one
go. `CSV_MAX_ROWS` now defaults to 10,000 and cannot be set above it. Lowering
it still works.

"Select all filtered" on a mass edit or delete is refused past 10,000 rows in
the database rather than after every matching row has been read and
fingerprinted in memory, and the CSV preview enforces the same size limit the
import does.

The dashboard runs its three aggregates together instead of one after another,
the CSV export walks the ledger once instead of re-counting it for every page,
and a transaction write asks about the one payee it names rather than grouping
every payee in the ledger.

A CSV export now carries the bank's own reference for each row, and an import
no longer invents one. The file had no column for it, and restoring one wrote
the source ledger's internal id into that field instead, so the check that stops
a statement being imported twice was keying on an identity that means nothing in
the ledger it was read into. Files written by 0.1.3 and earlier still import; their
rows simply carry no reference, which is the honest answer for a file that has
none. One consequence worth knowing: a row with no bank reference, re-imported a
second time under a different account, is no longer refused as a duplicate,
because the invented id that used to catch it is gone.

A transfer keeps its category when an export is restored into another ledger,
and a category whose name begins with `=`, `+`, `-` or `@` no longer gains an
apostrophe on every round trip and becomes a second category each time. The
visible column stays safe to open in a spreadsheet; the value the import trusts
travels beside it where nothing rewrites it.

Archiving an account now closes it at zero on the day you archive it, not on the
date of the last transaction it happens to hold. A single closing entry dated
that last transaction left the account holding a balance on every day in
between, while every total had already stopped counting it: a report for a date
in that window showed money in an account you had retired, and restoring it in
that window put the balance back on top of one that had never left. Accounts
archived before this are re-closed once, the first time the server starts, which
is logged. Nothing is deleted and no total changes for an account whose
transactions are all in the past.

A negative number in a mapped Debit or Credit column no longer has its sign
quietly removed. Where the file has both columns the other one is what a
reversal goes in, so the column decides and a sign changes nothing, which is how
nearly every two-column bank export is written. Where it has only one, the sign
is the only way that file could say the other direction and nothing says which
was meant, so the row is refused with the reason rather than staged in whichever
direction the column implied.

A recurring transaction set to a relative day, such as the second Tuesday, no
longer proposes a date that has already passed, and the form's preview shows the
date the scheduler will actually propose first. Typing a negative interval no
longer freezes the tab.

Editing the amount of a transfer between two accounts in the same currency now
works. The form was sending a received amount from a field it never showed, and
the ledger refused every save. A transfer also keeps its category when you edit
it, rather than losing it to a form that has nowhere to display one.

A staged row filed under a category by name keeps that name when you open it to
review it, instead of committing uncategorised.

Two settings changes made at the same time no longer overwrite one another.

The timezone and currency the browser detects are offered only while nobody has
chosen, and that is now decided by the server at the moment of writing rather
than by the page against the session it loaded with. Choosing a timezone in
Settings on one tab, or on another device, while a Simple Balance page is open
elsewhere could previously have that choice replaced by the other page's guess.

## 0.1.3 - 2026-08-06

### Added

A template holds whatever subset of a transaction you give it, and only the name
is required now. The type is optional like everything else, and a date and a
category name are stored where before they were refused. The import reference is
still refused, and is the only one: copied onto every transaction made from the
template it would make the next real import of that statement row look like one
already seen.

Applying a template fills in the fields it carries and leaves the rest as they
were, so it works on a transaction that already exists as well as on a new one.
The picker is on the edit form now, not only on Add transaction, which is the
point of the change: a template is a quick way to correct a row somebody else's
import got wrong, not only a way to start one.

The exception is a field the previously chosen template set, which goes back to
what the form held before any template. Without that, picking Rent and then
Coffee would leave Rent's amount attached to Coffee, which is a wrong
transaction one click from being committed. Typing a value yourself and then
applying a template keeps what you typed, because no template put it there.

Each template also reports what came of it: how many committed transactions,
how many rows still waiting in the review queue, and the two added together, the
same three numbers the categories and payees lists show. The count is a link to
those transactions, on a screen of the template's own. A transaction records
which template it was started from, and `list_transactions` takes a `templateId`
filter so an agent can read the same thing.

That record is provenance rather than current state, so it carries no foreign
key. Deleting a template is still allowed and still leaves the transactions made
from it untouched; they simply stop being counted. A key would have made a used
template undeletable, or deleted real entries along with it.

Templates have a screen of their own, above Import CSV in the menu, and Settings
no longer has them. Settings was where the feature landed because it arrived as
one small management panel; a list you sort, search, page, and change many rows
of at once is not a setting.

It is the transactions screen's shape. Every column it shows orders by that
column, the search narrows on name, payee, and notes, and the row menu edits or
deletes one. Tick some rows and the selection bar offers a mass edit and a mass
delete, both atomic. The screen also creates a template, which Settings could not
do: a management screen with an edit and a delete and no way to add a row sends
you back to the transactions list to invent a transaction you did not want. Saving
one from a transaction or a staged row is unchanged.

A template mass edit has a third answer per field that a transaction mass edit
does not need. A template's fields are blank on purpose, so besides leaving a
field alone and setting it, you can clear it: the template stops carrying an
amount and starts asking for one each time you use it. An empty string is refused
rather than read as a clear, because blank and absent meaning different things is
the whole of what a template records.

Two things the screen decides rather than guesses. Changing a template's type
drops whichever account side the new type cannot hold, because nothing asked for
that side and a template holding an account nothing reads is worse than a blank;
a change that does not touch the type leaves both sides alone. Setting a side the
type cannot hold is refused and names the templates that could not take it,
because something did ask for that one. And a template naming an
account or category that no longer exists now says Unavailable in its row; the
Settings list dropped those silently, which hid the one thing most worth knowing
about an old template.

`bulk_edit_transaction_templates` and `bulk_delete_transaction_templates` give an
agent the same two operations, so the MCP surface still does everything the
browser does. Each names every template outright with the version it was read at,
and one that moved underneath refuses the whole call. There is no fingerprinted
filter selection here: that contract exists for rows a browser has never loaded,
and a person can hold two hundred templates, so naming them all is cheaper and
more honest than describing them.

Templates, for the transactions you enter again and again. Open the menu on any
row, on the transactions list or the review queue, and save it as a template:
what you keep is a starting point, not a copy. Anything you clear before saving
is simply not saved, which is the point of the feature rather than a limitation
of it. A template with a payee and a category and no amount is the one most
people want, because the amount is the part that changes.

Pick one from the new dropdown at the top of Add transaction and the form fills
in. From there it is an ordinary form: change anything, change everything, the
template is untouched. There is no path from that form back to the template, so
that is a property of the code rather than a promise about it.

One thing a template deliberately never keeps: the reference a row came in from
a bank file under, because copying that into every transaction made from the
template would make the next real import of that statement row look like one
already seen.

An account or category the template names is looked up when you use it, and
dropped with a note if it is not there any more. Templates outlive the accounts
they mention rather than being deleted along with them. Rename, reshape, or
delete them on the Templates screen.

Agents get templates too, through `list_transaction_templates` and the create,
update, and delete tools.

The categories list says how much each category is actually used: how many
committed transactions, how many rows still waiting in the review queue, and the
two added together, the same three numbers the payees list has always shown. You
can sort by any of them, so the category nothing has ever been filed under is
one click away, which is the one worth archiving or merging. A category with
nothing under it is listed at zero rather than left out.

The counts cover the whole ledger rather than a date range, because this page
has no date range on it. A category's own page does, and shows it, so a badge
reading 43 landing on a list of 7 has its reason on screen.

Agents get the same three numbers from `list_categories`, which is the cheapest
way to stop a ledger accumulating a third spelling of Groceries.

Mass edit for staged rows, on the same terms as committed ones. Select rows in
the review queue, or select everything matching the current filters, and change
the date, payee, category, account, description, notes, or deposit/withdrawal
type in one atomic request. This is the fastest way through the case the queue
exists for: a CSV whose account column meant nothing to the importer leaves
several hundred rows all failing the same check, and one edit fixes the lot.

Every row it writes is validated again, so a batch that was failing on a missing
account comes back ready to commit, and the reply says how many are ready and
how many still need attention. The selection is protected the way a committed
mass edit is: explicit rows carry the version they were read at, and an
all-matching selection carries a server-issued count and `id:version`
fingerprint, so a row that moved underneath makes the whole request stale rather
than quietly taking a value nobody saw.

Account and type are refused on a transfer, which has two accounts and no single
one to move. Setting an account on a row that does not yet say which way the
money went is refused unless the same edit sets the type. Both refuse rather
than skip, so the count of rows changed always matches what was selected.

Agents get the same thing through `bulk_edit_staged_transactions` and
`preview_bulk_staged_selection`, with `dryRun` to see what a change would do
first.

The MCP surface now does everything the web app does. Fourteen tools closed the
gaps that had accumulated: reading and setting the timezone and default
currency, which is the one that mattered most because what counts as today is
decided by the person's timezone and an agent previously had no way to read it
or explain the figures it was given; payee suggestions, which is how an agent
avoids forking a shop into a second spelling; previewing a CSV's columns before
staging it and listing the imports still awaiting review; fetching a single
account or category; the five template tools; counting everything in the ledger;
and `whoami`, which also lets a client pick itself out of the list of connected
agents.

Two things stay out of an agent's reach, and they are now the whole of the list
rather than the part somebody remembered to write down: deleting the account,
which destroys the audit trail that makes every other agent action recoverable,
and setting a sign-in password. Both are account management rather than
bookkeeping. A test compares the two surfaces route by route and fails if a
capability lands on one without reaching the other, so the boundary cannot drift
quietly.

### Fixed

An export could only be imported back into the ledger it came from. The importer
recognised its own format and then read the account ids out of the file, and
those ids name accounts of the ledger that wrote it. Into a different account,
a different person's books, or a fresh install they resolved to nothing, so
every row was rejected with "An exported account is unavailable" and staged
blank: no payee, no account, no category, no amount. A 5,334-row file arrived as
5,334 empty rows.

No account is read out of a file any more, by any import path. The account is
the one chosen on the import screen, which is the only thing that decides where
rows land. The same export now stages with its payees, amounts, categories,
notes, and bank references intact, against whichever account was picked, for
whoever picked it.

An export also needs no column mapping now. Its columns are already known, so
the import screen asks for the account and nothing else, and `stage_csv` takes
one with no `mapping` at all.

Transfers are the one row this cannot decide. A transfer moves between two
accounts and an import names one, so those rows stage with everything else they
carry and ask for both accounts in the queue, where mass edit can answer for
every transfer in a file at once. Which side to put the chosen account on is not
guessed: a transfer pointed the wrong way is a wrong entry one click from being
committed.

A row that cannot be turned into a draft now keeps whatever could be read from
it rather than staging empty, so what reaches the queue is a row missing one
field instead of a row missing everything.

A quality pass over the whole application, driven by nine independent reviews
and by running it and using it. Everything below was found rather than
suspected, and each one has a test that fails without the fix.

Archiving an account could hang forever on a small connection pool. The closing
entry it posts read the person's timezone from the pool while its own
transaction was holding the only connection, so with `DATABASE_POOL_SIZE=1` the
request waited on itself: no answer, no error, nothing in the log. Preference
reads now travel on the transaction the caller already has.

An idle database connection that dropped took the whole container with it. `pg`
reports those on the pool rather than on any request, and with no listener that
is an uncaught exception and an exit, so a database restart or a proxy timeout
became a crash instead of a reconnect.

The accounts list sorted balances through `Number`, which cannot hold the
eighteen decimal places the ledger stores, so two balances differing in the last
of them sorted arbitrarily. Balances now compare exactly, sign included.

A staged row whose date column held something that is not a date turned the
category and payee pages white. `Intl` throws on a date it cannot read, and the
throw unmounted the page. Dates that cannot be read are now shown as they
arrived, which is what somebody needs to see to fix them.

A staged mass edit accepted `currency` and `includeDeleted` filters, advertised
them to agents, and applied neither. Narrowing an edit to one currency would
have had the preview count and the fingerprint agree and then rewritten every
row in the queue. Both are now refused rather than ignored.

A category could become permanently undeletable with nothing on screen to
explain it: the guard counted staged rows that had already been committed, which
keep their draft, so a category showing no transactions at all still refused to
go.

A mistyped id in a URL returned 500 and wrote a Postgres stack trace to the log,
on every `/:id` route. Ids are now checked before they reach a query.

Six pages told people they had nothing when a request had actually failed:
"Create your first account", "No accounts yet", "No categories in this view",
"No activity yet", "Create an account first". Each now shows the error, and none
of them claims emptiness while still loading.

Renaming a category left the old name on the transactions list and in the
spending figures until something else happened to refresh them. Committing a
transaction that created a category or a payee did not refresh either list.

The staged queue's row cap notice was tested against the page rather than the
total, so it could never appear however long the queue was, and a whole-list
selection that hit the cap still said "All … selected". It now says how many of
how many, and a selection that fails partway says so instead of quietly
stopping.

An MCP client configured with a trailing slash was capped at 256 KiB rather than
the CSV-sized limit, so it could complete the OAuth flow and then be refused an
upload the other spelling was allowed. The CHANGELOG entry that claimed
otherwise has been corrected.

The mobile navigation stayed in the tab order while off screen, so tabbing from
the header walked into a menu nobody could see.

Also removed: three CSS rules no component used, two type exports nothing
imported, and a `vitest` run that collected a second copy of every test when a
git worktree sat inside the repo.

The MCP endpoint answers on `/mcp/` as well as `/mcp`. They are different paths
to a router and only the second was registered, so a client configured with the
trailing slash completed OAuth correctly, had its grant recorded in Settings and
a valid token in hand, and then got a bare 404 on every call, which an agent
reports as an authorization problem. Discovery under the resource path accepts
the slash for the same reason, and so does the larger request body an MCP CSV
upload is allowed: the route was registered for both spellings but the body
limit still recognised only one, so a client using the slash could reach the
endpoint and then be refused a payload the other spelling was allowed.

### Changed

Uncategorised spending sits at the bottom of spending by category rather than
wherever its total ranks. It is not a category anybody chose, so putting it
first answers "what needs filing" on a panel that was asked where the money
went. It is still shown, and shown even when the list is cut short, because it
is the one row that says there is filing left to do. Ordered in the summary
itself, so an agent reading `get_financial_summary` sees the same order as the
page.

## 0.1.2 - 2026-08-03

### Added

Deleting your own account, from Settings, taking everything in it: accounts,
transactions and the postings under them, categories, payees, staged rows,
import history, preferences, audit history, sessions, sign-in methods, and every
agent you had connected. What will go is counted and shown first, and the address
on the account has to be typed, because that is the one thing on the screen a
stray click cannot produce. Nothing is kept and there is no undo.

It works by one delete: every table holding a person's data references
`auth_user` with `on delete cascade`, so nothing enumerates tables and a table
added later cannot be forgotten. The test reads the tables out of the database
and asserts not one row of the deleted account is left in any of them, which a
hand-kept list would not have done.

An agent cannot do it. Deleting is reachable only with a session cookie, which
an MCP token never becomes.

### Fixed

Signing up with Google. Better Auth declares its social callback as the route
pattern `/callback/:id` and hands database hooks that pattern rather than the URL
requested, so the policy deciding who may open an account was told
`/callback/:id`, matched nothing, and fell through to refusing. A first-ever
Google sign-up therefore failed with `unable_to_create_user` while linking
Google to an account that already existed kept working, because linking creates
no user. Both forms of the path are now recognised.

The icon. It was in the built bundle and nothing routed to it: only `/assets/*`
was served as files, so a request for `/favicon.svg` fell through to the
single-page shell and a browser was handed HTML under a `text/html` content type
for an image. The whole root of the bundle is served now, and the Apple touch
icon is a PNG rather than an SVG, which iOS does not accept.

### Changed

A new account starts on the timezone and currency its browser implies rather
than UTC and USD. UTC is wrong for most of the world in a way that misdates
entries: something recorded on a California evening lands on tomorrow. The
timezone comes from the browser, which knows it exactly, and the currency from
the region of its language tag, with USD when the tag names no region. Both are
ordinary settings afterwards, and nothing is adopted once anybody has chosen.

The sign-in screen and Settings no longer describe anything as "local".
`AUTH_MODE=local` is a name for a deployment mode, not something a person
signing in has any use for, and on a hosted instance it suggests the data lives
on their own machine.

Settings lays its cards out in columns rather than rows, so a short panel no
longer leaves a stretch of nothing beneath it to line up with the tall one
beside it.

## 0.1.1 - 2026-08-03

Two things a first deployment ran into. No schema change, no data migration:
pull the new image and restart.

### Fixed

Reaching a database on another host over TLS. The deployment guide said to
append `?sslmode=require`, which in libpq means "encrypt and do not check the
certificate" but in node-postgres does check it. A self-hosted PostgreSQL almost
always presents a certificate it signed itself, so the setting the guide
recommended was the one that could not work, and it failed with
`DEPTH_ZERO_SELF_SIGNED_CERT` while Node advised installing a root CA that does
not exist. Use `?sslmode=no-verify` for a self-signed server: the connection is
still encrypted, it just stops checking who signed the certificate. The guide
now sets out all three modes and what each does, and the startup failure names
the one to use instead of leaving an operator with a certificate error and no
way forward.

The first-run setup code is no longer printed where it cannot be used. The code
is read only after `ALLOWED_EMAILS` has turned an address away, so a rule
admitting everyone makes it unreachable, and printing one sent operators looking
for a code the sign-up form does not ask for. Where it is still live, the log
now says which it is: the only way in when the rule admits nobody, or the way to
claim the instance with an address the rule would turn away.

## 0.1.0 - 2026-08-02

The first release. Everything below is new, so this reads as a description of
what Simple Balance does rather than a list of differences.

### The ledger

The books are double-entry. Every transaction settles to zero in each currency
it touches, checked before anything is written, with server-owned income,
expense, exchange, and equity accounts doing the balancing. Opening balances
post against equity, so the ledger sums to zero from the first account onward.
None of those counter-accounts appear in a picker, and no transaction can name
one as a side.

Archiving an account posts its remaining balance out to equity, so it closes at
zero and the totals that leave it out stay right. Restoring puts the balance
back. The dashboard stops at today, so an entry dated next month is not counted
as money you have, and its balance, cash flow, and spending all describe the
same set of accounts.

Postings are append-only and carry their own date. Correcting an entry appends
only the difference, so changing an amount costs one adjusting row per side and
an edit that touches only labels writes nothing at all. Deleting posts the
reversal instead of setting a flag, which is why no balance or report has to
remember to exclude deleted rows. A balance as of a date reads an index rather
than scanning the ledger.

Balances, cash flow, and spending by category all come from the postings.

### Accounts and transactions

Accounts for assets and liabilities, each fixed to one currency once it is in
use. Crypto wallets track native quantities and quote no prices. Deposits,
withdrawals, and transfers, including cross-currency conversions that keep the
sent and received amounts separate.

Editing uses optimistic concurrency and creating uses idempotency keys, so a
retry cannot duplicate work and a stale edit fails rather than overwriting
someone else's.

Mass edit and mass delete cover up to 10,000 rows in one atomic request from any
transaction view. Explicit selections carry row versions; all-matching
selections carry a server-issued count and fingerprint, so a concurrent change
makes the request stale rather than silently changing its scope.

### Getting data in and out

Bank CSV import detects the format, maps columns, parses localised dates and
numbers, matches or creates categories and payees, and lands everything in a
review queue. Committing a batch validates every row first and runs as one
transaction. Simple Balance's own export reads back in without loss.

Categories and payees match case-insensitively, surface their own near
duplicates, and merge by rewriting every reference at once. Typing a category on
a transaction is enough: an existing one is matched whatever its capitalization,
and a new one is created on save, so a ledger does not end up with three
spellings of the same thing.

### Using it

Every list sorts by any column it displays, in either direction, and pages by
number. Amounts show at their currency's own precision, with crypto keeping the
digits it needs. Date ranges live in the URL, so a view can be linked to.
Destructive actions ask first, in the app's own dialogs, and say what will
happen and how to undo it.

### Agents

An MCP server over OAuth with separate read, stage, and write scopes, calling
the same ledger code the browser does. Tools outside a token's scope are not
even discoverable. Schema fields carry descriptions, so an agent does not have
to infer that money is a string or that a credit card opens negative. Access
tokens are audience-bound RS256 JWTs backed by revocable records.

Settings lists every agent you have approved and what it may do, and revoking
one deletes its tokens rather than waiting for them to lapse, so it loses access
on its next call. An agent can do the same: listing what is connected needs only
read, and revoking needs write, so a read-only token cannot lock your other
agents out.

### Accounts and who may have one

One deployment holds as many people as you let it. Each has their own accounts,
transactions, categories, payees, totals, and audit history, and none of them
can see or name another's. `ALLOWED_EMAILS` decides who may register: exact
addresses, whole domains such as `example.com`, or `*` for anybody. Leave it
unset and nobody can, which keeps a personal deployment personal.

It governs registration and nothing else, so an address removed from the list
keeps the account it already has rather than losing access to its own books.

Sign in with a password, with Google, or with both on one account. Google
sign-ups must carry a verified address, so a domain entry means what it says.

Give the deployment a mail server, with `SMTP_HOST` and `MAIL_FROM`, and two
things follow: a forgotten password can be reset from the sign-in screen, and a
new account has to open a link sent to its address before it works. That is what
makes a domain entry mean something in password mode too. Leave them unset and
neither happens, which is the right answer for a deployment of one. Accounts
made before a mail server was added keep working after it arrives.

### Running it

One non-root image that never writes to its own filesystem, with PostgreSQL as
the only thing it stores anything in. Migrations run at startup under an
advisory lock, and readiness stays closed until they finish. Local sign-in works
with no configuration at all; Google is optional.

Tagged multi-architecture images publish to GHCR on release.
