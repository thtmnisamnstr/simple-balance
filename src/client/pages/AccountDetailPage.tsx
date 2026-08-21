import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Landmark } from "lucide-react";
import { Link, useParams } from "../router.js";
import {
  api,
  queryString,
  type Account,
  type AccountBalanceSnapshot,
  type AccountRegister,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  DateRangeBar,
  PageHeader,
  Skeleton,
} from "../components.js";
import {
  formatDate,
  formatMoney,
  isNegativeMoney,
} from "../money.js";
import { useDateRange } from "../date-range.js";
import { TransactionBrowser } from "../TransactionBrowser.js";

const balanceLabels = {
  beginning: {
    title: "Beginning balance",
    description: "Immediately before this date range",
  },
  ending: {
    title: "Ending balance",
    description: "At the end of this date range",
  },
  current: {
    title: "Current balance",
    description: "As of today",
  },
  future: {
    title: "Future balance",
    description: "Including every future transaction",
  },
} as const;

export default function AccountDetailPage() {
  const { accountId = "" } = useParams();
  const { start, end } = useDateRange();
  const account = useQuery({
    queryKey: ["accounts", accountId],
    queryFn: () => api<Account>(`/api/v1/accounts/${accountId}`),
    enabled: Boolean(accountId),
  });
  const balances = useQuery({
    queryKey: ["accounts", accountId, "balances", start, end],
    queryFn: () =>
      api<AccountBalanceSnapshot>(
        `/api/v1/accounts/${accountId}/balances?${queryString({
          start,
          end,
        })}`,
      ),
    enabled: Boolean(accountId),
  });

  // Loaded only when asked for. It is the row-by-row view somebody opens when a
  // balance is wrong, not something to fetch on every visit — and on a busy
  // account it is thousands of rows.
  const [showRegister, setShowRegister] = useState(false);
  const register = useQuery({
    queryKey: ["accounts", accountId, "register", start, end],
    queryFn: () =>
      api<AccountRegister>(
        `/api/v1/accounts/${accountId}/register?${queryString({ start, end })}`,
      ),
    enabled: Boolean(accountId) && showRegister,
  });

  if (account.error) return <Alert>{account.error.message}</Alert>;
  if (!account.data) return <p>Loading account…</p>;

  return (
    <>
      <Link className="back-link" to={{ pathname: "/accounts", search: location.search }}>
        <ArrowLeft size={16} /> All accounts
      </Link>
      <PageHeader
        eyebrow="Account"
        title={account.data.name}
        description={
          account.data.institution ||
          "Transactions and balances for this account."
        }
        actions={
          <>
            <Badge tone="blue">{account.data.currency}</Badge>
            {account.data.archivedAt ? <Badge>Archived</Badge> : null}
          </>
        }
      />
      {balances.error ? <Alert>{balances.error.message}</Alert> : null}
      <DateRangeBar />
      <section className="balance-snapshot-grid" aria-label="Account balances">
        {(Object.keys(balanceLabels) as (keyof typeof balanceLabels)[]).map(
          (key) => {
            const value = balances.data?.[key];
            return (
              <article className="balance-snapshot" key={key}>
                <span className="account-icon">
                  <Landmark size={18} />
                </span>
                <div>
                  <span>{balanceLabels[key].title}</span>
                  <strong>
                    {value
                      ? formatMoney(
                          value.balancePresentation.amount,
                          account.data.currency,
                        )
                      : "—"}
                  </strong>
                  <small>
                    {value?.balancePresentation.label === "Amount owed"
                      ? "Amount owed · "
                      : value?.balancePresentation.label === "Credit balance"
                        ? "Credit balance · "
                        : ""}
                    {balanceLabels[key].description}
                  </small>
                </div>
              </article>
            );
          },
        )}
      </section>
      <section className="account-transactions">
        <div className="section-title">
          <div>
            <h2>Transactions</h2>
            <p>Filter, search, export, or add activity for this account.</p>
          </div>
        </div>
        <TransactionBrowser
          fixedAccountId={accountId}
          allowCreate={!account.data.archivedAt}
          showDateRange={false}
        />
      </section>

      <section className="account-register">
        <div className="section-title">
          <div>
            <h2>Register</h2>
            <p>
              Every posting in date order with the balance before and after it,
              for when a balance is wrong and you need the row it went wrong on.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowRegister(!showRegister)}
          >
            {showRegister ? "Hide register" : "Show register"}
          </Button>
        </div>

        {showRegister ? (
          register.error ? (
            <Alert>{register.error.message}</Alert>
          ) : register.isPending || !register.data ? (
            <Skeleton height={220} />
          ) : (
            <>
              <p className="settings-note">
                Opening {formatMoney(register.data.openingBalance, register.data.currency)},
                closing {formatMoney(register.data.closingBalance, register.data.currency)}
                , as of {formatDate(register.data.asOf)}.
              </p>
              {register.data.entries.length ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <caption className="sr-only">
                      Postings on {register.data.accountName} in date order
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Origin</th>
                        <th scope="col" className="align-right">Amount</th>
                        <th scope="col" className="align-right">Before</th>
                        <th scope="col" className="align-right">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {register.data.entries.map((entry) => (
                        <tr key={entry.postingId}>
                          <th scope="row">{formatDate(entry.date)}</th>
                          <td>
                            {entry.origin === "transaction" ? (
                              entry.transactionId ? (
                                <Link
                                  to={{
                                    pathname: "/transactions",
                                    search: `transactionId=${entry.transactionId}`,
                                  }}
                                >
                                  Transaction
                                </Link>
                              ) : (
                                "Transaction"
                              )
                            ) : entry.origin === "opening" ? (
                              "Opening balance"
                            ) : (
                              "Closing balance"
                            )}
                          </td>
                          <td
                            className={`align-right${isNegativeMoney(entry.amount) ? " money-negative" : ""}`}
                          >
                            {formatMoney(entry.amount, register.data.currency)}
                          </td>
                          <td className="align-right">
                            {formatMoney(entry.balanceBefore, register.data.currency)}
                          </td>
                          <td className="align-right">
                            {formatMoney(entry.balanceAfter, register.data.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="settings-note">
                  No postings in this range.
                </p>
              )}
            </>
          )
        ) : null}
      </section>
    </>
  );
}
