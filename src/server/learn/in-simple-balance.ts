/**
 * Each money guide's "How to do it in Simple Balance" steps, mapped to the
 * tools on this server that do them.
 *
 * The guides are the site's words and arrive verbatim in `learn-pack.json`; this
 * file is this repository's, because what a tool takes is something only this
 * repository knows. The guides are written for the browser, and for an agent
 * the browser's wording is half right: a card's debt is typed "as a plain
 * number" there, beside a Starting balance type of Amount owed, and the same
 * debt is a negative `openingBalance` here. An agent following the guide's
 * words alone would open a card holding 500 rather than owing it. So each step
 * carries the tools and one or two sentences for an agent, where the browser's
 * words would mislead or where a field name is the whole answer.
 *
 * **Held to both sides by `tests/learn-pack.test.ts`.** Every guide in the pack
 * has an entry, every `###` under its "How to do it in Simple Balance" is a
 * step here and nothing else is, every tool is one `TOOL_SCOPES` names, and
 * every backticked word in a `how` is one of the step's tools or a field or
 * enum value that one of them publishes. A sync that renames a step fails
 * there, which is the point: the step map is edited in the same commit as the
 * pack, and `scripts/sync-learn.mjs` says which guides need it.
 *
 * Keyed by the step's heading with straight quotes, because the site curls
 * some of its text; the comparison folds both.
 */
export type LearnStep = {
  /** The guide's `###` heading, word for word apart from quote marks. */
  readonly step: string;
  /** The tools that do the step, in the order an agent would call them. */
  readonly tools: readonly string[];
  /** One or two sentences for an agent: what to call, with what. */
  readonly how: string;
};

export const IN_SIMPLE_BALANCE: Readonly<Record<string, readonly LearnStep[]>> = {
  "track-your-spending": [
    {
      step: "Set up your accounts",
      tools: ["create_account", "whoami"],
      how: "One `create_account` per account. A card's debt is a negative `openingBalance`, such as \"-500\", where the browser takes a plain number and Amount owed; `whoami` reports the plan's `accountLimit` and `accountsUsed`.",
    },
    {
      step: "Bring in a statement",
      tools: ["preview_csv", "stage_csv"],
      // The last sentence stands in for the site until it renames the page: the
      // pack is never edited, and an agent passing the guide on would send the
      // person looking for a page the navigation no longer has. It goes when a
      // sync brings the site's own correction, and `tests/learn-pack.test.ts`
      // holds both ends: a label the navigation lacks needs the sentence, and a
      // sentence the guide no longer needs fails too.
      how: "`preview_csv` reads the columns and returns a `suggestedMapping`. Send a `mapping` and `defaultAccountId` to `stage_csv`, first with `dryRun` (the browser's Dry run) and then without, which puts the rows in Staged where nothing counts yet; `dateFormat` MDY is a US bank that writes the month first. The page the guide calls Import CSV is Import and export now.",
    },
    {
      step: "Sort the rows as you check them",
      tools: [
        "list_staged_transactions",
        "update_staged_transaction",
        "bulk_edit_staged_transactions",
        "get_staged_duplicate",
        "commit_staged_transactions",
      ],
      how: "Categorize staged rows with `update_staged_transaction`, or many at once with `bulk_edit_staged_transactions`. `list_staged_transactions` with `validity` duplicate finds the possible repeats, and `get_staged_duplicate` shows each beside what it repeats. Only `commit_staged_transactions` makes rows count.",
    },
    {
      step: "Card payments and refunds",
      tools: ["create_transaction"],
      how: "A card payment is `type` transfer from checking to the card, with the payment in `sourceAmount` and no category. A refund is a deposit in the purchase's category; for a category that does not exist yet, send `categoryKind` expense, which the browser asks as A refund of money you spent.",
    },
    {
      step: "See where it went",
      tools: ["get_financial_summary", "get_report", "bulk_edit_transactions"],
      how: "`get_financial_summary` is the Overview's spending by category, and `get_report` with `report` categories or income-expense is Reports. Recategorize many entries with `bulk_edit_transactions`, running `dryRun` first to show the count.",
    },
  ],
  "budget-categories": [
    {
      step: "Set them up ahead of time",
      tools: ["list_categories", "create_category"],
      how: "Call `list_categories` first so a second spelling is not created, then `create_category` with `kind` expense, income or both (the browser's Applies to).",
    },
    {
      step: "Make groups",
      tools: ["create_category_group", "update_category"],
      how: "`create_category_group` with `policy` standalone for one budget for the whole group, or sum_of_children to budget each category and show the total; then set each category's `groupId` with `update_category`.",
    },
    {
      step: "Clean up",
      tools: [
        "list_duplicate_categories",
        "merge_categories",
        "bulk_edit_transactions",
        "update_transaction",
        "archive_category",
      ],
      how: "`list_duplicate_categories` finds names entered twice, and `merge_categories` joins them and cannot be undone, so confirm it first. `bulk_edit_transactions` recategorizes many entries; a split is `legs` on `update_transaction`; `archive_category` puts one away with its history.",
    },
    {
      step: "See where the money went",
      tools: ["get_financial_summary", "get_report"],
      how: "`get_report` with `report` categories, or `get_financial_summary` for the Overview's figures. A transfer carries no category, so neither counts it as spending.",
    },
  ],
  "make-a-budget": [
    {
      step: "Start with real spending",
      tools: ["stage_csv", "create_transaction", "get_financial_summary"],
      how: "Bring in or enter a month or two first, then set each amount from the spending by category `get_financial_summary` reports.",
    },
    {
      step: "Set a budget",
      tools: ["create_budget_plan"],
      how: "One `create_budget_plan` per category, with `amount`, `periodUnit` month and `activeFrom`. It covers every period from then on until `activeTo` ends it.",
    },
    {
      step: "Read your budget",
      tools: ["get_budget_report"],
      how: "Each row reports `limit`, `actual` and `remaining`, and a refund lowers `actual`. A category budgeted in another period unit reads as unbudgeted here, so check `otherPeriodUnits` before saying it has no budget.",
    },
    {
      step: "Let one month be different",
      tools: ["set_budget_entry", "list_budget_entries", "delete_budget_entry"],
      how: "`set_budget_entry` sets one period's amount, named by `periodStart`, over the standing budget. `delete_budget_entry` goes back to the usual amount, with the entry's `id` and its `version` as `expectedVersion`, from `list_budget_entries` or the `set_budget_entry` reply.",
    },
    {
      step: "A simple first month",
      tools: ["create_budget_plan", "get_budget_report"],
      how: '`rollover` is the browser\'s Carry what is left over. `targetAmount` and `targetDate` are Saving up for and Needed by, and a budget saving toward them needs `rollover` on and an `amount` of "0".',
    },
  ],
  "zero-based-budgeting": [
    {
      step: "Turn on carrying",
      tools: ["create_budget_plan", "update_budget_plan"],
      how: "Set `rollover` on the budget, which makes it an envelope.",
    },
    {
      step: "Watch what's left to assign",
      tools: ["get_budget_report"],
      how: "Each period's `toAssign` is left to assign, reported once any budget rolls over.",
    },
    {
      step: "Choose which accounts count",
      tools: ["list_accounts", "update_account"],
      how: "`inBudget` is The budget is about the money in this account: on for checking, savings spent from and cards, off for a retirement account or a mortgage.",
    },
    {
      step: "Move money between jobs",
      tools: ["set_budget_entry"],
      how: "Two `set_budget_entry` calls with the same `periodStart`, one lowering the category with money to spare and one raising the one that ran over.",
    },
    {
      step: "Set a limit on an envelope",
      tools: ["update_budget_plan"],
      how: "`rolloverCap` is Most to carry, and it caps the carry in both directions.",
    },
  ],
  "envelope-budgeting": [
    {
      step: "Make a budget carry over",
      tools: ["create_budget_plan", "update_budget_plan", "get_budget_report"],
      how: "Set `rollover` on the budget; `get_budget_report` then reports each row's `carriedIn`, `available` and `carriedOut`.",
    },
    {
      step: "Put a limit on an envelope",
      tools: ["update_budget_plan"],
      how: "`rolloverCap` is Most to carry, and it holds the carry inside one number in both directions.",
    },
    {
      step: "See what's left to put in envelopes",
      tools: ["get_budget_report"],
      how: "Each period's `toAssign`.",
    },
    {
      step: "Keep track of real cash",
      tools: ["create_account", "create_transaction"],
      how: "An account of `type` cash. Taking money out at an ATM is a transfer from checking to it, and spending it is a withdrawal from it with a category.",
    },
    {
      step: "Make cash quick to record",
      tools: ["create_transaction_template", "get_transaction_template", "create_transaction"],
      how: "`create_transaction_template` with the amount left out, so it is asked for each time. To use one, copy its `draft` into `create_transaction`, fill in the `amount` and the `date` it leaves out (today, unless the template carries one), and set `templateId` to the template's id.",
    },
  ],
  "sinking-funds": [
    {
      step: "Set the goal",
      tools: ["create_budget_plan"],
      how: '`targetAmount` is Saving up for and `targetDate` is Needed by, not `activeTo`. The budget needs `rollover` on and an `amount` of "0", because it works out its own.',
    },
    {
      step: "Let it work out the amount",
      tools: ["get_budget_report"],
      how: "Each period's worked-out figure is the row's `limit` in `get_budget_report`; the standing budget's own amount stays 0.",
    },
    {
      step: "Pay the bill from the same category",
      tools: ["create_transaction"],
      how: "A withdrawal in the fund's category, which the money it carried covers.",
    },
    {
      step: "Know where the money is",
      tools: ["get_budget_report", "update_account"],
      how: "`toAssign` is what is left after every fund and envelope. Keep `inBudget` on for a separate savings account holding the fund, so its money still counts.",
    },
    {
      step: "One fund for each bill",
      tools: ["create_budget_plan"],
      how: "One standing budget per category, each with its own `targetAmount` and `targetDate`.",
    },
  ],
  "budget-with-irregular-income": [
    {
      step: "Record income as it comes in",
      tools: ["create_transaction", "create_recurrence"],
      how: "Each payment is a deposit with an income category. A `create_recurrence` with no `amount` proposes a staged row on each payday to complete with the real figure; it never posts.",
    },
    {
      step: "Budget from last month's income",
      tools: ["create_budget_plan"],
      how: "`percentOfIncome` takes a share of what came in the period before.",
    },
    {
      step: "Decide what gets paid first",
      tools: ["create_budget_plan", "update_budget_plan", "get_budget_report"],
      how: "`priority`, lowest first. `get_budget_report` then reports on each row how much of its limit the period's income has `funded`.",
    },
    {
      step: "Let a budget follow your history",
      tools: ["create_budget_plan"],
      how: "`lookbackPeriods` budgets the average of what the last few periods spent.",
    },
    {
      step: "Look ahead",
      tools: ["get_forecast"],
      how: "`basis` recurring_and_history is what the browser's What happens next panel shows. Every figure is a projection and never a balance, so say projected.",
    },
  ],
  "balance-your-checking-account": [
    {
      step: "Bring in the statement",
      tools: [
        "preview_csv",
        "stage_csv",
        "list_staged_transactions",
        "get_staged_duplicate",
        "delete_staged_transactions",
        "commit_staged_transactions",
      ],
      how: "`stage_csv`, then `list_staged_transactions` with `validity` duplicate finds the flagged rows, and `get_staged_duplicate` shows each beside the entry it looks like. Drop the copy rather than the entry with `delete_staged_transactions`, which cannot be undone, so confirm it first; then `commit_staged_transactions` the rest. The page the guide calls Import CSV is Import and export now.",
    },
    {
      step: "Open the register",
      tools: ["get_account_register"],
      how: "`get_account_register` lists every posting in date order with the balance before and after it.",
    },
    {
      step: "Compare the closing balance",
      tools: ["get_account_register", "get_account_balances"],
      how: "The balance after the last row on or before the statement's closing date, or `get_account_balances` with `end` on that date.",
    },
    {
      step: "Find where it went wrong",
      tools: ["get_account_register"],
      how: "Read down the rows until the running balance stops matching the bank's; that row is the one to fix.",
    },
    {
      step: "Fix it and keep the history",
      tools: ["get_transaction", "update_transaction", "list_audit_events"],
      how: "`update_transaction` replaces the draft, so read it with `get_transaction` first. The correction is appended rather than written over, and `list_audit_events` lists it.",
    },
  ],
  "budget-with-a-credit-card": [
    {
      step: "Add the card as an account",
      tools: ["create_account"],
      how: '`type` credit_card with a negative `openingBalance`, such as "-500" for 500 owed, where the browser takes the plain number and Amount owed.',
    },
    {
      step: "Record purchases on the card",
      tools: ["create_transaction"],
      how: "A withdrawal with the card as `fromAccountId`, and a category.",
    },
    {
      step: "Record the payment as a transfer",
      tools: ["create_transaction", "create_recurrence"],
      how: "`type` transfer, `fromAccountId` checking and `toAccountId` the card, with the payment in `sourceAmount`. A `create_recurrence` between the same two accounts proposes it each month; it takes the figure as `amount`, or none for a payment that varies.",
    },
    {
      step: "Make interest easy to see",
      tools: ["create_category", "create_transaction"],
      how: "A withdrawal from the card in an expense category of its own, such as Interest and fees.",
    },
    {
      step: "How budgets count the card",
      tools: ["get_budget_report", "update_account"],
      how: "Cards are `inBudget` by default, so `toAssign` counts what is owed on them.",
    },
    {
      step: "Why two reports disagree",
      tools: ["get_report"],
      how: "`report` income-expense counts a purchase the day of the swipe and cash-flow the day the bill is paid; both are right.",
    },
    {
      step: "Find your statement balance",
      tools: ["get_account_register", "get_account_balances"],
      how: "The balance on the statement's closing date, from `get_account_register` or from `get_account_balances` with `end` on that date.",
    },
  ],
  "find-your-subscriptions": [
    {
      step: "Start with your payees",
      tools: ["list_payees", "list_transactions"],
      how: "`list_payees` gives each payee's transaction count, and `list_transactions` with `payee` lists every payment to one.",
    },
    {
      step: "Search for the rest",
      tools: ["list_transactions"],
      how: "`search` covers payee, description and notes; `sort` amount puts charges of the same size together.",
    },
    {
      step: "Put them in one category",
      tools: ["create_category", "bulk_edit_transactions", "get_report"],
      how: "`create_category`, then `bulk_edit_transactions` with `dryRun` first to move the rows. `get_report` with `report` categories shows what they cost together.",
    },
    {
      step: "Track the ones you keep",
      tools: ["create_recurrence", "whoami"],
      how: "One `create_recurrence` per subscription proposes a staged row when it is due. `notifyOnCreate` sends mail only where `whoami` reports `notificationsAvailable`.",
    },
    {
      step: "Get a reminder before a trial ends",
      tools: ["create_transaction_template", "whoami"],
      how: "A `create_transaction_template` whose `notification` has no `frequency` is one reminder on its `anchorDate`. It is mailed only where `whoami` reports `notificationsAvailable`.",
    },
  ],
  "net-worth": [
    {
      step: "Add every account",
      tools: ["create_account"],
      how: "One per account. A debt is `type` credit_card or loan with a negative `openingBalance`.",
    },
    {
      step: "Read the report",
      tools: ["get_report"],
      how: "`report` net-worth, with `bucket` month or quarter for the trend.",
    },
    {
      step: "More than one currency",
      tools: ["get_report"],
      how: "Each currency comes back on its own. Never add across them: this ledger holds no exchange rate.",
    },
    {
      step: "Things it can't put a price on",
      // Not `update_account`, though "the last value you entered" reads like an
      // edit: the only figure it changes is the opening balance, which is posted
      // on the opening date, so a new value there moves every month of the trend
      // this guide is about and leaves today's figure off by whatever has moved
      // since. A dated entry for the difference changes the trend from its own
      // day on. One income category for both directions, because a withdrawal
      // naming an income category reverses income (`resolveEntrySide`), so a fall
      // lowers the recorded gains rather than reading as spending.
      tools: ["create_account", "get_account", "create_transaction"],
      how: "An account of `type` investment or other_asset. Nothing here looks up a value: its `balance` is the last value entered, so say how current it is. A new value is a `create_transaction` for the difference from that `balance`, dated the day it was valued: a `deposit` for a rise or a `withdrawal` for a fall, both in one income category of its own (`categoryKind` income) so a fall reverses the gain rather than counting as spending. It reads as income in reports and budgets, so say so. Never change `openingBalance` for it, which is posted on the opening date and rewrites every month of the trend.",
    },
    {
      step: "Accounts you've closed",
      tools: ["archive_account"],
      how: "`archive_account` posts the balance out to equity, so the account stops counting toward totals and keeps its history. It moves money in the books, so confirm it first.",
    },
  ],
  "emergency-fund": [
    {
      step: "Find your monthly essentials",
      tools: ["get_report", "get_financial_summary"],
      how: "`get_report` with `report` income-expense and `bucket` month over the last three months, or `get_financial_summary` for spending by category to add the essential ones up.",
    },
    {
      step: "Give the fund its own account",
      tools: ["create_account"],
      how: "`type` savings, with `inBudget` false.",
    },
    {
      step: "Make the payday transfer repeat",
      tools: ["create_recurrence"],
      how: "A transfer from checking to the fund on payday. Each time it is due it stages a row to commit once the money has moved, and it never posts on its own.",
    },
    {
      step: "Watch it grow",
      tools: ["list_accounts", "get_report", "create_transaction"],
      how: "`list_accounts` for the balance and `get_report` net-worth for the trend. Using the fund is a transfer back to checking, then the spending in a category of its own.",
    },
  ],
};
