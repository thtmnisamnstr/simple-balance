import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarCheck, History, Tags } from "lucide-react";
import { api, queryString, type Category, type Report } from "../api.js";
import { Alert, Badge, DateRangeBar, MetricTile, PageHeader } from "../components.js";
import { formatMoney, isNegativeMoney, isZeroMoney, sumMoney } from "../money.js";
import { useDateRange } from "../date-range.js";
import { Link, useLocation, useParams } from "../router.js";
import { TransactionBrowser } from "../TransactionBrowser.js";
import { categoryKindLabels } from "../select-options.js";

const kindLabels = categoryKindLabels;

/**
 * What this category holds, per currency, out of a report.
 *
 * The categories report keys a row `"<kind>:<categoryId>"` and a category whose
 * kind is `both` can carry a row under each, so every matching row is summed
 * rather than the first one taken.
 */
function totalsByCurrency(report: Report | undefined, categoryId: string) {
  return (report?.currencies ?? [])
    .map((currency) => ({
      currency: currency.currency,
      total: sumMoney(
        currency.rows
          .filter((row) => row.key.slice(row.key.indexOf(":") + 1) === categoryId)
          .map((row) => row.total),
      ),
    }))
    .filter((entry) => !isZeroMoney(entry.total));
}

export default function CategoryDetailPage() {
  const { categoryId = "" } = useParams();
  const location = useLocation();
  const { start, end } = useDateRange();
  const category = useQuery({
    queryKey: ["categories", categoryId],
    queryFn: () => api<Category>(`/api/v1/categories/${categoryId}`),
    enabled: Boolean(categoryId),
  });

  /**
   * The two figures the page was missing, read out of the categories report
   * rather than out of a route of this page's own.
   *
   * A detail page with no summary reads as one that failed to load its middle,
   * and this is the page somebody opens to ask what a category costs them. The
   * report already answers exactly that — a sum per category over a range — so
   * taking it from there is a page change rather than a product change. A new
   * `/api/v1` route would have been the other way, and by `AGENTS.md`'s parity
   * invariant it would have had to arrive with an MCP tool beside it.
   *
   * Two calls, because the second is deliberately unbounded: `start` and `end`
   * are optional on the report and `queryString` drops what is falsy, so an
   * empty range is every transaction there has ever been.
   *
   * `staleTime: 0` and `refetchOnMount` for the reason `ReportsPage` gives:
   * every figure here is derived from transactions edited elsewhere, and none
   * of those mutations knows to invalidate a report.
   */
  const inRange = useQuery({
    queryKey: ["report", "categories", start, end, "detail"],
    queryFn: () =>
      api<Report>(`/api/v1/reports/categories?${queryString({ start, end, bucket: "none" })}`),
    enabled: Boolean(categoryId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const allTime = useQuery({
    queryKey: ["report", "categories", "all-time", "detail"],
    queryFn: () => api<Report>(`/api/v1/reports/categories?${queryString({ bucket: "none" })}`),
    enabled: Boolean(categoryId),
    staleTime: 0,
    refetchOnMount: "always",
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
      <Link className="back-link" to={{ pathname: "/categories", search: location.search }}>
        <ArrowLeft size={16} /> All categories
      </Link>
      <PageHeader
        eyebrow={category.data ? "Category" : undefined}
        title={category.data?.name ?? "Category"}
        description="Transactions assigned to this category."
        actions={
          category.data ? (
            <>
              <Badge tone={category.data.kind === "expense" ? "red" : "green"}>
                <Tags size={14} /> {kindLabels[category.data.kind]}
              </Badge>
              {category.data.archivedAt ? <Badge>Archived</Badge> : null}
            </>
          ) : undefined
        }
      />
    </>
  );

  if (category.error)
    return (
      <>
        {header}
        <Alert>{category.error.message}</Alert>
      </>
    );
  if (!category.data)
    return (
      <>
        {header}
        <p role="status">Loading category…</p>
      </>
    );

  const ranged = totalsByCurrency(inRange.data, categoryId);
  const ever = totalsByCurrency(allTime.data, categoryId);
  /* One currency is the ordinary case and reads best with a bare label; a
     category that spans two needs the code or the two tiles are a riddle. */
  const currencies = [...new Set([...ranged, ...ever].map((entry) => entry.currency))];
  const suffix = (currency: string) => (currencies.length > 1 ? ` (${currency})` : "");
  // A figure that did not load is not zero (`common.md`, "Zero is a value"):
  // a failed read rendered $0.00 here, which is a claim about the ledger the
  // page had no grounds for. A dash, beside the alert saying why — the same
  // "—" the tiles show while loading, rather than a second placeholder.
  const figure = (
    entries: readonly { currency: string; total: string }[],
    currency: string,
    unknown: boolean,
  ) => {
    const found = entries.find((entry) => entry.currency === currency);
    if (!found) return unknown ? "—" : formatMoney("0", currency);
    return formatMoney(found.total, currency);
  };

  return (
    <>
      {header}
      {inRange.error ? <Alert>{inRange.error.message}</Alert> : null}
      {/* The all-time read can fail on its own, and its tile showed $0.00 with
          nothing saying so. */}
      {allTime.error ? <Alert>{allTime.error.message}</Alert> : null}
      <DateRangeBar />
      {currencies.length ? (
        <section className="metric-grid" aria-label="What this category holds">
          {currencies.map((currency) => (
            <MetricTile
              key={`range-${currency}`}
              icon={CalendarCheck}
              label={`In this range${suffix(currency)}`}
              figure={figure(ranged, currency, inRange.isPending || inRange.isError)}
              negative={isNegativeMoney(
                ranged.find((entry) => entry.currency === currency)?.total ?? "0",
              )}
              note="Filed under this category between the two dates above"
            />
          ))}
          {currencies.map((currency) => (
            <MetricTile
              key={`ever-${currency}`}
              icon={History}
              label={`All time${suffix(currency)}`}
              figure={figure(ever, currency, allTime.isPending || allTime.isError)}
              negative={isNegativeMoney(
                ever.find((entry) => entry.currency === currency)?.total ?? "0",
              )}
              note="Every transaction ever filed under it"
            />
          ))}
        </section>
      ) : null}
      <section className="account-transactions">
        <TransactionBrowser
          heading={{
            kind: "section",
            title: "Transactions",
            description: "Filter, search, export, or add activity in this category.",
          }}
          includeStaged
          fixedCategoryId={categoryId}
          initialType={category.data.kind === "income" ? "deposit" : "withdrawal"}
          allowCreate={!category.data.archivedAt}
          showDateRange={false}
        />
      </section>
    </>
  );
}
