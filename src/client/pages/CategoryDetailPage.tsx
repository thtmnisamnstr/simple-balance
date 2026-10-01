import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Tags } from "lucide-react";
import { api, type Category } from "../api.js";
import { Alert, Badge, DateRangeBar, PageHeader } from "../components.js";
import { Link, useLocation, useParams } from "../router.js";
import { TransactionBrowser } from "../TransactionBrowser.js";

const kindLabels = {
  income: "Income",
  expense: "Expense",
  both: "Income or expense",
} as const;

export default function CategoryDetailPage() {
  const { categoryId = "" } = useParams();
  const location = useLocation();
  const category = useQuery({
    queryKey: ["categories", categoryId],
    queryFn: () => api<Category>(`/api/v1/categories/${categoryId}`),
    enabled: Boolean(categoryId),
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

  return (
    <>
      {header}
      <DateRangeBar />
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
