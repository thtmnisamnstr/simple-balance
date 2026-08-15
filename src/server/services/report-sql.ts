import { sql, type SQL } from "drizzle-orm";

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
