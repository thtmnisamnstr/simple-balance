import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CheckCheck, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import {
  api,
  json,
  queryString,
  type Account,
  type Category,
  type DuplicateReviewSide,
  type PaginatedPage,
  type StagedDuplicateReview,
  type StagedTransaction,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Note,
  PageHeader,
  Skeleton,
  useConfirm,
} from "../components.js";
import { formatDate, formatMoney, movementSign } from "../money.js";
import { TransactionForm } from "../forms.js";
import { summarizeStagedDraft } from "../staged-draft.js";
import { Link, Navigate, useParams } from "../router.js";

/**
 * Two records of what might be one payment, open for editing side by side.
 *
 * Not a diff. Nothing here highlights what differs, because the fields that
 * differ are the ones that always differ — the payee the bank chose and the
 * category somebody picked — and coloring them says nothing a person reading
 * two transactions does not already see. What matters is being able to correct
 * either one and drop the copy that should not have existed.
 */
export default function DuplicateReviewPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const drop = useConfirm<string>();

  /**
   * Every flagged row, in the order the queue lists them, so this page is a
   * queue rather than one screen you reach from one badge and leave again.
   *
   * A window rather than the whole set: two hundred is the most a listing
   * returns, and it does not need to be the whole set, because the window
   * refills from the server every time a row leaves it. Working through a
   * thousand duplicates drains them two hundred at a time without knowing it.
   */
  const duplicates = useQuery({
    queryKey: ["staged", "duplicates", "queue"],
    queryFn: () =>
      api<PaginatedPage<StagedTransaction>>(
        `/api/v1/staged-transactions?${queryString({
          validity: "duplicate",
          limit: "200",
          sort: "date",
          direction: "asc",
        })}`,
      ),
  });
  const queue = duplicates.data?.items.map((stage) => stage.id) ?? [];
  const position = id ? queue.indexOf(id) : -1;
  const total = duplicates.data?.totalCount ?? 0;
  const at = (index: number) => (queue[index] ? `/staged/duplicates/${queue[index]}` : null);

  /**
   * Where to go once the row on screen has been dealt with: the one after it, or
   * the one before when it was the last, which is what makes dropping a row land
   * on more work rather than back at the list.
   *
   * Stamped with the row it was decided for, and only acted on while that row is
   * still the one on screen. Holding a bare path here navigated forever: this
   * component survives its own route parameter changing, so on arriving at the
   * next row the instruction was still set and sent it to the same place again,
   * which renders nothing at all.
   */
  const [handled, setHandled] = useState<{ from: string; to: string | "done" } | null>(null);
  const advanceTo = handled && handled.from === id ? handled.to : null;

  const review = useQuery({
    queryKey: ["staged", id, "duplicate"],
    queryFn: () => api<StagedDuplicateReview>(`/api/v1/staged-transactions/${id}/duplicate`),
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

  const deletion = useMutation({
    mutationFn: async (side: DuplicateReviewSide) => {
      const staged = side.staged!;
      await api("/api/v1/staged-transactions/bulk-delete", {
        ...json({
          stagedIds: [staged.id],
          expectedVersions: { [staged.id]: staged.version },
        }),
      });
      return staged.id;
    },
    onSuccess: async (deletedId) => {
      const wasSubject = review.data?.first.staged?.id === deletedId;
      // Read before the refetch, because the row is about to leave the queue and
      // its neighbors are what say where to go next.
      if (wasSubject && id) {
        setHandled({
          from: id,
          to: at(position + 1) ?? at(position - 1) ?? "done",
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["staged"],
          // The review itself is not worth refetching when its subject is gone:
          // the answer would be a red "Staged transaction not found" over an
          // empty screen, the failure looking exactly like the success.
          predicate: (entry) => !(wasSubject && entry.queryKey[2] === "duplicate"),
        }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      ]);
    },
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["staged"] });
  };

  const ready = accounts.data && categories.data;
  const error = review.error ?? duplicates.error ?? accounts.error ?? categories.error;

  const caughtUp = (
    <EmptyState
      icon={CheckCheck}
      // The answer to the whole screen rather than a section of it: this
      // replaces the review, so its heading is the page's own.
      level={2}
      title="No duplicates left to review"
      body="Nothing in the queue looks like a copy of anything else. Rows still waiting on you are on the queue itself."
      action={
        <Link className="button button-primary" to="/staged">
          Back to the queue
        </Link>
      }
    />
  );

  // Dealt with, so move on rather than back. This is the whole difference
  // between a page you visit once and a queue you work through.
  if (advanceTo) {
    return advanceTo === "done" ? (
      <>
        <PageHeader
          eyebrow="Review queue"
          title="Possible duplicates"
          description="Two records of what might be one payment, checked one pair at a time."
        />
        {/* 13.3's shape, on the branch that ends every run: the Drop button is
            inside the panel this replaces, so confirming unmounts the element
            the dialog's `close()` would have returned focus to and it falls to
            `<body>`. The neighbour case needs nothing — `<Navigate>` changes
            the pathname and the shell moves focus to `<main>` — so only the
            queue of one was bare, which is the common ending rather than an
            edge. `EmptyState` cannot take focus and `Note` is a plain `<p>`,
            so this is also the only thing here a screen reader announces. */}
        <Alert kind="success" takeFocus>
          The row was dropped. Nothing left in the queue looks like a copy of anything else.
        </Alert>
        {caughtUp}
      </>
    ) : (
      <Navigate to={advanceTo} replace />
    );
  }

  // Reached without naming a row, which is how the queue is entered from the
  // list: start at the first one that needs looking at.
  if (!id) {
    // The header first, then the state — its own loading branch was the one
    // of the three that dropped it, so the page lost its title for exactly
    // as long as the queue took to arrive.
    const entryHeader = (
      <PageHeader
        eyebrow="Review queue"
        title="Possible duplicates"
        description="Two records of what might be one payment, checked one pair at a time."
      />
    );
    if (duplicates.isPending)
      return (
        <>
          {entryHeader}
          <Skeleton height={320} label="Loading duplicates…" />
        </>
      );
    if (!queue[0]) {
      return (
        <>
          {entryHeader}
          {/* One or the other, never both. An errored query is not pending and
              leaves the queue empty, so "No duplicates left to review" was
              printed over the alert saying the queue could not be read — the
              one screen that tells somebody they are finished, shown when
              nothing is known. */}
          {error ? <Alert>{error.message}</Alert> : caughtUp}
        </>
      );
    }
    return <Navigate to={`/staged/duplicates/${queue[0]}`} replace />;
  }

  return (
    <>
      <PageHeader
        eyebrow={
          position >= 0 && total ? `Possible duplicate ${position + 1} of ${total}` : "Review queue"
        }
        title="Two records of one payment"
        description="Correct either side and save it, or drop the copy that should not be there. Only a staged row can be dropped: a committed transaction is already in the books."
        actions={
          /* A fragment and not a wrapper element, which is what this was. The
             responsive rule that gives a phone full-width header buttons is
             `.page-heading > .page-actions { width: 100% }` with
             `.page-heading > .page-actions .button { flex: 1 }`, and the child
             combinator means a `<div>` in between absorbs the full width and
             hands the buttons a content-sized box to divide instead — so this
             was the one page whose three header controls huddled at the left
             while Staged's and Templates' stretched edge to edge (web.md 7.5). */
          <>
            {/* Rendered as links rather than buttons so the browser's own back
                button walks the queue too, and so one can be opened in a new
                tab. Disabled at the ends by rendering a dead button instead,
                because a link with no destination is still focusable. */}
            {at(position - 1) ? (
              <Link className="button button-secondary" to={at(position - 1)!}>
                <ChevronLeft size={15} /> Previous
              </Link>
            ) : (
              <Button type="button" variant="secondary" disabled>
                <ChevronLeft size={15} /> Previous
              </Button>
            )}
            {at(position + 1) ? (
              <Link className="button button-secondary" to={at(position + 1)!}>
                Next <ChevronRight size={15} />
              </Link>
            ) : (
              <Button type="button" variant="secondary" disabled>
                Next <ChevronRight size={15} />
              </Button>
            )}
            <Link className="button button-ghost" to="/staged">
              Back to the queue
            </Link>
          </>
        }
      />

      {error ? <Alert>{error.message}</Alert> : null}
      {deletion.error ? <Alert>{deletion.error.message}</Alert> : null}

      {review.isPending || !ready ? (
        <div className="duplicate-review">
          <Skeleton height={320} label="Loading the comparison…" />
          <Skeleton height={320} />
        </div>
      ) : !review.data ? null : !review.data.second ? (
        <EmptyState
          icon={CheckCheck}
          title="Nothing repeats this anymore"
          body="Whatever it looked like a copy of has been changed, committed or dropped. This row is on its own now."
          action={
            // On to the next one where there is one: this row needs nothing
            // further, and stopping here would end the run over a row that has
            // already been settled.
            at(position + 1) ? (
              <Link className="button button-primary" to={at(position + 1)!}>
                Next duplicate <ChevronRight size={15} />
              </Link>
            ) : (
              <Link className="button button-primary" to="/staged">
                Back to the queue
              </Link>
            )
          }
        />
      ) : (
        <div className="duplicate-review">
          {[review.data.first, review.data.second].map((side, index) => {
            const staged = side.staged;
            const committed = side.committed;
            const summary = staged ? summarizeStagedDraft(staged.draft, accounts.data!) : null;
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
                  {/* Signed, as every movement is (`web.md` 10.1). On the one page
                      asking whether two records are the same payment, a $50
                      deposit and a $50 withdrawal read identically without it. */}
                  <span>
                    {committed
                      ? `${formatDate(committed.date)} · ${
                          (committed.sourceAmount ?? committed.destinationAmount)
                            ? `${movementSign(committed.type).sign}${formatMoney(
                                committed.sourceAmount ?? committed.destinationAmount ?? "0",
                                committed.sourceCurrency ?? committed.destinationCurrency ?? "",
                              )}`
                            : ""
                        }`
                      : summary?.amount && summary.currency
                        ? `${formatDate(String(staged?.draft.date ?? ""))} · ${
                            movementSign(String(staged?.draft.type ?? "")).sign
                          }${formatMoney(summary.amount, summary.currency)}`
                        : formatDate(String(staged?.draft.date ?? ""))}
                  </span>
                </div>

                <TransactionForm
                  accounts={accounts.data!}
                  categories={categories.data!}
                  transaction={committed ?? undefined}
                  staged={staged ?? undefined}
                  autoFocus={false}
                  onDone={refresh}
                />

                <div className="duplicate-side-actions">
                  {staged ? (
                    <Button
                      variant="danger"
                      loading={deletion.isPending}
                      onClick={() => drop.ask(staged.id, () => deletion.mutate(side))}
                    >
                      <Trash2 size={15} />
                      Drop this staged row
                    </Button>
                  ) : (
                    <Note>
                      Committed transactions are not dropped from here. If this is the copy to
                      remove, delete it from the transactions list.
                    </Note>
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
