import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Landmark } from "lucide-react";
import { Link, useParams } from "../router.js";
import {
  api,
  queryString,
  type Account,
  type AccountBalanceSnapshot,
} from "../api.js";
import {
  Alert,
  Badge,
  DateRangeBar,
  formatMoney,
  PageHeader,
} from "../components.js";
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
    </>
  );
}
