import { sql, type SQL } from "drizzle-orm";
import type {
  Actor,
  ReportAccumulation,
  ReportBucket,
  ReportName,
} from "../../shared/domain.js";
import {
  MAX_REGISTER_ENTRIES,
  MAX_REPORT_BUCKETS,
  cashAccountTypes,
  dateRangeSchema,
  reportQuerySchema,
} from "../../shared/domain.js";
import { todayIn } from "../../shared/recurrence-dates.js";
import { getDb } from "../db/client.js";
import { notFound, validationError } from "./errors.js";
import { canonicalDecimal, decimal } from "./helpers.js";
import { getPreferences } from "./preferences.js";
import { archivedExclusion, withClause } from "./report-sql.js";

type ReportRow = {
  key: string;
  label: string;
  kind: string | null;
  values: string[];
  total: string;
};

type CurrencyReport = {
  currency: string;
  rows: ReportRow[];
  totals: string[];
};

type Bucket = { start: string; end: string };

/**
 * A column keeps the period start it is keyed on as well as the edges it is
 * reported with. A range opening mid-period reports the day it was asked for,
 * while the postings inside it are still grouped under `date_trunc`, so the two
 * have to be carried separately or every cell in the first column is dropped
 * for failing to match its own bucket.
 */
type BucketWindow = Bucket & { periodStart: string };

type Cell = {
  bucketStart: string;
  currency: string;
  key: string;
  label: string;
  kind: string | null;
  value: string;
};

const PRESETS: Record<
  ReportName,
  { accumulation: ReportAccumulation; defaultBucket: ReportBucket }
> = {
  "net-worth": { accumulation: "historical", defaultBucket: "month" },
  "income-expense": { accumulation: "change", defaultBucket: "month" },
  categories: { accumulation: "change", defaultBucket: "none" },
  "cash-flow": { accumulation: "change", defaultBucket: "month" },
  "balance-sheet": { accumulation: "historical", defaultBucket: "none" },
  "trial-balance": { accumulation: "historical", defaultBucket: "none" },
};

const STEPS: Record<Exclude<ReportBucket, "none">, SQL> = {
  week: sql`interval '1 week'`,
  month: sql`interval '1 month'`,
  quarter: sql`interval '3 months'`,
  year: sql`interval '1 year'`,
};

const UNITS: Record<Exclude<ReportBucket, "none">, SQL> = {
  week: sql`'week'`,
  month: sql`'month'`,
  quarter: sql`'quarter'`,
  year: sql`'year'`,
};

const SEGMENT_LABELS: Record<string, string> = {
  operating: "Earning and spending",
  investing: "Investing",
  financing: "Borrowing and repaying",
  internal: "Between your own accounts",
  exchange: "Currency exchange",
  opening: "Opening balances",
  other: "Other",
};

const ZERO = "0";

const cashTypeList = () =>
  sql.join(
    cashAccountTypes.map((type) => sql`${type}`),
    sql`, `,
  );

/**
 * A posting's bucket, or null when it falls before the window.
 *
 * Collapsing everything earlier into one null-keyed group is what lets the
 * opening balance and the in-window movement come out of a single pass over the
 * postings rather than two.
 */
function bucketExpression(
  bucket: ReportBucket,
  start: string,
  alias: string,
): SQL {
  const column = sql.raw(`${alias}.date`);
  if (bucket === "none") {
    return sql`case when ${column} < ${start}::date then null else ${start}::date end`;
  }
  return sql`case when ${column} < ${start}::date then null else date_trunc(${UNITS[bucket]}, ${column})::date end`;
}

function gridQuery(bucket: ReportBucket, start: string, asOf: string): SQL {
  if (bucket === "none") {
    return sql`select ${start}::date as bucket_start, ${asOf}::date as period_end`;
  }
  return sql`
    select
      b.bucket::date as bucket_start,
      (b.bucket + ${STEPS[bucket]} - interval '1 day')::date as period_end
    from generate_series(
      date_trunc(${UNITS[bucket]}, ${start}::date),
      date_trunc(${UNITS[bucket]}, ${asOf}::date),
      ${STEPS[bucket]}
    ) as b(bucket)
  `;
}

/**
 * The window's own edges win over the period's. A quarterly report starting in
 * August opens on the 16th rather than on July 1st, so a partial period reads
 * as the part of it that was asked for instead of as a full quarter that fell.
 */
function clip(
  rows: { bucket_start: unknown; period_end: unknown }[],
  start: string,
  asOf: string,
): BucketWindow[] {
  return rows.map((row) => {
    const periodStart = String(row.bucket_start);
    const periodEnd = String(row.period_end);
    return {
      periodStart,
      start: periodStart < start ? start : periodStart,
      end: periodEnd > asOf ? asOf : periodEnd,
    };
  });
}

async function earliestPostingDate(userId: string, fallback: string) {
  const result = await getDb().execute(sql`
    select min(p.date)::text as first from posting p where p.user_id = ${userId}
  `);
  const first = result.rows[0]?.first;
  return first ? String(first) : fallback;
}

function accountClass(report: ReportName): SQL {
  if (report === "trial-balance") return sql``;
  if (report === "cash-flow") {
    return sql`and a.system_kind is null and a.type in (${cashTypeList()})`;
  }
  return sql`and a.system_kind is null`;
}

export async function getReport(
  actor: Actor,
  input: unknown,
  includeArchived = false,
) {
  const query = reportQuerySchema.parse(input);
  if (query.start && query.end && query.start > query.end) {
    throw validationError("Start date must be on or before end date");
  }

  const preset = PRESETS[query.report];
  const bucket = query.bucket ?? preset.defaultBucket;
  const { timezone } = await getPreferences(actor);
  const today = todayIn(timezone);
  const requestedEnd = query.end ?? "9999-12-31";
  const asOf = requestedEnd < today ? requestedEnd : today;

  // An unbounded start is the beginning of this ledger, not the beginning of
  // the calendar. Left at 0001-01-01 a monthly series would run to twenty-four
  // thousand columns before reaching anything anybody posted.
  const start = query.start ?? (await earliestPostingDate(actor.userId, asOf));
  const windowStart = start > asOf ? asOf : start;

  const gridRows = await getDb().execute(gridQuery(bucket, windowStart, asOf));
  if (gridRows.rows.length > MAX_REPORT_BUCKETS) {
    throw validationError(
      `That range needs ${gridRows.rows.length} ${bucket} columns, and ${MAX_REPORT_BUCKETS} is the most a report will draw. Ask for a coarser bucket or a shorter range.`,
    );
  }
  const buckets = clip(
    gridRows.rows as { bucket_start: unknown; period_end: unknown }[],
    windowStart,
    asOf,
  );

  const currencies =
    query.report === "cash-flow"
      ? assemble(
          await cashFlowCells(actor, bucket, windowStart, asOf, includeArchived),
          buckets,
        )
      : preset.accumulation === "historical"
        ? assemble(
            await balanceCells(
              actor,
              query.report,
              bucket,
              windowStart,
              asOf,
              includeArchived,
            ),
            buckets,
          )
        : assemble(
            await flowCells(
              actor,
              query.report,
              bucket,
              windowStart,
              asOf,
              includeArchived,
            ),
            buckets,
          );

  return {
    report: query.report,
    range: { start: query.start ?? null, end: query.end ?? null },
    asOf,
    bucket,
    accumulation: preset.accumulation,
    includesArchived: includeArchived,
    buckets: buckets.map(({ start: from, end }) => ({ start: from, end })),
    currencies,
  };
}

/**
 * Balances at the end of each bucket, accumulated with a window function over a
 * single pass of the postings.
 *
 * Asking the database for a balance as of each bucket's end instead costs one
 * correlated aggregate per column, which on five years of monthly buckets is
 * fifty times slower and gets worse as the series lengthens.
 */
async function balanceCells(
  actor: Actor,
  report: ReportName,
  bucket: ReportBucket,
  start: string,
  asOf: string,
  includeArchived: boolean,
): Promise<Cell[]> {
  const result = await getDb().execute(sql`
    with accounts as (
      select a.id, a.name, a.type::text as type, a.currency, a.system_kind
      from ledger_account a
      where a.user_id = ${actor.userId}
        ${accountClass(report)}
        and (${includeArchived} or a.archived_at is null)
    ),
    changes as (
      select
        ${bucketExpression(bucket, start, "p")} as bucket,
        p.account_id,
        sum(p.amount) as amount
      from posting p
      join accounts acc on acc.id = p.account_id
      where p.user_id = ${actor.userId}
        and p.date <= ${asOf}::date
      group by 1, 2
    ),
    grid as (${gridQuery(bucket, start, asOf)})
    select
      g.bucket_start,
      acc.id,
      acc.name,
      acc.type,
      acc.currency,
      acc.system_kind::text as system_kind,
      (coalesce(o.amount, 0) + sum(coalesce(ch.amount, 0)) over (
        partition by acc.id order by g.bucket_start
        rows between unbounded preceding and current row
      ))::text as value
    from grid g
    cross join accounts acc
    left join changes ch on ch.bucket = g.bucket_start and ch.account_id = acc.id
    left join changes o on o.bucket is null and o.account_id = acc.id
    order by acc.currency, lower(acc.name), g.bucket_start
  `);

  return result.rows.map((row) => ({
    bucketStart: String(row.bucket_start),
    currency: String(row.currency),
    key: String(row.id),
    label: String(row.name),
    kind: row.system_kind ? `system:${String(row.system_kind)}` : String(row.type),
    value: String(row.value),
  }));
}

async function flowCells(
  actor: Actor,
  report: ReportName,
  bucket: ReportBucket,
  start: string,
  asOf: string,
  includeArchived: boolean,
): Promise<Cell[]> {
  const archived = archivedExclusion(actor.userId, includeArchived);
  const byCategory = report === "categories";

  // An income statement is signed, so its column total is a net: income
  // postings are stored negative and expense postings positive, and negating
  // both puts what came in above the line and what went out below it. The
  // category report is a breakdown rather than a statement, so it reports
  // magnitudes and agrees with the spending figures on the dashboard.
  const signed = byCategory
    ? sql`(case when a.system_kind = 'income' then -sum(p.amount) else sum(p.amount) end)`
    : sql`(-sum(p.amount))`;

  const result = await getDb().execute(sql`
    ${withClause(archived.cte)}
    select
      ${bucketExpression(bucket, start, "p")} as bucket,
      p.currency,
      a.system_kind::text as kind,
      ${byCategory ? sql`c.id as category_id, coalesce(c.name, 'Uncategorized') as label,` : sql``}
      ${signed}::text as value
    from posting p
    join ledger_account a
      on a.user_id = p.user_id
      and a.id = p.account_id
      and a.system_kind in ('income', 'expense')
    ${
      byCategory
        ? sql`
    left join transaction_leg l
      on l.user_id = p.user_id
      and l.id = p.leg_id
    left join ledger_transaction t
      on p.leg_id is null
      and t.user_id = p.user_id
      and t.id = p.transaction_id
    left join category c
      on c.user_id = p.user_id
      -- A case rather than a coalesce: a leg with no category is a share the
      -- person left unfiled on purpose, and coalesce would quietly fall
      -- through to the transaction's own label instead of honouring it.
      and c.id = case
        when p.leg_id is not null then l.category_id
        else t.category_id
      end`
        : sql``
    }
    ${archived.join}
    where p.user_id = ${actor.userId}
      and p.date between ${start}::date and ${asOf}::date
      ${archived.filter}
    group by 1, p.currency, a.system_kind${byCategory ? sql`, c.id, c.name` : sql``}
    having sum(p.amount) <> 0
    order by p.currency, 1
  `);

  return result.rows.map((row) => {
    const kind = String(row.kind);
    const categoryId = byCategory && row.category_id ? String(row.category_id) : null;
    return {
      bucketStart: String(row.bucket),
      currency: String(row.currency),
      key: byCategory ? `${kind}:${categoryId ?? "uncategorized"}` : kind,
      label: byCategory
        ? String(row.label)
        : kind === "income"
          ? "Income"
          : "Expenses",
      kind,
      value: String(row.value),
    };
  });
}

/**
 * Where the money in the spendable accounts came from and went to, by the class
 * of the account on the far side of each transaction.
 *
 * `sides` reduces a transaction to its distinct accounts per currency, so a
 * receipt split three ways presents one counter-account rather than three rows
 * that would treble the cash side. Matching on currency is what makes a
 * conversion resolve to the exchange account in the moving side's own currency
 * instead of to all three of its other legs.
 *
 * Closing postings are left out because archiving is not a payment: counted as
 * movement, closing an account would report its whole balance as money spent on
 * the day it was closed.
 */
async function cashFlowCells(
  actor: Actor,
  bucket: ReportBucket,
  start: string,
  asOf: string,
  includeArchived: boolean,
): Promise<Cell[]> {
  const result = await getDb().execute(sql`
    with cash as (
      select a.id
      from ledger_account a
      where a.user_id = ${actor.userId}
        and a.system_kind is null
        and a.type in (${cashTypeList()})
        and (${includeArchived} or a.archived_at is null)
    ),
    sides as (
      select p.transaction_id, p.currency, p.account_id, a.system_kind, a.type
      from posting p
      join ledger_account a on a.user_id = p.user_id and a.id = p.account_id
      where p.user_id = ${actor.userId}
        and p.transaction_id is not null
      group by 1, 2, 3, a.system_kind, a.type
    ),
    moves as (
      select
        p.transaction_id,
        p.opening_account_id,
        p.date,
        p.currency,
        p.account_id,
        p.amount
      from posting p
      join cash on cash.id = p.account_id
      where p.user_id = ${actor.userId}
        and p.closing_account_id is null
        and p.date between ${start}::date and ${asOf}::date
    )
    select
      ${bucketExpression(bucket, start, "m")} as bucket,
      m.currency,
      case
        -- The equity half of an opening pair is joined by the account it opens
        -- rather than by a transaction, so it has no counterpart to look up.
        when m.opening_account_id is not null then 'opening'
        when s.system_kind in ('income', 'expense') then 'operating'
        when s.system_kind = 'exchange' then 'exchange'
        when s.system_kind = 'equity' then 'opening'
        when s.type in ('investment', 'crypto_wallet', 'other_asset') then 'investing'
        when s.type in ('loan', 'credit_card', 'other_liability') then 'financing'
        when s.type in (${cashTypeList()}) then 'internal'
        else 'other'
      end as segment,
      sum(m.amount)::text as value
    from moves m
    left join sides s
      on s.transaction_id = m.transaction_id
      and s.currency = m.currency
      and s.account_id <> m.account_id
    group by 1, 2, 3
    order by m.currency, 1
  `);

  return result.rows.map((row) => ({
    bucketStart: String(row.bucket),
    currency: String(row.currency),
    key: String(row.segment),
    label: SEGMENT_LABELS[String(row.segment)] ?? String(row.segment),
    kind: String(row.segment),
    value: String(row.value),
  }));
}

/**
 * One account's postings with the balance before and after each of them.
 *
 * The running total is ordered by `(date, id)` rather than by date alone: two
 * postings on one day would otherwise take whichever order the scan produced,
 * and the balance printed beside each of them would change between two calls
 * that returned the same rows.
 *
 * Closing postings stay in. They are what an archived account's register ends
 * on, and leaving them out would show it still holding money it has already
 * posted out to equity.
 */
export async function getAccountRegister(
  actor: Actor,
  id: string,
  input: unknown,
) {
  const range = dateRangeSchema.parse(input);
  if (range.start && range.end && range.start > range.end) {
    throw validationError("Start date must be on or before end date");
  }

  const { timezone } = await getPreferences(actor);
  const today = todayIn(timezone);
  const requestedEnd = range.end ?? "9999-12-31";
  const asOf = requestedEnd < today ? requestedEnd : today;
  const hasStart = Boolean(range.start);
  const start = range.start ?? "0001-01-01";

  const account = await getDb().execute(sql`
    select a.id, a.name, a.type::text as type, a.currency, a.archived_at
    from ledger_account a
    where a.id = ${id}::uuid
      and a.user_id = ${actor.userId}
      and a.system_kind is null
  `);
  const details = account.rows[0];
  if (!details) throw notFound("Account not found");

  const opening = await getDb().execute(sql`
    select coalesce(sum(p.amount) filter (
      where ${hasStart} and p.date < ${start}::date
    ), 0)::text as opening
    from posting p
    where p.user_id = ${actor.userId}
      and p.account_id = ${id}::uuid
  `);
  const openingBalance = canonicalDecimal(String(opening.rows[0]?.opening ?? ZERO));

  const counted = await getDb().execute(sql`
    select count(*)::int as entries
    from posting p
    where p.user_id = ${actor.userId}
      and p.account_id = ${id}::uuid
      and p.date <= ${asOf}::date
      and (${!hasStart} or p.date >= ${start}::date)
  `);
  const total = Number(counted.rows[0]?.entries ?? 0);
  if (total > MAX_REGISTER_ENTRIES) {
    throw validationError(
      `That range holds ${total} postings, and ${MAX_REGISTER_ENTRIES} is the most a register will list. Ask for a shorter range.`,
    );
  }

  const entries = await getDb().execute(sql`
    select
      p.id,
      p.date::text as date,
      p.transaction_id,
      p.opening_account_id,
      p.closing_account_id,
      p.amount::text as amount,
      (sum(p.amount) over (
        order by p.date, p.id
        rows between unbounded preceding and current row
      ))::text as running
    from posting p
    where p.user_id = ${actor.userId}
      and p.account_id = ${id}::uuid
      and p.date <= ${asOf}::date
      and (${!hasStart} or p.date >= ${start}::date)
    order by p.date, p.id
  `);

  const rows = entries.rows.map((row) => {
    const after = canonicalDecimal(
      decimal(openingBalance).plus(String(row.running)),
    );
    const amount = canonicalDecimal(String(row.amount));
    return {
      postingId: String(row.id),
      transactionId: row.transaction_id ? String(row.transaction_id) : null,
      date: String(row.date),
      amount,
      balanceBefore: canonicalDecimal(decimal(after).minus(amount)),
      balanceAfter: after,
      origin: row.opening_account_id
        ? "opening"
        : row.closing_account_id
          ? "closing"
          : "transaction",
    };
  });

  return {
    accountId: String(details.id),
    accountName: String(details.name),
    type: String(details.type),
    currency: String(details.currency),
    archivedAt: details.archived_at
      ? new Date(String(details.archived_at)).toISOString()
      : null,
    range: { start: range.start ?? null, end: range.end ?? null },
    asOf,
    openingBalance,
    closingBalance: rows.length
      ? rows[rows.length - 1]!.balanceAfter
      : openingBalance,
    entries: rows,
  };
}

/**
 * Cells into a dense matrix. A bucket a row has no cell for is a zero rather
 * than a gap, so a quiet month keeps its column and the series does not
 * silently compress time.
 */
function assemble(cells: Cell[], buckets: BucketWindow[]): CurrencyReport[] {
  const index = new Map(
    buckets.map((bucket, position) => [bucket.periodStart, position]),
  );
  const byCurrency = new Map<string, Map<string, ReportRow>>();

  for (const cell of cells) {
    const position = index.get(cell.bucketStart);
    if (position === undefined) continue;
    if (!byCurrency.has(cell.currency)) byCurrency.set(cell.currency, new Map());
    const rows = byCurrency.get(cell.currency)!;
    if (!rows.has(cell.key)) {
      rows.set(cell.key, {
        key: cell.key,
        label: cell.label,
        kind: cell.kind,
        values: buckets.map(() => ZERO),
        total: ZERO,
      });
    }
    const row = rows.get(cell.key)!;
    row.values[position] = canonicalDecimal(
      decimal(row.values[position] ?? ZERO).plus(cell.value),
    );
  }

  return [...byCurrency.entries()]
    .map(([currency, rows]) => {
      const list = [...rows.values()].map((row) => ({
        ...row,
        total: canonicalDecimal(
          row.values.reduce((sum, value) => sum.plus(value), decimal(ZERO)),
        ),
      }));
      const totals = buckets.map((_, position) =>
        canonicalDecimal(
          list.reduce(
            (sum, row) => sum.plus(row.values[position] ?? ZERO),
            decimal(ZERO),
          ),
        ),
      );
      return { currency, rows: list, totals };
    })
    .sort((left, right) => left.currency.localeCompare(right.currency));
}
