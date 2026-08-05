import { useSearchParams } from "../router.js";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  CheckCheck,
  CircleAlert,
  ClipboardList,
  Pencil,
  Plus,
  Search,
  Trash2,
  LayoutTemplate,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { isoDateSchema } from "../../shared/domain.js";
import {
  api,
  ApiClientError,
  json,
  queryString,
  type Account,
  type Category,
  type ImportBatchSummary,
  type PaginatedPage,
  type Page,
  type StagedBulkEditPatch,
  type StagedBulkEditResult,
  type StagedBulkEditSelection,
  type StagedTransaction,
} from "../api.js";
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
  PageHeader,
  Pagination,
  RowMenu,
  Select,
  SelectionCheckbox,
  ConfirmDialog,
  SortableHeader,
  Textarea,
  type SortState,
  useConfirm,
} from "../components.js";
import { TemplateForm, TransactionForm } from "../forms.js";
import {
  MAX_BULK_SELECTION_ENTRIES,
  type StageSortField,
} from "../../shared/domain.js";
import { useDateRange } from "../date-range.js";
import {
  draftForTransactionForm,
  stagedString,
  summarizeStagedDraft,
  templateDraftFromDraft,
} from "../staged-draft.js";
import { newIdempotencyKey } from "../idempotency.js";

function stageSummary(stage: StagedTransaction, accounts: Account[]) {
  return summarizeStagedDraft(stage.draft, accounts);
}

// Mirrors the server cap, which also sizes the bulk request body limit.
const MAX_BULK_STAGES = MAX_BULK_SELECTION_ENTRIES;
const STAGE_PAGE_SIZE = 100;
const SELECT_ALL_FETCH_SIZE = 200;

type BulkEditField = keyof StagedBulkEditPatch;

const bulkEditFields: BulkEditField[] = [
  "date",
  "payee",
  "categoryId",
  "accountId",
  "description",
  "notes",
  "type",
];

const emptyBulkEditEnabled = (): Record<BulkEditField, boolean> => ({
  date: false,
  payee: false,
  categoryId: false,
  accountId: false,
  description: false,
  notes: false,
  type: false,
});

const emptyBulkEditValues = () => ({
  date: "",
  payee: "",
  categoryId: "",
  accountId: "",
  description: "",
  notes: "",
  type: "withdrawal" as "deposit" | "withdrawal",
});

/**
 * Which account field a draft carries follows from its type, so a row that is
 * neither a deposit nor a withdrawal has no side to move an account to. A row a
 * parser could not read may carry no type at all, which is exactly the row
 * somebody opened this queue to repair.
 */
const draftType = (stage: StagedTransaction) =>
  stagedString(stage.draft.type).trim();
const isOneSided = (stage: StagedTransaction) =>
  draftType(stage) === "deposit" || draftType(stage) === "withdrawal";

function retainedIdempotencyKey(
  keys: Map<string, string>,
  payload: unknown,
) {
  const fingerprint = JSON.stringify(payload);
  const existing = keys.get(fingerprint);
  if (existing) return existing;
  const created = newIdempotencyKey();
  keys.set(fingerprint, created);
  return created;
}

export default function StagingPage() {
  // Keyed by id and holding the row, so a selection that spans pages keeps the
  // versions and validation flags the bulk actions need after paging away.
  const [selected, setSelected] = useState<Map<string, StagedTransaction>>(
    () => new Map(),
  );
  const [page, setPage] = useState(1);
  const bulkRemoval = useConfirm<number>();
  const rowRemoval = useConfirm<StagedTransaction>();
  const duplicate = useConfirm<StagedTransaction>();
  const [editing, setEditing] = useState<StagedTransaction | "new" | null>(null);
  const [savingTemplate, setSavingTemplate] = useState<StagedTransaction | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [validity, setValidity] = useState("");
  const [accountId, setAccountId] = useState("");
  // Seeded from the link the import hands over, so arriving from an import
  // opens the queue on the rows that just landed rather than on everything
  // ever staged.
  const [searchParams] = useSearchParams();
  const [importBatchId, setImportBatchId] = useState(
    () => searchParams.get("importBatchId") ?? "",
  );
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkEnabled, setBulkEnabled] = useState(emptyBulkEditEnabled);
  const [bulkValues, setBulkValues] = useState(emptyBulkEditValues);
  const [bulkEditKey, setBulkEditKey] = useState<string | null>(null);
  const [bulkEditNotice, setBulkEditNotice] = useState<string | null>(null);
  const payeeListId = useId();
  const { start, end } = useDateRange();
  const queryClient = useQueryClient();
  const bulkCommitKeys = useRef(new Map<string, string>());
  const rowCommitKeys = useRef(new Map<string, string>());
  const batchPages = useInfiniteQuery({
    queryKey: ["import-batches", "active"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<Page<ImportBatchSummary>>(
        `/api/v1/import-batches?${queryString({
          cursor: pageParam,
          limit: "50",
        })}`,
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const [sort, setSort] = useState<SortState<StageSortField>>({
    field: "date",
    direction: "desc",
  });
  // Reordering re-cuts the pages, so start again from the first one.
  const applySort = (next: SortState<StageSortField>) => {
    setSort(next);
    setPage(1);
  };
  const stageQuery = {
    search: search || undefined,
    validity: validity || undefined,
    accountId: accountId || undefined,
    importBatchId: importBatchId || undefined,
    start,
    end,
    limit: String(STAGE_PAGE_SIZE),
  };
  const stagePages = useQuery({
    queryKey: ["staged", stageQuery, page, sort],
    queryFn: ({ signal }) =>
      api<PaginatedPage<StagedTransaction>>(
        `/api/v1/staged-transactions?${queryString({
          ...stageQuery,
          page: String(page),
          sort: sort.field,
          direction: sort.direction,
        })}`,
        { signal },
      ),
    placeholderData: (previous) => previous,
  });
  const stages = useMemo(
    () => stagePages.data?.items ?? [],
    [stagePages.data],
  );
  const batches = useMemo(
    () => batchPages.data?.pages.flatMap((page) => page.items) ?? [],
    [batchPages.data],
  );
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/api/v1/categories"),
  });
  // A staged draft names its category by id, so the queue needs the list to
  // show a name instead of a UUID.
  const categoryNames = useMemo(
    () =>
      new Map((categories.data ?? []).map((category) => [category.id, category.name])),
    [categories.data],
  );
  const selectedRows = useMemo(() => [...selected.values()], [selected]);
  const selectableRows = stages;

  const payeeSuggestions = useQuery({
    queryKey: ["payees", "suggestions", bulkValues.payee.trim().toLowerCase()],
    queryFn: () =>
      api<string[]>(
        `/api/v1/payees/suggestions?search=${encodeURIComponent(
          bulkValues.payee.trim(),
        )}`,
      ),
    enabled: bulkEditing && bulkEnabled.payee,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    setSelected(new Map());
    setAllowDuplicates(false);
    setBulkEditing(false);
    setBulkEditKey(null);
    setBulkEditNotice(null);
    setPage(1);
  }, [search, validity, accountId, importBatchId, start, end]);

  const bulkMutation = useMutation({
    mutationFn: (action: "commit" | "delete") => {
      const expectedVersions = Object.fromEntries(
        selectedRows.map((stage) => [stage.id, stage.version]),
      );
      if (action === "delete") {
        return api("/api/v1/staged-transactions/delete", {
            ...json({
              stagedIds: selectedRows.map((stage) => stage.id),
              expectedVersions,
            }),
          });
      }
      const payload = {
        stagedIds: selectedRows.map((stage) => stage.id),
        expectedVersions,
        allowDuplicates,
        dryRun: false,
      };
      return api("/api/v1/staged-transactions/commit", {
        ...json({
          ...payload,
          idempotencyKey: retainedIdempotencyKey(
            bulkCommitKeys.current,
            payload,
          ),
        }),
      });
    },
    onSuccess: async () => {
      bulkCommitKeys.current.clear();
      setSelected(new Map());
      setAllowDuplicates(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
      ]);
    },
  });

  const selectedTransferCount = selectedRows.filter(
    (stage) => draftType(stage) === "transfer",
  ).length;
  const selectionContainsTransfers = selectedTransferCount > 0;
  // Rows the parser could not type at all. An account can still be set on them,
  // but only in the same edit that says which way the money went.
  const selectedUntypedCount = selectedRows.filter(
    (stage) => !isOneSided(stage) && draftType(stage) !== "transfer",
  ).length;
  const accountNeedsType = selectedUntypedCount > 0 && !bulkEnabled.type;
  const accountChangeUnavailable = selectionContainsTransfers;
  const accountChangeBlocked =
    bulkEnabled.accountId &&
    (accountChangeUnavailable ||
      accountNeedsType ||
      !bulkValues.accountId);
  const typeChangeUnavailable = selectionContainsTransfers;
  const typeChangeBlocked = bulkEnabled.type && typeChangeUnavailable;
  const hasEnabledBulkField = bulkEditFields.some((field) => bulkEnabled[field]);
  const canSubmitBulkEdit =
    selectedRows.length > 0 &&
    hasEnabledBulkField &&
    (!bulkEnabled.date || /^\d{4}-\d{2}-\d{2}$/.test(bulkValues.date)) &&
    (!bulkEnabled.payee || Boolean(bulkValues.payee.trim())) &&
    !accountChangeBlocked &&
    !typeChangeBlocked;

  const bulkEditMutation = useMutation<
    StagedBulkEditResult,
    Error,
    {
      selection: StagedBulkEditSelection;
      patch: StagedBulkEditPatch;
      idempotencyKey: string;
      dryRun: false;
    }
  >({
    mutationFn: (request) =>
      api<StagedBulkEditResult>("/api/v1/staged-transactions/bulk-edit", {
        ...json(request),
      }),
    onSuccess: async (result) => {
      setBulkEditing(false);
      setBulkEditKey(null);
      setSelected(new Map());
      setBulkEditNotice(
        `${result.updatedCount} staged row${
          result.updatedCount === 1 ? "" : "s"
        } updated. ${result.validCount} ready to commit, ${
          result.invalidCount
        } still needing attention.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["payees"] }),
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
      ]);
    },
    // Otherwise a selection that went stale stays on screen and every retry
    // fails against the same versions, with nothing saying why.
    onError: async (error) => {
      if (error instanceof ApiClientError && error.code === "STALE_VERSION") {
        setBulkEditing(false);
        setBulkEditKey(null);
        setSelected(new Map());
        setBulkEditNotice(
          "A selected row changed. Review the refreshed queue and select the rows again.",
        );
        await queryClient.invalidateQueries({ queryKey: ["staged"] });
      }
    },
  });

  const openBulkEditor = () => {
    bulkEditMutation.reset();
    setBulkEnabled(emptyBulkEditEnabled());
    setBulkValues(emptyBulkEditValues());
    setBulkEditKey(newIdempotencyKey());
    setBulkEditNotice(null);
    setBulkEditing(true);
  };

  const closeBulkEditor = () => {
    setBulkEditing(false);
    setBulkEditKey(null);
    bulkEditMutation.reset();
  };

  const submitBulkEdit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canSubmitBulkEdit) return;
    const idempotencyKey = bulkEditKey ?? newIdempotencyKey();
    if (!bulkEditKey) setBulkEditKey(idempotencyKey);
    bulkEditMutation.mutate({
      selection: {
        mode: "ids",
        items: selectedRows.map((stage) => ({
          id: stage.id,
          expectedVersion: stage.version,
        })),
      },
      patch: {
        ...(bulkEnabled.date ? { date: bulkValues.date } : {}),
        ...(bulkEnabled.payee ? { payee: bulkValues.payee.trim() } : {}),
        ...(bulkEnabled.categoryId
          ? { categoryId: bulkValues.categoryId || null }
          : {}),
        ...(bulkEnabled.accountId ? { accountId: bulkValues.accountId } : {}),
        ...(bulkEnabled.description
          ? { description: bulkValues.description.trim() || null }
          : {}),
        ...(bulkEnabled.notes
          ? { notes: bulkValues.notes.trim() || null }
          : {}),
        ...(bulkEnabled.type ? { type: bulkValues.type } : {}),
      },
      idempotencyKey,
      dryRun: false,
    });
  };

  const allSelected =
    Boolean(selectableRows.length) &&
    selectableRows.every((stage) => selected.has(stage.id));
  const someSelected = selectableRows.some((stage) => selected.has(stage.id));
  const totalMatching = stagePages.data?.totalCount ?? stages.length;
  const selectableTotal = Math.min(totalMatching, MAX_BULK_STAGES);
  const allMatchingSelected =
    selectableTotal > 0 && selected.size >= selectableTotal;
  // Worth offering whenever the filtered list reaches past the rows on screen.
  const canSelectAllMatching =
    Boolean(selectableRows.length) &&
    totalMatching > stages.length &&
    !allMatchingSelected;
  const [selectingAll, setSelectingAll] = useState(false);

  /**
   * Staged commits and deletes are explicit-ID, so whole-list selection walks
   * the pages and keeps the rows, rather than handing the server a filter. The
   * rows are collected directly instead of through the table query so the page
   * on screen never changes underneath the user.
   */
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const collected = new Map<string, StagedTransaction>();
      for (
        let current = 1;
        collected.size < MAX_BULK_STAGES;
        current += 1
      ) {
        const result = await api<PaginatedPage<StagedTransaction>>(
          `/api/v1/staged-transactions?${queryString({
            ...stageQuery,
            // Collect in the largest pages the API allows; this walk is
            // independent of the page size shown in the table.
            limit: String(SELECT_ALL_FETCH_SIZE),
            page: String(current),
          })}`,
        );
        for (const stage of result.items) {
          if (collected.size >= MAX_BULK_STAGES) break;
          collected.set(stage.id, stage);
        }
        if (current >= result.totalPages || !result.items.length) break;
      }
      setSelected(collected);
    } finally {
      setSelectingAll(false);
    }
  };
  const invalidSelected = selectedRows.some((stage) => stage.validationIssues.length);
  const isPossibleDuplicate = (stage: StagedTransaction) =>
    Boolean(stage.duplicateOfId) || Boolean(stage.repeatsStagedRow);
  const duplicateSelected = selectedRows.some(isPossibleDuplicate);
  const duplicateCommitError =
    bulkMutation.error instanceof ApiClientError &&
    bulkMutation.error.code === "DUPLICATE";

  const rowMutation = useMutation({
    mutationFn: ({
      stage,
      action,
    }: {
      stage: StagedTransaction;
      action: "commit" | "delete";
    }) => {
      if (action === "delete") {
        return api("/api/v1/staged-transactions/delete", {
            ...json({
              stagedIds: [stage.id],
              expectedVersions: { [stage.id]: stage.version },
            }),
          });
      }
      const payload = {
        stagedIds: [stage.id],
        expectedVersions: { [stage.id]: stage.version },
        allowDuplicates: isPossibleDuplicate(stage),
        dryRun: false,
      };
      return api("/api/v1/staged-transactions/commit", {
        ...json({
          ...payload,
          idempotencyKey: retainedIdempotencyKey(
            rowCommitKeys.current,
            payload,
          ),
        }),
      });
    },
    onSuccess: async () => {
      rowCommitKeys.current.clear();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
      ]);
    },
  });

  return (
    <>
      <PageHeader
        eyebrow="Review queue"
        title="Staged transactions"
        description="Rows waiting on you. Nothing here counts until you commit it."
        actions={
          <Button onClick={() => setEditing("new")} disabled={!accounts.data?.length}>
            <Plus size={16} /> Stage transaction
          </Button>
        }
      />
      <DateRangeBar />
      <div className="filter-bar">
        <label className="search-box">
          <Search size={16} />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search staged transactions"
          />
        </label>
        <Select
          aria-label="Filter by status"
          value={validity}
          onChange={(event) => setValidity(event.target.value)}
        >
          <option value="">All statuses</option>
          <option value="valid">Ready to commit</option>
          <option value="invalid">Needs attention</option>
          <option value="duplicate">Possible duplicate</option>
        </Select>
        <Select
          aria-label="Filter by account"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          <option value="">All accounts</option>
          {accounts.data?.map((account) => (
            <option key={account.id} value={account.id}>{account.name}</option>
          ))}
        </Select>
        <Select
          aria-label="Filter by import batch"
          value={importBatchId}
          onChange={(event) => setImportBatchId(event.target.value)}
        >
          <option value="">All batches</option>
          {batches.map((batch) => (
            <option key={batch.id} value={batch.id}>
              {batch.fileName} ({batch.stagedCount})
            </option>
          ))}
        </Select>
        {batchPages.hasNextPage ? (
          <Button
            variant="ghost"
            loading={batchPages.isFetchingNextPage}
            onClick={() => batchPages.fetchNextPage()}
          >
            Load older batches
          </Button>
        ) : null}
        {selectedRows.length ? (
          <div className="bulk-actions">
            <span>
              {allMatchingSelected && totalMatching > stages.length
                ? `All ${selectedRows.length} matching staged transactions selected`
                : `${selectedRows.length} selected`}
            </span>
            {canSelectAllMatching ? (
              <Button
                type="button"
                variant="secondary"
                loading={selectingAll}
                onClick={() => void selectAllMatching()}
              >
                {`Select all ${selectableTotal} matching`}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={invalidSelected || (duplicateSelected && !allowDuplicates)}
              loading={bulkMutation.isPending}
              onClick={() => bulkMutation.mutate("commit")}
            >
              <CheckCheck size={16} /> Commit selected
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={openBulkEditor}
            >
              <Pencil size={16} /> Edit selected
            </Button>
            <Button
              variant="danger"
              loading={bulkMutation.isPending}
              onClick={() => {
                bulkRemoval.ask(selectedRows.length, () =>
                  bulkMutation.mutate("delete"),
                );
              }}
            >
              <Trash2 size={16} /> Delete
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSelected(new Map())}
            >
              Clear selection
            </Button>
            {duplicateSelected || duplicateCommitError ? (
              <label className="check-label duplicate-override">
                <input
                  type="checkbox"
                  checked={allowDuplicates}
                  onChange={(event) => setAllowDuplicates(event.target.checked)}
                />
                Commit possible duplicates
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
      {bulkMutation.error || rowMutation.error ? (
        <Alert>{(bulkMutation.error ?? rowMutation.error)!.message}</Alert>
      ) : null}
      {bulkEditNotice ? <Alert kind="info">{bulkEditNotice}</Alert> : null}
      {stagePages.error || batchPages.error ? (
        <Alert>{(stagePages.error ?? batchPages.error)!.message}</Alert>
      ) : null}
      {stages.length > MAX_BULK_STAGES ? (
        <Alert kind="info">
          Bulk actions are limited to {MAX_BULK_STAGES.toLocaleString()} rows
          at a time. Commit or delete the selected group, then continue with
          the remaining rows.
        </Alert>
      ) : null}
      {stages.length ? (
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th className="checkbox-cell">
                  <SelectionCheckbox
                    aria-label="Select all staged transactions on this page"
                    checked={allSelected}
                    indeterminate={someSelected && !allSelected}
                    onChange={(event) => {
                      const next = new Map(selected);
                      for (const stage of selectableRows) {
                        if (event.target.checked) next.set(stage.id, stage);
                        else next.delete(stage.id);
                      }
                      setSelected(next);
                    }}
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
                  field="status"
                  label="Status"
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
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {stages.map((stage) => {
                const draft = stage.draft;
                const summary = stageSummary(stage, accounts.data ?? []);
                const date = stagedString(draft.date);
                const payee = stagedString(draft.payee).trim() || "Incomplete row";
                const description = stagedString(draft.description).trim();
                const type = stagedString(draft.type).trim() || "Unknown type";
                return (
                  <tr key={stage.id}>
                    <td className="checkbox-cell">
                      <input
                        aria-label={`Select ${payee}`}
                        type="checkbox"
                        checked={selected.has(stage.id)}
                        disabled={
                          !selected.has(stage.id) &&
                          selected.size >= MAX_BULK_STAGES
                        }
                        onChange={(event) => {
                          const next = new Map(selected);
                          if (event.target.checked) next.set(stage.id, stage);
                          else next.delete(stage.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td>
                      {date
                        ? isoDateSchema.safeParse(date).success
                          ? formatDate(date)
                          : date
                        : "—"}
                    </td>
                    <td>
                      <strong>{payee}</strong>
                      <small className="table-subtitle">{description || type}</small>
                    </td>
                    <td>{summary.account}</td>
                    <td>
                      {categoryNames.get(stagedString(draft.categoryId)) ??
                        "Uncategorized"}
                    </td>
                    <td>
                      {stage.validationIssues.length ? (
                        <Badge tone="red">Needs attention</Badge>
                      ) : stage.duplicateOfId ? (
                        <Badge tone="amber">Already recorded</Badge>
                      ) : stage.repeatsStagedRow ? (
                        <Badge tone="amber">Repeats another row</Badge>
                      ) : (
                        <Badge tone="green">Ready</Badge>
                      )}
                      {stage.validationIssues.length ? (
                        <div className="issue-tooltip">
                          <CircleAlert size={13} />
                          {stage.validationIssues[0].message}
                        </div>
                      ) : null}
                    </td>
                    <td className="align-right">
                      {summary.amount && summary.currency
                        ? formatMoney(summary.amount, summary.currency)
                        : "—"}
                    </td>
                    <td className="row-actions">
                      <button
                        aria-label="Commit staged transaction"
                        disabled={Boolean(stage.validationIssues.length)}
                        onClick={() => {
                          // Only a possible repeat needs asking about.
                          if (isPossibleDuplicate(stage)) {
                            duplicate.ask(stage, () =>
                              rowMutation.mutate({ stage, action: "commit" }),
                            );
                          } else {
                            rowMutation.mutate({ stage, action: "commit" });
                          }
                        }}
                      >
                        <CheckCheck size={16} />
                      </button>
                      <button aria-label="Edit staged transaction" onClick={() => setEditing(stage)}>
                        <Pencil size={16} />
                      </button>
                      <button
                        aria-label="Delete staged transaction"
                        onClick={() => {
                          rowRemoval.ask(stage, () =>
                            rowMutation.mutate({ stage, action: "delete" }),
                          );
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                      <RowMenu label={`Actions for ${payee}`}>
                        <button onClick={() => setSavingTemplate(stage)}>
                          <LayoutTemplate size={15} /> Save as template
                        </button>
                      </RowMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination
            page={stagePages.data?.page ?? page}
            pageSize={stagePages.data?.pageSize ?? stages.length}
            totalCount={stagePages.data?.totalCount ?? stages.length}
            totalPages={stagePages.data?.totalPages ?? 1}
            busy={stagePages.isFetching || selectingAll}
            itemLabel="staged transactions"
            onPageChange={setPage}
          />
        </div>
      ) : stagePages.isLoading ? null : (
        <EmptyState
          icon={<ClipboardList size={24} />}
          title="Nothing staged"
          body="Imported rows, drafts you save for later, and anything an agent prepares land here."
        />
      )}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Stage a transaction" : "Edit staged transaction"}
      >
        {editing ? (
          <TransactionForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            staged={editing === "new" ? undefined : editing}
            initialMode="stage"
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
            initialDraft={templateDraftFromDraft(
              draftForTransactionForm(savingTemplate.draft),
            )}
            onDone={() => setSavingTemplate(null)}
          />
        ) : null}
      </Modal>
      <Modal
        open={bulkEditing}
        onClose={closeBulkEditor}
        title="Mass edit staged rows"
        description="Choose only the fields you want to change. Nothing is committed: the rows are updated in the queue and checked again, so filling in what was missing can clear their warnings."
        footer={
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={closeBulkEditor}
              disabled={bulkEditMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="staged-bulk-edit-form"
              loading={bulkEditMutation.isPending}
              disabled={!canSubmitBulkEdit}
            >
              Apply changes
            </Button>
          </div>
        }
      >
        <form
          id="staged-bulk-edit-form"
          className="bulk-edit-form"
          onSubmit={submitBulkEdit}
        >
          <p className="bulk-edit-selection-summary">
            {`${selectedRows.length} selected staged row${
              selectedRows.length === 1 ? "" : "s"
            } will be edited.`}
          </p>

          {bulkEditMutation.error ? (
            <Alert>{bulkEditMutation.error.message}</Alert>
          ) : null}

          {selectionContainsTransfers ? (
            <Alert kind="info">
              This selection contains {selectedTransferCount} transfer
              {selectedTransferCount === 1 ? "" : "s"}. You can change common
              details, but Account and Type are unavailable for transfers.
            </Alert>
          ) : selectedUntypedCount ? (
            <Alert kind="info">
              {selectedUntypedCount} selected row
              {selectedUntypedCount === 1 ? " does" : "s do"} not say whether
              money came in or went out. Change Type in the same edit to set an
              account on {selectedUntypedCount === 1 ? "it" : "them"}.
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
                {(categories.data ?? []).map((category) => (
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
                {(accounts.data ?? [])
                  .filter((account) => !account.archivedAt)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.currency})
                    </option>
                  ))}
              </Select>
              {accountChangeUnavailable ? (
                <small>
                  Account cannot be mass edited when a transfer is selected.
                </small>
              ) : bulkEnabled.accountId && accountNeedsType ? (
                <small>
                  Some selected rows have no type yet. Turn on Change type to
                  set an account on them.
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
                  Type cannot be mass edited when a transfer is selected.
                </small>
              ) : null}
            </div>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={bulkRemoval.open}
        title="Delete these staged rows?"
        description={
          bulkRemoval.value
            ? `${bulkRemoval.value} row${bulkRemoval.value === 1 ? "" : "s"} will be removed from the review queue. Nothing has been committed yet, so no balance changes.`
            : undefined
        }
        onConfirm={bulkRemoval.confirm}
        onCancel={bulkRemoval.cancel}
      />

      <ConfirmDialog
        open={rowRemoval.open}
        title="Delete this staged row?"
        description="It is removed from the review queue. Nothing has been committed, so no balance changes."
        onConfirm={rowRemoval.confirm}
        onCancel={rowRemoval.cancel}
      />

      <ConfirmDialog
        open={duplicate.open}
        title="Commit this anyway?"
        description="This looks like a transaction you already have. Committing it will record a second one."
        confirmLabel="Commit"
        onConfirm={duplicate.confirm}
        onCancel={duplicate.cancel}
      />
    </>
  );
}
