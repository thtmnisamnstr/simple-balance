import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, LayoutTemplate } from "lucide-react";
import { api, type TransactionTemplate } from "../api.js";
import { Alert, Badge, DateRangeBar, PageHeader } from "../components.js";
import { Link, useLocation, useParams } from "../router.js";
import { TransactionBrowser } from "../TransactionBrowser.js";

const typeLabels = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  transfer: "Transfer",
} as const;

export default function TemplateDetailPage() {
  const { templateId = "" } = useParams();
  const location = useLocation();
  const template = useQuery({
    queryKey: ["transaction-templates", templateId],
    queryFn: () =>
      api<TransactionTemplate>(`/api/v1/transaction-templates/${templateId}`),
    enabled: Boolean(templateId),
  });

  if (template.error) return <Alert>{template.error.message}</Alert>;
  if (!template.data) return <p>Loading template…</p>;

  const { draft } = template.data;
  return (
    <>
      <Link
        className="back-link"
        to={{ pathname: "/templates", search: location.search }}
      >
        <ArrowLeft size={16} /> All templates
      </Link>
      <PageHeader
        eyebrow="Template"
        title={template.data.name}
        description="Transactions started from this template."
        actions={
          draft.type ? (
            <Badge tone={draft.type === "deposit" ? "green" : "red"}>
              <LayoutTemplate size={14} /> {typeLabels[draft.type]}
            </Badge>
          ) : null
        }
      />
      <DateRangeBar />
      <section className="account-transactions">
        <div className="section-title">
          <div>
            <h2>Transactions</h2>
            <p>
              What this template was used for. Changing one here does not change
              the template.
            </p>
          </div>
        </div>
        <TransactionBrowser
          includeStaged
          fixedTemplateId={templateId}
          initialType={draft.type === "deposit" ? "deposit" : "withdrawal"}
          showDateRange={false}
        />
      </section>
    </>
  );
}
