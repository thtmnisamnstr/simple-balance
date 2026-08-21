import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutTemplate, ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import {
  api,
  json,
  type Account,
  type Category,
  type TransactionTemplate,
} from "../api.js";
import {
  Alert,
  Badge,
  formatDate,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  RowMenu,
  Select,
  SelectionCheckbox,
  SortableHeader,
  compareForSort,
  compareMoney,
  formatMoney,
  useConfirm,
  type SortState,
} from "../components.js";
import { TemplateForm } from "../forms.js";
import { Link } from "../router.js";
import { newIdempotencyKey } from "../idempotency.js";
import type { TransactionTemplateBulkPatch } from "../../shared/domain.js";

const PAGE_SIZE = 25;

type TemplateSortField =
  | "name"
  | "type"
  | "payee"
  | "amount"
  | "account"
  | "category"
  | "used";

/**
 * Which fields a mass edit offers.
 *
 * `name` is missing on purpose: names are unique per person, so one name across
 * many rows is a request that cannot be satisfied. `type` is set-only, because
 * a draft has to have one.
 */
const BULK_FIELDS = [
  { key: "type", label: "Type", clearable: false },
  { key: "payee", label: "Payee", clearable: true },
  { key: "fromAccountId", label: "Source account", clearable: true },
  { key: "toAccountId", label: "Destination account", clearable: true },
  { key: "amount", label: "Amount", clearable: true },
  { key: "categoryId", label: "Category", clearable: true },
] as const;

type BulkField = (typeof BULK_FIELDS)[number]["key"];
type BulkAction = "leave" | "set" | "clear";

export const transactionTypeLabels: Record<string, string> = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  transfer: "Transfer",
};

/** The account side each type reads, so the other is never asked for. */
const sideForType: Record<string, "fromAccountId" | "toAccountId" | "both"> = {
  deposit: "toAccountId",
  withdrawal: "fromAccountId",
  transfer: "both",
};

function accountAllowed(
  field: "fromAccountId" | "toAccountId",
  type: string,
) {
  const side = sideForType[type];
  return side === "both" || side === field;
}

export default function TemplatesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState<SortState<TemplateSortField>>({
    field: "name",
    direction: "asc",
  });
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<TransactionTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [actions, setActions] = useState<Record<BulkField, BulkAction>>({
    type: "leave",
    payee: "leave",
    fromAccountId: "leave",
    toAccountId: "leave",
    amount: "leave",
    categoryId: "leave",
  });
  const [values, setValues] = useState<Record<BulkField, string>>({
    type: "withdrawal",
    payee: "",
    fromAccountId: "",
    toAccountId: "",
    amount: "",
    categoryId: "",
  });
  const removal = useConfirm<TransactionTemplate>();
  const bulkRemoval = useConfirm<number>();

  const templates = useQuery({
    queryKey: ["transaction-templates"],
    queryFn: () => api<TransactionTemplate[]>("/api/v1/transaction-templates"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/api/v1/categories"),
  });

  const accountName = (id: string | undefined) =>
    id ? accounts.data?.find((account) => account.id === id)?.name : undefined;
  const categoryName = (id: string | undefined) =>
    id ? categories.data?.find((category) => category.id === id)?.name : undefined;
  /**
   * What a template's category column says, whether it holds one category or a
   * split. A template's legs carry no amounts of their own, so the first is as
   * good a name for the row as any and the badge carries the rest.
   */
  const categoryLabel = (template: TransactionTemplate) => {
    const legs = template.draft.legs;
    if (!legs?.length) return categoryName(template.draft.categoryId);
    return (
      categoryName(legs[0]!.categoryId) ?? legs[0]!.categoryName ?? undefined
    );
  };

  const accountLabel = (template: TransactionTemplate) => {
    const { draft } = template;
    if (draft.type === "transfer" || (!draft.type && draft.fromAccountId && draft.toAccountId)) {
      const from = accountName(draft.fromAccountId);
      const to = accountName(draft.toAccountId);
      if (!draft.fromAccountId && !draft.toAccountId) return null;
      return `${from ?? "Unavailable"} → ${to ?? "Unavailable"}`;
    }
    const id =
      draft.type === "deposit"
        ? draft.toAccountId
        : (draft.fromAccountId ?? draft.toAccountId);
    if (!id) return null;
    return accountName(id) ?? "Unavailable";
  };

  const currencyFor = (template: TransactionTemplate) => {
    const { draft } = template;
    const id =
      draft.type === "deposit"
        ? draft.toAccountId
        : (draft.fromAccountId ?? draft.toAccountId);
    return accounts.data?.find((account) => account.id === id)?.currency ?? "USD";
  };

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = (templates.data ?? []).filter((template) => {
      if (typeFilter && template.draft.type !== typeFilter) return false;
      if (!term) return true;
      return [template.name, template.draft.payee, template.draft.notes]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
    const sorted = [...rows].sort((left, right) => {
      const order =
        sort.field === "amount"
          ? left.draft.amount && right.draft.amount
            ? (sort.direction === "asc" ? 1 : -1) *
              compareMoney(left.draft.amount, right.draft.amount)
            : compareForSort(
                left.draft.amount ?? null,
                right.draft.amount ?? null,
                sort.direction,
              )
          : compareForSort(
              sort.field === "name"
                ? left.name
                : sort.field === "type"
                  ? left.draft.type
                  : sort.field === "payee"
                    ? (left.draft.payee ?? null)
                    : sort.field === "account"
                      ? accountLabel(left)
                      : sort.field === "used"
                        ? (left.totalTransactionCount ?? 0)
                        : (categoryLabel(left) ?? null),
              sort.field === "name"
                ? right.name
                : sort.field === "type"
                  ? right.draft.type
                  : sort.field === "payee"
                    ? (right.draft.payee ?? null)
                    : sort.field === "account"
                      ? accountLabel(right)
                      : sort.field === "used"
                        ? (right.totalTransactionCount ?? 0)
                        : (categoryLabel(right) ?? null),
              sort.direction,
            );
      return order || left.name.localeCompare(right.name);
    });
    return sorted;
  }, [templates.data, accounts.data, categories.data, search, typeFilter, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const selectedIds = Object.keys(selection);
  const selectedTemplates = (templates.data ?? []).filter(
    (template) => template.id in selection,
  );
  const pageSelected = visible.filter((template) => template.id in selection);
  const selectionItems = selectedIds.map((id) => ({
    id,
    expectedVersion: selection[id]!,
  }));

  const clearSelection = () => setSelection({});

  const toggleOne = (template: TransactionTemplate, checked: boolean) =>
    setSelection((current) => {
      const next = { ...current };
      if (checked) next[template.id] = template.version;
      else delete next[template.id];
      return next;
    });

  const togglePage = (checked: boolean) =>
    setSelection((current) => {
      const next = { ...current };
      for (const template of visible) {
        if (checked) next[template.id] = template.version;
        else delete next[template.id];
      }
      return next;
    });

  const selectAllMatching = () =>
    setSelection(
      Object.fromEntries(
        filtered.map((template) => [template.id, template.version]),
      ),
    );

  const afterBulk = async (message: string) => {
    clearSelection();
    setBulkEditing(false);
    setNotice(message);
    await queryClient.invalidateQueries({ queryKey: ["transaction-templates"] });
  };

  const bulkEdit = useMutation({
    mutationFn: (patch: TransactionTemplateBulkPatch) =>
      api<{ changedCount: number }>(
        "/api/v1/transaction-templates/bulk-edit",
        json({
          selection: { items: selectionItems },
          patch,
          idempotencyKey: newIdempotencyKey(),
        }),
      ),
    onSuccess: (result) =>
      afterBulk(
        `${result.changedCount} template${result.changedCount === 1 ? "" : "s"} changed.`,
      ),
  });

  const bulkDelete = useMutation({
    mutationFn: () =>
      api<{ changedCount: number }>(
        "/api/v1/transaction-templates/bulk-delete",
        json({
          selection: { items: selectionItems },
          idempotencyKey: newIdempotencyKey(),
        }),
      ),
    onSuccess: (result) =>
      afterBulk(
        `${result.changedCount} template${result.changedCount === 1 ? "" : "s"} deleted.`,
      ),
  });

  const deletion = useMutation({
    mutationFn: (template: TransactionTemplate) =>
      api(`/api/v1/transaction-templates/${template.id}`, {
        ...json({ expectedVersion: template.version }),
        method: "DELETE",
      }),
    onSuccess: async () => {
      clearSelection();
      await queryClient.invalidateQueries({
        queryKey: ["transaction-templates"],
      });
    },
  });

  const selectedTypes = new Set(
    selectedTemplates.map((template) =>
      actions.type === "set" ? values.type : template.draft.type,
    ),
  );
  const sideUnavailable = (field: "fromAccountId" | "toAccountId") =>
    [...selectedTypes].some((type) => type && !accountAllowed(field, type));

  const resetBulkForm = () => {
    setActions({
      type: "leave",
      payee: "leave",
      fromAccountId: "leave",
      toAccountId: "leave",
      amount: "leave",
      categoryId: "leave",
    });
    setValues({
      type: "withdrawal",
      payee: "",
      fromAccountId: "",
      toAccountId: "",
      amount: "",
      categoryId: "",
    });
  };

  const setTargetType = (type: string) => {
    setValues((current) => ({ ...current, type }));
    setActions((current) => ({
      ...current,
      fromAccountId:
        current.fromAccountId === "set" && !accountAllowed("fromAccountId", type)
          ? "leave"
          : current.fromAccountId,
      toAccountId:
        current.toAccountId === "set" && !accountAllowed("toAccountId", type)
          ? "leave"
          : current.toAccountId,
    }));
  };

  const submitBulkEdit = (event: FormEvent) => {
    event.preventDefault();
    const patch: Record<string, unknown> = {};
    for (const field of BULK_FIELDS) {
      const action = actions[field.key];
      if (action === "leave") continue;
      patch[field.key] = action === "clear" ? null : values[field.key];
    }
    if (!Object.keys(patch).length) return;
    bulkEdit.mutate(patch as TransactionTemplateBulkPatch);
  };

  const anyChange = BULK_FIELDS.some((field) => actions[field.key] !== "leave");
  const error =
    templates.error ??
    accounts.error ??
    categories.error ??
    bulkDelete.error ??
    deletion.error;

  return (
    <>
      <PageHeader
        eyebrow="Ledger"
        title="Templates"
        description="Saved starting points for a transaction you enter often."
        actions={
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus size={16} /> New template
          </Button>
        }
      />

      {error ? <Alert>{error.message}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}

      <div className="category-toolbar">
        <label className="search-box">
          <span className="sr-only">Search templates</span>
          <Input
            type="search"
            placeholder="Search templates"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
              clearSelection();
            }}
          />
        </label>
        <Field label="Type">
          <Select
            value={typeFilter}
            onChange={(event) => {
              setTypeFilter(event.target.value);
              setPage(1);
              clearSelection();
            }}
          >
            <option value="">Every type</option>
            <option value="deposit">Deposit</option>
            <option value="withdrawal">Withdrawal</option>
            <option value="transfer">Transfer</option>
          </Select>
        </Field>
      </div>

      {selectedIds.length ? (
        <div className="transaction-selection-bar" aria-live="polite">
          <div>
            <ListChecks size={17} aria-hidden />
            <strong>
              {`${selectedIds.length} template${selectedIds.length === 1 ? "" : "s"} selected`}
            </strong>
          </div>
          <div className="transaction-selection-actions">
            {selectedIds.length < filtered.length ? (
              <Button
                type="button"
                variant="secondary"
                onClick={selectAllMatching}
              >
                {`Select all ${filtered.length} matching`}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                resetBulkForm();
                setBulkEditing(true);
              }}
            >
              <Pencil size={16} /> Edit selected
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() =>
                bulkRemoval.ask(selectedIds.length, () => bulkDelete.mutate())
              }
            >
              <Trash2 size={16} /> Delete selected
            </Button>
            <Button type="button" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {templates.isPending || accounts.isPending || categories.isPending ? (
        <p className="settings-note">Loading templates…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<LayoutTemplate size={25} />}
          title={
            templates.data?.length
              ? "No template matches"
              : "No templates yet"
          }
          body={
            templates.data?.length
              ? "Nothing here matches that search."
              : "Make one here, or open the menu on any transaction and choose “Save as template”."
          }
        />
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="checkbox-cell">
                    <SelectionCheckbox
                      aria-label="Select all templates on this page"
                      checked={
                        visible.length > 0 &&
                        pageSelected.length === visible.length
                      }
                      indeterminate={
                        pageSelected.length > 0 &&
                        pageSelected.length < visible.length
                      }
                      onChange={(event) => togglePage(event.target.checked)}
                    />
                  </th>
                  <SortableHeader
                    field="name"
                    label="Name"
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortableHeader
                    field="type"
                    label="Type"
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortableHeader
                    field="payee"
                    label="Payee"
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortableHeader
                    field="account"
                    label="Account"
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortableHeader
                    field="category"
                    label="Category"
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
                    field="used"
                    label="Used"
                    lean="descending"
                    className="align-right"
                    sort={sort}
                    onSort={setSort}
                  />
                  <th scope="col">Reminder</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((template) => {
                  const account = accountLabel(template);
                  const category = categoryName(template.draft.categoryId);
                  return (
                    <tr key={template.id}>
                      <td className="checkbox-cell">
                        <SelectionCheckbox
                          aria-label={`Select ${template.name}`}
                          checked={template.id in selection}
                          onChange={(event) =>
                            toggleOne(template, event.target.checked)
                          }
                        />
                      </td>
                      <td>
                        <strong>{template.name}</strong>
                      </td>
                      <td>
                        {template.draft.type ? (
                          transactionTypeLabels[template.draft.type]
                        ) : (
                          <span className="template-blank">blank</span>
                        )}
                      </td>
                      <td>
                        {template.draft.payee ?? (
                          <span className="template-blank">blank</span>
                        )}
                      </td>
                      <td>
                        {account ? (
                          account
                        ) : (
                          <span className="template-blank">blank</span>
                        )}
                      </td>
                      <td>
                        {template.draft.legs?.length ? (
                          <div className="transaction-payee">
                            <span>{categoryLabel(template) ?? "Unavailable"}</span>
                            <Badge tone="blue">
                              Split · {template.draft.legs.length}
                            </Badge>
                          </div>
                        ) : template.draft.categoryId ? (
                          (category ?? "Unavailable")
                        ) : (
                          <span className="template-blank">blank</span>
                        )}
                      </td>
                      <td className="align-right">
                        {template.draft.amount ? (
                          formatMoney(
                            template.draft.amount,
                            currencyFor(template),
                          )
                        ) : (
                          <span className="template-blank">blank</span>
                        )}
                      </td>
                      <td className="align-right">
                        <Link
                          to={{ pathname: `/templates/${template.id}` }}
                          aria-label={`Transactions from ${template.name}`}
                        >
                          {template.totalTransactionCount ?? 0}
                        </Link>
                        {template.stagedTransactionCount ? (
                          <span className="table-subtitle">
                            {`${template.transactionCount ?? 0} committed · ${template.stagedTransactionCount} pending`}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {template.notification ? (
                          <div className="transaction-payee">
                            <Badge tone={template.notification.repeats ? "blue" : undefined}>
                              {template.notification.repeats ? "Repeating" : "Once"}
                            </Badge>
                            <span className="table-subtitle">
                              {template.notification.nextNotificationDate
                                ? `${formatDate(template.notification.nextNotificationDate)} at ${template.notification.time}`
                                : template.notification.repeats
                                  ? // A repeating rule owing nothing is not a
                                    // rule that has finished: every occurrence
                                    // it would have is one its policies skip.
                                    "never — every date is skipped"
                                  : "sent"}
                            </span>
                          </div>
                        ) : (
                          <span className="template-blank">none</span>
                        )}
                      </td>
                      <td className="row-actions">
                        <RowMenu label={`Actions for ${template.name}`}>
                          <button
                            type="button"
                            onClick={() => setEditing(template)}
                          >
                            <Pencil size={15} /> Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() =>
                              removal.ask(template, () =>
                                deletion.mutate(template),
                              )
                            }
                          >
                            <Trash2 size={15} /> Delete
                          </button>
                        </RowMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            page={currentPage}
            pageSize={PAGE_SIZE}
            totalCount={filtered.length}
            totalPages={totalPages}
            onPageChange={setPage}
            itemLabel="templates"
          />
        </section>
      )}

      <Modal
        open={creating}
        title="New template"
        description="Anything you leave blank is not saved, and you fill it in when you use the template."
        onClose={() => setCreating(false)}
      >
        {creating ? (
          <TemplateForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            initialDraft={{ type: "withdrawal" }}
            onDone={() => setCreating(false)}
          />
        ) : null}
      </Modal>

      <Modal
        open={editing !== null}
        title="Edit template"
        description="Anything you leave blank is not saved, and you fill it in when you use the template."
        onClose={() => setEditing(null)}
      >
        {editing ? (
          <TemplateForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            template={editing}
            onDone={() => {
              setEditing(null);
              clearSelection();
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={bulkEditing}
        title={`Edit ${selectedIds.length} template${selectedIds.length === 1 ? "" : "s"}`}
        description="A field left alone keeps what each template already holds."
        onClose={() => setBulkEditing(false)}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setBulkEditing(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="template-bulk-edit-form"
              disabled={!anyChange}
              loading={bulkEdit.isPending}
            >
              Apply
            </Button>
          </>
        }
      >
        <form
          id="template-bulk-edit-form"
          className="bulk-edit-form"
          onSubmit={submitBulkEdit}
        >
          {bulkEdit.error ? <Alert>{bulkEdit.error.message}</Alert> : null}
          <div className="bulk-edit-fields">
            {BULK_FIELDS.map((field) => {
              const action = actions[field.key];
              const isAccount =
                field.key === "fromAccountId" || field.key === "toAccountId";
              const blocked =
                isAccount &&
                sideUnavailable(field.key as "fromAccountId" | "toAccountId");
              return (
                <div
                  key={field.key}
                  className={
                    action === "leave"
                      ? "bulk-edit-field"
                      : "bulk-edit-field enabled"
                  }
                >
                  <Field label={field.label}>
                    <Select
                      className="bulk-edit-action"
                      value={action}
                      onChange={(event) => {
                        const next = event.target.value as BulkAction;
                        if (field.key === "type" && next === "set") {
                          setTargetType(values.type);
                        }
                        setActions((current) => ({
                          ...current,
                          [field.key]: next,
                        }));
                      }}
                    >
                      <option value="leave">Leave alone</option>
                      <option value="set" disabled={blocked}>
                        Set to
                      </option>
                      {field.clearable ? (
                        <option value="clear">
                          Clear so it is filled in on use
                        </option>
                      ) : null}
                    </Select>
                  </Field>
                  {blocked ? (
                    <p className="settings-note">
                      {field.key === "fromAccountId"
                        ? "A deposit has no source account, so this cannot be set for everything selected."
                        : "A withdrawal has no destination account, so this cannot be set for everything selected."}
                    </p>
                  ) : null}
                  {field.key === "type" ? (
                    <Select
                      aria-label="New type"
                      value={values.type}
                      disabled={action !== "set"}
                      onChange={(event) => setTargetType(event.target.value)}
                    >
                      <option value="withdrawal">Withdrawal</option>
                      <option value="deposit">Deposit</option>
                      <option value="transfer">Transfer</option>
                    </Select>
                  ) : isAccount ? (
                    <Select
                      aria-label={`New ${field.label.toLowerCase()}`}
                      value={values[field.key]}
                      disabled={action !== "set"}
                      required={action === "set"}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Choose an account</option>
                      {accounts.data?.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </Select>
                  ) : field.key === "categoryId" ? (
                    <Select
                      aria-label="New category"
                      value={values.categoryId}
                      disabled={action !== "set"}
                      required={action === "set"}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          categoryId: event.target.value,
                        }))
                      }
                    >
                      <option value="">Choose a category</option>
                      {categories.data?.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      aria-label={`New ${field.label.toLowerCase()}`}
                      inputMode={field.key === "amount" ? "decimal" : undefined}
                      value={values[field.key]}
                      disabled={action !== "set"}
                      required={action === "set"}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={removal.open}
        title="Delete this template?"
        description={
          removal.value
            ? `“${removal.value.name}” is removed. Transactions already made from it are untouched.`
            : undefined
        }
        onCancel={removal.cancel}
        onConfirm={removal.confirm}
      />

      <ConfirmDialog
        open={bulkRemoval.open}
        title={`Delete ${bulkRemoval.value ?? 0} template${bulkRemoval.value === 1 ? "" : "s"}?`}
        description="They are removed together. Transactions already made from them are untouched."
        onCancel={bulkRemoval.cancel}
        onConfirm={bulkRemoval.confirm}
      />
    </>
  );
}
