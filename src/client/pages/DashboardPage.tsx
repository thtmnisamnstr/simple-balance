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
} from "../money.js";
import { useDateRange } from "../date-range.js";
import { fillPercent, periodName, periodState, stateLabel, stateTone } from "../budget-display.js";
import { TransactionForm } from "../forms.js";

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
  // Most of what it carries is dropped here on purpose (§11.9). A period's
  // `rows`, `groups`, `carriedIn`, `toAssign`, `perimeter` and `unfunded` are
  // the budgets page's subject; this panel answers one question — how is the
  // budget going — and a reader who wants the breakdown follows the link in its
  // header. `otherPeriodUnits` is dropped for the same reason: acting on it
  // means changing the period unit, and that control lives over there.
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
        eyebrow="Overview"
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
              {budgets.isError ||
              budgets.isPending ||
              budgetPeriodsFor(currency.currency).length ? (
                <section className="panel">
                  <header className="panel-header">
                    <h3>Budget</h3>
                    <span>
                      <Link to={{ pathname: "/budgets", search: location.search }}>
                        See budgets
                      </Link>
                    </span>
                  </header>
                  {budgets.isError ? (
                    <Alert kind="error">
                      The budget figures could not be loaded, so this panel is empty for a reason
                      that is not the ledger. {(budgets.error as Error).message}
                    </Alert>
                  ) : null}
                  {budgets.isPending ? <Skeleton height={54} label="Loading budgets…" /> : null}
                  {!budgets.isError &&
                  !budgets.isPending &&
                  budgetPeriodsFor(currency.currency).length === 0 ? (
                    <p className="panel-empty">Nothing budgeted in this range.</p>
                  ) : null}
                  {budgetPeriodsFor(currency.currency).map((period) => {
                    const state = periodState(period);
                    return (
                      <div
                        className="spending-row"
                        key={`${period.periodStart}:${period.currency}`}
                      >
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
                    );
                  })}
                </section>
              ) : null}
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
