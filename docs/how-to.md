# How to use it

Step-by-step instructions for everyday work, written for someone opening Simple
Balance for the first time. Every button named here is the button on the
screen. The [guide](guide.md) is the companion that explains *why* things work
the way they do; this page only tells you *what to do*.

- [Set up your accounts](#set-up-your-accounts)
- [Choose which accounts stay usable](#choose-which-accounts-stay-usable)
- [Record a transaction](#record-a-transaction)
- [The three kinds of transaction](#the-three-kinds-of-transaction)
- [Record a refund](#record-a-refund)
- [Split one receipt across categories](#split-one-receipt-across-categories)
- [Fix a mistake](#fix-a-mistake)
- [Import a bank file](#import-a-bank-file)
- [Take your ledger with you](#take-your-ledger-with-you)
- [Bring a Simple Balance file in](#bring-a-simple-balance-file-in)
- [Move your ledger to our cloud app, or to a copy you run yourself](#move-your-ledger-to-our-cloud-app-or-to-a-copy-you-run-yourself)
- [Save time with templates](#save-time-with-templates)
- [Set up recurring transactions](#set-up-recurring-transactions)
- [Budgeting, from nothing](#budgeting-from-nothing)
- [See where you stand](#see-where-you-stand)

## Set up your accounts

An account is anywhere money sits or is owed: a checking account, a savings
account, a credit card, a loan, cash in a drawer.

1. Open **Accounts** in the sidebar and press **New account**.
2. Give it a name and a type, and pick its currency. The currency is fixed once
   the account is in use, so a euro account and a dollar account are two
   accounts.
3. Enter the **opening balance**: what the account holds *today*, or held on
   whatever **opening date** you choose. For a credit card or a loan the form
   asks for a **Starting amount** instead. Enter what you owe as a plain
   positive number and leave **Starting balance type** on **Amount owed**.
4. Press **Create account**.

Start with the accounts you actually use. You can add more whenever you like,
unless you are on the **Free** plan of a deployment that sells plans and every
place it keeps is in use: then **New account** is disabled and says why, and
[the next section](#choose-which-accounts-stay-usable) says what to do. An
account you stop using can be archived from its row menu; its history stays
readable, and its balance stops counting toward your totals.

## Choose which accounts stay usable

This only happens on a deployment that sells plans, while you are on **Free**
with more accounts than it keeps usable. Anywhere else the Accounts page shows
no such panel and there is nothing to do. The [guide](guide.md#plans) explains
the plans and why this choice is made once.

1. Open **Accounts**. The panel above your accounts is headed **Choose which
   accounts stay usable**. Until you choose, your oldest accounts in use are
   the usable ones, so those are the ones checked.
2. Check the accounts you want to keep using, up to the number the panel
   names, and clear the rest. The count beside the button says how many
   places you have filled.
3. Press **Save which accounts are usable**. This is the one time you choose.
   The accounts you saved are marked **In use** and stay that way until you
   archive or delete one. The rest are marked **Frozen**: still listed, still
   readable, still counted in every balance and report, and closed to every
   change until they are back in use. If the checked accounts are already the
   ones you want, there is nothing to save. The button stays disabled, those
   accounts stay usable, and the question stays open until you save a
   different set.

To bring a frozen account back later:

1. Archive or delete an account you are using, from its row menu. That opens
   up its place. A frozen account cannot be archived or deleted itself.
2. In the same panel, now headed **Accounts you are using**, check the frozen
   account and press **Bring these back**.

Restoring an archived account and pressing **New account** each take a free
place too, and each says so when there is none. **Settings > Plan and billing**
shows how many places are in use, and upgrading to **Premium** there makes
every account usable.

## Record a transaction

1. Open **Transactions** and press **Add transaction**.
2. Pick which way the money moved: deposit, withdrawal, or transfer.
3. Fill in the date, the account, the amount, and the payee, meaning who the
   money went to or came from. Payees you have used before are offered as you
   type.
4. Optionally pick a **category** (type to search; typing a new name creates
   it), and add a description or notes.
5. Press **Commit transaction**.

That is the whole job. Categories are what the reports and budgets group
spending by, so the more consistently you categorize, the more the rest of the
app can tell you.

## The three kinds of transaction

- **Deposit**: money arriving. Salary, interest, a gift. It lands in one
  account and usually carries an income category such as Salary.
- **Withdrawal**: money leaving. Shopping, rent, fees. It leaves one account
  and usually carries a spending category such as Groceries.
- **Transfer**: money moving between two of *your own* accounts, like paying
  the credit card from the checking account or adding to savings. A transfer
  is not income and not spending, so it carries no category and never appears
  in spending reports.

A transfer between two currencies asks for both sides: what left one account
and what arrived in the other. There is no exchange rate to configure, because
the two amounts you type *are* the rate you actually got.

## Record a refund

Money coming back from a store is not income; it is spending undone. Record it
as a **deposit** into your account, and give it the **same spending category**
the original purchase had. The category's spending goes down by that amount,
which is what your budget wants to know. Nothing special to press: picking a
spending category on a deposit is what makes it a refund.

If the refund's category does not exist yet (say you are entering history),
the form asks what the new name is. Answer **A refund of money you spent** so
it is created as a spending category and lowers spending, instead of counting
as income.

## Split one receipt across categories

One supermarket receipt that is partly food, partly household:

1. In the transaction form, press **Split across categories** under the
   category field.
2. Give each row its own category and amount. The form shows what is left to
   assign until the rows add up to the total.
3. Commit as usual.

Each part is reported under its own category, and the parts always add up to
exactly what left the account. Transfers cannot be split, because they have no
category side to divide.

## Fix a mistake

- **Edit**: press the pencil button on the row. Change anything and save. The
  books stay consistent because a correction is posted as a difference, never
  typed over.
- **Delete**: the trash button beside it, with a confirmation. A deleted
  transaction can be restored later; both moves keep every balance you have
  ever seen reconcilable.
- **Find where a balance went wrong**: open the account from **Accounts** and
  press **Show register**. Every movement is listed with the balance before
  and after it. Read down until the running balance stops matching your
  statement, and that is the row to fix.
- **Change many rows at once**: check the rows you want on Transactions (or use
  the select-all box), then use the bulk bar to recategorize, redate, rename
  the payee, or delete. Up to 10,000 rows, all-or-nothing, after being told
  exactly how many rows the change will touch.
- **Repeat something similar**: open the row's ⋯ menu and choose **Clone
  transaction**. The staging form opens prefilled with everything the original
  carried, ready to adjust; saving puts the copy on **Staged** for review
  rather than straight into the books. (For something you repeat often, a
  template is the better tool. See below.)

## Import a bank file

1. Download a CSV statement from your bank.
2. Open **Import and export** and, under **Import a CSV**, choose the file and
   match the columns: which one is the date, the amount (or debit/credit
   pair), the payee. Press **Dry run** to see how each row will be read before
   anything is saved.
3. Press **Stage all rows**. They land in **Staged**, a review queue where
   nothing counts toward balances yet.
4. Press the **Review these N rows** link, look the batch over, fix anything
   the importer flagged (a row missing an account, an unreadable date), and
   press **Commit selected**. Committing is all-or-nothing.

Staging and committing fifty rows or more at once both show a bar counting
the rows as they go, so a batch of several thousand tells you where it is
instead of leaving you guessing. If either is refused partway, nothing was
written and the message beside the bar says so. If the connection drops instead,
nobody can say — the work continues at the server whatever the browser does —
so the message asks you to reload and look.

Small repairs happen right in the list: click a row's **date, payee, category
or amount** and it turns into the same editor the full form uses. Click away
to save (for the date and amount, Enter saves too); Escape cancels. A split's
category and amount still edit through the row's pencil button, because their
answer lives on the parts the list cannot show, and a transfer carries no
category at all. Cloning works here too: a staged row's ⋯ menu has the same
**Clone transaction** entry.

Rows that look like something you already have are flagged as possible
duplicates and open side by side with the entry they resemble, so you can drop
the staged copy. If the committed one is the spare, delete it from
Transactions. Categories and payees named by the file are matched
case-insensitively and created if new.

A file exported from Simple Balance itself (Transactions → **Export CSV**)
needs no column mapping at all: choose the account it goes into and stage it.
Splits, both amounts of a conversion, and descriptions a spreadsheet would
mangle all come back as they left. The accounts do not travel in a CSV, so a
transfer arrives in **Staged** asking which account its other side is. To move
a whole ledger, with its accounts, budgets and templates, use a Simple Balance
file instead.

## Take your ledger with you

A Simple Balance file is one file holding everything you have written in this
ledger, for keeping or for moving to another copy of Simple Balance: our cloud
app, or a copy you run yourself.

1. Open **Import and export**. The export is the last section, **Export a
   Simple Balance file**.
2. Under **What to export**, choose **Everything** for the whole ledger, or
   **Some accounts** for the ones you pick.
3. For **Everything**, untick any kind of record you do not want. Every box
   starts ticked but **Activity history**, which is kept in the file and cannot
   be imported. **Transactions from** is **All time** unless you choose a
   **Date range**.
4. For **Some accounts**, tick up to 100 of them — archived ones are listed
   too — and choose how much of each to take under **With their
   transactions**: **No, account details only**, **All of them**, or **In a
   date range**.
5. Press **Export file**. It downloads as `simple-balance-` and today's date,
   or `simple-balance-accounts-` and the date for chosen accounts.

Anything you leave out still travels by name wherever something in the file
refers to it, so unticking budgets does not break the categories they were
about, and a transfer to an account you did not choose names that account and
nothing more. A transfer between two accounts you did choose is in the file
once. With a date range, each account carries what it held the day before the
range starts, so its balance in the file still adds up.

One file holds up to 100,000 transactions, staged rows, budget amounts and
history events together. A larger ledger is refused with a sentence saying what
to narrow — usually a date range at a time.

To bring the file into another copy, see the next two sections; that copy
needs this release or a later one. For a spreadsheet of your transactions,
Transactions → **Export CSV** is still the one to use.

## Bring a Simple Balance file in

This adds the file to the ledger you are signed in to, whether it is empty or
already has accounts and transactions of its own. Nothing is written until you
press the button at the end.

1. Open **Import and export**. The middle section is **Import a Simple Balance
   file**.
2. Choose the file. The page reads it first, and a file it cannot read is
   refused with each problem beside the place in the file it points at. Then it
   checks the file against this ledger, a part at a time for a large one.
3. Under **How should this file come in?**, choose **Add it to this ledger**.
   Where this ledger has transactions of its own it is chosen already, and
   **Move it into this ledger** says why it is not offered. Where it has none,
   nothing is chosen, and moving, in the next section, is usually what you
   want.
4. Read **What the file holds**: for each kind of record, how many are in the
   file, how many are new, already here, need a choice, or are left out, and
   below it how many transactions will go to **Staged**. **Show all N
   records** lists every record and what will happen to it.
5. Answer every record that needs a choice. One already here under the same
   name offers **Use the one here**, **Leave it out**, or **Bring it in as**
   with a new name; one the file only names, such as the account on the far
   side of a transfer, offers **Use another here**, **Create it**, or **Leave
   for review**. Only the answers that work for that record are offered, and
   **Still to decide** lists whatever is left, each linked to its question.
6. On the free plan, if the file brings more accounts in use than you have room
   for, tick at least as many as it says under **Accounts to arrive archived**.
   Nothing is ticked for you.
7. If this copy has regional defaults of its own — set in Settings, or taken
   from your browser when it was first opened — and the file's differ, choose
   under **Regional defaults and appearance**: the file's, or this copy's.
8. Press **Add to this ledger**. A file in parts says which part it is on, with
   a bar counting the rows as they are staged.
9. Press **Review N staged rows** (one for each part, for a file in parts) to
   look over the transactions in **Staged** and commit them, as with any
   import. **Open Accounts** shows what arrived.

Accounts, categories, templates, recurring transactions and budgets that were
new are in the ledger as soon as the add finishes; only the transactions wait
for review. A transfer in two accounts' files lands once, and adding a file
again adds nothing it already brought. Deleted transactions are not brought,
and an account that was archived arrives archived. An account you chose to
arrive archived keeps its transactions in **Staged** until you restore it from
**Accounts** into a free place.

If an add is refused partway, nothing from that part was written, and the
parts before it are in; if the connection drops instead, the page says it
cannot tell whether the part finished. Either way the same button becomes
**Try part 2 of 3 again** (**Try again** for a file of one part), which sends
that part again with the same answers, and a part that did finish is not added
twice. **Check the file again**, or choosing the same file again, reads the
ledger afresh and keeps what you decided: what earlier parts brought in is
recognized and skipped.

To bring the transactions straight into the books instead, deleted ones and
the days accounts were archived included, move the file into a ledger that has
nothing else in it yet: the next section.

## Move your ledger to our cloud app, or to a copy you run yourself

Moving works the same in both directions, because both run the same software:
you export a Simple Balance file from the copy you are leaving and move it into
a new, empty ledger on the other. Every transaction goes straight into the
books, so there is nothing to review afterwards, and every account's balance is
checked against the file before the move is finished.

1. **Get the side you are moving to ready, and leave it empty.** For our cloud
   app, sign up. For a copy you run yourself, set it up and sign in; it needs
   this release or a later one, and so does a copy you are moving away from.
   Do not enter a transaction or import a CSV there first: a move is offered
   only while everything in the ledger came from a Simple Balance file.
2. **Export the ledger you are leaving.** Open **Import and export** there,
   choose **Everything** under **What to export**, and press **Export file**
   (see [Take your ledger with you](#take-your-ledger-with-you)). Leave
   **Include deleted transactions** ticked if you want them to come too.
3. **On the new side**, open **Import and export** and choose the file under
   **Import a Simple Balance file**.
4. Under **How should this file come in?**, choose **Move it into this
   ledger**. Nothing is chosen for you, and the button stays disabled until
   you choose.
5. Read what the move will do: how many transactions go straight into the
   books, how many deleted ones come with them, which balances are checked
   against the file, and, if any, how many refunds count as income here rather
   than as money back because a category's kind was widened after them.
6. Answer anything under **Still to decide**. A move offers fewer answers than
   an add: an account or a category the file's transactions are filed under
   has to come in, so **Leave it out** is not offered for it.
7. On our cloud app's free plan, which keeps three accounts in use, a ledger
   with more than three accounts you still use needs either Premium, from
   **Settings > Plan and billing** before you move, or some of them ticked
   under **Accounts to arrive archived**. An archived account holds its
   transactions and uses no place, and restoring it later posts its balance
   back. Accounts that were already archived come over archived and need no
   place.
8. If the new side has regional defaults of its own — your browser sets them
   the first time you sign in — choose the file's or this copy's under
   **Regional defaults and appearance**.
9. Press **Move into this ledger**. A large file goes in parts, with
   **Part 2 of 3** above a bar counting the transactions written.
10. When it finishes, the page says how many transactions went into the books
    and that every balance came out as the file says. **Open Accounts** shows
    them. Rows that were waiting in Staged on the old side are waiting in
    **Staged** again, behind **Review N staged rows**.

**If it stops.** Nothing from the part that stopped was written, and the parts
before it are in. If an account's balance did not come out, the page lists
each one with both figures, and trying again would meet the same figures, so
**Try again** is disabled: the account on this side probably holds
transactions that are not in the file. Rename it under **Accounts** and press
**Check the file again**, so the file's comes in as a new account, or add the
file instead. If anything else stopped it, **Try part 2 of 3 again** (**Try
again** for a file in one part) sends that part again, and a part that did
finish is not moved twice.

**What does not move.** Your sign-in, your password, the agents you connected
and your plan stay with the copy that holds them, so connect your agents to the
new side again. The ledger you left is not touched: delete it there, under
**Settings**, once you are happy with the new one.

A move is a one-time trip rather than a way to keep two copies in step. Once
you use the new side, it takes no second move; to bring later transactions
across, export them from the old side with a date range and add them instead.

## Save time with templates

For transactions you type often but irregularly, like the vet, the barber, or
a transit card reload:

1. Open the ⋯ menu on any transaction and choose **Save as template**, or make
   one from scratch on **Templates**.
2. A template stores whatever fields you give it and leaves the rest blank. A
   blank amount means "ask me each time".
3. Next time, pick the template in the transaction form: it fills the form in
   and gets out of the way.

A template can also carry an email **reminder**, once on a date or repeating,
for the things nothing can enter for you but something can nag you about.
Reminders need the deployment to have a mail server; without one the setting
is kept and nothing is sent.

## Set up recurring transactions

For money that moves on a schedule, like rent, salary, and subscriptions:

1. Open **Recurring** and press **New recurring transaction**, or choose **Save as
   recurring transaction** from any row's ⋯ menu to start from a real example.
2. Set the schedule: daily, weekly, monthly or yearly, every N of those, on a
   day of the month or a relative day such as the last Friday. Choose what
   happens when the date lands on a weekend or a too-short month.
3. Leave the amount blank if it varies. The electric bill recurs; its
   amount does not.

On each due date the recurrence **proposes** a row in Staged. It never posts
to your books by itself: you check the proposal and commit it like anything
else. If the number waiting grows, the Recurring page's count links straight
to those rows; if the schedule stops running, the page says the recurrence is
past due rather than letting rent go quietly missing.

## Budgeting, from nothing

A budget here is a comparison, not a constraint: you say what a category
should cost per month (or week, quarter, year), and the **Budgets** page holds
that against what you actually spent. Nothing about a budget ever touches your
books. Deleting one changes no balance and no report.

If you have never budgeted before, do it in this order and stop wherever it
stops being useful. Each step works on its own.

### Step 1: put a number on one category

1. Spend normally for a month or two first, so the reports can tell you what
   things actually cost. Guessed budgets get abandoned; measured ones stick.
2. Open **Budgets**. Under **Set a budget**, pick a category (Groceries is the
   classic), type a monthly amount, set when it starts, and press **Set
   budget**.
3. Read the row it produces: **Budget** is the limit, **Spent** is the signed
   truth from your entries (refunds lower it), **Remaining** is the
   difference, and **So far** marks a month still running. A month you are
   halfway through is not yet a month you stayed within.

A budget is a standing instruction: one line covers every month until you end
it. December is allowed to be different. Press the calendar button at the end
of the row to set an amount for that period alone (a screen reader names it
"Set the amount for Groceries in December 2026", and "Change" once an override
exists), and clear the override to fall back.

Add categories one at a time as the numbers teach you something. A category
you budgeted and never spent on still shows, at zero. That is usually the
interesting row.

### Step 2: make the leftovers mean something (envelopes)

Check **Carry what is left over into the next month** on a budget and it
becomes an envelope: the $50 you did not spend on groceries in March is $50
more grocery money in April, and overspending carries forward too, as a debt
the calendar does not forgive. This is the whole of "envelope budgeting".
Money you did not spend stays earmarked instead of evaporating at month end.

Once anything carries, the page says what is left to assign: what the accounts
your budget is about hold, minus what the envelopes have already claimed.
Getting that figure to zero is "zero-based budgeting", where every dollar has a
job. Two dials control whose money counts:

- On each account's form, **The budget is about the money in this account**
  decides whether it is inside the budget's perimeter. Leave your retirement
  account out; keep the credit card in (spending on a card empties an envelope
  even though no cash moved yet).
- A **Most to carry** cap keeps an envelope from hoarding without limit, in
  both directions: the fund nobody draws on, the debt nobody repays.

### Step 3: save toward a date (sinking funds)

For a known future expense, like insurance in June or a vacation in August:

1. Set a budget on the category and fill **Saving up for** with the target
   amount and the date you need it by.
2. There is no amount to type. Each month the budget works out what is still
   needed divided by the months left, adjusts as the fund fills, and stops
   asking when it is full. Carrying is turned on for you, because saving *is*
   carrying.

### Step 4: let the amount decide itself

Under **Amount decided by**, three alternatives to typing a number:

- **What the last few periods spent**: the budget becomes a trailing average.
  The amount you type is used only until there is history to average.
- **The last period, plus a percentage**: for planned growth or a deliberate
  taper. 10 steps it up each month; -10 squeezes it down.
- **A share of the income before it**: "groceries get 15% of what came in last
  month". The [guide](guide.md#budgets) explains why it reads last month and
  not this one.

An amount you set for a single month beats any rule, and the rule continues
from what you set.

### Step 5: when there is not enough to go around

Give your most important budgets a **Funded first** rank (lower goes first).
The report then shows how much of each budget the month's income actually
covers, filling them in your order until the money runs out. Rank savings
first and you have "pay yourself first"; budget *only* savings and rank it,
leaving everything else unbudgeted, and you have the anti-budget. Budgets you
never ranked are funded last, after every ranked one, and the column only
appears once you rank something.

### Grouping categories

On **Categories**, press **Add group**. Every category row then has a **group
picker** on it: choose the group there, or pick one on the add-category form to
file a new category as you make it. A group is budgeted one of two ways, chosen
when you make it:

- **Has a budget of its own**: one number for the whole group ("Eating out:
  $200 across restaurants, takeout, coffee"). Bucket budgeting; three such
  groups make 50/30/20. The Budgets page badges these **Own budget**.
- **Adds up its categories' budgets**: the group is whatever its member
  budgets total, badged **Adds up**. Hierarchical budgeting; the group line is
  a subtotal, never a second claim.

### What happens next (the forecast)

The **What happens next** panel projects your balance per currency, month by
month. Nothing in it has happened; it is what the balances would do if nothing
changed. **Counting** decides what it reads:

- **Recurring plus what you usually spend** — the default. Dated recurrences,
  plus the average of what each category has actually spent over recent finished
  months where no recurrence already covers it, and the same for income. This is
  the only one that says anything at all before you have set up a recurrence.
  The month you are in is never part of its own average.
- **Recurring transactions only** — schedules and nothing else. Empty until you
  have some, and honest about it.
- **Recurring plus what budgets intend** — the pessimistic reading: it adds the
  part of each budget no recurrence already covers, so the rent is never counted
  twice.

A recurring transaction with no amount cannot be projected, and the panel names
it rather than quietly flattering every month.

### A starter recipe

For a first real month of budgeting: import or enter last month's spending;
set plain budgets on your five biggest spending categories at roughly what
they cost; check **Carry what is left over** on the two you most want to
control; add one sinking fund for the next known bill; then come back weekly
and read **Left to assign** and the **So far** rows. Adjust the numbers, not
your honesty. The report only works if the entries are true.

## See where you stand

- **Overview**: balances, cash flow, and spending by category for any date
  range. It stops at today whatever range you pick, because money dated next
  week has not moved. Archived accounts are left out until you tick **Include
  archived accounts** under the range, which counts them and what moved
  through them and marks each one "(archived)"; the choice is kept in the
  page's address, as it is on Reports. Below those, **Budget** shows where the period stands —
  what it has spent against what it may spend — and under it every group and
  category you have budgeted, whether or not anything has been spent against
  them yet, each category linking to its own page. Categories with no budget are
  left out: the panel above already reports that spending. Only the period your
  range ends in is broken down; **See budgets** opens the rest. When no category
  is budgeted in the range it says so rather than disappearing.
- **Reports**: net worth, income against expenses, spending by category, a
  cash flow statement, a balance sheet, and a trial balance that totals zero
  when the books are whole. On the categories report, one outsized category
  (rent, a tax bill) can flatten every other line in the chart: open its row's
  ⋯ menu and choose **Exclude from this view** to read the rest at their own
  scale. Pills above the report name what is left out and put it back, and
  nothing stored changes.
- **Activity**: the hundred most recent things you or a connected agent did,
  newest first. The full history is in the audit log underneath.

Every figure is per currency; nothing is ever added across currencies, because
there is no exchange rate here to add them with.
