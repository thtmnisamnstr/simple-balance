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
import { accountTypeLabels } from "../../shared/domain.js";
import { api, queryString, type Account, type Category, type Summary } from "../api.js";
import {
  Button,
  DateRangeBar,
  EmptyState,
  formatMoney,
  isNegativeMoney,
  Modal,
  moneyRatioPercent,
  PageHeader,
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

      {summary.data?.currencies.length === 0 ? (
        <EmptyState
          icon={<Landmark size={25} />}
          title="Create your first account"
          body="Once an account exists, deposits, withdrawals, and transfers will appear here."
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
                    <span>As of {end || "today"}</span>
                  </header>
                  <div className="account-mini-list">
                    {currency.accounts.map((account) => (
                      <div key={account.id} className="account-mini-row">
                        <div>
                          <strong>{account.name}</strong>
                          <small>{accountTypeLabels[account.type]}</small>
                        </div>
                        <span className={isNegativeMoney(account.balance) ? "money-negative" : ""}>
                          {formatMoney(account.balance, currency.currency)}
                        </span>
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
                      {currency.spendingByCategory.slice(0, 7).map((item) => {
                        const percent = moneyRatioPercent(
                          item.amount,
                          currency.spendingByCategory[0]?.amount ?? "1",
                        );
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
