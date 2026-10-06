import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, CalendarCheck, History, Landmark, Scale, TrendingUp } from "lucide-react";
import { Link, useLocation, useParams } from "../router.js";
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
  EmptyState,
  MetricTile,
  Note,
  PageHeader,
  Skeleton,
} from "../components.js";
import { compareMoney, formatDate, formatMoney, isNegativeMoney } from "../money.js";
import { useDateRange } from "../date-range.js";
import { liabilityAccountTypes } from "../../shared/domain.js";
import { TransactionBrowser } from "../TransactionBrowser.js";

/**
 * The four figures, each with the glyph that says which one it is.
 *
 * One icon drawn four times is a channel carrying nothing: the band was four
 * identical saturated green squares beside four different numbers, and the
 * loudest thing on the page. `Scale` and `TrendingUp` are the same two the
 * Overview uses for the same two meanings.
 */
const balanceLabels = {
  beginning: {
    title: "Beginning balance",
    icon: History,
    description: "Immediately before this date range",
  },
  ending: {
    title: "Ending balance",
    icon: CalendarCheck,
    description: "At the end of this date range",
  },
  current: {
    title: "Current balance",
    icon: Scale,
    description: "As of today",
  },
  future: {
    title: "Future balance",
    icon: TrendingUp,
    description: "Including every future transaction",
  },
} as const;

export default function AccountDetailPage() {
  const { accountId = "" } = useParams();
  // The router's location, not the window global: the global happens to
  // agree only because this router writes real URLs, and a render that reads
  // it skips the subscription — a back/forward navigation would not re-render.
  const location = useLocation();
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
      api<AccountRegister>(`/api/v1/accounts/${accountId}/register?${queryString({ start, end })}`),
    enabled: Boolean(accountId) && showRegister,
  });

  /**
   * The back link and the page header, before any of the four states rather
   * than after them.
   *
   * `web.md` 12.1 says four states per list, and nothing said the four states
   * are states of the page's BODY. So this page returned its skeleton and its
   * alert from above the header and took the title, the eyebrow and the way
   * back to the list down with them — and `document.title` is set inside
   * `PageHeader`, whose own comment is that two windows of this app are
   * otherwise indistinguishable in a task switcher. A fresh tab on this URL
   * read the bare app name until the query landed, and forever if it failed.
   *
   * The eyebrow waits for the name, because an eyebrow and an `h1` saying the
   * same word is decoration that reads as structure (16).
   */
  const header = (
    <>
      <Link className="back-link" to={{ pathname: "/accounts", search: location.search }}>
        <ArrowLeft size={16} /> All accounts
      </Link>
      <PageHeader
        eyebrow={account.data ? "Account" : undefined}
        title={account.data?.name ?? "Account"}
        description="Transactions and balances for this account."
        actions={
          account.data ? (
            <>
              {/* The institution was the description until it was moved here,
                  and the move is the rule rather than taste: the description
                  slot is authored copy and a varying fact belongs in a badge
                  (web.md 7.5). As a description it rendered a bare noun —
                  "Chase" — where the other three detail pages render a
                  sentence, and it pushed the one authored sentence this page
                  has out of every account that names its bank. Beside the
                  currency it reads as what it is, and all four detail pages
                  are one shape: eyebrow, name, badges, sentence. */}
              {account.data.institution ? (
                <Badge>
                  <Landmark size={14} /> {account.data.institution}
                </Badge>
              ) : null}
              <Badge tone="blue">{account.data.currency}</Badge>
              {account.data.archivedAt ? <Badge>Archived</Badge> : null}
              {account.data.frozen ? <Badge tone="amber">Frozen</Badge> : null}
            </>
          ) : undefined
        }
      />
    </>
  );

  if (account.error)
    return (
      <>
        {header}
        <Alert>{account.error.message}</Alert>
      </>
    );
  if (!account.data)
    return (
      <>
        {header}
        <p role="status">Loading account…</p>
      </>
    );

  return (
    <>
      {header}
      {balances.error ? <Alert>{balances.error.message}</Alert> : null}
      <DateRangeBar />
      <section className="metric-grid" aria-label="Account balances">
        {(Object.keys(balanceLabels) as (keyof typeof balanceLabels)[]).map((key) => {
          const value = balances.data?.[key];
          const prefix =
            value?.balancePresentation.label === "Amount owed"
              ? "Amount owed · "
              : value?.balancePresentation.label === "Credit balance"
                ? "Credit balance · "
                : "";
          // Which day "today" was, which the server has computed in the
          // account's own timezone and sent since the first release and this
          // page never printed. `AGENTS.md` makes it an invariant that a
          // summary reports the day it used, and the Overview, the reports and
          // the register three inches below all name theirs.
          // Guarded the way `value` above it is: this band already renders
          // from a response that may be missing pieces, and a snapshot without
          // a range falls back to the static words rather than taking the page
          // down.
          const today = balances.data?.range?.today;
          const asOf =
            key === "current" && today
              ? `As of ${formatDate(today)}`
              : balanceLabels[key].description;
          return (
            <MetricTile
              key={key}
              icon={balanceLabels[key].icon}
              label={balanceLabels[key].title}
              figure={
                value ? formatMoney(value.balancePresentation.amount, account.data.currency) : "—"
              }
              // Marked as the Accounts card marks the same figure: an asset
              // below zero is overdrawn, and a liability's figure is already
              // presented as the amount owed, which is not a warning.
              negative={
                Boolean(value) &&
                !liabilityAccountTypes.has(account.data.type) &&
                isNegativeMoney(value!.balance)
              }
              note={`${prefix}${asOf}`}
            />
          );
        })}
      </section>
      <section className="account-transactions">
        <TransactionBrowser
          heading={{
            kind: "section",
            title: "Transactions",
            description: "Filter, search, export, or add activity for this account.",
          }}
          fixedAccountId={accountId}
          // A frozen account refuses a new entry exactly as an archived one
          // does, and the form this opens is preselected to it, so offering
          // the button would be offering a save the server then refuses.
          allowCreate={!account.data.archivedAt && !account.data.frozen}
          showDateRange={false}
        />
      </section>

      <section className="account-register">
        <div className="section-title">
          <div>
            <h2>Register</h2>
            <p>
              Every posting in date order with the balance before and after it, for when a balance
              is wrong and you need the row it went wrong on.
            </p>
          </div>
          {/* In `page-actions` rather than loose, which is what every other
              section heading with a button does. `.page-actions` is the thing
              carrying `flex: 0 0 auto`; a bare button is a shrinkable flex item
              beside a long description, and this one was rendering as two
              lines reading "Show" and "register". */}
          <div className="page-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowRegister(!showRegister)}
            >
              {showRegister ? "Hide register" : "Show register"}
            </Button>
          </div>
        </div>

        {showRegister ? (
          register.error ? (
            <Alert>{register.error.message}</Alert>
          ) : register.isPending || !register.data ? (
            <Skeleton height={220} label="Loading the register…" />
          ) : (
            <>
              <Note>
                Opening {formatMoney(register.data.openingBalance, register.data.currency)}, closing{" "}
                {formatMoney(register.data.closingBalance, register.data.currency)}, as of{" "}
                {formatDate(register.data.asOf)}.
              </Note>
              {register.data.entries.length ? (
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Register">
                  <table className="data-table">
                    <caption className="sr-only">
                      Postings on {register.data.accountName} in date order
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Origin</th>
                        <th scope="col" className="align-right">
                          Amount
                        </th>
                        <th scope="col" className="align-right">
                          Before
                        </th>
                        <th scope="col" className="align-right">
                          After
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {register.data.entries.map((entry) => (
                        <tr key={entry.postingId}>
                          <th scope="row" className="nowrap">
                            {formatDate(entry.date)}
                          </th>
                          <td>
                            {entry.origin === "transaction" ? (
                              entry.transactionId ? (
                                // The list narrowed to this account on this one
                                // day, which is a filter it actually has. An
                                // id in the query string would have been
                                // ignored and landed on the whole list.
                                <Link
                                  to={{
                                    pathname: "/transactions",
                                    search: queryString({
                                      accountId: register.data.accountId,
                                      start: entry.date,
                                      end: entry.date,
                                      preset: "custom",
                                    }),
                                  }}
                                  aria-label={`Transactions on ${formatDate(entry.date)} in ${register.data.accountName}`}
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
                // An `EmptyState` rather than a muted line, and two of them.
                // `web.md` 12.1: a list's empty state is this component, and
                // "nothing yet" and "nothing in this range" are different
                // sentences with different next actions — a line reading "no
                // postings in this range" told somebody looking at a brand-new
                // account to adjust a range that was never the problem.
                //
                // The opening balance tells part of them apart: it is what the
                // account held before this range began, so a non-zero one means
                // the postings exist and are outside the window. A zero one
                // does not mean there are none — an archived account closes to
                // zero, a card paid off sits at zero, and anything after the
                // range is not in the opening balance at all — so "yet" is
                // said only of a range that hides nothing, and a bounded empty
                // range says what it can know.
                <EmptyState
                  icon={Landmark}
                  title={
                    compareMoney(register.data.openingBalance, "0") !== 0
                      ? "No postings in this range"
                      : start || end
                        ? "Nothing posted to this account in this range"
                        : "Nothing posted to this account yet"
                  }
                  body={
                    compareMoney(register.data.openingBalance, "0") !== 0
                      ? "This account was not empty before this range began, so widen the dates to find what it holds."
                      : start || end
                        ? "Every deposit, withdrawal and transfer that touches this account shows up here, oldest first. Widen the dates to look outside this range."
                        : "Every deposit, withdrawal and transfer that touches this account shows up here, oldest first."
                  }
                />
              )}
            </>
          )
        ) : null}
      </section>
    </>
  );
}
