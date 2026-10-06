import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, LayoutTemplate } from "lucide-react";
import { api, type TransactionTemplate } from "../api.js";
import { Alert, Badge, DateRangeBar, PageHeader } from "../components.js";
import { Link, useLocation, useParams } from "../router.js";
import { TransactionBrowser } from "../TransactionBrowser.js";
import { transactionTypeLabels } from "./TemplatesPage.js";

export default function TemplateDetailPage() {
  const { templateId = "" } = useParams();
  const location = useLocation();
  const template = useQuery({
    queryKey: ["transaction-templates", templateId],
    queryFn: () => api<TransactionTemplate>(`/api/v1/transaction-templates/${templateId}`),
    enabled: Boolean(templateId),
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
      <Link className="back-link" to={{ pathname: "/templates", search: location.search }}>
        <ArrowLeft size={16} /> All templates
      </Link>
      <PageHeader
        eyebrow={template.data ? "Template" : undefined}
        title={template.data?.name ?? "Template"}
        description="Transactions started from this template."
        actions={
          template.data?.draft.type ? (
            // Each type in the color the register draws it: a transfer between
            // somebody's own accounts is blue there, and the two-way choice
            // this was gave it withdrawal red (web.md 2.4).
            <Badge
              tone={
                template.data.draft.type === "deposit"
                  ? "green"
                  : template.data.draft.type === "transfer"
                    ? "blue"
                    : "red"
              }
            >
              <LayoutTemplate size={14} /> {transactionTypeLabels[template.data.draft.type]}
            </Badge>
          ) : null
        }
      />
    </>
  );

  if (template.error)
    return (
      <>
        {header}
        <Alert>{template.error.message}</Alert>
      </>
    );
  if (!template.data)
    return (
      <>
        {header}
        <p role="status">Loading template…</p>
      </>
    );

  const { draft } = template.data;
  return (
    <>
      {header}
      <DateRangeBar />
      <section className="account-transactions">
        <TransactionBrowser
          heading={{
            kind: "section",
            title: "Transactions",
            description:
              "What this template was used for. Changing one here does not change the template.",
          }}
          includeStaged
          fixedTemplateId={templateId}
          initialType={draft.type === "deposit" ? "deposit" : "withdrawal"}
          showDateRange={false}
        />
      </section>
    </>
  );
}
