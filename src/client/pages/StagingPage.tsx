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
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  Select,
  SelectionCheckbox,
  ConfirmDialog,
  SortableHeader,
  type SortState,
  useConfirm,
} from "../components.js";
import { TransactionForm } from "../forms.js";
import {
  MAX_BULK_SELECTION_ENTRIES,
  type StageSortField,
} from "../../shared/domain.js";
import { useDateRange } from "../date-range.js";
import { stagedString, summarizeStagedDraft } from "../staged-draft.js";

function stageSummary(stage: StagedTransaction, accounts: Account[]) {
  return summarizeStagedDraft(stage.draft, accounts);
}

// Mirrors the server cap, which also sizes the bulk request body limit.
const MAX_BULK_STAGES = MAX_BULK_SELECTION_ENTRIES;
const STAGE_PAGE_SIZE = 100;
const SELECT_ALL_FETCH_SIZE = 200;

function retainedIdempotencyKey(
  keys: Map<string, string>,
  payload: unknown,
) {
  const fingerprint = JSON.stringify(payload);
  const existing = keys.get(fingerprint);
  if (existing) return existing;
  const created = crypto.randomUUID();
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
  const selectedRows = useMemo(() => [...selected.values()], [selected]);
  const selectableRows = stages;

  useEffect(() => {
    setSelected(new Map());
    setAllowDuplicates(false);
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
  const duplicateSelected = selectedRows.some((stage) => stage.duplicateOfId);
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
        allowDuplicates: Boolean(stage.duplicateOfId),
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
        <Select value={validity} onChange={(event) => setValidity(event.target.value)}>
          <option value="">All statuses</option>
          <option value="valid">Ready to commit</option>
          <option value="invalid">Needs attention</option>
          <option value="duplicate">Possible duplicate</option>
        </Select>
        <Select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          <option value="">All accounts</option>
          {accounts.data?.map((account) => (
            <option key={account.id} value={account.id}>{account.name}</option>
          ))}
        </Select>
        <Select value={importBatchId} onChange={(event) => setImportBatchId(event.target.value)}>
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
                      {stage.validationIssues.length ? (
                        <Badge tone="red">Needs attention</Badge>
                      ) : stage.duplicateOfId ? (
                        <Badge tone="amber">Possible duplicate</Badge>
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
                          if (stage.duplicateOfId) {
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
