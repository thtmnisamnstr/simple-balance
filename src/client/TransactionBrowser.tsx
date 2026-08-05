import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Download,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  LayoutTemplate,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Link, payeeDetailSearch, useLocation } from "./router.js";
import {
  api,
  ApiClientError,
  json,
  queryString,
  type Account,
  type Category,
  type PaginatedPage,
  type StagedTransaction,
  type Transaction,
  type TransactionBulkEditFilter,
  type TransactionBulkEditPatch,
  type TransactionBulkEditResult,
  type TransactionBulkEditSelection,
  type TransactionBulkSelectionPreview,
} from "./api.js";
import {
  Alert,
  Badge,
  Button,
  DateRangeBar,
  EmptyState,
  formatDate,
  formatMoney,
  Input,
  Modal,
  Pagination,
  RowMenu,
  Select,
  SelectionCheckbox,
  ConfirmDialog,
  SortableHeader,
  type SortState,
  Textarea,
  useConfirm,
} from "./components.js";
import {
  draftForTransactionForm,
  summarizeStagedDraft,
  templateDraftFromDraft,
} from "./staged-draft.js";
import type { TransactionSortField } from "../shared/domain.js";
import { useDateRange } from "./date-range.js";
import { TemplateForm, TransactionForm, draftFromTransaction } from "./forms.js";
import { newIdempotencyKey } from "./idempotency.js";

const typeMeta = {
  deposit: { label: "Deposit", icon: ArrowDownLeft },
  withdrawal: { label: "Withdrawal", icon: ArrowUpRight },
  transfer: { label: "Transfer", icon: ArrowLeftRight },
};

type SelectionState =
  | { mode: "ids"; versions: Record<string, number> }
  | { mode: "filter"; excludedIds: Set<string> };

type BulkEditField =
  | "date"
  | "payee"
  | "categoryId"
  | "accountId"
  | "description"
  | "notes"
  | "type";

type BulkEditValues = {
  date: string;
  payee: string;
  categoryId: string;
  accountId: string;
  description: string;
  notes: string;
  type: "deposit" | "withdrawal";
};

type BulkEditRequest = {
  selection: TransactionBulkEditSelection;
  patch: TransactionBulkEditPatch;
  idempotencyKey: string;
  allowDuplicates: boolean;
  dryRun: false;
};

const bulkEditFields: BulkEditField[] = [
  "date",
  "payee",
  "categoryId",
  "accountId",
  "description",
  "notes",
  "type",
];

const emptySelection = (): SelectionState => ({ mode: "ids", versions: {} });

const emptyBulkEditEnabled = (): Record<BulkEditField, boolean> => ({
  date: false,
  payee: false,
  categoryId: false,
  accountId: false,
  description: false,
  notes: false,
  type: false,
});

const emptyBulkEditValues = (accountId = ""): BulkEditValues => ({
  date: "",
  payee: "",
  categoryId: "",
  accountId,
  description: "",
  notes: "",
  type: "withdrawal",
});

function normalizeName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function TransactionBrowser({
  fixedAccountId,
  fixedCategoryId,
  fixedPayee,
  initialType,
  allowCreate = true,
  showDateRange = true,
  includeStaged = false,
}: {
  fixedAccountId?: string;
  fixedCategoryId?: string;
  fixedPayee?: string;
  initialType?: "deposit" | "withdrawal" | "transfer";
  allowCreate?: boolean;
  showDateRange?: boolean;
  /**
   * Also list the staged rows that reference this category or payee. They are
   * shown for context only: staged rows post nothing, so they are never
   * selectable for a committed bulk edit.
   */
  includeStaged?: boolean;
}) {
  const { start, end } = useDateRange();
  const location = useLocation();
  const [editing, setEditing] = useState<Transaction | "new" | null>(null);
  const [savingTemplate, setSavingTemplate] = useState<Transaction | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [accountId, setAccountId] = useState(fixedAccountId ?? "");
  const [showDeleted, setShowDeleted] = useState(false);
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkEnabled, setBulkEnabled] = useState(emptyBulkEditEnabled);
  const [bulkValues, setBulkValues] = useState(emptyBulkEditValues);
  const [bulkIdempotencyKey, setBulkIdempotencyKey] = useState<string | null>(
    null,
  );
  const [bulkNotice, setBulkNotice] = useState<{
    kind: "success" | "info";
    message: string;
  } | null>(null);
  const payeeListId = useId();
  const queryClient = useQueryClient();
  const selectedAccountId = fixedAccountId ?? accountId;
  const params = {
    start,
    end,
    search: search || undefined,
    type: type || undefined,
    accountId: selectedAccountId || undefined,
    categoryId: fixedCategoryId || undefined,
    payee: fixedPayee || undefined,
    includeDeleted: showDeleted ? "true" : undefined,
  };
  const bulkFilter: TransactionBulkEditFilter = {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(search ? { search } : {}),
    ...(type
      ? { type: type as "deposit" | "withdrawal" | "transfer" }
      : {}),
    ...(selectedAccountId ? { accountId: selectedAccountId } : {}),
    ...(fixedCategoryId ? { categoryId: fixedCategoryId } : {}),
    ...(fixedPayee ? { payee: fixedPayee } : {}),
    includeDeleted: showDeleted,
  };
  const selectionConstraintKey = JSON.stringify(bulkFilter);
  const [page, setPage] = useState(1);
  const deletion = useConfirm<number>();
  const rowDeletion = useConfirm<Transaction>();
  const [sort, setSort] = useState<SortState<TransactionSortField>>({
    field: "date",
    direction: "desc",
  });
  // Reordering re-cuts the pages, so the row that was at the top of page three
  // is no longer there. Going back to the first page is the honest answer.
  const applySort = (next: SortState<TransactionSortField>) => {
    setSort(next);
    setPage(1);
  };
  const transactions = useQuery({
    queryKey: ["transactions", params, page, sort],
    queryFn: () =>
      api<PaginatedPage<Transaction>>(
        `/api/v1/transactions?${queryString({
          ...params,
          page: String(page),
          sort: sort.field,
          direction: sort.direction,
        })}`,
      ),
    placeholderData: (previous) => previous,
  });
  const staged = useQuery({
    queryKey: ["staged", "for-browser", fixedCategoryId, fixedPayee, start, end],
    queryFn: () =>
      api<PaginatedPage<StagedTransaction>>(
        `/api/v1/staged-transactions?${queryString({
          categoryId: fixedCategoryId,
          payee: fixedPayee,
          start,
          end,
          limit: "100",
        })}`,
      ),
    enabled: includeStaged && Boolean(fixedCategoryId || fixedPayee),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });
  const categories = useQuery({
    queryKey: ["categories", true],
    queryFn: () => api<Category[]>("/api/v1/categories?includeArchived=true"),
  });
  const payeeSuggestions = useQuery({
    queryKey: [
      "payees",
      "suggestions",
      bulkValues.payee.trim().toLowerCase(),
    ],
    queryFn: () =>
      api<string[]>(
        `/api/v1/payees/suggestions?search=${encodeURIComponent(
          bulkValues.payee.trim(),
        )}`,
      ),
    enabled: bulkEditing && bulkEnabled.payee,
    placeholderData: (previous) => previous,
  });
  const filterExcludedIds =
    selection.mode === "filter" ? [...selection.excludedIds].sort() : [];
  const filterSelectionPreview = useQuery({
    queryKey: [
      "transactions",
      "bulk-selection",
      bulkFilter,
      filterExcludedIds,
    ],
    queryFn: () =>
      api<TransactionBulkSelectionPreview>(
        "/api/v1/transactions/bulk-selection",
        {
          ...json({ filter: bulkFilter, excludedIds: filterExcludedIds }),
        },
      ),
    enabled: selection.mode === "filter",
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const deleteMutation = useMutation({
    mutationFn: ({
      transaction,
      deleted,
      allowDuplicate = false,
    }: {
      transaction: Transaction;
      deleted: boolean;
      allowDuplicate?: boolean;
    }) =>
      api<Transaction>(`/api/v1/transactions/${transaction.id}/deleted`, {
        ...json({
          expectedVersion: transaction.version,
          deleted,
          allowDuplicate,
        }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
      ]);
    },
  });
  const items = transactions.data?.items ?? [];
  const totalMatching = transactions.data?.totalCount ?? items.length;
  const stagedRows = staged.data?.items ?? [];
  const activeAccounts = (accounts.data ?? []).filter(
    (account) => !account.archivedAt,
  );
  const activeCategories = (categories.data ?? []).filter(
    (category) => !category.archivedAt,
  );
  const selectedLoadedItems = items.filter((transaction) =>
    selection.mode === "filter"
      ? !selection.excludedIds.has(transaction.id)
      : Object.hasOwn(selection.versions, transaction.id),
  );
  const explicitSelectedCount =
    selection.mode === "ids" ? Object.keys(selection.versions).length : 0;
  const explicitSelectionHasMissingRows =
    selection.mode === "ids" &&
    explicitSelectedCount !== selectedLoadedItems.length;
  const allLoadedSelected =
    items.length > 0 && selectedLoadedItems.length === items.length;
  const someLoadedSelected = selectedLoadedItems.length > 0;
  const hasSelection =
    selection.mode === "filter" || explicitSelectedCount > 0;
  const selectedTransferCount =
    selection.mode === "filter"
      ? (filterSelectionPreview.data?.transferCount ?? 0)
      : selectedLoadedItems.filter(
          (transaction) => transaction.type === "transfer",
        ).length;
  const selectedCurrencies =
    selection.mode === "filter"
      ? (filterSelectionPreview.data?.currencies ?? [])
      : [
          ...new Set(
            selectedLoadedItems.flatMap((transaction) =>
              transaction.type === "deposit"
                ? [transaction.destinationCurrency].filter(Boolean)
                : transaction.type === "withdrawal"
                  ? [transaction.sourceCurrency].filter(Boolean)
                  : [
                      transaction.sourceCurrency,
                      transaction.destinationCurrency,
                    ].filter(Boolean),
            ) as string[],
          ),
        ].sort();
  const selectionContainsTransfers = selectedTransferCount > 0;
  const selectionMayIncludeDeleted =
    selection.mode === "filter"
      ? bulkFilter.includeDeleted
      : selectedLoadedItems.some((transaction) => Boolean(transaction.deletedAt));
  const selectedBulkAccount = activeAccounts.find(
    (account) => account.id === bulkValues.accountId,
  );
  const accountChangeUnavailable =
    explicitSelectionHasMissingRows ||
    selectionContainsTransfers ||
    selectedCurrencies.length !== 1;
  const accountChangeBlocked =
    bulkEnabled.accountId &&
    (accountChangeUnavailable ||
      selectedBulkAccount?.currency !== selectedCurrencies[0]);
  const typeChangeUnavailable =
    explicitSelectionHasMissingRows || selectionContainsTransfers;
  const typeChangeBlocked = bulkEnabled.type && typeChangeUnavailable;
  const hasEnabledBulkField = bulkEditFields.some(
    (field) => bulkEnabled[field],
  );
  const filterSelectionReady =
    selection.mode === "ids" ||
    (Boolean(filterSelectionPreview.data) &&
      !filterSelectionPreview.isFetching &&
      !filterSelectionPreview.error &&
      filterSelectionPreview.data!.count > 0);
  const enabledRequiredValuesAreValid =
    (!bulkEnabled.date || /^\d{4}-\d{2}-\d{2}$/.test(bulkValues.date)) &&
    (!bulkEnabled.payee || Boolean(bulkValues.payee.trim())) &&
    (!bulkEnabled.accountId ||
      activeAccounts.some((account) => account.id === bulkValues.accountId));
  const canSubmitBulkEdit =
    hasSelection &&
    filterSelectionReady &&
    hasEnabledBulkField &&
    enabledRequiredValuesAreValid &&
    !accountChangeBlocked &&
    !typeChangeBlocked;
  const discardBulkSelectionSnapshots = () =>
    queryClient.removeQueries({
      queryKey: ["transactions", "bulk-selection"],
    });

  const clearTransactionSelection = () => {
    discardBulkSelectionSnapshots();
    setSelection(emptySelection());
  };

  const bulkDeleteMutation = useMutation<
    TransactionBulkEditResult,
    Error,
    {
      selection: TransactionBulkEditSelection;
      idempotencyKey: string;
      dryRun: false;
    }
  >({
    mutationFn: (request) =>
      api<TransactionBulkEditResult>("/api/v1/transactions/bulk-delete", {
        ...json(request),
      }),
    onSuccess: async (result) => {
      clearTransactionSelection();
      setBulkNotice({
        kind: "success",
        message: `Deleted ${result.updatedCount} transaction${
          result.updatedCount === 1 ? "" : "s"
        }.`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
      ]);
    },
    // Without this, a selection that went stale leaves the same snapshot in
    // place and every retry fails against it again, with nothing on screen
    // explaining why.
    onError: async (error) => {
      if (error instanceof ApiClientError && error.code === "STALE_VERSION") {
        clearTransactionSelection();
        setBulkNotice({
          kind: "info",
          message:
            "A selected transaction changed. Review the refreshed list and select the transactions again.",
        });
        await queryClient.invalidateQueries({ queryKey: ["transactions"] });
      }
    },
  });

  const bulkMutation = useMutation<
    TransactionBulkEditResult,
    Error,
    BulkEditRequest
  >({
    mutationFn: (request) =>
      api<TransactionBulkEditResult>("/api/v1/transactions/bulk-edit", {
        ...json(request),
      }),
    onSuccess: async (result) => {
      setBulkEditing(false);
      setBulkIdempotencyKey(null);
      setSelection(emptySelection());
      setBulkNotice({
        kind: "success",
        message: `${result.updatedCount} transaction${result.updatedCount === 1 ? "" : "s"} updated.`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["audit-events"] }),
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
        queryClient.invalidateQueries({ queryKey: ["payees"] }),
      ]);
    },
    onError: async (error) => {
      if (
        error instanceof ApiClientError &&
        error.code === "STALE_VERSION"
      ) {
        if (selection.mode === "ids") {
          setBulkEditing(false);
          setBulkIdempotencyKey(null);
          setSelection(emptySelection());
          setBulkNotice({
            kind: "info",
            message:
              "A selected transaction changed. Review the refreshed list and select the transactions again.",
          });
        }
        await queryClient.invalidateQueries({ queryKey: ["transactions"] });
      }
    },
  });

  useEffect(() => {
    discardBulkSelectionSnapshots();
    setSelection(emptySelection());
    setBulkEditing(false);
    setBulkIdempotencyKey(null);
    setBulkNotice(null);
    // A narrower filter can leave the current page past the end of the results.
    setPage(1);
  }, [selectionConstraintKey]);

  useEffect(() => {
    if (!bulkEnabled.payee || !bulkValues.payee.trim()) return;
    const exact = payeeSuggestions.data?.find(
      (candidate) => normalizeName(candidate) === normalizeName(bulkValues.payee),
    );
    if (exact && exact !== bulkValues.payee) {
      setBulkValues((current) => ({ ...current, payee: exact }));
    }
  }, [bulkEnabled.payee, bulkValues.payee, payeeSuggestions.data]);

  const toggleLoadedSelection = (checked: boolean) => {
    if (selection.mode === "filter") discardBulkSelectionSnapshots();
    setSelection((current) => {
      if (current.mode === "filter") {
        const excludedIds = new Set(current.excludedIds);
        for (const transaction of items) {
          if (checked) excludedIds.delete(transaction.id);
          else excludedIds.add(transaction.id);
        }
        return { mode: "filter", excludedIds };
      }
      const versions = { ...current.versions };
      for (const transaction of items) {
        if (checked) versions[transaction.id] = transaction.version;
        else delete versions[transaction.id];
      }
      return { mode: "ids", versions };
    });
  };

  const toggleTransactionSelection = (
    transaction: Transaction,
    checked: boolean,
  ) => {
    if (selection.mode === "filter") discardBulkSelectionSnapshots();
    setSelection((current) => {
      if (current.mode === "filter") {
        const excludedIds = new Set(current.excludedIds);
        if (checked) excludedIds.delete(transaction.id);
        else excludedIds.add(transaction.id);
        return { mode: "filter", excludedIds };
      }
      const versions = { ...current.versions };
      if (checked) versions[transaction.id] = transaction.version;
      else delete versions[transaction.id];
      return { mode: "ids", versions };
    });
  };

  const openBulkEditor = () => {
    bulkMutation.reset();
    setBulkEnabled(emptyBulkEditEnabled());
    setBulkValues(
      emptyBulkEditValues(
        activeAccounts.find(
          (account) => account.currency === selectedCurrencies[0],
        )?.id,
      ),
    );
    setBulkIdempotencyKey(newIdempotencyKey());
    setBulkEditing(true);
  };

  const closeBulkEditor = () => {
    setBulkEditing(false);
    setBulkIdempotencyKey(null);
    bulkMutation.reset();
  };

  const buildBulkPatch = (): TransactionBulkEditPatch => ({
    ...(bulkEnabled.date ? { date: bulkValues.date } : {}),
    ...(bulkEnabled.payee ? { payee: bulkValues.payee.trim() } : {}),
    ...(bulkEnabled.categoryId
      ? { categoryId: bulkValues.categoryId || null }
      : {}),
    ...(bulkEnabled.accountId ? { accountId: bulkValues.accountId } : {}),
    ...(bulkEnabled.description
      ? { description: bulkValues.description.trim() || null }
      : {}),
    ...(bulkEnabled.notes ? { notes: bulkValues.notes.trim() || null } : {}),
    ...(bulkEnabled.type ? { type: bulkValues.type } : {}),
  });

  /** The same selection contract backs both the bulk edit and the bulk delete. */
  const buildBulkSelection = (): TransactionBulkEditSelection =>
    selection.mode === "filter"
      ? {
          mode: "filter",
          filter: bulkFilter,
          excludedIds: filterExcludedIds,
          expectedCount: filterSelectionPreview.data!.count,
          expectedFingerprint: filterSelectionPreview.data!.fingerprint,
        }
      : {
          mode: "ids",
          items: Object.entries(selection.versions).map(
            ([id, expectedVersion]) => ({ id, expectedVersion }),
          ),
        };

  const submitBulkDelete = () => {
    if (!hasSelection || !filterSelectionReady) return;
    const count =
      selection.mode === "filter"
        ? (filterSelectionPreview.data?.count ?? 0)
        : explicitSelectedCount;
    deletion.ask(count, () =>
      bulkDeleteMutation.mutate({
        selection: buildBulkSelection(),
        idempotencyKey: newIdempotencyKey(),
        dryRun: false,
      }),
    );
  };

  const submitBulkEdit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canSubmitBulkEdit) return;
    const idempotencyKey = bulkIdempotencyKey ?? newIdempotencyKey();
    if (!bulkIdempotencyKey) setBulkIdempotencyKey(idempotencyKey);
    const bulkSelection = buildBulkSelection();
    bulkMutation.mutate({
      selection: bulkSelection,
      patch: buildBulkPatch(),
      idempotencyKey,
      allowDuplicates: false,
      dryRun: false,
    });
  };

  return (
    <>
      <div className="transaction-browser-actions">
        <a
          className="button button-secondary"
          href={`/api/v1/csv/export?${queryString(params)}`}
        >
          <Download size={16} /> Export CSV
        </a>
        {allowCreate ? (
          <Button
            onClick={() => setEditing("new")}
            disabled={!accounts.data?.length}
          >
            <Plus size={16} /> Add transaction
          </Button>
        ) : null}
      </div>
      {showDateRange ? <DateRangeBar /> : null}
      <div className="filter-bar">
        <label className="search-box">
          <Search size={16} />
          <Input
            aria-label="Search transactions"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search payee, description, or notes"
          />
        </label>
        <Select
          aria-label="Transaction type"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="">All types</option>
          <option value="deposit">Deposits</option>
          <option value="withdrawal">Withdrawals</option>
          <option value="transfer">Transfers</option>
        </Select>
        {!fixedAccountId ? (
          <Select
            aria-label="Account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">All accounts</option>
            {accounts.data?.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        ) : null}
        <label className="check-label">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(event) => setShowDeleted(event.target.checked)}
          />
          Show deleted
        </label>
      </div>
      {hasSelection ? (
        <div className="transaction-selection-bar" aria-live="polite">
          <div>
            <ListChecks size={17} aria-hidden />
            <strong>
              {selection.mode === "filter"
                ? filterSelectionPreview.isPending ||
                  filterSelectionPreview.isFetching
                  ? "Counting transactions matching this view…"
                  : filterSelectionPreview.data
                    ? `${filterSelectionPreview.data.count} transaction${
                        filterSelectionPreview.data.count === 1 ? "" : "s"
                      } matching this view selected`
                    : "Unable to count matching transactions"
                : `${explicitSelectedCount} transaction${
                    explicitSelectedCount === 1 ? "" : "s"
                  } selected`}
            </strong>
            {selection.mode === "filter" && selection.excludedIds.size ? (
              <span>
                {selection.excludedIds.size} excluded
              </span>
            ) : null}
            {selection.mode === "filter" &&
            filterSelectionPreview.data?.deletedCount ? (
              <span>
                {filterSelectionPreview.data.activeCount} active ·{" "}
                {filterSelectionPreview.data.deletedCount} deleted
              </span>
            ) : null}
          </div>
          <div className="transaction-selection-actions">
            {selection.mode === "ids" && totalMatching > items.length ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  discardBulkSelectionSnapshots();
                  setSelection({ mode: "filter", excludedIds: new Set() });
                }}
              >
                {`Select all ${totalMatching} matching`}
              </Button>
            ) : null}
            {selection.mode === "filter" ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  discardBulkSelectionSnapshots();
                  setSelection({
                    mode: "ids",
                    versions: Object.fromEntries(
                      items.map((transaction) => [
                        transaction.id,
                        transaction.version,
                      ]),
                    ),
                  });
                }}
              >
                Select only this page
              </Button>
            ) : null}
            <Button
              type="button"
              variant="danger"
              onClick={submitBulkDelete}
              disabled={!filterSelectionReady}
              loading={bulkDeleteMutation.isPending}
            >
              Delete selected
            </Button>
            <Button
              type="button"
              onClick={openBulkEditor}
              disabled={!filterSelectionReady}
            >
              Mass edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={clearTransactionSelection}
            >
              Clear selection
            </Button>
          </div>
        </div>
      ) : null}
      {selection.mode === "filter" && filterSelectionPreview.error ? (
        <Alert>{filterSelectionPreview.error.message}</Alert>
      ) : null}
      {bulkDeleteMutation.error ? (
        <Alert>{bulkDeleteMutation.error.message}</Alert>
      ) : null}
      {bulkNotice ? (
        <Alert kind={bulkNotice.kind}>{bulkNotice.message}</Alert>
      ) : null}
      {deleteMutation.error ? (
        <Alert>
          {deleteMutation.error.message}
          {deleteMutation.error instanceof ApiClientError &&
          deleteMutation.error.code === "DUPLICATE" &&
          deleteMutation.variables?.deleted === false &&
          !deleteMutation.variables.allowDuplicate ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                deleteMutation.mutate({
                  ...deleteMutation.variables!,
                  allowDuplicate: true,
                })
              }
            >
              Restore anyway
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {transactions.error ? <Alert>{transactions.error.message}</Alert> : null}
      {items.length || stagedRows.length ? (
        <>
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="checkbox-cell">
                    <SelectionCheckbox
                      aria-label="Select all transactions on this page"
                      checked={allLoadedSelected}
                      indeterminate={someLoadedSelected && !allLoadedSelected}
                      onChange={(event) =>
                        toggleLoadedSelection(event.target.checked)
                      }
                    />
                  </th>
                  <SortableHeader
                    field="date"
                    label="Date"
                    lean="descending"
                    sort={sort}
                    onSort={applySort}
                  />
                  <SortableHeader
                    field="payee"
                    label="Payee"
                    sort={sort}
                    onSort={applySort}
                  />
                  <SortableHeader
                    field="account"
                    label="Account"
                    sort={sort}
                    onSort={applySort}
                  />
                  <SortableHeader
                    field="category"
                    label="Category"
                    sort={sort}
                    onSort={applySort}
                  />
                  <SortableHeader
                    field="amount"
                    label="Amount"
                    lean="descending"
                    className="align-right"
                    sort={sort}
                    onSort={applySort}
                  />
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {stagedRows.map((stage) => {
                  const draft = stage.draft;
                  const stagedPayee =
                    typeof draft.payee === "string" && draft.payee.trim()
                      ? draft.payee
                      : "Incomplete row";
                  const stagedDate =
                    typeof draft.date === "string" ? draft.date : null;
                  // The same summary the staged queue itself shows, so a
                  // transfer reports an amount here rather than nothing and the
                  // figure is formatted like every other on the page.
                  const stagedSummary = summarizeStagedDraft(
                    stage.draft,
                    accounts.data ?? [],
                  );
                  return (
                    <tr key={`staged-${stage.id}`} className="row-staged">
                      <td className="checkbox-cell">
                        {/* Staged rows cannot join a committed bulk edit. */}
                        <span className="sr-only">Not selectable</span>
                      </td>
                      <td>{stagedDate ? formatDate(stagedDate) : "—"}</td>
                      <td>
                        <div className="transaction-payee">
                          <span className="transaction-payee-name">
                            {stagedPayee}
                          </span>
                          <Badge tone="amber">Staged</Badge>
                        </div>
                      </td>
                      <td>{stagedSummary.account}</td>
                      <td>—</td>
                      <td className="align-right">
                        {stagedSummary.amount && stagedSummary.currency
                          ? formatMoney(stagedSummary.amount, stagedSummary.currency)
                          : "—"}
                      </td>
                      <td>
                        <Link className="text-link" to="/staged">
                          Review
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {items.map((transaction) => {
                  const meta = typeMeta[transaction.type];
                  const Icon = meta.icon;
                  const isInboundTransfer =
                    transaction.type === "transfer" &&
                    Boolean(fixedAccountId) &&
                    transaction.destinationAccountId === fixedAccountId;
                  const amount =
                    transaction.type === "deposit" || isInboundTransfer
                      ? transaction.destinationAmount!
                      : transaction.sourceAmount!;
                  const currency =
                    transaction.type === "deposit" || isInboundTransfer
                      ? transaction.destinationCurrency!
                      : transaction.sourceCurrency!;
                  const sign =
                    transaction.type === "deposit" || isInboundTransfer
                      ? "+"
                      : transaction.type === "withdrawal" ||
                          (transaction.type === "transfer" && fixedAccountId)
                        ? "−"
                        : "";
                  const accountLabel =
                    transaction.type === "transfer"
                      ? `${transaction.sourceAccount?.name} → ${transaction.destinationAccount?.name}`
                      : transaction.sourceAccount?.name ??
                        transaction.destinationAccount?.name;
                  const transactionSelected =
                    selection.mode === "filter"
                      ? !selection.excludedIds.has(transaction.id)
                      : Object.hasOwn(selection.versions, transaction.id);
                  return (
                    <tr
                      key={transaction.id}
                      className={[
                        transaction.deletedAt ? "row-deleted" : "",
                        transactionSelected ? "row-selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <td className="checkbox-cell">
                        <input
                          type="checkbox"
                          aria-label={`Select transaction ${transaction.payee}, ${formatDate(
                            transaction.date,
                          )}, ${accountLabel ?? "Unknown account"}, ${transaction.id.slice(
                            0,
                            8,
                          )}`}
                          checked={transactionSelected}
                          onChange={(event) =>
                            toggleTransactionSelection(
                              transaction,
                              event.target.checked,
                            )
                          }
                        />
                      </td>
                      <td className="nowrap">{formatDate(transaction.date)}</td>
                      <td>
                        <div className="transaction-cell">
                          <span
                            className={`transaction-icon ${transaction.type}`}
                          >
                            <Icon size={16} />
                          </span>
                          <div>
                            <strong>
                              <Link
                                to={{
                                  pathname: "/payees/transactions",
                                  search: payeeDetailSearch(
                                    location.search,
                                    transaction.payee,
                                  ),
                                }}
                              >
                                {transaction.payee}
                              </Link>
                            </strong>
                            <span>{transaction.description || meta.label}</span>
                          </div>
                        </div>
                      </td>
                      <td>{accountLabel}</td>
                      <td>
                        {transaction.category ? (
                          <Link
                            to={{
                              pathname: `/categories/${transaction.category.id}`,
                              search: location.search,
                            }}
                          >
                            {transaction.category.name}
                          </Link>
                        ) : (
                          <span className="subtle">Uncategorized</span>
                        )}
                      </td>
                      <td
                        className={`align-right money ${
                          isInboundTransfer ? "deposit" : transaction.type
                        }`}
                      >
                        {sign}
                        {formatMoney(amount, currency)}
                        {!fixedAccountId &&
                        transaction.type === "transfer" &&
                        transaction.sourceCurrency !==
                          transaction.destinationCurrency ? (
                          <small>
                            →{" "}
                            {formatMoney(
                              transaction.destinationAmount!,
                              transaction.destinationCurrency!,
                            )}
                          </small>
                        ) : null}
                      </td>
                      <td className="row-actions">
                        {transaction.deletedAt ? (
                          <button
                            aria-label="Restore"
                            onClick={() =>
                              deleteMutation.mutate({
                                transaction,
                                deleted: false,
                              })
                            }
                          >
                            <RotateCcw size={16} />
                          </button>
                        ) : (
                          <>
                            <button
                              aria-label="Edit"
                              onClick={() => setEditing(transaction)}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              aria-label="Delete"
                              onClick={() =>
                                rowDeletion.ask(transaction, () =>
                                  deleteMutation.mutate({
                                    transaction,
                                    deleted: true,
                                  }),
                                )
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                            <RowMenu label={`Actions for ${transaction.payee}`}>
                              <button
                                onClick={() => setSavingTemplate(transaction)}
                              >
                                <LayoutTemplate size={15} /> Save as template
                              </button>
                            </RowMenu>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination
              page={transactions.data?.page ?? page}
              pageSize={transactions.data?.pageSize ?? items.length}
              totalCount={transactions.data?.totalCount ?? items.length}
              totalPages={transactions.data?.totalPages ?? 1}
              busy={transactions.isFetching}
              itemLabel="transactions"
              onPageChange={setPage}
            />
          </div>
        </>
      ) : transactions.isPending ? (
        <p>Loading transactions…</p>
      ) : (
        <EmptyState
          icon={<ArrowLeftRight size={24} />}
          title="No transactions in this view"
          body="Adjust the date range or add a deposit, withdrawal, or transfer."
          action={
            allowCreate && accounts.data?.length ? (
              <Button onClick={() => setEditing("new")}>Add transaction</Button>
            ) : undefined
          }
        />
      )}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add a transaction" : "Edit transaction"}
      >
        {editing ? (
          <TransactionForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            transaction={editing === "new" ? undefined : editing}
            initialAccountId={fixedAccountId}
            initialCategoryId={fixedCategoryId}
            initialPayee={fixedPayee}
            initialType={initialType}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Modal>
      <Modal
        open={Boolean(savingTemplate)}
        onClose={() => setSavingTemplate(null)}
        title="Save as template"
        description="A starting point for the next one like this. Anything you leave blank is not saved, and you fill it in when you use the template."
      >
        {savingTemplate ? (
          <TemplateForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            initialDraft={templateDraftFromDraft(draftForTransactionForm(draftFromTransaction(savingTemplate)))}
            onDone={() => setSavingTemplate(null)}
          />
        ) : null}
      </Modal>
      <Modal
        open={bulkEditing}
        onClose={closeBulkEditor}
        title="Mass edit transactions"
        description="Choose only the fields you want to change. The entire update is atomic: either every selected transaction is updated or none are."
        footer={
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={closeBulkEditor}
              disabled={bulkMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="transaction-bulk-edit-form"
              loading={bulkMutation.isPending}
              disabled={!canSubmitBulkEdit}
            >
              Apply changes
            </Button>
          </div>
        }
      >
        <form
          id="transaction-bulk-edit-form"
          className="bulk-edit-form"
          onSubmit={submitBulkEdit}
        >
          <p className="bulk-edit-selection-summary">
            {selection.mode === "filter"
              ? `${filterSelectionPreview.data?.count ?? 0} transaction${
                  filterSelectionPreview.data?.count === 1 ? "" : "s"
                } matching this view will be edited.`
              : `${explicitSelectedCount} selected transaction${
                  explicitSelectedCount === 1 ? "" : "s"
                } will be edited.`}
          </p>

          {selectionMayIncludeDeleted ? (
            <Alert kind="info">
              This selection may include deleted transactions. Their values will
              be updated, but they will remain deleted.
            </Alert>
          ) : null}

          {selectionContainsTransfers ? (
            <Alert kind="info">
              This selection contains {selectedTransferCount} transfer
              {selectedTransferCount === 1 ? "" : "s"}. You can change common
              details, but Account and Type are unavailable for transfers.
            </Alert>
          ) : null}

          {explicitSelectionHasMissingRows ? (
            <Alert>
              One or more selected transactions are no longer visible. Their
              captured versions are preserved, but Account and Type are disabled.
              Clear the selection and review the current list before changing
              those fields.
            </Alert>
          ) : null}

          <div className="bulk-edit-fields">
            <div className={bulkEnabled.date ? "bulk-edit-field enabled" : "bulk-edit-field"}>
              <label className="bulk-edit-toggle">
                <input
                  type="checkbox"
                  checked={bulkEnabled.date}
                  onChange={(event) =>
                    setBulkEnabled((current) => ({
                      ...current,
                      date: event.target.checked,
                    }))
                  }
                />
                <span>Change date</span>
              </label>
              <Input
                aria-label="New date"
                type="date"
                value={bulkValues.date}
                disabled={!bulkEnabled.date}
                required={bulkEnabled.date}
                onChange={(event) =>
                  setBulkValues((current) => ({
                    ...current,
                    date: event.target.value,
                  }))
                }
              />
            </div>

            <div className={bulkEnabled.payee ? "bulk-edit-field enabled" : "bulk-edit-field"}>
              <label className="bulk-edit-toggle">
                <input
                  type="checkbox"
                  checked={bulkEnabled.payee}
                  onChange={(event) =>
                    setBulkEnabled((current) => ({
                      ...current,
                      payee: event.target.checked,
                    }))
                  }
                />
                <span>Change payee</span>
              </label>
              <Input
                aria-label="New payee"
                list={payeeListId}
                value={bulkValues.payee}
                disabled={!bulkEnabled.payee}
                required={bulkEnabled.payee}
                placeholder="Start typing a payee"
                onChange={(event) =>
                  setBulkValues((current) => ({
                    ...current,
                    payee: event.target.value,
                  }))
                }
              />
              <datalist id={payeeListId}>
                {payeeSuggestions.data?.map((payee) => (
                  <option key={payee} value={payee} />
                ))}
              </datalist>
            </div>

            <div className={bulkEnabled.categoryId ? "bulk-edit-field enabled" : "bulk-edit-field"}>
              <label className="bulk-edit-toggle">
                <input
                  type="checkbox"
                  checked={bulkEnabled.categoryId}
                  onChange={(event) =>
                    setBulkEnabled((current) => ({
                      ...current,
                      categoryId: event.target.checked,
                    }))
                  }
                />
                <span>Change category</span>
              </label>
              <Select
                aria-label="New category"
                value={bulkValues.categoryId}
                disabled={!bulkEnabled.categoryId}
                onChange={(event) =>
                  setBulkValues((current) => ({
                    ...current,
                    categoryId: event.target.value,
                  }))
                }
              >
                <option value="">Uncategorized (clear)</option>
                {activeCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className={bulkEnabled.accountId ? "bulk-edit-field enabled" : "bulk-edit-field"}>
              <label className="bulk-edit-toggle">
                <input
                  type="checkbox"
                  checked={bulkEnabled.accountId}
                  disabled={accountChangeUnavailable}
                  onChange={(event) =>
                    setBulkEnabled((current) => ({
                      ...current,
                      accountId: event.target.checked,
                    }))
                  }
                />
                <span>Change account</span>
              </label>
              <Select
                aria-label="New account"
                value={bulkValues.accountId}
                disabled={!bulkEnabled.accountId}
                required={bulkEnabled.accountId}
                onChange={(event) =>
                  setBulkValues((current) => ({
                    ...current,
                    accountId: event.target.value,
                  }))
                }
              >
                <option value="">Choose an account</option>
                {activeAccounts.map((account) => (
                  <option
                    key={account.id}
                    value={account.id}
                    disabled={account.currency !== selectedCurrencies[0]}
                  >
                    {account.name} ({account.currency})
                  </option>
                ))}
              </Select>
              {bulkEnabled.accountId ? (
                <small>
                  Only accounts using {selectedCurrencies[0]} are available.
                  Amounts and currencies are preserved; no FX conversion is
                  performed.
                </small>
              ) : accountChangeUnavailable ? (
                <small>
                  {selectionContainsTransfers
                    ? "Account cannot be mass edited when a transfer is selected."
                    : explicitSelectionHasMissingRows
                      ? "Account cannot be mass edited until every selected row is visible."
                    : "Account cannot be mass edited across multiple currencies."}
                </small>
              ) : null}
            </div>

            <div className={bulkEnabled.description ? "bulk-edit-field enabled" : "bulk-edit-field"}>
              <label className="bulk-edit-toggle">
                <input
                  type="checkbox"
                  checked={bulkEnabled.description}
                  onChange={(event) =>
                    setBulkEnabled((current) => ({
                      ...current,
                      description: event.target.checked,
                    }))
                  }
                />
                <span>Change description</span>
              </label>
              <Input
                aria-label="New description"
                value={bulkValues.description}
                disabled={!bulkEnabled.description}
                placeholder="Leave blank to clear"
                onChange={(event) =>
                  setBulkValues((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
              {bulkEnabled.description ? <small>Leave blank to clear.</small> : null}
            </div>

            <div className={bulkEnabled.notes ? "bulk-edit-field enabled" : "bulk-edit-field"}>
              <label className="bulk-edit-toggle">
                <input
                  type="checkbox"
                  checked={bulkEnabled.notes}
                  onChange={(event) =>
                    setBulkEnabled((current) => ({
                      ...current,
                      notes: event.target.checked,
                    }))
                  }
                />
                <span>Change notes</span>
              </label>
              <Textarea
                aria-label="New notes"
                rows={3}
                value={bulkValues.notes}
                disabled={!bulkEnabled.notes}
                placeholder="Leave blank to clear"
                onChange={(event) =>
                  setBulkValues((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
              {bulkEnabled.notes ? <small>Leave blank to clear.</small> : null}
            </div>

            <div className={bulkEnabled.type ? "bulk-edit-field enabled" : "bulk-edit-field"}>
              <label className="bulk-edit-toggle">
                <input
                  type="checkbox"
                  checked={bulkEnabled.type}
                  disabled={typeChangeUnavailable}
                  onChange={(event) =>
                    setBulkEnabled((current) => ({
                      ...current,
                      type: event.target.checked,
                    }))
                  }
                />
                <span>Change type</span>
              </label>
              <Select
                aria-label="New transaction type"
                value={bulkValues.type}
                disabled={!bulkEnabled.type}
                onChange={(event) =>
                  setBulkValues((current) => ({
                    ...current,
                    type: event.target.value as "deposit" | "withdrawal",
                  }))
                }
              >
                <option value="deposit">Deposit</option>
                <option value="withdrawal">Withdrawal</option>
              </Select>
              {typeChangeUnavailable ? (
                <small>
                  {selectionContainsTransfers
                    ? "Type cannot be mass edited when a transfer is selected."
                    : "Type cannot be mass edited until every selected row is visible."}
                </small>
              ) : null}
            </div>
          </div>

          {accountChangeBlocked ? (
            <Alert>
              Choose an account in the selected transactions’ existing currency.
              Mass editing an account never performs an FX conversion.
            </Alert>
          ) : null}

          {bulkMutation.error ? (
            <Alert>
              {bulkMutation.error instanceof ApiClientError &&
              bulkMutation.error.code === "STALE_VERSION" &&
              selection.mode === "filter"
                ? "The matching transaction set changed. Review the refreshed selection count, then apply the edit again."
                : bulkMutation.error.message}
              {bulkMutation.error instanceof ApiClientError &&
              bulkMutation.error.code === "DUPLICATE" &&
              bulkMutation.variables &&
              !bulkMutation.variables.allowDuplicates ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    bulkMutation.mutate({
                      ...bulkMutation.variables!,
                      allowDuplicates: true,
                    })
                  }
                >
                  Apply anyway
                </Button>
              ) : null}
            </Alert>
          ) : null}
        </form>
      </Modal>
      <ConfirmDialog
        open={rowDeletion.open}
        title="Delete this transaction?"
        description={
          rowDeletion.value
            ? `“${rowDeletion.value.payee}” stops counting toward balances and reports. Nothing is erased: turn on “Show deleted” to find and restore it.`
            : undefined
        }
        onConfirm={rowDeletion.confirm}
        onCancel={rowDeletion.cancel}
      />

      <ConfirmDialog
        open={deletion.open}
        title="Delete these transactions?"
        description={
          deletion.value
            ? `${deletion.value} transaction${deletion.value === 1 ? "" : "s"} will stop counting toward balances and reports. Nothing is erased: turn on “Show deleted” to find and restore them.`
            : undefined
        }
        onConfirm={deletion.confirm}
        onCancel={deletion.cancel}
      />
    </>
  );
}
