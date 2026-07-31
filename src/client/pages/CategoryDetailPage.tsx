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

  if (category.error) return <Alert>{category.error.message}</Alert>;
  if (!category.data) return <p>Loading category…</p>;

  return (
    <>
      <Link className="back-link" to={{ pathname: "/categories", search: location.search }}>
        <ArrowLeft size={16} /> All categories
      </Link>
      <PageHeader
        eyebrow="Category"
        title={category.data.name}
        description="Transactions assigned to this category."
        actions={
          <>
            <Badge tone={category.data.kind === "expense" ? "red" : "green"}>
              <Tags size={14} /> {kindLabels[category.data.kind]}
            </Badge>
            {category.data.archivedAt ? <Badge>Archived</Badge> : null}
          </>
        }
      />
      <DateRangeBar />
      <section className="account-transactions">
        <div className="section-title">
          <div>
            <h2>Transactions</h2>
            <p>Filter, search, export, or add activity in this category.</p>
          </div>
        </div>
        <TransactionBrowser
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
