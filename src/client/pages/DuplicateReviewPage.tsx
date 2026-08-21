import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  api,
  json,
  type Account,
  type Category,
  type DuplicateReviewSide,
  type StagedDuplicateReview,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Skeleton,
  useConfirm,
} from "../components.js";
import {
  formatDate,
  formatMoney,
} from "../money.js";
import { TransactionForm } from "../forms.js";
import { summarizeStagedDraft } from "../staged-draft.js";
import { Link, Navigate, useParams } from "../router.js";

/**
 * Two records of what might be one payment, open for editing side by side.
 *
 * Not a diff. Nothing here highlights what differs, because the fields that
 * differ are the ones that always differ — the payee the bank chose and the
 * category somebody picked — and colouring them says nothing a person reading
 * two transactions does not already see. What matters is being able to correct
 * either one and drop the copy that should not have existed.
 */
export default function DuplicateReviewPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const drop = useConfirm<string>();

  const review = useQuery({
    queryKey: ["staged", id, "duplicate"],
    queryFn: () =>
      api<StagedDuplicateReview>(`/api/v1/staged/${id}/duplicate`),
    enabled: Boolean(id),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/api/v1/categories"),
  });

  // Dropping the row this page is about ends the page. Refetching instead asks
  // for a review of a row that no longer exists, and the answer is a red "Staged
  // transaction not found" over an empty screen — the failure looking exactly
  // like the success.
  const [subjectDropped, setSubjectDropped] = useState(false);

  const deletion = useMutation({
    mutationFn: async (side: DuplicateReviewSide) => {
      const staged = side.staged!;
      await api("/api/v1/staged-transactions/delete", {
        ...json({
          stagedIds: [staged.id],
          expectedVersions: { [staged.id]: staged.version },
        }),
      });
      return staged.id;
    },
    onSuccess: async (deletedId) => {
      const wasSubject = review.data?.first.staged?.id === deletedId;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["staged"],
          // The review itself is not worth refetching when its subject is gone.
          predicate: (entry) =>
            !(wasSubject && entry.queryKey[2] === "duplicate"),
        }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      ]);
      if (wasSubject) setSubjectDropped(true);
    },
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["staged"] });
  };

  const ready = accounts.data && categories.data;
  const error = review.error ?? accounts.error ?? categories.error;

  // Back to the queue, which is where the work continues and where the row that
  // is left now sits without a badge.
  if (subjectDropped) return <Navigate to="/staged" replace />;

  return (
    <>
      <PageHeader
        eyebrow="Review queue"
        title="Two records of one payment"
        description="Correct either side and save it, or drop the copy that should not be there. Only a staged row can be dropped: a committed transaction is already in the books."
        actions={
          <Link className="button button-secondary" to="/staged">
            Back to the queue
          </Link>
        }
      />

      {error ? <Alert>{error.message}</Alert> : null}
      {deletion.error ? <Alert>{deletion.error.message}</Alert> : null}

      {review.isPending || !ready ? (
        <div className="duplicate-review">
          <Skeleton height={320} />
          <Skeleton height={320} />
        </div>
      ) : !review.data ? null : !review.data.second ? (
        <EmptyState
          title="Nothing repeats this any more"
          body="Whatever it looked like a copy of has been changed, committed or dropped. This row is on its own now."
          action={
            <Link className="button button-primary" to="/staged">
              Back to the queue
            </Link>
          }
        />
      ) : (
        <div className="duplicate-review">
          {[review.data.first, review.data.second].map((side, index) => {
            const staged = side.staged;
            const committed = side.committed;
            const summary = staged
              ? summarizeStagedDraft(staged.draft, accounts.data!)
              : null;
            return (
              <section
                className="panel duplicate-side"
                key={staged?.id ?? committed?.id ?? index}
                aria-label={
                  side.kind === "committed"
                    ? "Committed transaction"
                    : index === 0
                      ? "Staged row under review"
                      : "The older staged row"
                }
              >
                <div className="panel-header">
                  <h2>
                    {side.kind === "committed" ? (
                      <Badge tone="blue">Already recorded</Badge>
                    ) : (
                      <Badge tone="amber">Waiting in the queue</Badge>
                    )}
                  </h2>
                  <span>
                    {committed
                      ? `${formatDate(committed.date)} · ${
                          committed.sourceAmount ?? committed.destinationAmount
                            ? formatMoney(
                                committed.sourceAmount ??
                                  committed.destinationAmount ??
                                  "0",
                                committed.sourceCurrency ??
                                  committed.destinationCurrency ??
                                  "",
                              )
                            : ""
                        }`
                      : summary?.amount && summary.currency
                        ? `${formatDate(String(staged?.draft.date ?? ""))} · ${formatMoney(summary.amount, summary.currency)}`
                        : formatDate(String(staged?.draft.date ?? ""))}
                  </span>
                </div>

                <TransactionForm
                  accounts={accounts.data!}
                  categories={categories.data!}
                  transaction={committed ?? undefined}
                  staged={staged ?? undefined}
                  onDone={refresh}
                />

                <div className="duplicate-side-actions">
                  {staged ? (
                    <Button
                      variant="danger"
                      loading={deletion.isPending}
                      onClick={() =>
                        drop.ask(staged.id, () => deletion.mutate(side))
                      }
                    >
                      <Trash2 size={15} />
                      Drop this staged row
                    </Button>
                  ) : (
                    <p className="panel-empty">
                      Committed transactions are not dropped from here. If this
                      is the copy to remove, delete it from the transactions
                      list.
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={drop.open}
        title="Drop this staged row?"
        description="It leaves the queue and posts nothing. The other record stays as it is."
        confirmLabel="Drop it"
        onConfirm={drop.confirm}
        onCancel={drop.cancel}
      />
    </>
  );
}
