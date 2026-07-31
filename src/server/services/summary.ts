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
      (
        case when a.opening_date <= ${end}::date then a.opening_balance else 0 end
        + coalesce(sum(case
            when t.deleted_at is null and t.date <= ${end}::date then p.amount
            else 0
          end), 0)
      )::text as balance
    from ledger_account a
    left join posting p on p.account_id = a.id
    left join ledger_transaction t on t.id = p.transaction_id
    where a.user_id = ${actor.userId}
      and a.archived_at is null
    group by a.id
    order by a.currency, lower(a.name)
  `);
  const flowResult = await db.execute(sql`
    select
      coalesce(destination_currency, source_currency) as currency,
      coalesce(sum(case when type = 'deposit' then destination_amount else 0 end), 0)::text as deposits,
      coalesce(sum(case when type = 'withdrawal' then source_amount else 0 end), 0)::text as withdrawals
    from ledger_transaction
    where user_id = ${actor.userId}
      and deleted_at is null
      and date between ${start}::date and ${end}::date
      and type in ('deposit', 'withdrawal')
    group by coalesce(destination_currency, source_currency)
  `);
  const categoryResult = await db.execute(sql`
    select
      t.source_currency as currency,
      c.id as category_id,
      coalesce(c.name, 'Uncategorized') as category,
      sum(t.source_amount)::text as amount
    from ledger_transaction t
    left join category c on c.id = t.category_id
    where t.user_id = ${actor.userId}
      and t.deleted_at is null
      and t.type = 'withdrawal'
      and t.date between ${start}::date and ${end}::date
    group by t.source_currency, c.id, c.name
    order by t.source_currency, sum(t.source_amount) desc
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
