import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  api,
  json,
  type Account,
  type Category,
  type Recurrence,
  type RecurrenceList,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  RowMenu,
  SortableHeader,
  compareForSort,
  compareMoney,
  formatDate,
  formatMoney,
  useConfirm,
  type SortState,
} from "../components.js";
import { RecurrenceForm, scheduleSentence } from "../forms.js";
import { Link } from "../router.js";
import { transactionTypeLabels } from "./TemplatesPage.js";

type RecurrenceSortField = "name" | "schedule" | "amount" | "next" | "proposed";

export default function RecurrencesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState<RecurrenceSortField>>({
    field: "next",
    direction: "asc",
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Recurrence | null>(null);
  const removal = useConfirm<Recurrence>();

  const recurrences = useQuery({
    queryKey: ["recurrences"],
    queryFn: () => api<RecurrenceList>("/api/v1/recurrences"),
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
    mutationFn: (recurrence: Recurrence) =>
      api(`/api/v1/recurrences/${recurrence.id}`, {
        ...json({ expectedVersion: recurrence.version }),
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["recurrences"] });
      await queryClient.invalidateQueries({ queryKey: ["staged"] });
    },
  });

  const currencyFor = (recurrence: Recurrence) => {
    const shape = recurrence.shape;
    const accountId =
      "fromAccountId" in shape ? shape.fromAccountId : shape.toAccountId;
    return accounts.data?.find((account) => account.id === accountId)?.currency;
  };

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matching = (recurrences.data?.items ?? []).filter(
      (recurrence) =>
        !term ||
        recurrence.name.toLowerCase().includes(term) ||
        recurrence.shape.payee.toLowerCase().includes(term),
    );
    const key = (recurrence: Recurrence) => {
      switch (sort.field) {
        case "name":
          return recurrence.name;
        case "schedule":
          return scheduleSentence(recurrence);
        case "amount":
          return recurrence.shape.amount ?? "";
        case "proposed":
          return recurrence.proposedCount;
        default:
          return recurrence.nextOccurrence.occurrenceDate;
      }
    };
    return [...matching].sort((left, right) => {
      // Amounts are stored exactly as typed, so comparing them as text puts
      // 1.45 above 1.50. The same branch the templates list already has.
      const leftAmount = left.shape.amount;
      const rightAmount = right.shape.amount;
      if (sort.field === "amount" && leftAmount && rightAmount) {
        return (
          (sort.direction === "asc" ? 1 : -1) * compareMoney(leftAmount, rightAmount)
        );
      }
      return compareForSort(key(left), key(right), sort.direction);
    });
  }, [recurrences.data, search, sort]);

  const overdue = visible.filter((recurrence) => recurrence.overdue).length;
  const error = recurrences.error ?? accounts.error ?? deletion.error;

  return (
    <>
      <PageHeader
        eyebrow="Ledger"
        title="Recurring"
        description="Standing instructions that propose a transaction into the review queue on a schedule. Nothing is posted until you commit it."
        actions={
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus size={16} /> New recurrence
          </Button>
        }
      />

      {error ? <Alert>{error.message}</Alert> : null}
      {overdue ? (
        <Alert kind="error">
          <AlertTriangle size={16} aria-hidden />{" "}
          {`${overdue} recurrence${overdue === 1 ? " is" : "s are"} past due with nothing proposed. Whatever runs the schedule has not run recently.`}
        </Alert>
      ) : null}

      <div className="category-toolbar">
        <label className="search-box">
          <span className="sr-only">Search recurrences</span>
          <Input
            type="search"
            placeholder="Search recurrences"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {recurrences.isPending || accounts.isPending ? (
        <p className="settings-note">Loading recurrences…</p>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Repeat size={25} />}
          title={
            recurrences.data?.items.length
              ? "No recurrence matches"
              : "No recurrences yet"
          }
          body={
            recurrences.data?.items.length
              ? "Nothing here matches that search."
              : "Set one up for anything that arrives on a schedule: rent, a salary, a subscription. Make one here, or open the menu on any transaction and choose “Save as recurring transaction”. Each due date puts a row in the review queue for you to check."
          }
        />
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableHeader field="name" label="Name" sort={sort} onSort={setSort} />
                  <SortableHeader
                    field="schedule"
                    label="Schedule"
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortableHeader
                    field="amount"
                    label="Amount"
                    lean="descending"
                    className="align-right"
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortableHeader
                    field="next"
                    label="Next"
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortableHeader
                    field="proposed"
                    label="Proposed"
                    lean="descending"
                    className="align-right"
                    sort={sort}
                    onSort={setSort}
                  />
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((recurrence) => (
                  <tr key={recurrence.id}>
                    <td>
                      <strong>{recurrence.name}</strong>
                      <span className="table-subtitle">
                        {transactionTypeLabels[recurrence.shape.type]} ·{" "}
                        {recurrence.shape.payee}
                      </span>
                    </td>
                    <td>{scheduleSentence(recurrence)}</td>
                    <td className="align-right">
                      {recurrence.shape.amount ? (
                        formatMoney(
                          recurrence.shape.amount,
                          currencyFor(recurrence) ?? "",
                        )
                      ) : (
                        <span className="template-blank">each time</span>
                      )}
                    </td>
                    <td>
                      <div className="transaction-payee">
                        <span>
                          {formatDate(recurrence.nextOccurrence.occurrenceDate)}
                        </span>
                        {recurrence.overdue ? (
                          <Badge tone="amber">Past due</Badge>
                        ) : recurrence.nextOccurrence.postedDate === null ? (
                          <Badge>Skipped</Badge>
                        ) : recurrence.nextOccurrence.postedDate !==
                          recurrence.nextOccurrence.occurrenceDate ? (
                          <Badge tone="blue">
                            Posts {formatDate(recurrence.nextOccurrence.postedDate)}
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="align-right">
                      {recurrence.proposedCount ? (
                        <Link
                          to={{
                            pathname: "/staged",
                            search: `recurrenceId=${recurrence.id}`,
                          }}
                          aria-label={`Rows waiting from ${recurrence.name}`}
                        >
                          {recurrence.proposedCount}
                        </Link>
                      ) : (
                        0
                      )}
                      {recurrence.committedCount ? (
                        <span className="table-subtitle">
                          {`${recurrence.committedCount} committed`}
                        </span>
                      ) : null}
                    </td>
                    <td className="row-actions">
                      <RowMenu label={`Actions for ${recurrence.name}`}>
                        <button type="button" onClick={() => setEditing(recurrence)}>
                          <Pencil size={15} /> Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() =>
                            removal.ask(recurrence, () => deletion.mutate(recurrence))
                          }
                        >
                          <Trash2 size={15} /> Delete
                        </button>
                      </RowMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Modal
        open={creating}
        title="New recurrence"
        description="It proposes into the review queue on each due date. Nothing is posted until you commit it."
        onClose={() => setCreating(false)}
      >
        {creating ? (
          <RecurrenceForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            onDone={() => setCreating(false)}
          />
        ) : null}
      </Modal>

      <Modal
        open={editing !== null}
        title="Edit recurrence"
        description="Changing the schedule changes what is proposed next. Rows already in the queue are left alone."
        onClose={() => setEditing(null)}
      >
        {editing ? (
          <RecurrenceForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            recurrence={editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Modal>

      <ConfirmDialog
        open={removal.open}
        title="Delete this recurrence?"
        confirmLabel="Delete"
        description={
          removal.value
            ? `“${removal.value.name}” stops proposing. Rows it has already put in the queue, and anything committed from them, are left exactly as they are.`
            : undefined
        }
        onCancel={removal.cancel}
        onConfirm={removal.confirm}
      />
    </>
  );
}
