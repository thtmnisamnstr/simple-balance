import { Link, useSearchParams } from "../router.js";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCheck,
  CircleAlert,
  ClipboardList,
  Copy,
  CopyCheck,
  LayoutTemplate,
  Pencil,
  Plus,
  Repeat,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { isoDateSchema, type EntryType } from "../../shared/domain.js";
import {
  api,
  ApiClientError,
  apiStreamed,
  json,
  queryString,
  writeDidNotHappen,
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
  BulkEditToggle,
  Button,
  ConfirmDialog,
  DateRangeBar,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Pagination,
  ProgressBar,
  progressLabel,
  RowMenu,
  SearchBox,
  Select,
  SelectionBar,
  SelectionCheckbox,
  formatCount,
  Skeleton,
  SortableHeader,
  type SortState,
  TransferCategory,
  useConfirm,
} from "../components.js";
import { formatDate, formatMoney, formatTimestamp, moneyLabel, movementSign } from "../money.js";
import { useTimezone } from "../timezone.js";
import {
  CategoryPicker,
  PayeeInput,
  RecurrenceForm,
  TemplateForm,
  TransactionForm,
} from "../forms.js";
import {
  MAX_BULK_SELECTION_ENTRIES,
  PROGRESS_STREAM_MIN_ROWS,
  type StageSortField,
} from "../../shared/domain.js";
import { progressFraction, type ProgressEvent } from "../../shared/progress.js";
import { useDateRange } from "../date-range.js";
import {
  draftForTransactionForm,
  largestStagedLeg,
  recurrenceShapeFromDraft,
  stagedLegs,
  stagedString,
  summarizeStagedDraft,
  templateDraftFromDraft,
} from "../staged-draft.js";
import { newIdempotencyKey } from "../idempotency.js";
import {
  BulkEditDateField,
  BulkEditDescriptionField,
  BulkEditNotesField,
  BulkEditPayeeField,
  bulkEditFields,
  emptyBulkEditEnabled,
  emptyBulkEditValues,
  type BulkEditField,
  type BulkEditValues,
} from "../bulk-edit.js";
import { useDebounced } from "../debounce.js";
import { emptyScreen, waysOut, noAccountReason } from "../list-filters.js";
import { transactionTypeLabels } from "./TemplatesPage.js";

/** The four cells a staged row edits in place. */
type InlineField = "date" | "payee" | "category" | "amount";
/** What a staged row's own buttons do to it. */
type RowAction = "commit" | "delete";

function stageSummary(stage: StagedTransaction, accounts: Account[]) {
  return summarizeStagedDraft(stage.draft, accounts);
}

// Mirrors the server cap, which also sizes the bulk request body limit.
const MAX_BULK_STAGES = MAX_BULK_SELECTION_ENTRIES;
const STAGE_PAGE_SIZE = 100;
const SELECT_ALL_FETCH_SIZE = 200;

/**
 * Which account field a draft carries follows from its type, so a row that is
 * neither a deposit nor a withdrawal has no side to move an account to. A row a
 * parser could not read may carry no type at all, which is exactly the row
 * somebody opened this queue to repair.
 */
const draftType = (stage: StagedTransaction) => stagedString(stage.draft.type).trim();
const isOneSided = (stage: StagedTransaction) =>
  draftType(stage) === "deposit" || draftType(stage) === "withdrawal";
const stageLegs = (stage: StagedTransaction) => stagedLegs(stage.draft.legs);

function retainedIdempotencyKey(keys: Map<string, string>, payload: unknown) {
  const fingerprint = JSON.stringify(payload);
  const existing = keys.get(fingerprint);
  if (existing) return existing;
  const created = newIdempotencyKey();
  keys.set(fingerprint, created);
  return created;
}

export default function StagingPage() {
  const timezone = useTimezone();
  // Keyed by id and holding the row, so a selection that spans pages keeps the
  // versions and validation flags the bulk actions need after paging away.
  const [selected, setSelected] = useState<Map<string, StagedTransaction>>(() => new Map());
  const [page, setPage] = useState(1);
  const bulkRemoval = useConfirm<number>();
  const rowRemoval = useConfirm<StagedTransaction>();
  const duplicate = useConfirm<StagedTransaction>();
  const [editing, setEditing] = useState<StagedTransaction | "new" | null>(null);
  const [cloning, setCloning] = useState<StagedTransaction | null>(null);
  const [savingTemplate, setSavingTemplate] = useState<StagedTransaction | null>(null);
  const [savingRecurrence, setSavingRecurrence] = useState<StagedTransaction | null>(null);
  const recurrenceSeed = savingRecurrence ? draftForTransactionForm(savingRecurrence.draft) : null;
  const [search, setSearch] = useState("");
  const settledSearch = useDebounced(search);
  // `typeFilter` rather than `type`, which is what Templates and Recurring call
  // theirs: the row map below binds `const type` for the draft's own type, so a
  // state named `type` would be shadowed exactly where the two are easiest to
  // confuse.
  const [typeFilter, setTypeFilter] = useState("");
  const [validity, setValidity] = useState("");
  const [accountId, setAccountId] = useState("");
  // Seeded from the link the import hands over, so arriving from an import
  // opens the queue on the rows that just landed rather than on everything
  // ever staged.
  const [searchParams] = useSearchParams();
  const [importBatchId, setImportBatchId] = useState(() => searchParams.get("importBatchId") ?? "");
  const [recurrenceId, setRecurrenceId] = useState(() => searchParams.get("recurrenceId") ?? "");
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkEnabled, setBulkEnabled] = useState(emptyBulkEditEnabled);
  const [bulkValues, setBulkValues] = useState(emptyBulkEditValues);
  const setBulkFieldEnabled = (field: BulkEditField, on: boolean) =>
    setBulkEnabled((current) => ({ ...current, [field]: on }));
  const setBulkFieldValues = (patch: Partial<BulkEditValues>) =>
    setBulkValues((current) => ({ ...current, ...patch }));
  const [bulkEditKey, setBulkEditKey] = useState<string | null>(null);
  const [bulkEditNotice, setBulkEditNotice] = useState<string | null>(null);
  // What a finished bulk commit or delete says. `bulkEditNotice` is only ever
  // set by the bulk EDIT modal, so these two reported nothing: the button is
  // inside the selection bar, success empties the selection, and the bar and
  // the button went with it (`web.md` 13.3).
  const [bulkOutcome, setBulkOutcome] = useState<string | null>(null);
  /** What a single row's commit or delete did, said where focus can reach it. */
  const [rowOutcome, setRowOutcome] = useState<string | null>(null);
  // Whether anything but the date range is narrowing this queue. The range is
  // left out because every view carries one, so counting it would report an
  // empty queue as a filtered one.
  // Six controls, all of them on the bar above the list, and the last two
  // seeded from the link an import or a recurrence hands over — so arriving
  // here with nothing matching is the common case rather than an edge. In the
  // order they sit on the bar, because that is the order the way out is read
  // in.
  const { narrowed, ways } = emptyScreen([
    { set: Boolean(settledSearch), clear: "clear the search" },
    { set: Boolean(typeFilter), clear: "clear the type filter" },
    { set: Boolean(validity), clear: "clear the status filter" },
    { set: Boolean(accountId), clear: "clear the account filter" },
    { set: Boolean(importBatchId), clear: "clear the import batch filter" },
    { set: Boolean(recurrenceId), clear: "show everything rather than one recurring transaction" },
  ]);
  const payeeListId = useId();
  const issueIdPrefix = useId();
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
    search: settledSearch || undefined,
    type: typeFilter || undefined,
    validity: validity || undefined,
    accountId: accountId || undefined,
    importBatchId: importBatchId || undefined,
    recurrenceId: recurrenceId || undefined,
    start,
    end,
    limit: String(STAGE_PAGE_SIZE),
  };
  /**
   * How many rows look like copies of something, whatever this list is filtered
   * to. Its own count rather than a read of the page on screen, because the
   * offer to work through them is about the whole queue and should not appear
   * and vanish as somebody narrows the view.
   */
  const duplicateCount = useQuery({
    queryKey: ["staged", "duplicates", "count"],
    queryFn: () =>
      api<PaginatedPage<StagedTransaction>>(
        `/api/v1/staged-transactions?${queryString({
          validity: "duplicate",
          limit: "1",
        })}`,
      ).then((page) => page.totalCount),
  });

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
  const stages = useMemo(() => stagePages.data?.items ?? [], [stagePages.data]);
  const batches = useMemo(
    () => batchPages.data?.pages.flatMap((page) => page.items) ?? [],
    [batchPages.data],
  );
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });
  const categories = useQuery({
    // Archived ones included, as the transaction browser does. A recurrence can
    // propose a row filed under a category retired since, and leaving it out of
    // this list rendered that row as Uncategorized with a blank category field
    // in its editor: the one row somebody opened this queue to repair, showing
    // the wrong thing about itself.
    queryKey: ["categories", true],
    queryFn: () => api<Category[]>("/api/v1/categories?includeArchived=true"),
  });
  // A staged draft names its category by id, so the queue needs the list to
  // show a name instead of a UUID.
  const categoryNames = useMemo(
    () => new Map((categories.data ?? []).map((category) => [category.id, category.name])),
    [categories.data],
  );
  const selectedRows = useMemo(() => [...selected.values()], [selected]);
  const selectableRows = stages;

  const payeeSuggestions = useQuery({
    queryKey: ["payees", "suggestions", bulkValues.payee.trim().toLowerCase()],
    queryFn: () =>
      api<string[]>(
        `/api/v1/payees/suggestions?search=${encodeURIComponent(bulkValues.payee.trim())}`,
      ),
    enabled: bulkEditing && bulkEnabled.payee,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    // A selection is accumulated rather than worked out, so there is nothing to
    // derive during render; and there is no event to hang this on either. The
    // search settles on a debounce timer and the date range is shared with the
    // rest of the app, so neither arrives through a handler on this page.
    // Watching the filters themselves is what makes every route to a new one
    // drop the selection, rather than only the ones somebody remembered.
    // oxlint-disable-next-line react/set-state-in-effect
    setSelected(new Map());
    setAllowDuplicates(false);
    setBulkEditing(false);
    setBulkEditKey(null);
    setBulkEditNotice(null);
    setPage(1);
  }, [settledSearch, typeFilter, validity, accountId, importBatchId, recurrenceId, start, end]);

  // Beside the mutation rather than inside it: a mutation reports pending or
  // settled and has no channel for anything in between, and this arrives four
  // times a second while one is in flight.
  const [commitProgress, setCommitProgress] = useState<ProgressEvent | null>(null);

  const bulkMutation = useMutation({
    mutationFn: (action: RowAction) => {
      const expectedVersions = Object.fromEntries(
        selectedRows.map((stage) => [stage.id, stage.version]),
      );
      if (action === "delete") {
        return api("/api/v1/staged-transactions/bulk-delete", {
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
      const request = json({
        ...payload,
        idempotencyKey: retainedIdempotencyKey(bulkCommitKeys.current, payload),
      });
      // The selection is counted here, so a commit small enough to finish
      // before a bar could be read never asks for frames at all. The import
      // cannot do this — it has not parsed the file yet — and asks every time.
      if (selectedRows.length < PROGRESS_STREAM_MIN_ROWS) {
        return api("/api/v1/staged-transactions/commit", request);
      }
      return apiStreamed("/api/v1/staged-transactions/commit", request, setCommitProgress);
    },
    // Cleared here as well as in onSettled, because onSettled runs after
    // onSuccess has awaited six refetches — long enough for the finished bar
    // and the result to sit on screen together.
    onMutate: () => setBulkOutcome(null),
    onSuccess: async (_result, action) => {
      setCommitProgress(null);
      bulkCommitKeys.current.clear();
      // Counted before the selection is emptied, and said out loud, because
      // the bar that held the button has gone by the time this renders.
      //
      // Counted from the selection rather than read off the reply, which is
      // why the reply's per-row halves go unread (`web.md` 11.9): a delete's
      // `deletedIds` and a commit's `committed[].stagedId` each name exactly
      // the rows selected, since both are all-or-nothing, and the queue is
      // read again below, which is where each row's absence is shown.
      const rows = selectedRows.length;
      setBulkOutcome(
        `${rows.toLocaleString()} staged ${rows === 1 ? "row" : "rows"} ${
          action === "commit" ? "committed" : "deleted"
        }.`,
      );
      setSelected(new Map());
      setAllowDuplicates(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["budgets"] }),
        queryClient.invalidateQueries({ queryKey: ["forecast"] }),
      ]);
    },
    onSettled: () => setCommitProgress(null),
  });

  const selectedTransferCount = selectedRows.filter(
    (stage) => draftType(stage) === "transfer",
  ).length;
  const selectionContainsTransfers = selectedTransferCount > 0;
  const selectedSplitCount = selectedRows.filter((stage) => stageLegs(stage).length > 0).length;
  const selectionContainsSplits = selectedSplitCount > 0;
  // Rows the parser could not type at all. An account can still be set on them,
  // but only in the same edit that says which way the money went.
  const selectedUntypedCount = selectedRows.filter(
    (stage) => !isOneSided(stage) && draftType(stage) !== "transfer",
  ).length;
  const accountNeedsType = selectedUntypedCount > 0 && !bulkEnabled.type;
  const accountChangeUnavailable = selectionContainsTransfers;
  const categoryChangeUnavailable = selectionContainsSplits;
  const categoryChangeBlocked = bulkEnabled.categoryId && categoryChangeUnavailable;
  const accountChangeBlocked =
    bulkEnabled.accountId &&
    (accountChangeUnavailable || accountNeedsType || !bulkValues.accountId);
  const typeChangeUnavailable = selectionContainsTransfers || selectionContainsSplits;
  const typeChangeBlocked = bulkEnabled.type && typeChangeUnavailable;
  const hasEnabledBulkField = bulkEditFields.some((field) => bulkEnabled[field]);
  const canSubmitBulkEdit =
    selectedRows.length > 0 &&
    hasEnabledBulkField &&
    (!bulkEnabled.date || /^\d{4}-\d{2}-\d{2}$/.test(bulkValues.date)) &&
    (!bulkEnabled.payee || Boolean(bulkValues.payee.trim())) &&
    !accountChangeBlocked &&
    !categoryChangeBlocked &&
    !typeChangeBlocked;
  /**
   * The first unmet condition, in the order the form asks for them.
   *
   * `web.md` 12.3 wants the first rather than all of them. One fixed sentence
   * over a seven-conjunct predicate told somebody who had changed a field and
   * mistyped a date to change a field.
   */
  const bulkEditBlockedBecause =
    selectedRows.length === 0
      ? "Select at least one row."
      : !hasEnabledBulkField
        ? "Change at least one field above."
        : bulkEnabled.date && !/^\d{4}-\d{2}-\d{2}$/.test(bulkValues.date)
          ? "Give the date as YYYY-MM-DD."
          : bulkEnabled.payee && !bulkValues.payee.trim()
            ? "Give the payee a name."
            : accountChangeBlocked
              ? // Each cause its own sentence. This read "These rows are in more
                // than one currency", copied from the register, and a staged
                // edit refuses for none of the register's currency reasons: it
                // was false on the ordinary path of turning the field on
                // before choosing an account.
                accountChangeUnavailable
                ? "Account cannot be edited across the selection while a transfer is in it."
                : accountNeedsType
                  ? "Some selected rows have no type yet. Turn on Change type to set an account on them."
                  : "Choose an account."
              : categoryChangeBlocked
                ? "A split cannot be flattened into one category."
                : typeChangeBlocked
                  ? selectionContainsTransfers
                    ? "A transfer cannot become a deposit or a withdrawal."
                    : "A split cannot change direction, because each leg's category was chosen for the way it runs."
                  : undefined;

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
      // The counts, not the rows. The reply's `items` carry each row's
      // `issueCount` and `possiblyDuplicate`, and the queue read again below
      // shows both on the row itself — its issues and its duplicate badge —
      // which is where somebody looks for them rather than in a sentence.
      setBulkEditNotice(
        `${formatCount(result.updatedCount)} staged row${
          result.updatedCount === 1 ? "" : "s"
        } updated. ${formatCount(result.validCount)} ready to commit, ${formatCount(
          result.invalidCount,
        )} still needing attention.`,
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
        ...(bulkEnabled.categoryId ? { categoryId: bulkValues.categoryId || null } : {}),
        ...(bulkEnabled.accountId ? { accountId: bulkValues.accountId } : {}),
        ...(bulkEnabled.description ? { description: bulkValues.description.trim() || null } : {}),
        ...(bulkEnabled.notes ? { notes: bulkValues.notes.trim() || null } : {}),
        ...(bulkEnabled.type ? { type: bulkValues.type } : {}),
      },
      idempotencyKey,
      dryRun: false,
    });
  };

  const allSelected =
    Boolean(selectableRows.length) && selectableRows.every((stage) => selected.has(stage.id));
  const someSelected = selectableRows.some((stage) => selected.has(stage.id));
  const totalMatching = stagePages.data?.totalCount ?? stages.length;
  const selectableTotal = Math.min(totalMatching, MAX_BULK_STAGES);
  const allMatchingSelected = selectableTotal > 0 && selected.size >= selectableTotal;
  // Worth offering whenever the filtered list reaches past the rows on screen.
  const canSelectAllMatching =
    Boolean(selectableRows.length) && totalMatching > stages.length && !allMatchingSelected;
  const [selectingAll, setSelectingAll] = useState(false);

  /**
   * Staged commits and deletes are explicit-ID, so whole-list selection walks
   * the pages and keeps the rows, rather than handing the server a filter. The
   * rows are collected directly instead of through the table query so the page
   * on screen never changes underneath the user.
   */
  const selectAllMatching = async () => {
    setSelectingAll(true);
    setBulkEditNotice(null);
    try {
      const collected = new Map<string, StagedTransaction>();
      for (let current = 1; collected.size < MAX_BULK_STAGES; current += 1) {
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
      // Truncation is said out loud. "All 25,000 matching selected" when only
      // 10,000 were taken is the kind of wrong that is only discovered by the
      // rows that were left behind.
      if (collected.size < totalMatching) {
        setBulkEditNotice(
          `${collected.size.toLocaleString()} of ${totalMatching.toLocaleString()} matching rows selected, which is as many as one action covers. Deal with these, then select the rest.`,
        );
      }
    } catch (error) {
      // Without this the walk rejects into nothing and the bar simply stops
      // growing, with no way to tell that from having finished.
      setBulkEditNotice(
        error instanceof Error
          ? `Could not select every matching row: ${error.message}`
          : "Could not select every matching row.",
      );
    } finally {
      setSelectingAll(false);
    }
  };
  const invalidSelected = selectedRows.some((stage) => stage.validationIssues.length);
  const isPossibleDuplicate = (stage: StagedTransaction) =>
    Boolean(stage.duplicateOfId) ||
    Boolean(stage.likelyDuplicateOfId) ||
    Boolean(stage.repeatsStagedRow);
  const duplicateSelected = selectedRows.some(isPossibleDuplicate);
  const duplicateCommitError =
    bulkMutation.error instanceof ApiClientError && bulkMutation.error.code === "DUPLICATE";

  /**
   * Click-to-edit for the four fields a queue pass actually touches.
   *
   * The queue is where imports get repaired, and repairing a date or a payee
   * through the full modal is four clicks for a one-word change. The editors
   * are the modal's own — PayeeInput and CategoryPicker, not copies — and the
   * write is the same PUT the modal sends, version and all, so everything the
   * server enforces about a draft is enforced here identically. Splits keep
   * their category and amount edits in the modal (they live on the legs), and
   * a transfer's category likewise stays out (it has none by design).
   */
  const [inline, setInline] = useState<{
    id: string;
    field: InlineField;
    value: string;
    categoryName: string;
  } | null>(null);
  const [inlineError, setInlineError] = useState("");
  // A ref, not isPending: Enter commits, and the blur that follows a click
  // away can run before the render that would set isPending — two identical
  // PUTs, the second refused as stale by the version the first just bumped.
  const inlineInFlight = useRef(false);
  // Escape's other half: removing a focused editor fires a browser blur, and
  // the blur handler's closure still holds the pre-Escape state — so without
  // this, canceling could commit. Set before the state change, read first.
  const inlineCanceled = useRef(false);
  // Where focus goes when an editor closes. Commit, refusal and Escape all
  // removed the focused element and stranded keyboard users on <body>; the
  // trigger the editor replaced is the honest place to land.
  const focusAfterInline = useRef<{ id: string; field: string } | null>(null);
  useEffect(() => {
    if (inline || !focusAfterInline.current) return;
    const { id, field } = focusAfterInline.current;
    focusAfterInline.current = null;
    document.querySelector<HTMLButtonElement>(`[data-inline-trigger="${field}:${id}"]`)?.focus();
  });
  const inlineMutation = useMutation({
    mutationFn: ({
      stage,
      draft,
    }: {
      stage: StagedTransaction;
      draft: Record<string, unknown>;
      field: InlineField;
    }) =>
      api(`/api/v1/staged-transactions/${stage.id}`, {
        ...json({ draft, expectedVersion: stage.version }),
        method: "PUT",
      }),
    onSuccess: async (_result, variables) => {
      inlineInFlight.current = false;
      // Only the editor this write belongs to — the cell, not the row. A
      // second editor opened while the PUT was in flight is somebody already
      // doing the next thing, and closing it under them threw their
      // keystrokes away.
      setInline((current) =>
        current && current.id === variables.stage.id && current.field === variables.field
          ? null
          : current,
      );
      setInlineError("");
      focusAfterInline.current = { id: variables.stage.id, field: variables.field };
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
        queryClient.invalidateQueries({ queryKey: ["payees"] }),
      ]);
    },
    // The editor closes either way: the message says why the change did not
    // take, and the list refetches so the row shows what the server really
    // holds — a version conflict means somebody else moved it.
    onError: async (cause: Error, variables) => {
      inlineInFlight.current = false;
      setInline((current) =>
        current && current.id === variables.stage.id && current.field === variables.field
          ? null
          : current,
      );
      setInlineError(cause.message);
      focusAfterInline.current = { id: variables.stage.id, field: variables.field };
      await queryClient.invalidateQueries({ queryKey: ["staged"] });
    },
  });
  const commitInline = (
    stage: StagedTransaction,
    override?: { value?: string; categoryName?: string },
  ) => {
    if (!inline || inlineInFlight.current || inlineCanceled.current) return;
    const value = override?.value ?? inline.value;
    const categoryName = override?.categoryName ?? inline.categoryName;
    const source = stage.draft as Record<string, unknown>;
    // Emptying a date or an amount in place reads as abandoning the edit, not
    // as a request to erase the field: the modal is where a deliberate clear
    // belongs, beside everything else the emptiness affects.
    if ((inline.field === "date" || inline.field === "amount") && !value.trim()) {
      cancelInline();
      return;
    }
    const draft = { ...source };
    if (inline.field === "date") draft.date = value;
    if (inline.field === "payee") draft.payee = value;
    if (inline.field === "amount") draft.amount = value;
    if (inline.field === "category") {
      // The picker's contract: an id when the name matched a live category,
      // otherwise the name travels and the commit resolves or creates it.
      // Both keys are settled here so the draft never carries two answers.
      draft.categoryId = value || null;
      draft.categoryName = value ? null : categoryName.trim() || null;
      // The stored categoryKind goes ONLY when the category really changed:
      // it was somebody's answer about the old name, and riding along with a
      // new one it would file a brand-new category on a side nobody chose
      // here. On an untouched blur it stays — nulling it unconditionally
      // stripped a deferred import's kind from a row nobody edited.
      const changed =
        (draft.categoryId ?? null) !== (source.categoryId ?? null) ||
        (draft.categoryName ?? null) !== (source.categoryName ?? null);
      if (changed) draft.categoryKind = null;
    }
    // Nothing moved, nothing written: a same-value blur must not bump the
    // version, invalidate a bulk selection's fingerprint, or add an audit
    // entry saying an edit happened. Compared with absent and null treated as
    // one answer, because settling the category keys writes explicit nulls
    // onto a draft that may never have carried the keys at all — and gaining
    // three null keys is not an edit.
    const normalized = (record: Record<string, unknown>) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(record).filter(([, entry]) => entry !== null && entry !== undefined),
        ),
      );
    if (normalized(draft) === normalized(source)) {
      cancelInline();
      return;
    }
    inlineInFlight.current = true;
    inlineMutation.mutate({ stage, draft, field: inline.field });
  };
  const openInline = (
    stage: StagedTransaction,
    field: InlineField,
    value: string,
    categoryName = "",
  ) => {
    setInlineError("");
    inlineCanceled.current = false;
    setInline({ id: stage.id, field, value, categoryName });
  };
  const cancelInline = () => {
    inlineCanceled.current = true;
    if (inline) focusAfterInline.current = { id: inline.id, field: inline.field };
    setInline(null);
  };
  const inlineFor = (stage: StagedTransaction, field: InlineField) =>
    inline && inline.id === stage.id && inline.field === field ? inline : null;

  const rowMutation = useMutation({
    mutationFn: ({ stage, action }: { stage: StagedTransaction; action: RowAction }) => {
      if (action === "delete") {
        return api("/api/v1/staged-transactions/bulk-delete", {
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
          idempotencyKey: retainedIdempotencyKey(rowCommitKeys.current, payload),
        }),
      });
    },
    onSuccess: async (_result, { stage, action }) => {
      /*
       * 13.3, and the shape `web.md` 9.8 names: committing a row runs straight
       * from the row with no dialog unless it is a possible repeat, and the
       * committed row leaves this queue — so the button went with it and focus
       * fell to `<body>`. The delete beside it always asks first and its dialog
       * returns focus itself, but it is said here too, because the row is gone
       * either way and the dialog returns focus to a button that no longer
       * exists.
       */
      setRowOutcome(
        action === "commit"
          ? `${stage.draft.payee || "The staged row"} committed.`
          : `${stage.draft.payee || "The staged row"} deleted.`,
      );
      rowCommitKeys.current.clear();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["budgets"] }),
        queryClient.invalidateQueries({ queryKey: ["forecast"] }),
      ]);
    },
  });

  // Whether the failure on screen is a commit the server refused, which is the
  // only case the reassurance below is true of. Two conditions, and both are
  // needed: both mutations also delete, and a connection that died mid-commit
  // says nothing about whether the commit landed.
  const failure = bulkMutation.error ?? rowMutation.error;
  const commitRefused =
    writeDidNotHappen(failure) &&
    (bulkMutation.error
      ? bulkMutation.variables === "commit"
      : rowMutation.variables?.action === "commit");

  return (
    <>
      <PageHeader
        eyebrow="Review queue"
        title="Staged transactions"
        description="Rows waiting on you. Nothing here counts until you commit it."
        actions={
          <>
            {/* Only when there is something to work through. A run of side-by-side
                comparisons is the slow, careful way through the queue, so it is
                offered rather than assumed, and it says how much of it there is. */}
            {duplicateCount.data ? (
              <Link className="button button-secondary" to="/staged/duplicates">
                <CopyCheck size={16} /> Review {formatCount(duplicateCount.data)} possible
                {duplicateCount.data === 1 ? " duplicate" : " duplicates"}
              </Link>
            ) : null}
            <Button
              onClick={() => setEditing("new")}
              disabled={!accounts.data?.length}
              disabledReason={noAccountReason(accounts)}
            >
              <Plus size={16} /> Stage transaction
            </Button>
          </>
        }
      />
      <DateRangeBar />
      <div className="filter-bar">
        <SearchBox
          label="Search staged transactions"
          placeholder="Search payee, description, or notes"
          value={search}
          onChange={setSearch}
        />
        {/* Directly after the search box, where every other list of
            transactions puts its type filter: the register on Transactions and
            the four detail pages, Templates and Recurring. The plural labels
            are the register's rather than Templates' singular ones, because on
            those detail pages the staged rows and the committed ones are read
            as one list and the two bars sit one above the other.

            `stageFilterConditions` has applied `type` on this route since
            0.1.0, so until this control existed it was a filter only an agent
            could send
            — the defect AGENTS.md names one level below the route-by-route
            parity check, and the second instance of it after `categoryKind`. */}
        <Select
          aria-label="Filter by type"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="">All types</option>
          <option value="deposit">Deposits</option>
          <option value="withdrawal">Withdrawals</option>
          <option value="transfer">Transfers</option>
        </Select>
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
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by import batch"
          value={importBatchId}
          onChange={(event) => setImportBatchId(event.target.value)}
        >
          <option value="">All batches</option>
          {batches.map((batch) => (
            // When it arrived and how much of it is still here, because the
            // file name alone is the same every month: two "checking.csv"
            // imports read identically, and the one to filter by was a guess.
            <option key={batch.id} value={batch.id}>
              {`${batch.fileName} · ${formatTimestamp(batch.createdAt, timezone)} · ${formatCount(
                batch.stagedCount,
              )} of ${formatCount(batch.rowCount)} rows staged`}
            </option>
          ))}
        </Select>
        {recurrenceId ? (
          <Button variant="ghost" onClick={() => setRecurrenceId("")}>
            Showing one recurring transaction · show everything
          </Button>
        ) : null}
        {batchPages.hasNextPage ? (
          <Button
            variant="ghost"
            loading={batchPages.isFetchingNextPage}
            onClick={() => batchPages.fetchNextPage()}
          >
            Load older batches
          </Button>
        ) : null}
      </div>
      {/* Its own bar, a sibling of the filter row rather than a child of it.
          Nested, ticking a row grew the filter row into a second and third
          line and pushed the filters that made the selection down the page —
          and it was the one selection bar with no live region, on the one
          queue where selecting everything stops at the ten-thousand cap. */}
      {selectedRows.length ? (
        <SelectionBar
          // Always the explicit sentence, because this selection is always
          // explicit: staged commits name their rows. `web.md` 9.5 keeps "All
          // N matching selected" for the register's filtered selection, which
          // carries a server count and fingerprint, and this bar said it about
          // a list of ids — and said a bare "N selected" otherwise, where the
          // other two bars say what was selected.
          summary={
            allMatchingSelected && totalMatching > stages.length
              ? `${formatCount(selectedRows.length)} of ${formatCount(totalMatching)} matching staged transaction${
                  totalMatching === 1 ? "" : "s"
                } selected`
              : `${formatCount(selectedRows.length)} staged transaction${
                  selectedRows.length === 1 ? "" : "s"
                } selected`
          }
        >
          <>
            {canSelectAllMatching ? (
              <Button
                type="button"
                variant="secondary"
                loading={selectingAll}
                onClick={() => void selectAllMatching()}
              >
                {`Select all ${formatCount(selectableTotal)} matching`}
              </Button>
            ) : null}
            {/* One mutation runs both actions, so each button asks which one is
                running. Both spun on either, and Delete selected showed a
                spinner for the whole of a commit — work that was not
                happening, on the button that destroys rows. The other is
                still disabled while one runs, and withholds its reason then,
                because the busy flag is what disabled it (12.3). */}
            <Button
              variant="secondary"
              disabled={
                invalidSelected || (duplicateSelected && !allowDuplicates) || bulkMutation.isPending
              }
              disabledReason={
                bulkMutation.isPending
                  ? undefined
                  : invalidSelected
                    ? "Some selected rows have issues to fix first."
                    : "Some selected rows look like duplicates. Check the box to commit them anyway."
              }
              loading={bulkMutation.isPending && bulkMutation.variables === "commit"}
              onClick={() => bulkMutation.mutate("commit")}
            >
              <CheckCheck size={16} /> Commit selected
            </Button>
            <Button type="button" variant="secondary" onClick={openBulkEditor}>
              <Pencil size={16} /> Edit selected
            </Button>
            <Button
              variant="danger"
              disabled={bulkMutation.isPending}
              loading={bulkMutation.isPending && bulkMutation.variables === "delete"}
              onClick={() => {
                bulkRemoval.ask(selectedRows.length, () => bulkMutation.mutate("delete"));
              }}
            >
              <Trash2 size={16} /> Delete selected
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSelected(new Map())}>
              Clear selection
            </Button>
            {duplicateSelected || duplicateCommitError ? (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={allowDuplicates}
                  onChange={(event) => setAllowDuplicates(event.target.checked)}
                />
                Commit possible duplicates
              </label>
            ) : null}
          </>
        </SelectionBar>
      ) : null}
      {/* Mounted on the first frame, never before: until one arrives there is no
          count behind a bar, and the button's own busy state is the honest
          indicator. Removed the moment the work settles, so the Alert that
          reports the outcome takes the same slot rather than sitting under a
          bar frozen at some fraction — for an atomic commit, a bar left at 61%
          is a claim that 61% of it stuck. */}
      {commitProgress ? (
        <ProgressBar
          label={progressLabel(commitProgress)}
          value={progressFraction(commitProgress)}
          max={1}
        />
      ) : null}
      {failure ? (
        <Alert>
          {failure.message}
          {/* Somebody who watched a bar climb needs telling that the number it
              reached meant nothing. A commit is atomic, so a refusal at row two
              thousand leaves the books exactly as they were — and no other
              sentence on this page says so. Not said when the connection went
              away instead: that outcome is unknown, and the sentence it would
              be appended to says so. */}
          {commitRefused ? " Nothing was committed." : null}
        </Alert>
      ) : null}
      {bulkEditNotice ? (
        <Alert kind="info" takeFocus>
          {bulkEditNotice}
        </Alert>
      ) : null}
      {bulkOutcome ? (
        <Alert kind="success" takeFocus>
          {bulkOutcome}
        </Alert>
      ) : null}
      {rowOutcome ? (
        <Alert kind="success" takeFocus>
          {rowOutcome}
        </Alert>
      ) : null}
      {inlineError ? <Alert>{inlineError}</Alert> : null}
      {stagePages.error || batchPages.error ? (
        <Alert>{(stagePages.error ?? batchPages.error)!.message}</Alert>
      ) : null}
      {/* The whole matching set, not the page: a page holds at most 100 rows
          and the cap is 10,000, so testing the page meant this could never
          appear however long the queue was. */}
      {totalMatching > MAX_BULK_STAGES ? (
        <Alert kind="info">
          Bulk actions are limited to {MAX_BULK_STAGES.toLocaleString()} rows at a time. Commit or
          delete the selected group, then continue with the remaining rows.
        </Alert>
      ) : null}
      {stages.length ? (
        <div className="table-card">
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Staged transactions">
            <table className="data-table">
              <caption className="sr-only">Staged transactions</caption>
              <thead>
                <tr>
                  <th scope="col" className="checkbox-cell">
                    <SelectionCheckbox
                      aria-label="Select all staged transactions on this page"
                      data-selection-home
                      checked={allSelected}
                      indeterminate={someSelected && !allSelected}
                      onChange={(event) => {
                        const next = new Map(selected);
                        for (const stage of selectableRows) {
                          if (event.target.checked) {
                            // The same cap the per-row boxes enforce. Without it
                            // this one control pushed the selection past the
                            // limit, and the server then refused the whole bulk
                            // request with a message about a cap the page had
                            // claimed to be respecting.
                            if (!next.has(stage.id) && next.size >= MAX_BULK_STAGES) break;
                            next.set(stage.id, stage);
                          } else {
                            next.delete(stage.id);
                          }
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
                  <SortableHeader field="payee" label="Payee" sort={sort} onSort={applySort} />
                  <SortableHeader field="account" label="Account" sort={sort} onSort={applySort} />
                  <SortableHeader
                    field="category"
                    label="Category"
                    sort={sort}
                    onSort={applySort}
                  />
                  <SortableHeader field="status" label="Status" sort={sort} onSort={applySort} />
                  <SortableHeader
                    field="amount"
                    label="Amount"
                    lean="descending"
                    className="align-right"
                    sort={sort}
                    onSort={applySort}
                  />
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage) => {
                  const draft = stage.draft;
                  const summary = stageSummary(stage, accounts.data ?? []);
                  const date = stagedString(draft.date);
                  const payee = stagedString(draft.payee).trim() || "Incomplete row";
                  // 8.10 rule 6: a trigger's accessible name leads with its
                  // visible text, and this cell's visible text is the payee. The
                  // four were joined with an em dash, and this one was written
                  // here rather than at its attribute because that kept the dash
                  // off an `aria-label=` line, where `common.md` refuses one —
                  // which is the rule being stepped around rather than kept. A
                  // comma is the join a label takes.
                  const payeeTriggerName = `${payee}, edit the payee of ${payee}`;
                  const description = stagedString(draft.description).trim();
                  const type = stagedString(draft.type).trim() || "Unknown type";
                  return (
                    <tr key={stage.id}>
                      <td className="checkbox-cell">
                        <input
                          aria-label={`Select ${payee}`}
                          type="checkbox"
                          checked={selected.has(stage.id)}
                          disabled={!selected.has(stage.id) && selected.size >= MAX_BULK_STAGES}
                          onChange={(event) => {
                            const next = new Map(selected);
                            if (event.target.checked) next.set(stage.id, stage);
                            else next.delete(stage.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="nowrap">
                        {inlineFor(stage, "date") ? (
                          <Input
                            type="date"
                            autoFocus
                            aria-label={`Date of ${payee}`}
                            value={inline!.value}
                            onChange={(event) =>
                              setInline({ ...inline!, value: event.target.value })
                            }
                            onBlur={() => commitInline(stage)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") commitInline(stage);
                              if (event.key === "Escape") cancelInline();
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="inline-edit"
                            aria-label={`${
                              date && isoDateSchema.safeParse(date).success
                                ? formatDate(date)
                                : date || "No date"
                            }, edit the date of ${payee}`}
                            data-inline-trigger={`date:${stage.id}`}
                            onClick={() => openInline(stage, "date", date)}
                          >
                            {date
                              ? isoDateSchema.safeParse(date).success
                                ? formatDate(date)
                                : date
                              : "—"}
                          </button>
                        )}
                      </td>
                      <th scope="row">
                        {inlineFor(stage, "payee") ? (
                          <PayeeInput
                            autoFocus
                            ariaLabel={`Payee of ${payee}`}
                            value={inline!.value}
                            onChange={(next: string) => setInline({ ...inline!, value: next })}
                            onCommit={(finalValue: string) =>
                              commitInline(stage, { value: finalValue })
                            }
                            onCancel={cancelInline}
                          />
                        ) : (
                          <button
                            type="button"
                            className="inline-edit"
                            aria-label={payeeTriggerName}
                            data-inline-trigger={`payee:${stage.id}`}
                            onClick={() => openInline(stage, "payee", stagedString(draft.payee))}
                          >
                            <strong>{payee}</strong>
                          </button>
                        )}
                        <small className="table-subtitle">
                          {description || transactionTypeLabels[type] || type}
                        </small>
                        {stage.recurrenceId ? (
                          <small className="table-subtitle">
                            {`Proposed by ${
                              // The name is kept on the row rather than joined,
                              // because a proposal outlives the recurrence that
                              // made it and still has to say where it came from.
                              stage.rawData?.recurrence?.recurrenceName ?? "a recurring transaction"
                            }${
                              stage.occurrenceDate ? ` for ${formatDate(stage.occurrenceDate)}` : ""
                            }`}
                          </small>
                        ) : null}
                      </th>
                      <td>{summary.account}</td>
                      <td>
                        {stagedLegs(draft.legs).length ? (
                          // A split's categories live on its legs, so the modal
                          // is the honest editor: an inline cell could only lie
                          // about which leg it was changing.
                          <div className="cell-with-badge">
                            {/* `.subtle` here and nowhere else on this row: the
                              two inline-edit cells below render the same word as
                              a button's own label, where it takes the button's
                              color. This one is plain text and matches the
                              transactions list, which is the page a person
                              compares it against. */}
                            {categoryNames.get(
                              largestStagedLeg(stagedLegs(draft.legs))?.categoryId ?? "",
                            ) ? (
                              <span>
                                {categoryNames.get(
                                  largestStagedLeg(stagedLegs(draft.legs))?.categoryId ?? "",
                                )}
                              </span>
                            ) : (
                              <span className="subtle">Uncategorized</span>
                            )}
                            <Badge tone="blue">
                              Split · {formatCount(stagedLegs(draft.legs).length)}
                            </Badge>
                          </div>
                        ) : type === "transfer" ? (
                          // A transfer files under no category by design.
                          <TransferCategory />
                        ) : inlineFor(stage, "category") ? (
                          <span
                            // A grouping for the picker's input and list, so a
                            // blur can tell "left the editor" from "moved
                            // within it". The real control is the input inside;
                            // this wrapper only listens to events bubbling from
                            // it, which is the shape code/index.md's two named
                            // jsx-a11y exceptions already carry. Enter is
                            // deliberately NOT a commit here: picking from the
                            // datalist lands on Enter too, and committing on
                            // the keydown raced the picked value — creating a
                            // category named by the half-typed prefix. Blur is
                            // the commit gesture; Escape cancels.
                            role="presentation"
                            onBlur={(event) => {
                              if (!event.currentTarget.contains(event.relatedTarget)) {
                                commitInline(stage);
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") cancelInline();
                            }}
                          >
                            <CategoryPicker
                              categories={categories.data ?? []}
                              categoryId={inline!.value}
                              categoryName={inline!.categoryName}
                              ariaLabel={`Category of ${payee}`}
                              autoFocus
                              onChange={(nextId: string, nextName: string) =>
                                setInline({ ...inline!, value: nextId, categoryName: nextName })
                              }
                            />
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="inline-edit"
                            aria-label={`${
                              categoryNames.get(stagedString(draft.categoryId)) ??
                              (stagedString(draft.categoryName).trim() || "Uncategorized")
                            }, edit the category of ${payee}`}
                            data-inline-trigger={`category:${stage.id}`}
                            onClick={() =>
                              openInline(
                                stage,
                                "category",
                                stagedString(draft.categoryId),
                                categoryNames.get(stagedString(draft.categoryId)) ??
                                  stagedString(draft.categoryName),
                              )
                            }
                          >
                            {categoryNames.get(stagedString(draft.categoryId)) ??
                              (stagedString(draft.categoryName).trim() || "Uncategorized")}
                          </button>
                        )}
                      </td>
                      <td>
                        {stage.validationIssues.length ? (
                          <Badge tone="red">Needs attention</Badge>
                        ) : isPossibleDuplicate(stage) ? (
                          // A link rather than a label: the useful next step is
                          // seeing the two side by side, and the badge is where
                          // somebody's eye already is.
                          <Link
                            className="duplicate-badge-link"
                            to={`/staged/duplicates/${stage.id}`}
                          >
                            <Badge tone="amber">
                              {stage.duplicateOfId || stage.likelyDuplicateOfId
                                ? "Already recorded"
                                : "Repeats another row"}
                            </Badge>
                          </Link>
                        ) : (
                          <Badge tone="green">Ready</Badge>
                        )}
                        {stage.validationIssues.length ? (
                          <div className="issue-tooltip" id={`${issueIdPrefix}-${stage.id}`}>
                            <CircleAlert size={13} />
                            {stage.validationIssues[0].message}
                          </div>
                        ) : null}
                      </td>
                      <td
                        className={`align-right money ${movementSign(draftType(stage)).className}`}
                      >
                        {inlineFor(stage, "amount") ? (
                          <Input
                            inputMode="decimal"
                            autoFocus
                            aria-label={moneyLabel(`Amount of ${payee}`, summary.currency)}
                            pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
                            value={inline!.value}
                            onChange={(event) =>
                              setInline({ ...inline!, value: event.target.value })
                            }
                            onBlur={() => commitInline(stage)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") commitInline(stage);
                              if (event.key === "Escape") cancelInline();
                            }}
                          />
                        ) : (type === "deposit" || type === "withdrawal") &&
                          !stagedLegs(draft.legs).length ? (
                          // A split's total is its legs' business and a
                          // transfer carries two amounts; both edit in the
                          // modal, where the other half is on screen.
                          <button
                            type="button"
                            className="inline-edit inline-edit-money"
                            aria-label={`${
                              summary.amount && summary.currency
                                ? formatMoney(summary.amount, summary.currency)
                                : "No amount"
                            }, edit the amount of ${payee}`}
                            data-inline-trigger={`amount:${stage.id}`}
                            onClick={() => openInline(stage, "amount", stagedString(draft.amount))}
                          >
                            {summary.amount && summary.currency ? (
                              <>
                                {movementSign(draftType(stage)).sign}
                                {formatMoney(summary.amount, summary.currency)}
                              </>
                            ) : (
                              "—"
                            )}
                          </button>
                        ) : summary.amount && summary.currency ? (
                          <>
                            {movementSign(draftType(stage)).sign}
                            {formatMoney(summary.amount, summary.currency)}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="row-actions">
                        {/* A dead Commit points at the issue that stops it, which
                          the status cell already shows (`web.md` 12.3). It
                          was disabled with nothing saying why, while the
                          register's frozen-row icons beside it said theirs. */}
                        <button
                          aria-label={`Commit ${payee}`}
                          disabled={Boolean(stage.validationIssues.length)}
                          title={stage.validationIssues[0]?.message}
                          aria-describedby={
                            stage.validationIssues.length
                              ? `${issueIdPrefix}-${stage.id}`
                              : undefined
                          }
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
                        <button aria-label={`Edit ${payee}`} onClick={() => setEditing(stage)}>
                          <Pencil size={16} />
                        </button>
                        <button
                          aria-label={`Delete ${payee}`}
                          onClick={() => {
                            rowRemoval.ask(stage, () =>
                              rowMutation.mutate({ stage, action: "delete" }),
                            );
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                        <RowMenu label={`Actions for ${payee}`}>
                          <button onClick={() => setCloning(stage)}>
                            <Copy size={15} /> Clone transaction
                          </button>
                          <button onClick={() => setSavingTemplate(stage)}>
                            <LayoutTemplate size={15} /> Save as template
                          </button>
                          <button onClick={() => setSavingRecurrence(stage)}>
                            <Repeat size={15} /> Save as recurring transaction
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
            page={stagePages.data?.page ?? page}
            pageSize={stagePages.data?.pageSize ?? stages.length}
            totalCount={stagePages.data?.totalCount ?? stages.length}
            totalPages={stagePages.data?.totalPages ?? 1}
            busy={stagePages.isFetching || selectingAll}
            itemLabel="staged transactions"
            onPageChange={setPage}
          />
        </div>
      ) : stagePages.error || batchPages.error ? null : stagePages.isPending ? (
        // The busiest list in the product used to show nothing here, so the
        // page looked finished and empty until the rows arrived.
        <Skeleton height={160} label="Loading staged transactions…" />
      ) : (
        <EmptyState
          icon={ClipboardList}
          // Two screens. This queue has six filters — a search, a type, a
          // validity, an account, an import batch and a recurrence — and the
          // last two are seeded from the link an import hands over, so arriving
          // here with nothing matching is the *common* case rather than an
          // edge. It said "Nothing staged" either way, which tells somebody who
          // has just imported four hundred rows that their import did nothing.
          //
          // And "Nothing staged" only when the range hides nothing. The queue
          // opens on this month, so a row dated earlier was off screen while
          // the title said the queue was empty — beside a header counting
          // duplicates across all of it. The range is still not a filter
          // (`web.md` 12.1); it is named as the way out.
          title={
            narrowed
              ? "Nothing here matches those filters"
              : start || end
                ? "Nothing staged in this range"
                : "Nothing staged"
          }
          body={
            narrowed
              ? waysOut([...ways, "widen the date range"])
              : `${
                  start || end ? "Widen the date range to see rows dated outside it. " : ""
                }Imported rows, drafts you save for later, and anything an agent prepares land here.`
          }
        />
      )}
      <Modal open={Boolean(cloning)} onClose={() => setCloning(null)} title="Stage a transaction">
        {cloning ? (
          <TransactionForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            clone={cloning.draft}
            initialMode="stage"
            onDone={() => setCloning(null)}
          />
        ) : null}
      </Modal>
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
            initialDraft={templateDraftFromDraft(draftForTransactionForm(savingTemplate.draft))}
            onDone={() => setSavingTemplate(null)}
          />
        ) : null}
      </Modal>
      <Modal
        open={Boolean(savingRecurrence)}
        onClose={() => setSavingRecurrence(null)}
        title="Save as recurring transaction"
        description="The same entry on a schedule. It adds a row to Staged transactions on each due date and posts nothing until you commit it."
      >
        {recurrenceSeed ? (
          <RecurrenceForm
            accounts={accounts.data ?? []}
            categories={categories.data ?? []}
            initialShape={recurrenceShapeFromDraft(recurrenceSeed)}
            initialAnchorDate={recurrenceSeed.date}
            onDone={() => setSavingRecurrence(null)}
          />
        ) : null}
      </Modal>
      <Modal
        open={bulkEditing}
        onClose={closeBulkEditor}
        title="Edit selected staged rows"
        description="Choose only the fields you want to change. Nothing is committed: the rows are updated in the queue and checked again, so filling in what was missing can clear their warnings."
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
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
              disabledReason={bulkEditBlockedBecause}
            >
              Apply changes
            </Button>
          </>
        }
      >
        <form id="staged-bulk-edit-form" className="bulk-edit-form" onSubmit={submitBulkEdit}>
          <p className="bulk-edit-selection-summary">
            {`${formatCount(selectedRows.length)} selected staged row${
              selectedRows.length === 1 ? "" : "s"
            } will be edited.`}
          </p>

          {bulkEditMutation.error ? <Alert>{bulkEditMutation.error.message}</Alert> : null}

          {selectionContainsTransfers ? (
            <Alert kind="info">
              This selection contains {formatCount(selectedTransferCount)} transfer
              {selectedTransferCount === 1 ? "" : "s"}. You can change common details, but Account
              and Type are unavailable for transfers.
            </Alert>
          ) : selectedUntypedCount ? (
            <Alert kind="info">
              {formatCount(selectedUntypedCount)} selected row
              {selectedUntypedCount === 1 ? " does" : "s do"} not say whether money came in or went
              out. Change Type in the same edit to set an account on{" "}
              {selectedUntypedCount === 1 ? "it" : "them"}.
            </Alert>
          ) : null}

          <div className="bulk-edit-fields">
            <BulkEditDateField
              values={bulkValues}
              enabled={bulkEnabled}
              onEnabled={setBulkFieldEnabled}
              onValue={setBulkFieldValues}
            />

            <BulkEditPayeeField
              values={bulkValues}
              enabled={bulkEnabled}
              onEnabled={setBulkFieldEnabled}
              onValue={setBulkFieldValues}
              listId={payeeListId}
              suggestions={payeeSuggestions.data ?? []}
            />

            <BulkEditToggle
              label="Change category"
              enabled={bulkEnabled.categoryId}
              disabled={categoryChangeUnavailable}
              onToggle={(on) => setBulkEnabled((current) => ({ ...current, categoryId: on }))}
              hint={
                categoryChangeUnavailable
                  ? "Category cannot be edited across the selection while a split row is in it, because a split already files its money by category."
                  : undefined
              }
            >
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
            </BulkEditToggle>

            <BulkEditToggle
              label="Change account"
              enabled={bulkEnabled.accountId}
              disabled={accountChangeUnavailable}
              onToggle={(on) => setBulkEnabled((current) => ({ ...current, accountId: on }))}
              hint={
                accountChangeUnavailable
                  ? "Account cannot be edited across the selection while a transfer is in it."
                  : bulkEnabled.accountId && accountNeedsType
                    ? "Some selected rows have no type yet. Turn on Change type to set an account on them."
                    : undefined
              }
            >
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
                {/* Frozen accounts are left out as well as archived ones, the
                    rule the transaction browser's picker keeps: the server files
                    a move onto one as an issue on every row, so offering it
                    offers an edit that fixes nothing. */}
                {(accounts.data ?? [])
                  .filter((account) => !account.archivedAt && !account.frozen)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.currency})
                    </option>
                  ))}
              </Select>
            </BulkEditToggle>

            <BulkEditDescriptionField
              values={bulkValues}
              enabled={bulkEnabled}
              onEnabled={setBulkFieldEnabled}
              onValue={setBulkFieldValues}
            />

            <BulkEditNotesField
              values={bulkValues}
              enabled={bulkEnabled}
              onEnabled={setBulkFieldEnabled}
              onValue={setBulkFieldValues}
            />

            <BulkEditToggle
              label="Change type"
              enabled={bulkEnabled.type}
              disabled={typeChangeUnavailable}
              onToggle={(on) => setBulkEnabled((current) => ({ ...current, type: on }))}
              hint={
                typeChangeUnavailable
                  ? selectionContainsTransfers
                    ? "Type cannot be edited across the selection while a transfer is in it."
                    : "Type cannot be edited across the selection while a split row is in it, because every leg's category was chosen for the direction this entry runs in."
                  : undefined
              }
            >
              <Select
                aria-label="New transaction type"
                value={bulkValues.type}
                disabled={!bulkEnabled.type}
                onChange={(event) =>
                  setBulkValues((current) => ({
                    ...current,
                    type: event.target.value as EntryType,
                  }))
                }
              >
                <option value="deposit">Deposit</option>
                <option value="withdrawal">Withdrawal</option>
              </Select>
            </BulkEditToggle>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={bulkRemoval.open}
        confirmLabel="Delete staged rows"
        title="Delete these staged rows?"
        description={
          bulkRemoval.value
            ? `${formatCount(bulkRemoval.value)} row${bulkRemoval.value === 1 ? "" : "s"} will be removed from the queue. Nothing has been committed yet, so no balance changes.`
            : undefined
        }
        onConfirm={bulkRemoval.confirm}
        onCancel={bulkRemoval.cancel}
      />

      <ConfirmDialog
        open={rowRemoval.open}
        confirmLabel="Delete staged row"
        title="Delete this staged row?"
        description="It is removed from the queue. Nothing has been committed, so no balance changes."
        onConfirm={rowRemoval.confirm}
        onCancel={rowRemoval.cancel}
      />

      <ConfirmDialog
        open={duplicate.open}
        title="Commit this anyway?"
        description="This looks like a transaction you already have. Committing it will record a second one."
        confirmLabel="Commit anyway"
        confirmVariant="primary"
        onConfirm={duplicate.confirm}
        onCancel={duplicate.cancel}
      />
    </>
  );
}
