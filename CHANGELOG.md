# Changelog

Notable changes, newest first.

## Unreleased

The first release. Everything below is new, so this reads as a description of
what Simple Balance does rather than a list of differences.

### The ledger

The books are double-entry. Every transaction settles to zero in each currency
it touches, checked before anything is written, with server-owned income,
expense, exchange, and equity accounts doing the balancing. Opening balances
post against equity, so the ledger sums to zero from the first account onward.
None of those counter-accounts appear in a picker, and no transaction can name
one as a side.

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
duplicates, and merge by rewriting every reference at once.

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

### Running it

One non-root image that never writes to its own filesystem, with PostgreSQL as
the only thing it stores anything in. Migrations run at startup under an
advisory lock, and readiness stays closed until they finish. Local sign-in works
with no configuration at all; Google is optional and allowlisted.

Tagged multi-architecture images publish to GHCR on release.
