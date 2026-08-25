import { sql, type SQL } from "drizzle-orm";
import type { ReportBucket } from "../../shared/domain.js";

/**
 * Entries that still run through an archived account.
 *
 * Membership is decided by what the postings on an archived account still sum
 * to, never by whether a row is present. A correction that moved an entry on to
 * a live account leaves its old postings behind netting to zero, and matching
 * those drops the entry from the figures for good.
 */
export function archivedEntriesCte(userId: string): SQL {
  return sql`
    archived_entries as (
      select transaction_id
      from (
        select sibling.transaction_id, sibling.account_id
        from posting sibling
        join ledger_account side
          on side.user_id = sibling.user_id
          and side.id = sibling.account_id
        where sibling.user_id = ${userId}
          and sibling.transaction_id is not null
          and side.system_kind is null
          and side.archived_at is not null
        group by 1, 2
        having sum(sibling.amount) <> 0
      ) touched
      group by transaction_id
    )
  `;
}

/**
 * The exclusion as three fragments that only make sense together: the filter
 * without the join is a reference to a table that is not in the query, and the
 * join without the cte is a reference to one that does not exist. The driving
 * postings must be aliased `p`.
 */
export function archivedExclusion(userId: string, includeArchived: boolean) {
  if (includeArchived) {
    return { cte: null, join: sql.empty(), filter: sql.empty() };
  }
  return {
    cte: archivedEntriesCte(userId),
    join: sql`left join archived_entries ae on ae.transaction_id = p.transaction_id`,
    filter: sql`and ae.transaction_id is null`,
  };
}

export function withClause(...parts: (SQL | null)[]): SQL {
  const present = parts.filter((part): part is SQL => part !== null);
  if (present.length === 0) return sql.empty();
  return sql`with ${sql.join(present, sql`, `)}`;
}

/**
 * How long one bucket lasts, and what PostgreSQL calls it.
 *
 * Here rather than in `reports.ts` because budgeting needs the same grid. A
 * limit and the spending it is compared against have to be bucketed by one
 * expression, and two copies of `date_trunc` are two chances to disagree about
 * which month a purchase fell in.
 */
export const PERIOD_STEPS: Record<Exclude<ReportBucket, "none">, SQL> = {
  week: sql`interval '1 week'`,
  month: sql`interval '1 month'`,
  quarter: sql`interval '3 months'`,
  year: sql`interval '1 year'`,
};

export const PERIOD_UNITS: Record<Exclude<ReportBucket, "none">, SQL> = {
  week: sql`'week'`,
  month: sql`'month'`,
  quarter: sql`'quarter'`,
  year: sql`'year'`,
};

export function gridQuery(bucket: ReportBucket, start: string, asOf: string): SQL {
  if (bucket === "none") {
    return sql`select ${start}::date as bucket_start, ${asOf}::date as period_end`;
  }
  return sql`
    select
      b.bucket::date as bucket_start,
      (b.bucket + ${PERIOD_STEPS[bucket]} - interval '1 day')::date as period_end
    from generate_series(
      date_trunc(${PERIOD_UNITS[bucket]}, ${start}::date),
      date_trunc(${PERIOD_UNITS[bucket]}, ${asOf}::date),
      ${PERIOD_STEPS[bucket]}
    ) as b(bucket)
  `;
}
