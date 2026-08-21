import type {
  ActorSource,
  UserAccountType,
  CategoryKind,
  PaginatedPage,
  Page,
  RecurrenceFrequencyName,
  RecurrenceSchedule,
  RecurrenceShape,
  ReportBucket,
  ReportName,
  StagedDraft,
  TransactionTemplateDraft,
  TransactionType,
  ValidationIssue,
} from "../shared/domain.js";

export class ApiClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiClientError(
      payload?.error?.code ?? `HTTP_${response.status}`,
      payload?.error?.message ?? response.statusText,
      payload?.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const json = (value: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(value),
});

export type Session = {
  user: { id: string; name: string; email: string; image?: string | null };
  preferences: Preferences;
  auth: UserAuthState;
};

export type AuthMode = "local" | "google" | "both";

export type AuthPublicOptions = {
  mode: AuthMode;
  localEnabled: boolean;
  googleEnabled: boolean;
  localRegistrationOpen: boolean;
  awaitingFirstAccount: boolean;
  setupTokenRequired: boolean;
  passwordResetAvailable: boolean;
  emailVerificationRequired: boolean;
  minimumPasswordLength: number;
};

export type UserAuthState = {
  mode: AuthMode;
  localEnabled: boolean;
  googleEnabled: boolean;
  localPasswordConfigured: boolean;
  googleLinked: boolean;
};

export type Preferences = {
  userId: string;
  timezone: string;
  defaultCurrency: string;
  /** False until somebody has actually picked these, rather than been given them. */
  chosen: boolean;
};

export type Account = {
  id: string;
  name: string;
  type: UserAccountType;
  currency: string;
  openingDate: string;
  openingBalance: string;
  institution?: string | null;
  notes?: string | null;
  archivedAt?: string | null;
  version: number;
  balance: string;
  balancePresentation: { label: string; amount: string };
};

export type AccountBalanceSnapshot = {
  accountId: string;
  currency: string;
  range: {
    start: string | null;
    end: string | null;
    today: string;
  };
  beginning: AccountBalanceView;
  ending: AccountBalanceView;
  current: AccountBalanceView;
  future: AccountBalanceView;
};

export type AccountBalanceView = {
  balance: string;
  balancePresentation: { label: string; amount: string };
};

export type Category = {
  id: string;
  name: string;
  kind: CategoryKind;
  archivedAt?: string | null;
  version: number;
};

/**
 * A category plus how much it is used. Its own type rather than fields on
 * `Category`, because a category reached through a transaction, a merge result,
 * or a duplicate group carries no counts, and optional counts would leave every
 * reader guessing whether zero means zero or means nobody asked.
 */
export type CategorySummary = Category & {
  transactionCount: number;
  stagedTransactionCount: number;
  totalCount: number;
};

export type CategoryDuplicateGroup = {
  normalizedName: string;
  count: number;
  categories: Category[];
};

export type CategoryMergeResult = {
  targetCategory: Category;
  mergedSourceCategoryIds: string[];
  updatedTransactionCount: number;
  updatedStagedTransactionCount: number;
};

/**
 * Re-exported rather than restated, the way CsvPreview already is. A second
 * copy of a shape the server defines is a copy that can drift, and nothing here
 * would catch it: the browser would keep compiling against a shape the API had
 * stopped sending.
 */
export type {
  PayeeSummary,
  PayeeDuplicateGroup,
  PayeeMergeResult,
} from "../shared/domain.js";
export type {
  BulkTransactionSelectionSnapshot as TransactionBulkSelectionPreview,
  BulkTransactionEditResult as TransactionBulkEditResult,
  BulkStageEditResult as StagedBulkEditResult,
} from "../shared/domain.js";


/**
 * One category's share of a split. `id` is what an edit sends back to keep
 * meaning this leg rather than replacing it with a new one.
 */
export type TransactionLeg = {
  id: string;
  categoryId: string | null;
  category: Category | null;
  amount: string;
  note: string | null;
};

export type Transaction = {
  id: string;
  type: TransactionType;
  date: string;
  payee: string;
  description: string | null;
  categoryId?: string | null;
  category?: Category | null;
  notes?: string | null;
  externalId?: string | null;
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
  sourceAccount?: Pick<Account, "id" | "name" | "currency"> | null;
  destinationAccount?: Pick<Account, "id" | "name" | "currency"> | null;
  sourceAmount?: string | null;
  destinationAmount?: string | null;
  sourceCurrency?: string | null;
  destinationCurrency?: string | null;
  effectiveRate?: string | null;
  deletedAt?: string | null;
  legCount?: number;
  legs: TransactionLeg[];
  version: number;
};

export type TransactionBulkEditFilter = {
  start?: string;
  end?: string;
  search?: string;
  type?: TransactionType;
  accountId?: string;
  categoryId?: string;
  payee?: string;
  includeDeleted: boolean;
  currency?: string;
};

export type TransactionBulkEditSelection =
  | {
      mode: "ids";
      items: { id: string; expectedVersion: number }[];
    }
  | {
      mode: "filter";
      filter: TransactionBulkEditFilter;
      excludedIds: string[];
      expectedCount: number;
      expectedFingerprint: string;
    };


export type TransactionBulkEditPatch = {
  date?: string;
  payee?: string;
  categoryId?: string | null;
  accountId?: string;
  description?: string | null;
  notes?: string | null;
  type?: "deposit" | "withdrawal";
};


export type StagedTransaction = {
  id: string;
  draft: StagedDraft;
  validationIssues: ValidationIssue[];
  duplicateOfId?: string | null;
  /** Another row still waiting in the queue carries the same fingerprint. */
  repeatsStagedRow?: boolean;
  /**
   * A committed transaction that looks like the same money: same account, same
   * direction, same amount, within a few days. Payee and category are ignored,
   * being the two most likely to differ between two records of one purchase.
   */
  likelyDuplicateOfId?: string | null;
  importBatchId?: string | null;
  recurrenceId?: string | null;
  occurrenceDate?: string | null;
  rawData?: {
    recurrence?: {
      recurrenceId: string;
      recurrenceName: string;
      occurrenceDate: string;
    };
  } | null;
  version: number;
  status: "staged" | "committed" | "deleted";
  createdAt: string;
};

/**
 * The staged queue works in explicit ids, because it already holds the selected
 * rows to decide whether a commit is safe. The server also accepts a filter
 * selection, which is what an agent uses to reach a whole import batch without
 * listing it.
 */
export type StagedBulkEditSelection = {
  mode: "ids";
  items: { id: string; expectedVersion: number }[];
};

export type StagedBulkEditPatch = {
  date?: string;
  payee?: string;
  categoryId?: string | null;
  accountId?: string;
  description?: string | null;
  notes?: string | null;
  type?: "deposit" | "withdrawal";
};


/**
 * A saved starting point for the transaction form. The draft is partial on
 * purpose: a key that is not there is a field the person left for later.
 */
export type TransactionTemplate = {
  transactionCount?: number;
  stagedTransactionCount?: number;
  totalTransactionCount?: number;
  id: string;
  name: string;
  draft: TransactionTemplateDraft;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * A standing instruction to propose a transaction on a schedule.
 *
 * `nextOccurrence` is recomputed by the server from the rule rather than read
 * from the cached column, so a stale cache shows as an overdue recurrence with
 * nothing proposed rather than as a wrong date on this page.
 */
export type Recurrence = {
  id: string;
  name: string;
  shape: RecurrenceShape;
  frequency: RecurrenceFrequencyName;
  interval: number;
  anchorDate: string;
  monthPolicy: RecurrenceSchedule["monthPolicy"];
  weekendPolicy: RecurrenceSchedule["weekendPolicy"];
  positionOrdinal: number | null;
  positionWeekday: number | null;
  proposesFrom: string;
  lastOccurrenceDate: string | null;
  nextOccurrenceDate: string;
  nextOccurrence: { occurrenceDate: string; postedDate: string | null };
  overdue: boolean;
  proposedCount: number;
  committedCount: number;
  discardedCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RecurrenceList = { today: string; items: Recurrence[] };

export type ImportBatchSummary = {
  id: string;
  fileName: string;
  rowCount: number;
  stagedCount: number;
  createdAt: string;
};

export type Summary = {
  range: { start: string | null; end: string | null };
  /** The day the figures are really as of, which is today when the range runs past it. */
  asOf: string;
  includesArchived: boolean;
  currencies: {
    currency: string;
    balance: string;
    deposits: string;
    withdrawals: string;
    netCashFlow: string;
    accounts: {
      id: string;
      name: string;
      type: UserAccountType;
      balance: string;
      archivedAt: string | null;
    }[];
    spendingByCategory: {
      categoryId: string | null;
      category: string;
      amount: string;
    }[];
  }[];
};

export type Report = {
  report: ReportName;
  range: { start: string | null; end: string | null };
  /** The day the figures are really as of, which is today when the range runs past it. */
  asOf: string;
  bucket: ReportBucket;
  accumulation: "change" | "historical";
  includesArchived: boolean;
  buckets: { start: string; end: string }[];
  currencies: {
    currency: string;
    rows: {
      key: string;
      label: string;
      kind: string | null;
      /** A closed account, whose history a balance report still reports. */
      archived: boolean;
      values: string[];
      total: string;
    }[];
    totals: string[];
  }[];
};

export type AccountRegister = {
  accountId: string;
  accountName: string;
  type: UserAccountType;
  currency: string;
  archivedAt: string | null;
  range: { start: string | null; end: string | null };
  asOf: string;
  openingBalance: string;
  closingBalance: string;
  entries: {
    postingId: string;
    transactionId: string | null;
    date: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    origin: "opening" | "closing" | "transaction";
  }[];
};

/**
 * A staged row beside the one thing it looks like a repeat of.
 *
 * `second` is null when nothing matches it any more, which is what a pair
 * somebody has already resolved looks like. A committed transaction is always
 * `second`; where both sides are staged, the older one is.
 */
export type StagedDuplicateReview = {
  first: DuplicateReviewSide;
  second: DuplicateReviewSide | null;
};

export type DuplicateReviewSide = {
  kind: "staged" | "committed";
  staged: StagedTransaction | null;
  committed: Transaction | null;
};

export type AuditEvent = {
  id: string;
  actorSource: ActorSource;
  clientId?: string | null;
  entityType: string;
  entityId: string;
  operation: string;
  createdAt: string;
};

// The preview the server returns is exactly what the shared parser produces, so
// the browser reads that type rather than keeping a second copy of it that can
// drift.
export type { CsvPreview } from "../shared/csv.js";

export type { PaginatedPage, Page };

export function queryString(values: Record<string, string | undefined | null>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}
