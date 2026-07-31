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
  Select,
} from "../components.js";
import { TransactionForm } from "../forms.js";
import { useDateRange } from "../date-range.js";
import { stagedString, summarizeStagedDraft } from "../staged-draft.js";

function stageSummary(stage: StagedTransaction, accounts: Account[]) {
  return summarizeStagedDraft(stage.draft, accounts);
}

const MAX_BULK_STAGES = 5_000;
const STAGE_PAGE_SIZE = 100;

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<StagedTransaction | "new" | null>(null);
  const [search, setSearch] = useState("");
  const [validity, setValidity] = useState("");
  const [accountId, setAccountId] = useState("");
  const [importBatchId, setImportBatchId] = useState("");
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
  const stagePages = useInfiniteQuery({
    queryKey: ["staged", search, validity, accountId, importBatchId, start, end],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<Page<StagedTransaction>>(
        `/api/v1/staged-transactions?${queryString({
          search: search || undefined,
          validity: validity || undefined,
          accountId: accountId || undefined,
          importBatchId: importBatchId || undefined,
          start,
          end,
          cursor: pageParam,
          limit: String(STAGE_PAGE_SIZE),
        })}`,
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const stages = useMemo(
    () => stagePages.data?.pages.flatMap((page) => page.items) ?? [],
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
  const selectedRows = useMemo(
    () => stages.filter((stage) => selected.has(stage.id)),
    [selected, stages],
  );
  const selectableRows = stages.slice(0, MAX_BULK_STAGES);

  useEffect(() => {
    setSelected(new Set());
    setAllowDuplicates(false);
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
      setSelected(new Set());
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
        description="Review imported or agent-prepared work before it changes any balance."
        actions={
          <Button onClick={() => setEditing("new")} disabled={!accounts.data?.length}>
            <Plus size={16} /> Stage manually
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
            <span>{selectedRows.length} selected</span>
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
                if (window.confirm(`Delete ${selectedRows.length} staged transaction(s)?`)) {
                  bulkMutation.mutate("delete");
                }
              }}
            >
              <Trash2 size={16} /> Delete
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
                  <input
                    aria-label="Select all staged transactions"
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? new Set(selectableRows.map((stage) => stage.id))
                          : new Set(),
                      )
                    }
                  />
                </th>
                <th>Date</th>
                <th>Transaction</th>
                <th>Account</th>
                <th>Status</th>
                <th className="align-right">Amount</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {stages.map((stage) => {
                const draft = stage.draft;
                const summary = stageSummary(stage, accounts.data ?? []);
                const date = stagedString(draft.date);
                const description =
                  stagedString(draft.description).trim() || "Incomplete row";
                const type = stagedString(draft.type).trim() || "Unknown type";
                return (
                  <tr key={stage.id}>
                    <td className="checkbox-cell">
                      <input
                        aria-label={`Select ${description}`}
                        type="checkbox"
                        checked={selected.has(stage.id)}
                        disabled={
                          !selected.has(stage.id) &&
                          selected.size >= MAX_BULK_STAGES
                        }
                        onChange={(event) => {
                          const next = new Set(selected);
                          event.target.checked ? next.add(stage.id) : next.delete(stage.id);
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
                      <strong>{description}</strong>
                      <small className="table-subtitle">{type}</small>
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
                          if (
                            !stage.duplicateOfId ||
                            window.confirm("Commit this possible duplicate anyway?")
                          ) {
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
                          if (window.confirm("Delete this staged transaction?")) {
                            rowMutation.mutate({ stage, action: "delete" });
                          }
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
          {stagePages.hasNextPage ? (
            <div className="form-actions">
              <Button
                variant="secondary"
                loading={stagePages.isFetchingNextPage}
                onClick={() => stagePages.fetchNextPage()}
              >
                Load more transactions
              </Button>
            </div>
          ) : null}
        </div>
      ) : stagePages.isLoading ? null : (
        <EmptyState
          icon={<ClipboardList size={24} />}
          title="The review queue is clear"
          body="CSV imports, manually staged items, and agent-prepared transactions appear here."
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
    </>
  );
}
