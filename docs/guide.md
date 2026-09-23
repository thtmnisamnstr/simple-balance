# Using it

What each part of Simple Balance is for, and the decisions behind the ones that
are not obvious. Read it end to end once, or jump to what you are doing. For
step-by-step instructions — which buttons, in what order, and a budgeting
walkthrough that starts from nothing — see [How to use it](how-to.md).

- [Accounts and transactions](#accounts-and-transactions)
- [Splitting one receipt across categories](#splitting-one-receipt-across-categories)
- [Importing and exporting](#importing-and-exporting)
- [Templates](#templates)
- [Recurring transactions](#recurring-transactions)
- [Reminders](#reminders)
- [Changing many rows at once](#changing-many-rows-at-once)
- [Reading it back](#reading-it-back)
- [Budgets](#budgets)
- [How it looks](#how-it-looks)
- [Plans](#plans)
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
its history stays readable throughout. On a plan that limits how many accounts
are usable, restoring one needs a free place, the same as opening one does; see
[Plans](#plans).

Transactions are deposits, withdrawals, and transfers, same-currency or
converted. A date, an account, an amount and a payee are required; the category,
description and notes are not. A conversion keeps the sent and received amounts
apart rather than applying a rate, because the rate you got is a fact about that
transfer and not about your ledger.

Nothing is typed over. Correcting an entry posts the difference, and deleting one
posts its reversal, so a figure you saw last month still reconciles with the
entries that produced it.

Any row can be cloned, from its menu on either list. The copy opens the staging
form prefilled and lands on Staged rather than in the books, because a copy is a
proposal until somebody has looked at it — and it deliberately leaves the
original's bank reference behind, or the next import of that statement would
recognize its own row in the copy and stay silent.

## Splitting one receipt across categories

A grocery run that is partly food, partly household and partly something for the
dog is one transaction with three category legs. Press **Split across categories** on the category
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

A file of a few thousand rows takes a minute or so to stage, and the same again
to commit. Both say how far along they are while they work, row by row, so a
long wait looks like a long wait rather than like nothing happening. Because a
commit is all or nothing, a bar that stops on a refusal means nothing was
written, and the message beside it says so. If the connection goes instead, the
message says that too and asks you to reload — the work is never canceled
because a browser went away, so it may well have finished.

Staged transactions flags a row that repeats something you already have. The
check anchors on the amount, with the account and the direction to keep two
unrelated spends of the same size apart, and three days of latitude on the
date — because a bank posts when a purchase settles and names the merchant its
own way, so the same day and the same payee is a test a real import fails. Payee
and category are ignored for exactly that reason.

A flagged row opens beside the entry it resembles, both editable, and you drop
whichever copy is the spare. Press **Review N possible duplicates** at the top of
Staged transactions to work through all of them in one run: each comparison has
Previous and Next, and dropping a copy lands you on the next pair rather than back
at the list. The badge on any single row still opens that pair directly, for when
you only care about one.

One of Simple Balance's own exports needs no mapping at all: pick the account and
stage it. The account is that choice and nothing else, so a file exported from one
ledger imports into another, or into somebody else's, or into a fresh install. A
transfer names a second account, which is a choice the import screen cannot make,
so those rows arrive in the queue asking for it.

## Templates

A transaction you enter often can be saved as a template from any row and picked
from a dropdown next time. It fills the form in and then gets out of the way:
what you change afterward is yours alone, and the template is not touched.

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

A business day here means Monday through Friday. Holidays are not modeled, so a
proposal can land on one.

Make one on the Recurring screen, or from the menu on any row, on the
transactions list or Staged transactions, the same way you save a template. The
row supplies the payee, the account, the amount and the category, and its own
date becomes the day of the month the schedule repeats on. You give it a name
and pick how often.

On its due date it puts an ordinary row on Staged transactions, dated its own
occurrence, and posts nothing. You check it and commit it like anything else.
Leave the amount out and each proposal waits for a number, which is what the
electric bill wants. A split recurrence divides the same way every time, so its
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
tell you when it is due. Once on a date, or repeating on the same schedules a
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

Single-field repairs are cheaper still: a staged row's date, payee, category and
amount edit in place on the list, with the same editors and the same server
checks the full form uses. The fields that depend on parts the list cannot show
— a split's division, a transfer's two amounts — keep the full editor, so an
in-place edit can never quietly decide something off screen.

Categories and payees match case-insensitively, flag their own near-duplicates,
and merge by rewriting every reference at once. Recategorizing the last
transaction off a category removes that category, unless something still names
it — a recurrence, a template, or a budget — or unless it was made ahead of
time and is standing empty on purpose.

## Reading it back

**The dashboard** covers balances, cash flow, spending by category and where
your budget stands, over any date range, and the range is in the URL, so you can
link to it. It stops at today whatever range you pick, because money dated next
month is not money you have. Each category in the spending panel links to its own
page, carrying the range with it.

**Reports** go further. Net worth and a balance sheet for what the accounts hold,
income against expense and categories for what moved, a cash flow statement for
where the money you can spend came from and went to, and a trial balance that
totals zero when the books are whole. Group by week, month, quarter or year, or
not at all.

Every figure is per currency and none is ever added across them, because there are
no exchange rates here to add them with.

On the categories report, any category can be excluded from the view from its
row's menu, because one outsized line flattens the rest of the chart. The
excluded ones are named above the report and put back with a click; the report
itself is not recalculated on the server and an agent reading over MCP sees
every category either way — this is a reading choice, not a filter with
consequences.

The cash flow statement will not agree with income and expense, and the gap is
widest for whoever uses a credit card most: a purchase is an expense the day the
card is swiped, while the cash leaves when the bill is paid, in a different period
and as borrowing rather than spending. Both figures are right, and the page says
so rather than leaving it to be discovered.

**An account's register** is every posting in date order with the balance before
and after it. It is for finding mistakes rather than for analysis: where a balance
is wrong, this is the row it went wrong on. Open an account and press **Show
register**; it is fetched only when you ask, because most visits do not need it.

**Lists**: the transactions list, Staged transactions and the templates list sort
by any column they show and page by number. The recurring list sorts but does not
page, because it shows every recurrence you have — there are never enough of them
for a second page. Activity shows the hundred most recent events and neither sorts
nor pages. Everything the
browser or an agent did is in the audit log.

## Budgets

Set an amount for a category and a period — a month, a week, a quarter, a year —
and **Budgets** compares it against what you actually spent on that category in
each period. A budget is a standing instruction rather than a row per month: two
hundred a month on Groceries is one line, and it covers every period from the day
it starts until you end it. Both ends snap to whole periods, so a budget set on
the 14th applies to that whole month rather than to half of it.

**One month can differ without changing the rest.** December's grocery bill is
not November's, so an amount set for a single period overrides the standing one
for that period alone, and the report says which of the two produced each figure.
Clearing the override puts the standing amount back.

**A refund lowers the category it came back to**, rather than raising income.
Thirty back from the store makes groceries thirty lighter, because spending is
summed signed from the postings and a refund is the negative one. A split
receipt lands each leg on its own category, and a transfer between your own
accounts is not spending, so neither needs a rule here.

**A category you budgeted and never spent on still appears**, at zero against
its limit, because a category dropped for being empty is the one you most want
to see. Spending in categories nobody budgeted for is shown too — the question a
budget raises is where the rest went — and can be turned off.

Figures stop at today in your own timezone, whatever range you ask for, and a
period still running is marked "so far" rather than reported as though it had
finished. Nothing here writes to the ledger: a budget is a plan, and deleting one
changes no balance and no report.

**What is left over can carry into the next period.** Check "Carry what is left
over" and the budget becomes an envelope: the fifty you did not spend on
groceries in March is fifty more to spend in April, and going over is carried
the same way, as a debt against the next period rather than something the
calendar forgives. A cap holds it inside a number in both directions, for the
fund nobody ever draws on and the debt nobody ever repays. Nothing is stored
period by period — the figures are worked out from what you budgeted and what
you spent — so turning it off leaves nothing behind, and correcting a
transaction from last year changes every period after it, which is the honest
answer rather than a comfortable one.

**A budget can be saving up for something.** Put six hundred in "Saving up for"
with the date you need it by, and there is no amount to type: each period puts
aside what is still needed divided by the periods left, the figure adjusts as
the fund fills, and it stops asking once the fund is full. Carrying is part of
what a fund is, so it is turned on for you.

Carried figures are worked out from the budget's own start. Where that is more
than 120 periods back — ten years of months, or a little over two of weeks —
the page says how far it looked, because a number with a boundary is worth
having and a boundary nobody mentions is not.

**A budget can decide its own amount.** Under "Amount decided by" there are
three alternatives to typing a number, and picking one is all there is to it:

- **What the last few periods spent.** Say how many, and the budget is their
  average. The period being budgeted is never part of its own average, and
  early on it averages the periods that exist rather than counting the months
  before you started as nothing. The amount you type is what it uses until
  there is anything to average.
- **The last period, plus a percentage.** Ten percent more each month, or a
  negative number to taper. The amount you type is the first period's, and the
  increase starts from the one after it, compounding on the period before
  rather than on the original.
- **A share of the income before it.** Fifteen percent of what came in last
  month. Last month rather than this one, because a share of a month still
  running changes every time you look at it.

An amount you set for a single period beats any of them, and the chain carries
on from what you set.

**When there is not enough to go around, you can say what comes first.**
"Funded first" takes a number — lower goes first — and the report then shows how
much of each budget the period's income actually covers, filling them in that
order until it runs out. Anything you did not rank is funded last, after
every ranked budget, and shows its funded figure like the rest; the column
only appears where somebody asked the question.

**Categories can be grouped, one level deep.** Make a group on the Categories
page and say how it is budgeted: either it has a budget of its own, or it is
whatever the budgets of the categories in it add up to. There is no default,
because the two answer differently and being given the wrong one makes every
figure on the page wrong in the same direction. Put a category in a group by
editing it.

A group's line appears above the categories on the budget page, with what its
categories spent between them. Moving a category into a group changes what that
group spent in every past period too, because a group is a way of reading
categories rather than a record of where they used to be. Nothing about the
categories themselves changes. Nothing on a transaction ever names a group, so
grouping changes no figure until you budget one, and deleting a group leaves
every category exactly where it was.

**A budget that carries is an envelope, and the page says what is left to
assign.** That figure is the money in the accounts the budget is about, less
what every envelope with money still in it has already claimed. It sits below
your bank balance on purpose, for two reasons: envelopes have claimed the rest,
and an account can be left out of the budget entirely — uncheck "The budget is
about the money in this account" when you add or edit one. Cards are counted by
default, because spending on a card empties an envelope even though no cash has
moved yet.

**"What happens next" projects your balances forward.** It walks each period
from what your accounts hold today. Nothing in it has happened: it is what the
balances would do if nothing changed, and the page never calls a projected
figure a balance.

Choose how far ahead, and what to count. By default it counts your recurring
transactions plus what you usually spend — the average of recent finished
months, category by category, wherever no recurring transaction already covers
it. That is what lets the panel say something on a ledger that has months of
real spending and no schedules yet, which used to show zero in both columns
without explaining why. The other two readings are there when you want them:
schedules alone, or schedules plus everything your budgets intend, which is the
pessimistic one. Whichever you pick, a figure that came from history is reported
separately from one that came from a date, so you can always tell them apart. A
recurring transaction with no amount cannot be projected — the page names it,
because leaving it out silently would make every period look better than it is.

## How it looks

There is a light theme and a dark one, and by default the app takes whichever the
machine is set to — so it goes dark with the rest of the screen at sunset without
being told. The moon in the bottom corner of the sidebar switches it, and Settings
has all three choices: **Light** and **Dark**, which stay where you put them, and
**Follow my system**, which is the default.

The choice is saved to the account rather than to the browser, so signing in on a
different device brings it along. It is applied before the page draws, so there is
no flash of the wrong theme on the way in.

Every figure means the same thing in both themes. Money out is red and money in is
green in each of them, and the report charts keep each account on the same color
family when the theme changes, so a chart you have learned to read still reads the
same way.

## Plans

A deployment sells plans only if its operator sets that up, and one that does
not includes everything: no account is ever frozen and no advertisement is
shown. Where payments were never set up at all, Settings has no **Plan and
billing** tab either. The rest of this section is for a deployment that does
sell them.

There are two plans, and only accounts and advertising set them apart. **Free**
keeps three accounts usable at a time and may show an advertisement below the
page. **Premium** keeps every account usable and shows none. Everything else in
this guide — budgets, imports, reports, recurring transactions, the MCP server —
is the same on both, because what you pay for is the use of every account, not
a feature held back.

**Settings > Plan and billing** says which plan you are on and how many of its
places are in use, and it is where you upgrade, switch between monthly and
annual, replace the card, or cancel. A canceled plan runs to the end of the
period you paid for. When a renewal fails, Premium continues for fifteen days
while Stripe retries the card, and paying from that tab, or replacing the card,
settles it right away. An operator can also grant a plan directly, and the tab
says so when one has.

**A frozen account is still all there.** On Free, the accounts past the three
in use are frozen. Each stays on the Accounts page with a **Frozen** badge, is
readable in full, and counts toward every balance and report: nothing is hidden
and nothing is deleted. What it refuses is change. No new entry, no edit to or
deletion of an entry it holds, no rename, and it cannot be archived or deleted
either; a payee or category merge that would rewrite one of its entries is
refused whole rather than done in part. Upgrading makes every account usable
again.

**Which accounts stay usable is chosen once.** When a plan starts limiting you,
the Accounts page opens a panel headed **Choose which accounts stay usable**,
and until you answer it your oldest accounts in use are the usable ones, so
those are the ones checked to begin with. Check the ones you want, up to three,
and press **Save which accounts are usable**. If the checked ones are already
the ones you want, there is nothing to save: the button stays disabled, those
accounts stay usable, and the question stays open until you save a different
set. Once you have saved, the panel reads **Accounts you are using**, the
chosen accounts are marked **In use**, and they stay in use until you archive or
delete one. Nothing trades an account in use for a frozen one, because being
able to swap them back and forth whenever you liked would be the same as having
all of them.

Archiving or deleting an account you are using opens up its place. A frozen
account can then take it: check it in the same panel and press **Bring these
back**. Restoring an archived account needs a free place too, and the restored
account takes it. **New account** does the same, so with every place in use it
is disabled and says why. While every account you have fits within the three,
all of them are in use and there is nothing to choose.

Time on Premium leaves an earlier choice standing unless you opened or restored
accounts during it. If you did, going back to Free asks the question again,
because the choice you made before was about a smaller ledger.

An agent can read which plan you are on, its limit and how many places are in
use, which is what it needs to explain a refusal. Starting, changing or
canceling a plan is yours alone, signed in; see
[MCP](mcp.md#what-an-agent-cannot-do).

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
