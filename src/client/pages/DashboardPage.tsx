import { Link, useLocation } from "../router.js";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Landmark, Plus, Scale, TrendingUp } from "lucide-react";
import { useState } from "react";
import { groupAccountsByType } from "../../shared/domain.js";
import {
  api,
  queryString,
  type Account,
  type BudgetReport,
  type BudgetReportRow,
  type Category,
  type Summary,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  DateRangeBar,
  EmptyState,
  Modal,
  Note,
  PageHeader,
  Skeleton,
} from "../components.js";
import {
  compareMoney,
  formatDate,
  formatMoney,
  isNegativeMoney,
  largestMoney,
  moneyRatioPercent,
  moneyUnits,
} from "../money.js";
import { useDateRange } from "../date-range.js";
import {
  fillPercent,
  periodName,
  periodState,
  rowState,
  stateLabel,
  stateTone,
} from "../budget-display.js";
import { TransactionForm } from "../forms.js";

/** How many categories of one period the overview shows before deferring. */
const BUDGET_ROWS_SHOWN = 6;

/**
 * How much of a category's money is gone, for ordering alone.
 *
 * Unclamped on purpose, which is why `fillPercent` is not reused: that one
 * stops at a hundred so a bar cannot run off its panel, and stopping there
 * would tie every category that is over its limit with every category that has
 * spent exactly all of it — collapsing the ordering at the top, which is the
 * end that matters. Against `available` rather than the bare limit, for the
 * same reason the bar is: a category that carried money forward has more to
 * spend than its limit says.
 */
function consumed(row: BudgetReportRow) {
  const cap = moneyUnits(row.available ?? row.limit ?? "0");
  const spent = moneyUnits(row.actual);
  if (spent === null || spent <= 0n) return 0;
  // Spending against a limit of nothing is as over as it gets, and dividing by
  // it is the other kind of wrong.
  if (cap === null || cap <= 0n) return Number.MAX_SAFE_INTEGER;
  return Number((spent * 10_000n) / cap);
}

export default function DashboardPage() {
  const { start, end } = useDateRange();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const summary = useQuery({
    queryKey: ["summary", start, end],
    queryFn: () => api<Summary>(`/api/v1/summary?${queryString({ start, end })}`),
  });
  const accounts = useQuery({
    queryKey: ["accounts", end],
    queryFn: () => api<Account[]>(`/api/v1/accounts?${queryString({ end })}`),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/api/v1/categories"),
  });
  // The same report the budgets page reads, over the range this page is
  // showing. Keyed under "budgets" so setting one over there refreshes this.
  //
  // Some of what it carries is dropped here on purpose (§11.9), and `rows` is
  // no longer among them. "How is the budget going" turned out to be two
  // questions — how is it going, and where is it going wrong — and the second
  // needs the categories, so a reader had to leave the page to learn which
  // budget the period's red bar was about. The six with most of their money
  // gone are shown per period; `groups`, `carriedIn`, `toAssign`, `perimeter`
  // and `unfunded` are still the budgets page's subject, and the link in the
  // header is what reaches them. `otherPeriodUnits` is dropped for the same
  // reason: acting on it means changing the period unit, and that control
  // lives over there.
  const budgets = useQuery({
    queryKey: ["budgets", "report", start, end],
    queryFn: () => api<BudgetReport>(`/api/v1/budget-report?${queryString({ start, end })}`),
  });
  // A period with nothing budgeted in it is not a budget to report on, so a
  // ledger that has never set one gets no panel rather than a row of zeroes.
  const budgetPeriodsFor = (currency: string) =>
    (budgets.data?.periods ?? []).filter(
      (period) => period.currency === currency && compareMoney(period.budgeted, "0") > 0,
    );

  return (
    <>
      <PageHeader
        title="Overview"
        description="Where your money sits and how it moved."
        actions={
          <Button onClick={() => setOpen(true)} disabled={!accounts.data?.length}>
            <Plus size={16} /> Add transaction
          </Button>
        }
      />
      <DateRangeBar />

      {summary.error ? <Alert>{summary.error.message}</Alert> : null}
      {accounts.error ? <Alert>{accounts.error.message}</Alert> : null}

      {summary.isPending ? (
        <div className="currency-sections">
          <Skeleton height={160} label="Loading the overview…" />
          <Skeleton height={160} />
        </div>
      ) : summary.error ? null : !summary.data?.currencies.length ? (
        <EmptyState
          icon={<Landmark size={25} />}
          title="Create your first account"
          body="An account is where your money lives. Once one exists, deposits, withdrawals, and transfers show up here."
          action={
            <Link className="button button-primary" to="/accounts">
              Create an account
            </Link>
          }
        />
      ) : (
        <div className="currency-sections">
          {summary.data?.currencies.map((currency) => (
            <section className="currency-section" key={currency.currency}>
              <div className="currency-heading">
                <div>
                  <span className="currency-code">{currency.currency}</span>
                  <h2>{formatMoney(currency.balance, currency.currency)} total</h2>
                </div>
                <span className="subtle">
                  {currency.accounts.length} account{currency.accounts.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="metric-grid">
                <article className="metric-card metric-balance">
                  <span className="metric-icon">
                    <Scale size={18} />
                  </span>
                  <div>
                    <span>Balance</span>
                    <strong>{formatMoney(currency.balance, currency.currency)}</strong>
                  </div>
                </article>
                <article className="metric-card">
                  <span className="metric-icon positive">
                    <ArrowDownLeft size={18} />
                  </span>
                  <div>
                    <span>Deposits</span>
                    <strong>{formatMoney(currency.deposits, currency.currency)}</strong>
                  </div>
                </article>
                <article className="metric-card">
                  <span className="metric-icon negative">
                    <ArrowUpRight size={18} />
                  </span>
                  <div>
                    <span>Withdrawals</span>
                    <strong>{formatMoney(currency.withdrawals, currency.currency)}</strong>
                  </div>
                </article>
                <article className="metric-card">
                  <span className="metric-icon">
                    <TrendingUp size={18} />
                  </span>
                  <div>
                    <span>Net cash flow</span>
                    <strong
                      className={isNegativeMoney(currency.netCashFlow) ? "money-negative" : ""}
                    >
                      {formatMoney(currency.netCashFlow, currency.currency)}
                    </strong>
                  </div>
                </article>
              </div>
              <div className="dashboard-detail-grid">
                <article className="panel">
                  <header className="panel-header">
                    <h3>Accounts</h3>
                    <span>
                      {/* Through formatDate like every date below it: raw ISO
                          above formatted tables read as two different days. */}
                      As of {formatDate(summary.data?.asOf ?? end ?? "") || "today"}
                    </span>
                  </header>
                  <div>
                    {groupAccountsByType(currency.accounts).map((group) => (
                      <div className="account-mini-group" key={group.type}>
                        <h4 className="account-mini-heading">{group.label}</h4>
                        {group.accounts.map((account) => (
                          // The whole row, not just the name: the balance is
                          // what somebody is looking at when they decide to open
                          // an account. The date range travels with them, so the
                          // account page opens on the same period.
                          <Link
                            key={account.id}
                            className="account-mini-row"
                            to={{
                              pathname: `/accounts/${account.id}`,
                              search: location.search,
                            }}
                          >
                            <strong>{account.name}</strong>
                            <span
                              className={isNegativeMoney(account.balance) ? "money-negative" : ""}
                            >
                              {formatMoney(account.balance, currency.currency)}
                            </span>
                          </Link>
                        ))}
                      </div>
                    ))}
                  </div>
                </article>
                <article className="panel">
                  <header className="panel-header">
                    <h3>Spending by category</h3>
                    <span>Transfers excluded</span>
                  </header>
                  {currency.spendingByCategory.length ? (
                    <div>
                      {(() => {
                        // Uncategorised arrives last from the server and stays
                        // last here, but it is kept rather than cut: it is the
                        // one row that says there is filing left to do, and
                        // losing it at rank eight would hide that.
                        const named = currency.spendingByCategory.filter(
                          (item) => item.categoryId !== null,
                        );
                        const unnamed = currency.spendingByCategory.filter(
                          (item) => item.categoryId === null,
                        );
                        return [...named.slice(0, 7), ...unnamed];
                      })().map((item, _index, shown) => {
                        // Scaled against the largest row on show rather than
                        // the first. With uncategorised moved off the top the
                        // first row is no longer necessarily the biggest, and a
                        // ratio over one is clamped to a full bar, which would
                        // draw two different amounts the same width.
                        const widest = largestMoney(shown.map((entry) => entry.amount)) ?? "1";
                        const percent = moneyRatioPercent(item.amount, widest);
                        return (
                          <div key={item.categoryId ?? "uncategorized"} className="spending-row">
                            <div>
                              {/* Linked where there is something to link to.
                                  Uncategorised has no id — it is the absence of
                                  a category rather than one of them — and a
                                  link to /categories/null is a 404. The range
                                  travels, because the detail page mounts its
                                  own range bar and would otherwise open on a
                                  different month than the figure just read. */}
                              {item.categoryId ? (
                                <Link
                                  to={{
                                    pathname: `/categories/${item.categoryId}`,
                                    search: location.search,
                                  }}
                                >
                                  {item.category}
                                </Link>
                              ) : (
                                <span>{item.category}</span>
                              )}
                              <strong>{formatMoney(item.amount, currency.currency)}</strong>
                            </div>
                            <div className="progress-track">
                              <span style={{ width: `${percent}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="panel-empty">No withdrawals in this date range.</p>
                  )}
                </article>
              </div>

              {/* Where the budget stands over the range above, for this
                  currency. A row per period the report returns rather than one
                  folded total: the service is explicit that "a range chooses
                  which periods to show, it does not slice them", so adding two
                  months of limits together would be arithmetic nothing else in
                  the product does. Each row says which period it is, which also
                  answers the all-time case, where the range is empty and the
                  report falls back to the period today is in. */}
              {/* Always rendered, which it was not.
                  
                  The panel used to be gated on
                  `isError || isPending || periods.length`, while the empty
                  state inside it was gated on the exact complement
                  `!isError && !isPending && periods.length === 0` — so the
                  message could never appear and the whole panel vanished
                  instead. Somebody who budgets in another month, or in another
                  currency, met a page with no budget section and nothing
                  saying why, which reads as a feature that was never built.
                  Section 12.1: a list says which kind of empty it is. */}
              <section className="panel">
                <header className="panel-header">
                  <h3>Budget</h3>
                  <span>
                    <Link to={{ pathname: "/budgets", search: location.search }}>See budgets</Link>
                  </span>
                </header>
                {budgets.isError ? (
                  <Alert kind="error">
                    The budget figures could not be loaded, so this panel is empty for a reason that
                    is not the ledger. {(budgets.error as Error).message}
                  </Alert>
                ) : null}
                {budgets.isPending ? <Skeleton height={54} label="Loading budgets…" /> : null}
                {!budgets.isError &&
                !budgets.isPending &&
                budgetPeriodsFor(currency.currency).length === 0 ? (
                  <p className="panel-empty">Nothing budgeted in this range.</p>
                ) : null}
                {budgetPeriodsFor(currency.currency).map((period, index, all) => {
                  const state = periodState(period);
                  // Only the period the range ends in is broken down. A range
                  // of a year is twelve monthly periods, and six categories
                  // under each would put seventy-two rows on a page whose job
                  // is a glance — per currency. The newest is the one still
                  // worth acting on; the ones before it are settled, and the
                  // budgets page has them in full.
                  const expanded = index === all.length - 1;
                  // Only what has a budget. An unbudgeted category is spending
                  // this panel has nothing to say about — "Spending by
                  // category" above already reports it, and a row reading
                  // "£100 of —" is a budget nobody set.
                  const budgeted = expanded ? period.rows.filter((row) => row.limit !== null) : [];
                  // Most of the money gone first, so the cap can never be what
                  // hides the category in trouble. Ordering the report's own
                  // way and then taking the first six would do exactly that.
                  const ranked = [...budgeted].sort((a, b) => consumed(b) - consumed(a));
                  const shown = ranked.slice(0, BUDGET_ROWS_SHOWN);
                  const rest = ranked.slice(BUDGET_ROWS_SHOWN);
                  // Ranked truncation still selects for trouble, so the line
                  // that defers the rest says whether any of them is over
                  // rather than leaving a reader to trust the ordering.
                  const restOver = rest.filter((row) => rowState(row, period.partial) === "over");
                  return (
                    <div
                      className="budget-period-group"
                      key={`${period.periodStart}:${period.currency}`}
                    >
                      <div className="spending-row">
                        <div>
                          <span>
                            {periodName(budgets.data!.periodUnit, period.periodStart)}
                            {period.partial ? " (so far)" : ""}
                          </span>
                          <strong>
                            {formatMoney(period.spent, currency.currency)} of{" "}
                            {formatMoney(period.budgeted, currency.currency)}
                          </strong>
                        </div>
                        <div className="budget-progress">
                          <div
                            className="budget-bar"
                            data-state={state}
                            role="img"
                            aria-label={`${stateLabel[state]}, ${formatMoney(
                              period.spent,
                              currency.currency,
                            )} of ${formatMoney(period.budgeted, currency.currency)}`}
                          >
                            {/* Against `available`, not `budgeted`. `rowState`
                                decides the badge beside this from the same
                                figure, and a bar drawn against the bare limit
                                said "nearly there" beside a badge saying most
                                of the money was still there — a period that
                                carried something forward has more to spend than
                                its limit. */}
                            <span
                              style={{ width: `${fillPercent(period.available, period.spent)}%` }}
                            />
                          </div>
                          <Badge tone={stateTone[state]}>{stateLabel[state]}</Badge>
                        </div>
                      </div>
                      {shown.map((row) => {
                        // Each category judged by the same rule the budgets
                        // page uses, from `budget-display.ts`, so the two
                        // pages can never call one category over and fine.
                        const rowIs = rowState(row, period.partial);
                        // One denominator for the figure, the bar and the
                        // badge. `remaining` is `available` minus what was
                        // spent (`budgets.ts:1665`), so printing the bare
                        // limit beside a bar drawn against `available` made a
                        // category that carried money forward read "£245.00 of
                        // £200.00" next to a bar under half full.
                        const room = row.available ?? row.limit!;
                        const spent = formatMoney(row.actual, currency.currency);
                        const limit = formatMoney(room, currency.currency);
                        return (
                          <div className="spending-row budget-category-row" key={row.categoryId}>
                            <div>
                              {/* The range travels, so the category page opens
                                  on the month the figure was read in. */}
                              <Link
                                to={{
                                  pathname: `/categories/${row.categoryId}`,
                                  search: location.search,
                                }}
                              >
                                {row.category}
                              </Link>
                              <strong>
                                {spent} of {limit}
                              </strong>
                            </div>
                            <div className="budget-progress">
                              <div
                                className="budget-bar"
                                data-state={rowIs}
                                role="img"
                                aria-label={`${row.category}: ${stateLabel[rowIs]}, ${spent} of ${limit}`}
                              >
                                <span
                                  style={{
                                    width: `${fillPercent(room, row.actual)}%`,
                                  }}
                                />
                              </div>
                              <Badge tone={stateTone[rowIs]}>{stateLabel[rowIs]}</Badge>
                            </div>
                          </div>
                        );
                      })}
                      {rest.length > 0 ? (
                        <Note>
                          <Link to={{ pathname: "/budgets", search: location.search }}>
                            {`And ${rest.length} more ${
                              rest.length === 1 ? "category" : "categories"
                            }${restOver.length > 0 ? `, ${restOver.length} over budget` : ""}`}
                          </Link>
                        </Note>
                      ) : null}
                    </div>
                  );
                })}
                {/* The carry is folded at read time and the fold is bounded, so
                    a report that hit the bound has to say so — `AGENTS.md`
                    makes that an invariant, and every figure above counts a
                    carry. Only when it was actually clipped: the budgets page
                    names the date it folded from either way, because that page
                    is the subject; here it would be a sentence about method
                    under a panel somebody is glancing at. */}
                {budgets.data?.rollover?.clipped ? (
                  <Note>
                    Carried-in figures start from {formatDate(budgets.data.rollover.from)}, which is
                    as far back as this looks.
                  </Note>
                ) : null}
              </section>
            </section>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a transaction"
        description="Commit it now or stage it for review."
      >
        {/* Mounted only while the dialog is open, so closing it clears what was
            half typed instead of leaving it there for next time. */}
        {open ? (
          <>
            {/* Said rather than left blank. Both of these feed pickers, and a
                picker with nothing in it because a request failed looks exactly
                like a ledger with no accounts or no categories in it. */}
            {accounts.isError || categories.isError ? (
              <Alert kind="error">
                {accounts.isError ? "Accounts" : "Categories"} could not be loaded, so the picker
                below is short. Reload before entering anything.
              </Alert>
            ) : null}
            <TransactionForm
              accounts={accounts.data ?? []}
              categories={categories.data ?? []}
              onDone={() => setOpen(false)}
            />
          </>
        ) : null}
      </Modal>
    </>
  );
}
