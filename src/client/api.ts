import type {
  AccountType,
  CategoryKind,
  Page,
  StagedDraft,
  TransactionDraft,
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
  setupTokenRequired: boolean;
  minimumPasswordLength: number;
};

export type UserAuthState = {
  mode: AuthMode;
  localEnabled: boolean;
  googleEnabled: boolean;
  localPasswordConfigured: boolean;
  googleLinked: boolean;
  googleEligible: boolean;
};

export type Preferences = {
  userId: string;
  timezone: string;
  defaultCurrency: string;
};

export type Account = {
  id: string;
  name: string;
  type: AccountType;
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

export type Transaction = {
  id: string;
  type: TransactionType;
  date: string;
  description: string;
  payee?: string | null;
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
  version: number;
};

export type StagedTransaction = {
  id: string;
  draft: StagedDraft;
  validationIssues: ValidationIssue[];
  duplicateOfId?: string | null;
  importBatchId?: string | null;
  version: number;
  status: "staged" | "committed" | "deleted";
  createdAt: string;
};

export type ImportBatchSummary = {
  id: string;
  fileName: string;
  rowCount: number;
  stagedCount: number;
  createdAt: string;
};

export type Summary = {
  range: { start: string | null; end: string | null };
  currencies: {
    currency: string;
    balance: string;
    deposits: string;
    withdrawals: string;
    netCashFlow: string;
    accounts: {
      id: string;
      name: string;
      type: AccountType;
      balance: string;
    }[];
    spendingByCategory: {
      categoryId: string | null;
      category: string;
      amount: string;
    }[];
  }[];
};

export type AuditEvent = {
  id: string;
  actorSource: "web" | "mcp";
  clientId?: string | null;
  entityType: string;
  entityId: string;
  operation: string;
  createdAt: string;
};

export type CsvPreview = {
  delimiter: string;
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
};

export type { Page, TransactionDraft };

export function queryString(values: Record<string, string | undefined | null>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}
