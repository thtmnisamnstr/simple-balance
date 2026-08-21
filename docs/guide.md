# Using it

What each part of Simple Balance is for, and the decisions behind the ones that
are not obvious. Read it end to end once, or jump to what you are doing.

- [Accounts and transactions](#accounts-and-transactions)
- [Splitting one receipt across categories](#splitting-one-receipt-across-categories)
- [Importing and exporting](#importing-and-exporting)
- [Templates](#templates)
- [Recurring transactions](#recurring-transactions)
- [Reminders](#reminders)
- [Changing many rows at once](#changing-many-rows-at-once)
- [Reading it back](#reading-it-back)
- [Signing in, and leaving](#signing-in-and-leaving)

## Accounts and transactions

Accounts hold anything you file as an asset or a liability, each in its own
currency: checking, savings, credit cards, cash, loans, investments, crypto
wallets. A credit card or a loan opens at a negative balance, because that is
money owed. Crypto wallets track native quantities; nothing here quotes a market
price.

Retiring an account archives it. That posts whatever it still holds out to
equity, so the account closes at zero and stops counting toward your totals
without the books going out of balance. Restoring it posts the balance back, and
its history stays readable throughout.

Transactions are deposits, withdrawals, and transfers, same-currency or
converted. A date, an account, an amount and a payee are required; the category,
description and notes are not. A conversion keeps the sent and received amounts
apart rather than applying a rate, because the rate you got is a fact about that
transfer and not about your ledger.

Nothing is typed over. Correcting an entry posts the difference, and deleting one
posts its reversal, so a figure you saw last month still reconciles with the
entries that produced it.

## Splitting one receipt across categories

A grocery run that is partly food, partly household and partly something for the
dog is one transaction with three category legs. Press **Split** on the category
field, give each row its own amount, and the form tells you what is left to
assign until it comes to nothing.

Each leg is attributed to its own category everywhere the money is reported: the
dashboard, the category pages, the reports, and over MCP. Nothing is counted
twice — the categories add up to exactly what left the account, because a split
cuts the entry's existing counter-side into pieces rather than recording the money
again.

Splits work on staged rows and on templates too, where the categories are stored
and the amounts left for you. An export carries a split by category name and
reads back as the same split in another ledger. A transfer names an account on
both sides, so there is no counter-side to divide and a transfer is never split.

## Importing and exporting

Imports go through **Staged transactions**, which is the review queue in front
of the books: nothing on it has been posted and nothing on it counts. Simple
Balance reads the CSV, works out the format, maps the columns, parses whatever
date and number conventions your bank uses, and creates categories and payees as
it goes. You look at the result before any of it counts, and committing a batch
is all or nothing.

Staged transactions flags a row that repeats something you already have. The
check anchors on the amount, with the account and the direction to keep two
unrelated spends of the same size apart, and three days of latitude on the
date — because a bank posts
when a purchase settles and names the merchant its own way, so the same day and
the same payee is a test a real import fails. Payee and category are ignored for
exactly that reason. A flagged row opens beside the entry it resembles, both
editable, and you drop whichever copy is the spare.

One of Simple Balance's own exports needs no mapping at all: pick the account and
stage it. The account is that choice and nothing else, so a file exported from one
ledger imports into another, or into somebody else's, or into a fresh install. A
transfer names a second account, which is a choice the import screen cannot make,
so those rows arrive in the queue asking for it.

## Templates

A transaction you enter often can be saved as a template from any row and picked
from a dropdown next time. It fills the form in and then gets out of the way:
what you change afterwards is yours alone, and the template is not touched.

Only the name is required. A template holds whatever subset of a transaction's
fields you give it, and applying one fills in those fields and leaves the rest as
they were — so you can apply a template to an entry that already exists as well
as to a new one. Each template reports how many transactions have come from it,
and links to them.

Templates have a screen of their own, where you can make one, change one, or
change many at once. A mass edit there can also clear a field rather than set it,
which is how a template stops carrying an amount and starts asking for one each
time you use it.

## Recurring transactions

Rent, a salary, a subscription: anything that arrives on a schedule can be set up
once and left. Daily, weekly, monthly or yearly, every N of those, on a day of the
month or on a relative day such as the second Tuesday or the last Friday. You
choose what happens when the month is too short for the day you picked, and what
happens when a date lands on a weekend.

A business day here means Monday to Friday. Public holidays are not modelled, so
a proposal can land on one.

Make one on the Recurring screen, or from the menu on any row, on the
transactions list or Staged transactions, the same way you save a template. The
row supplies the payee, the account, the amount and the category, and its own
date becomes the day of the month the schedule repeats on. You give it a name
and pick how often.

On its due date it puts an ordinary row on Staged transactions, dated its own
occurrence, and posts nothing. You check it and commit it like anything else.
Leave the amount out and each proposal waits for a number, which is what the
electricity bill wants. A split recurrence divides the same way every time, so its
legs have to add up to the amount before it is saved rather than each proposal
being refused later.

That it proposes rather than posts is the whole design. A scheduler writing to the
ledger unattended is a writer nobody watched; a scheduler filling a queue is just
another thing suggesting work. It also turns the usual failure inside out: when
the schedule stops running, the Recurring page says a recurrence is past due
rather than the ledger quietly missing months of rent.

## Reminders

Two kinds of email, both on the same schedule machinery, and the difference
between them is what you are being told.

**A recurrence can write when it proposes**, so a queue you check weekly does not
quietly grow. One message per proposal however many rows it holds, naming the
dates and pointing at the queue. The Recurring list says which recurrences are
set to send one, and the column sorts, so you can see them together.

**A template can carry a reminder**, which is the other half of the same idea. A
template is filled in by hand, so nothing can make it for you — but something can
tell you it is the day. Once on a date, or repeating on the same schedules a
recurrence offers, and either way at a time of day on your own clock rather than
the server's. The Templates list says which templates have one and whether it
repeats.

So a recurrence proposes a row and asks you to check it, and a reminder asks you
to make one. The reminder's mail records nothing.

Both need a mail server configured. Without one the setting is saved and nothing
is sent, and it starts sending when one is configured — but nothing queues in the
meantime, so a reminder whose moment passed while there was nowhere to send it is
not sent later. A backlog collapses into one message either way: coming back from
a week of downtime brings one reminder, not seven.

## Changing many rows at once

You can change or delete up to 10,000 rows in one request that either wholly
succeeds or wholly does not, from any view, after seeing what it will touch.

That works on the queue as well as on committed rows, which is how you fix a file
whose account or category column meant nothing to the importer: one edit over the
whole batch, and the rows it repairs come back ready to commit.

Categories and payees match case-insensitively, flag their own near-duplicates,
and merge by rewriting every reference at once. Recategorising the last
transaction off a category removes that category, unless something still names
it — a recurrence or a template — or unless it was made ahead of time and is
standing empty on purpose.

## Reading it back

**The dashboard** covers balances, cash flow, and spending by category over any
date range, and the range is in the URL, so you can link to it. It stops at today
whatever range you pick, because money dated next month is not money you have.

**Reports** go further. Net worth and a balance sheet for what the accounts hold,
income against expense and categories for what moved, a cash flow statement for
where the money you can spend came from and went to, and a trial balance that
totals zero when the books are whole. Group by week, month, quarter or year, or
not at all.

Every figure is per currency and none is ever added across them, because there are
no exchange rates here to add them with.

The cash flow statement will not agree with income and expense, and the gap is
widest for whoever uses a credit card most: a purchase is an expense the day the
card is swiped, while the cash leaves when the bill is paid, in a different period
and as borrowing rather than spending. Both figures are right, and the page says
so rather than leaving it to be discovered.

**An account's register** is every posting in date order with the balance before
and after it. It is for finding mistakes rather than for analysis: where a balance
is wrong, this is the row it went wrong on. Open an account and press **Show
register**; it is fetched only when you ask, because most visits do not need it.

**Lists**: the transactions list, Staged transactions, the templates list and
the recurring list sort by any column they show and page by number. Activity
shows the hundred most recent events and neither sorts nor pages. Everything the
browser or an agent did is in the audit log.

## Signing in, and leaving

Sign in with an email and password, with Google, or with both on the same account.
One deployment can hold any number of people, each with their own separate books,
and `ALLOWED_EMAILS` decides who may join. Two people on one deployment cannot
see each other's accounts, transactions, categories, payees, or totals.

The MCP server runs over OAuth with separate read, stage, and write scopes. What
an agent can and cannot do is in [MCP](mcp.md).

Leaving is yours to do. Settings deletes the account and everything in it, after
counting what that is and asking you to type your address. Nothing is kept, and
no agent can do it for you.
