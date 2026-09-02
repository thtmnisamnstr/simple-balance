# How to use it

Step-by-step instructions for everyday work, written for someone opening Simple
Balance for the first time. Every button named here is the button on the
screen. The [guide](guide.md) is the companion that explains *why* things work
the way they do; this page only tells you *what to do*.

- [Set up your accounts](#set-up-your-accounts)
- [Record a transaction](#record-a-transaction)
- [The three kinds of transaction](#the-three-kinds-of-transaction)
- [Record a refund](#record-a-refund)
- [Split one receipt across categories](#split-one-receipt-across-categories)
- [Fix a mistake](#fix-a-mistake)
- [Import a bank file](#import-a-bank-file)
- [Save time with templates](#save-time-with-templates)
- [Set up recurring transactions](#set-up-recurring-transactions)
- [Budgeting, from nothing](#budgeting-from-nothing)
- [See where you stand](#see-where-you-stand)

## Set up your accounts

An account is anywhere money sits or is owed: a current account, a savings
account, a credit card, a loan, cash in a drawer.

1. Open **Accounts** in the sidebar and press **New account**.
2. Give it a name and a type, and pick its currency. The currency is fixed once
   the account is in use, so a euro account and a dollar account are two
   accounts.
3. Enter the **opening balance** — what the account holds *today*, or held on
   whatever **opening date** you choose. For a credit card or a loan the form
   asks for a **Starting amount** instead: enter what you owe as a plain
   positive number and leave **Starting balance type** on **Amount owed**.
4. Press **Create account**.

Start with the accounts you actually use. You can add more at any time, and an
account you stop using can be archived from its row menu — its history stays
readable, and its balance stops counting toward your totals.

## Record a transaction

1. Open **Transactions** and press **Add transaction**.
2. Pick which way the money moved: deposit, withdrawal, or transfer.
3. Fill in the date, the account, the amount, and the payee — who the money
   went to or came from. Payees you have used before are offered as you type.
4. Optionally pick a **category** (type to search; typing a new name creates
   it), and add a description or notes.
5. Press **Commit transaction**.

That is the whole job. Categories are what the reports and budgets group
spending by, so the more consistently you categorise, the more the rest of the
app can tell you.

## The three kinds of transaction

- **Deposit** — money arriving: salary, interest, a gift. It lands in one
  account and usually carries an income category such as Salary.
- **Withdrawal** — money leaving: shopping, rent, fees. It leaves one account
  and usually carries a spending category such as Groceries.
- **Transfer** — money moving between two of *your own* accounts: paying the
  credit card from the current account, topping up savings. A transfer is not
  income and not spending, so it carries no category and never appears in
  spending reports.

A transfer between two currencies asks for both sides: what left one account
and what arrived in the other. There is no exchange rate to configure — the
two amounts you type *are* the rate you actually got.

## Record a refund

Money coming back from a shop is not income — it is spending undone. Record it
as a **deposit** into your account, and give it the **same spending category**
the original purchase had. The category's spending goes down by that amount,
which is what your budget wants to know. Nothing special to press: picking a
spending category on a deposit is what makes it a refund.

If the refund's category does not exist yet (say you are entering history),
the form asks what the new name is — answer **A refund of money you spent**
so it is created as a spending category and lowers spending, instead of
counting as income.

## Split one receipt across categories

One supermarket receipt that is partly food, partly household:

1. In the transaction form, press **Split across categories** under the
   category field.
2. Give each row its own category and amount. The form shows what is left to
   assign until the rows add up to the total.
3. Commit as usual.

Each part is reported under its own category, and the parts always add up to
exactly what left the account. Transfers cannot be split — they have no
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
  and after it — read down until the running balance stops matching your
  statement, and that is the row to fix.
- **Change many rows at once**: tick their checkboxes on Transactions (or use
  the select-all box), then use the bulk bar to recategorise, redate, rename
  the payee, or delete — up to 10,000 rows, all-or-nothing, after being told
  exactly how many rows the change will touch.
- **Repeat something similar**: open the row's ⋯ menu and choose **Clone
  transaction**. The staging form opens prefilled with everything the original
  carried, ready to adjust; saving puts the copy on **Staged** for review
  rather than straight into the books. (For something you repeat often, a
  template is the better tool — see below.)

## Import a bank file

1. Download a CSV statement from your bank.
2. Open **Import CSV**, choose the file, and match the columns — which one is
   the date, the amount (or debit/credit pair), the payee. Press **Dry run**
   to see how each row will be read before anything is saved.
3. Press **Stage all rows**. They land in **Staged** — a review queue where
   nothing counts toward balances yet.
4. Press the **Review these N rows** link, look the batch over, fix anything
   the importer flagged (a row missing an account, an unreadable date), and
   press **Commit selected**. Committing is all-or-nothing.

Small repairs happen right in the list: click a row's **date, payee, category
or amount** and it turns into the same editor the full form uses — type the
change, press Enter or click away to save, Escape to cancel. A split's
category and amount, and a transfer's category, still edit through the row's
pencil button, because their answer lives on the parts the list cannot show.
Cloning works here too: a staged row's ⋯ menu has the same **Clone
transaction** entry.

Rows that look like something you already have are flagged as possible
duplicates and open side by side with the entry they resemble, so you can drop
the staged copy — or, if the committed one is the spare, delete it from
Transactions. Categories and payees named by the file are
matched case-insensitively and created if new.

A file exported from Simple Balance itself (Transactions → **Export CSV**) needs no
column mapping at all, and survives the round trip exactly — splits, both
sides of a conversion, everything.

## Save time with templates

For transactions you type often but irregularly — the vet, the barber, a
top-up:

1. Open the ⋯ menu on any transaction and choose **Save as template**, or make
   one from scratch on **Templates**.
2. A template stores whatever fields you give it and leaves the rest blank. A
   blank amount means "ask me each time".
3. Next time, pick the template in the transaction form: it fills the form in
   and gets out of the way.

A template can also carry an email **reminder** — once on a date, or
repeating — for the things nothing can enter for you but something can nag you
about. Reminders need the deployment to have a mail server; without one the
setting is kept and nothing is sent.

## Set up recurring transactions

For money that moves on a schedule — rent, salary, subscriptions:

1. Open **Recurring** and press **New recurrence**, or choose **Save as
   recurring transaction** from any row's ⋯ menu to start from a real example.
2. Set the schedule: daily, weekly, monthly or yearly, every N of those, on a
   day of the month or a relative day such as the last Friday. Choose what
   happens when the date lands on a weekend or a too-short month.
3. Leave the amount blank if it varies — the electricity bill recurs, its
   amount does not.

On each due date the recurrence **proposes** a row in Staged — it never posts
to your books by itself. You check the proposal and commit it like anything
else. If the number waiting grows, the Recurring page's count links straight
to those rows; if the schedule stops running, the page says the recurrence is
past due rather than letting rent go quietly missing.

## Budgeting, from nothing

A budget here is a comparison, not a constraint: you say what a category
should cost per month (or week, quarter, year), and the **Budgets** page holds
that against what you actually spent. Nothing about a budget ever touches your
books — deleting one changes no balance and no report.

If you have never budgeted before, do it in this order and stop wherever it
stops being useful. Each step works on its own.

### Step 1 — put a number on one category

1. Spend normally for a month or two first, so the reports can tell you what
   things actually cost. Guessed budgets get abandoned; measured ones stick.
2. Open **Budgets**. Under **Set a budget**, pick a category (Groceries is the
   classic), type a monthly amount, set when it starts, and press **Set
   budget**.
3. Read the row it produces: **Budget** is the limit, **Spent** is the signed
   truth from your entries (refunds lower it), **Remaining** is the
   difference, and **So far** marks a month still running — a month you are
   halfway through is not yet a month you stayed within.

A budget is a standing instruction: one line covers every month until you end
it. December is allowed to be different — press **Just this month** on the
row to override a single period, and clear the override to fall back.

Add categories one at a time as the numbers teach you something. A category
you budgeted and never spent on still shows, at zero — that is usually the
interesting row.

### Step 2 — make the leftovers mean something (envelopes)

Tick **Carry what is left over into the next month** on a budget and it
becomes an envelope: the £50 you did not spend on groceries in March is £50
more grocery money in April, and overspending carries forward too, as a debt
the calendar does not forgive. This is the whole of "envelope budgeting" —
money you did not spend stays earmarked instead of evaporating at month end.

Once anything carries, the page shows **Left to assign**: what the accounts
your budget is about hold, minus what the envelopes have already claimed.
Getting that figure to zero is "zero-based budgeting" — every pound has a
job. Two dials control whose money counts:

- On each account's form, **The budget is about the money in this account**
  decides whether it is inside the budget's perimeter. Leave your pension out;
  keep the credit card in (spending on a card empties an envelope even though
  no cash moved yet).
- A **Most to carry** cap stops an envelope hoarding without limit, in both
  directions — the fund nobody draws on, the debt nobody repays.

### Step 3 — save toward a date (sinking funds)

For a known future expense — insurance in June, a holiday in August:

1. Set a budget on the category and fill **Saving up for** with the target
   amount and the date you need it by.
2. There is no amount to type. Each month the budget works out what is still
   needed divided by the months left, adjusts as the fund fills, and stops
   asking when it is full. Carrying is turned on for you, because saving *is*
   carrying.

### Step 4 — let the amount decide itself

Under **Amount decided by**, three alternatives to typing a number:

- **What the last few periods spent** — the budget becomes a trailing
  average. The amount you type is used only until there is history to
  average.
- **The last period, plus a percentage** — for planned growth or a deliberate
  taper: 10 steps it up each month, -10 squeezes it down.
- **A share of the income before it** — "groceries get 15% of what came in
  last month". Last month, because a share of a month still running would
  change every time you looked.

An amount you set for a single month beats any rule, and the rule carries on
from what you set.

### Step 5 — when there is not enough to go round

Give your most important budgets a **Funded first** rank (lower goes first).
The report then shows how much of each budget the month's income actually
covers, filling them in your order until the money runs out. Rank savings
first and you have "pay yourself first"; budget *only* savings and rank it,
leaving everything else unbudgeted, and you have the anti-budget. Budgets you
never ranked are funded last, after every ranked one — and the column only
appears once you rank something.

### Grouping categories

On **Categories**, press **Add group**, then edit a category to file it under
the group. A group is budgeted one of two ways, chosen when you make it:

- **Has a budget of its own** — one number for the whole group ("Eating out:
  £200 across restaurants, takeaway, coffee"). Bucket budgeting; three such
  groups make 50/30/20. The Budgets page badges these **Own budget**.
- **Adds up its categories' budgets** — the group is whatever its member
  budgets total, badged **Adds up**. Hierarchical budgeting; the group line
  is a subtotal, never a second claim.

### What happens next (the forecast)

The **What happens next** panel walks your recurring transactions forward and
projects your balance per currency, month by month. Nothing in it has happened — it is
what the balances would do if nothing changed. Switch **Counting** to
"Recurring plus what budgets intend" for the pessimistic reading: it adds the
part of each budget no recurrence already covers, so rent is never counted
twice. A recurrence with no amount cannot be projected, and the panel names it
rather than quietly flattering every month.

### A starter recipe

For a first real month of budgeting: import or enter last month's spending;
set plain budgets on your five biggest spending categories at roughly what
they cost; tick **Carry what is left over** on the two you most want to
control; add one sinking fund for the next known bill; then come back weekly
and read **Left to assign** and the **So far** rows. Adjust the numbers, not
your honesty — the report only works if the entries are true.

## See where you stand

- **Overview** — balances, cash flow, and spending by category for any date
  range. It stops at today whatever range you pick, because money dated next
  week has not moved.
- **Reports** — net worth, income against expenses, spending by category, a
  cash flow statement, a balance sheet, and a trial balance that totals zero
  when the books are whole. On the categories report, one outsized category
  (rent, a tax bill) can flatten every other line in the chart: open its row's
  ⋯ menu and choose **Exclude from this view** to read the rest at their own
  scale. The exclusion is a view choice only — pills above the report name
  what is left out and put it back, and nothing stored changes.
- **Activity** — the hundred most recent things you or a connected agent did,
  newest first. The full history is in the audit log underneath.

Every figure is per currency; nothing is ever added across currencies, because
there is no exchange rate here to add them with.
