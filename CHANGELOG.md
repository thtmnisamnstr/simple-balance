# Changelog

Notable changes, newest first.

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
