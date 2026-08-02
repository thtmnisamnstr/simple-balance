import { sql } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import { dateRangeSchema } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import { canonicalDecimal, decimal } from "./helpers.js";

type CurrencySummary = {
  currency: string;
  balance: string;
  deposits: string;
  withdrawals: string;
  netCashFlow: string;
  accounts: { id: string; name: string; type: string; balance: string }[];
  spendingByCategory: { categoryId: string | null; category: string; amount: string }[];
};

export async function getSummary(actor: Actor, input: unknown) {
  const range = dateRangeSchema.parse(input);
  const start = range.start ?? "0001-01-01";
  const end = range.end ?? "9999-12-31";
  const db = getDb();
  const accountResult = await db.execute(sql`
    select
      a.id,
      a.name,
      a.type,
      a.currency,
      coalesce(sum(p.amount), 0)::text as balance
    from ledger_account a
    left join posting p
      on p.user_id = a.user_id
      and p.account_id = a.id
      and p.date <= ${end}::date
    where a.user_id = ${actor.userId}
      and a.system_kind is null
      and a.archived_at is null
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
    group by p.currency, c.id, c.name
    having sum(p.amount) <> 0
    order by p.currency, sum(p.amount) desc
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
    currencies: [...currencies.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
  };
}
