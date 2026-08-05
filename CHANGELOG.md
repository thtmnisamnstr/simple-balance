# Changelog

Notable changes, newest first.

## Unreleased

### Added

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

### Changed

Uncategorised spending sits at the bottom of spending by category rather than
wherever its total ranks. It is not a category anybody chose, so putting it
first answers "what needs filing" on a panel that was asked where the money
went. It is still shown, and shown even when the list is cut short, because it
is the one row that says there is filing left to do. Ordered in the summary
itself, so an agent reading `get_financial_summary` sees the same order as the
page.

### Fixed

The MCP endpoint answers on `/mcp/` as well as `/mcp`. They are different paths
to a router and only the second was registered, so a client configured with the
trailing slash completed OAuth correctly, had its grant recorded in Settings and
a valid token in hand, and then got a bare 404 on every call, which an agent
reports as an authorization problem. Discovery under the resource path accepts
the slash for the same reason, and the larger request body an MCP CSV upload is
allowed now applies to both spellings.

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
