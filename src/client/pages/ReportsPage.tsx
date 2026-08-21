import { useQuery } from "@tanstack/react-query";
import { BarChart, ChartLegend, LineChart } from "../charts.js";
import { api, queryString, type Report } from "../api.js";
import {
  Alert,
  DateRangeBar,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  formatDate,
  formatMoney,
  isNegativeMoney,
} from "../components.js";
import { useDateRange } from "../date-range.js";
import { Link, useLocation, useParams, useSearchParams } from "../router.js";
import { reportBuckets, reportNames, type ReportName } from "../../shared/domain.js";

const TITLES: Record<ReportName, string> = {
  "net-worth": "Net worth",
  "income-expense": "Income and expenses",
  categories: "Categories",
  "cash-flow": "Cash flow",
  "balance-sheet": "Balance sheet",
  "trial-balance": "Trial balance",
};

const BLURBS: Record<ReportName, string> = {
  "net-worth": "What your accounts held at the end of each period.",
  "income-expense": "What came in and what went out over each period.",
  categories:
    "Where the money went and where it came from, by what you filed it under.",
  "cash-flow":
    "Movements in and out of the accounts you can spend from, by where the money came from and went to.",
  "balance-sheet": "What every account holds, as of one date.",
  "trial-balance":
    "Every account including the ledger's own counter-accounts. It totals zero when the books are whole.",
};

const BUCKET_LABELS: Record<string, string> = {
  none: "One column",
  week: "Weekly",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

const isReportName = (value: string | undefined): value is ReportName =>
  reportNames.includes(value as ReportName);

export default function ReportsPage() {
  const { report: param } = useParams<{ report?: string }>();
  const report: ReportName = isReportName(param) ? param : "net-worth";
  const location = useLocation();
  const { start, end } = useDateRange();
  const [params, setParams] = useSearchParams();
  const bucket = params.get("bucket") ?? "";

  const query = useQuery({
    queryKey: ["report", report, start, end, bucket],
    queryFn: () =>
      api<Report>(
        `/api/v1/reports/${report}?${queryString({ start, end, bucket })}`,
      ),
    // Every figure here is derived from transactions edited on other pages, and
    // none of those mutations knows to invalidate a report. Refetching on mount
    // closes that window at the one place that reads it, rather than adding this
    // key to eight mutation callbacks that would each have to remember it.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const setBucket = (next: string) => {
    const updated = new URLSearchParams(params);
    if (next) updated.set("bucket", next);
    else updated.delete("bucket");
    setParams(updated, { replace: true });
  };

  const data = query.data;
  const plotted = data ? data.buckets.length > 1 : false;

  // A balance is as of a day; a period's movement is between two. Heading a
  // single wide column with only its first day reads as a report about that
  // day rather than about everything up to now.
  const columnHeading = (entry: { start: string; end: string }) => {
    if (plotted) return formatDate(entry.start);
    if (data?.accumulation === "historical") return formatDate(entry.end);
    return `${formatDate(entry.start)} – ${formatDate(entry.end)}`;
  };

  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title={TITLES[report]}
        description={BLURBS[report]}
      />

      <nav className="report-tabs" aria-label="Reports">
        {reportNames.map((name) => (
          <Link
            key={name}
            to={{ pathname: `/reports/${name}`, search: location.search }}
            className={name === report ? "report-tab is-current" : "report-tab"}
            aria-current={name === report ? "page" : undefined}
          >
            {TITLES[name]}
          </Link>
        ))}
      </nav>

      <div className="date-bar" aria-label="Report options">
        <Select
          aria-label="Group by"
          value={bucket}
          onChange={(event) => setBucket(event.target.value)}
        >
          <option value="">Default grouping</option>
          {reportBuckets.map((option) => (
            <option key={option} value={option}>
              {BUCKET_LABELS[option]}
            </option>
          ))}
        </Select>
      </div>
      <DateRangeBar />

      {report === "cash-flow" ? (
        <Alert kind="info">
          Cash flow will not match income and expenses, and the gap is widest if
          you use a credit card. A card purchase is an expense the day you make
          it; the cash leaves when you pay the bill, in a different period and
          under borrowing and repaying. Both figures are right.
        </Alert>
      ) : null}

      {query.error ? <Alert>{query.error.message}</Alert> : null}

      {query.isPending ? (
        <div className="currency-sections">
          <Skeleton height={220} />
        </div>
      ) : query.error ? null : !data?.currencies.length ? (
        <EmptyState
          title="Nothing to report yet"
          body="Once there are transactions in this date range, this report will fill in."
          action={
            <Link className="button button-primary" to="/transactions">
              Add a transaction
            </Link>
          }
        />
      ) : (
        <div className="currency-sections">
          {data.currencies.map((currency) => {
            const series = currency.rows.map((entry) => ({
              key: entry.key,
              label: entry.label,
              values: entry.values,
            }));
            return (
              <section className="panel" key={currency.currency}>
                <div className="panel-header">
                  <h2>{currency.currency}</h2>
                  <span>As of {data.asOf}</span>
                </div>

                {plotted ? (
                  <>
                    {data.accumulation === "historical" ? (
                      <LineChart
                        buckets={data.buckets}
                        series={series}
                        currency={currency.currency}
                        title={`${TITLES[report]} over time, in ${currency.currency}`}
                      />
                    ) : (
                      <BarChart
                        buckets={data.buckets}
                        series={series}
                        currency={currency.currency}
                        title={`${TITLES[report]} by period, in ${currency.currency}`}
                      />
                    )}
                    <ChartLegend series={series} />
                  </>
                ) : null}

                <div className="table-wrap">
                  <table className="data-table report-table">
                    <caption className="sr-only">
                      {TITLES[report]} in {currency.currency}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Row</th>
                        {data.buckets.map((entry) => (
                          <th scope="col" className="align-right" key={entry.start}>
                            {columnHeading(entry)}
                          </th>
                        ))}
                        <th scope="col" className="align-right">
                          {data.accumulation === "historical" ? "Closing" : "Total"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {currency.rows.map((entry) => (
                        <tr key={entry.key}>
                          <th scope="row">
                            {entry.label}
                            {/* A balance report keeps a closed account's
                                history, so without saying so its past reads as
                                money still held. */}
                            {entry.archived ? (
                              <span className="row-note"> (closed)</span>
                            ) : null}
                          </th>
                          {entry.values.map((value, position) => (
                            <td
                              className={`align-right${isNegativeMoney(value) ? " money-negative" : ""}`}
                              key={data.buckets[position]?.start ?? position}
                            >
                              {formatMoney(value, currency.currency)}
                            </td>
                          ))}
                          <td
                            className={`align-right${isNegativeMoney(entry.total) ? " money-negative" : ""}`}
                          >
                            <strong>{formatMoney(entry.total, currency.currency)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">
                          {report === "categories"
                            ? "Total filed"
                            : data.accumulation === "historical"
                              ? "Total held"
                              : "Net"}
                        </th>
                        {currency.totals.map((value, position) => (
                          <td
                            className={`align-right${isNegativeMoney(value) ? " money-negative" : ""}`}
                            key={data.buckets[position]?.start ?? position}
                          >
                            <strong>{formatMoney(value, currency.currency)}</strong>
                          </td>
                        ))}
                        <td className="align-right" />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
