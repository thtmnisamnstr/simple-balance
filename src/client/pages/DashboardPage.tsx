import { Link } from "../router.js";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Landmark,
  Plus,
  Scale,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { groupAccountsByType } from "../../shared/domain.js";
import { api, queryString, type Account, type Category, type Summary } from "../api.js";
import {
  Alert,
  Button,
  DateRangeBar,
  EmptyState,
  formatMoney,
  isNegativeMoney,
  Modal,
  largestMoney,
  moneyRatioPercent,
  PageHeader,
  Skeleton,
} from "../components.js";
import { useDateRange } from "../date-range.js";
import { TransactionForm } from "../forms.js";

export default function DashboardPage() {
  const { start, end } = useDateRange();
  const [open, setOpen] = useState(false);
  const summary = useQuery({
    queryKey: ["summary", start, end],
    queryFn: () =>
      api<Summary>(`/api/v1/summary?${queryString({ start, end })}`),
  });
  const accounts = useQuery({
    queryKey: ["accounts", end],
    queryFn: () => api<Account[]>(`/api/v1/accounts?${queryString({ end })}`),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/api/v1/categories"),
  });

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
          <Skeleton height={160} />
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
                <span className="subtle">{currency.accounts.length} account{currency.accounts.length === 1 ? "" : "s"}</span>
              </div>
              <div className="metric-grid">
                <article className="metric-card metric-balance">
                  <span className="metric-icon"><Scale size={18} /></span>
                  <div>
                    <span>Balance</span>
                    <strong>{formatMoney(currency.balance, currency.currency)}</strong>
                  </div>
                </article>
                <article className="metric-card">
                  <span className="metric-icon positive"><ArrowDownLeft size={18} /></span>
                  <div>
                    <span>Deposits</span>
                    <strong>{formatMoney(currency.deposits, currency.currency)}</strong>
                  </div>
                </article>
                <article className="metric-card">
                  <span className="metric-icon negative"><ArrowUpRight size={18} /></span>
                  <div>
                    <span>Withdrawals</span>
                    <strong>{formatMoney(currency.withdrawals, currency.currency)}</strong>
                  </div>
                </article>
                <article className="metric-card">
                  <span className="metric-icon"><TrendingUp size={18} /></span>
                  <div>
                    <span>Net cash flow</span>
                    <strong className={isNegativeMoney(currency.netCashFlow) ? "money-negative" : ""}>
                      {formatMoney(currency.netCashFlow, currency.currency)}
                    </strong>
                  </div>
                </article>
              </div>
              <div className="dashboard-detail-grid">
                <article className="panel">
                  <header className="panel-header">
                    <h3>Accounts</h3>
                    <span>As of {summary.data?.asOf ?? end ?? "today"}</span>
                  </header>
                  <div className="account-mini-list">
                    {groupAccountsByType(currency.accounts).map((group) => (
                      <div className="account-mini-group" key={group.type}>
                        <h4 className="account-mini-heading">{group.label}</h4>
                        {group.accounts.map((account) => (
                          <div key={account.id} className="account-mini-row">
                            <strong>{account.name}</strong>
                            <span className={isNegativeMoney(account.balance) ? "money-negative" : ""}>
                              {formatMoney(account.balance, currency.currency)}
                            </span>
                          </div>
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
                    <div className="spending-list">
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
                        const widest =
                          largestMoney(shown.map((entry) => entry.amount)) ?? "1";
                        const percent = moneyRatioPercent(item.amount, widest);
                        return (
                          <div key={item.categoryId ?? "uncategorized"} className="spending-row">
                            <div>
                              <span>{item.category}</span>
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
          <TransactionForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Modal>
    </>
  );
}
