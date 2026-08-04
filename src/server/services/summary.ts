import { sql } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import { dateRangeSchema } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import { canonicalDecimal, decimal } from "./helpers.js";
import { getPreferences } from "./preferences.js";

/** The calendar date it is where this person lives, not where the server runs. */
function todayIn(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

type CurrencySummary = {
  currency: string;
  balance: string;
  deposits: string;
  withdrawals: string;
  netCashFlow: string;
  accounts: {
    id: string;
    name: string;
    type: string;
    balance: string;
    archivedAt: string | null;
  }[];
  spendingByCategory: { categoryId: string | null; category: string; amount: string }[];
};

export async function getSummary(
  actor: Actor,
  input: unknown,
  includeArchived = false,
) {
  const range = dateRangeSchema.parse(input);
  const start = range.start ?? "0001-01-01";
  const db = getDb();
  const { timezone } = await getPreferences(actor);
  const today = todayIn(timezone);
  // An open-ended range meant 9999-12-31, so a transaction dated next month
  // counted toward a balance the page called "as of today" and toward the cash
  // flow beside it. Money dated in the future has not moved yet, so the whole
  // summary stops at today unless a narrower end was asked for. The date it
  // actually used is returned, so nothing has to guess what it is showing.
  const requestedEnd = range.end ?? "9999-12-31";
  const end = requestedEnd < today ? requestedEnd : today;
  const accountResult = await db.execute(sql`
    select
      a.id,
      a.name,
      a.type,
      a.currency,
      a.archived_at,
      coalesce(sum(p.amount), 0)::text as balance
    from ledger_account a
    left join posting p
      on p.user_id = a.user_id
      and p.account_id = a.id
      and p.date <= ${end}::date
    where a.user_id = ${actor.userId}
      and a.system_kind is null
      and (${includeArchived} or a.archived_at is null)
    group by a.id
    order by a.currency, lower(a.name)
  `);
  // The income and expense accounts are the income statement. Reading the flow
  // off them rather than off the transaction rows means a corrected entry is
  // reflected here for the same reason it is reflected in a balance.
  const flowResult = await db.execute(sql`
    select
      p.currency,
      coalesce(-sum(p.amount) filter (where a.system_kind = 'income'), 0)::text as deposits,
      coalesce(sum(p.amount) filter (where a.system_kind = 'expense'), 0)::text as withdrawals
    from posting p
    join ledger_account a
      on a.user_id = p.user_id
      and a.id = p.account_id
    where p.user_id = ${actor.userId}
      and a.system_kind in ('income', 'expense')
      and p.date between ${start}::date and ${end}::date
      and (${includeArchived} or not exists (
        -- Whether this entry still runs through an archived account, by net
        -- rather than by the presence of a row. A correction that moved it on
        -- to a live account leaves its old postings behind netting to zero,
        -- and matching those dropped the entry from the figures for good.
        select 1
        from posting sibling
        join ledger_account side
          on side.user_id = sibling.user_id
          and side.id = sibling.account_id
        where sibling.user_id = p.user_id
          and sibling.transaction_id = p.transaction_id
          and side.system_kind is null
          and side.archived_at is not null
        group by sibling.account_id
        having sum(sibling.amount) <> 0
      ))
    group by p.currency
  `);
  // The amount is the posting's; the transaction is joined only for the label
  // it was filed under. Recategorising therefore updates past reports, and a
  // voided entry drops out because its postings already net to nothing.
  const categoryResult = await db.execute(sql`
    select
      p.currency,
      c.id as category_id,
      coalesce(c.name, 'Uncategorized') as category,
      sum(p.amount)::text as amount
    from posting p
    join ledger_account a
      on a.user_id = p.user_id
      and a.id = p.account_id
      and a.system_kind = 'expense'
    left join ledger_transaction t
      on t.user_id = p.user_id
      and t.id = p.transaction_id
    left join category c
      on c.user_id = p.user_id
      and c.id = t.category_id
    where p.user_id = ${actor.userId}
      and p.date between ${start}::date and ${end}::date
      and (${includeArchived} or not exists (
        -- Whether this entry still runs through an archived account, by net
        -- rather than by the presence of a row. A correction that moved it on
        -- to a live account leaves its old postings behind netting to zero,
        -- and matching those dropped the entry from the figures for good.
        select 1
        from posting sibling
        join ledger_account side
          on side.user_id = sibling.user_id
          and side.id = sibling.account_id
        where sibling.user_id = p.user_id
          and sibling.transaction_id = p.transaction_id
          and side.system_kind is null
          and side.archived_at is not null
        group by sibling.account_id
        having sum(sibling.amount) <> 0
      ))
    group by p.currency, c.id, c.name
    having sum(p.amount) <> 0
    -- Uncategorised last, whatever it totals. It is not a category somebody
    -- chose, so ranking it against the ones they did puts "work still to do" at
    -- the top of a list meant to answer where the money went. Sorted here
    -- rather than in the page, so an agent reading the summary sees the same
    -- order.
    order by p.currency, (c.id is null), sum(p.amount) desc
  `);

  const currencies = new Map<string, CurrencySummary>();
  const ensure = (currency: string) => {
    if (!currencies.has(currency)) {
      currencies.set(currency, {
        currency,
        balance: "0",
        deposits: "0",
        withdrawals: "0",
        netCashFlow: "0",
        accounts: [],
        spendingByCategory: [],
      });
    }
    return currencies.get(currency)!;
  };
  for (const row of accountResult.rows) {
    const summary = ensure(String(row.currency));
    const balance = canonicalDecimal(String(row.balance));
    summary.accounts.push({
      id: String(row.id),
      name: String(row.name),
      type: String(row.type),
      balance,
      archivedAt: row.archived_at ? new Date(String(row.archived_at)).toISOString() : null,
    });
    summary.balance = canonicalDecimal(decimal(summary.balance).plus(balance));
  }
  for (const row of flowResult.rows) {
    const summary = ensure(String(row.currency));
    summary.deposits = canonicalDecimal(String(row.deposits));
    summary.withdrawals = canonicalDecimal(String(row.withdrawals));
    summary.netCashFlow = canonicalDecimal(
      decimal(summary.deposits).minus(summary.withdrawals),
    );
  }
  for (const row of categoryResult.rows) {
    ensure(String(row.currency)).spendingByCategory.push({
      categoryId: row.category_id ? String(row.category_id) : null,
      category: String(row.category),
      amount: canonicalDecimal(String(row.amount)),
    });
  }

  return {
    range: { start: range.start ?? null, end: range.end ?? null },
    // What the figures are actually as of, which is not the requested end when
    // that end is in the future.
    asOf: end,
    includesArchived: includeArchived,
    currencies: [...currencies.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
  };
}
