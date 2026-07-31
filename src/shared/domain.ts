import { z } from "zod";

export const accountTypes = [
  "checking",
  "savings",
  "debit_card",
  "credit_card",
  "cash",
  "crypto_wallet",
  "loan",
  "investment",
  "other_asset",
  "other_liability",
] as const;

export type AccountType = (typeof accountTypes)[number];

export const accountTypeLabels: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  debit_card: "Debit Card",
  credit_card: "Credit Card",
  cash: "Cash",
  crypto_wallet: "Crypto Wallet",
  loan: "Loan",
  investment: "Investment",
  other_asset: "Other Asset",
  other_liability: "Other Liability",
};

export const liabilityAccountTypes = new Set<AccountType>([
  "credit_card",
  "loan",
  "other_liability",
]);

export const categoryKinds = ["income", "expense", "both"] as const;
export type CategoryKind = (typeof categoryKinds)[number];

export const transactionTypes = ["deposit", "withdrawal", "transfer"] as const;
export type TransactionType = (typeof transactionTypes)[number];

export const actorSources = ["web", "mcp"] as const;
export type ActorSource = (typeof actorSources)[number];

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
  }, "Date is not valid");

export const currencyCodeSchema = z
  .string()
  .regex(
    /^[A-Z]{2,12}$/,
    "Use an uppercase ISO currency code or supported crypto asset symbol",
  );

export const decimalStringSchema = z
  .string()
  .regex(
    /^-?(?:0|[1-9]\d{0,25})(?:\.\d{1,18})?$/,
    "Use a decimal string with at most 26 integer and 18 fractional digits",
  );

export const positiveDecimalStringSchema = decimalStringSchema.refine(
  (value) => !value.startsWith("-") && value !== "0" && !/^0\.0+$/.test(value),
  "Amount must be greater than zero",
);

export const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const nonNegativeDecimalStringSchema = decimalStringSchema.refine(
  (value) => !value.startsWith("-"),
  "Amount cannot be negative",
);

const transactionCommon = {
  date: isoDateSchema,
  description: z.string().trim().min(1).max(240),
  payee: z.string().trim().max(160).optional().nullable(),
  categoryId: z.string().uuid().optional().nullable(),
  notes: z.string().trim().max(4_000).optional().nullable(),
  externalId: z.string().trim().max(200).optional().nullable(),
};

export const depositDraftSchema = z.object({
  type: z.literal("deposit"),
  ...transactionCommon,
  toAccountId: z.string().uuid(),
  amount: positiveDecimalStringSchema,
});

export const withdrawalDraftSchema = z.object({
  type: z.literal("withdrawal"),
  ...transactionCommon,
  fromAccountId: z.string().uuid(),
  amount: positiveDecimalStringSchema,
});

export const transferDraftSchema = z.object({
  type: z.literal("transfer"),
  ...transactionCommon,
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  sourceAmount: positiveDecimalStringSchema,
  destinationAmount: positiveDecimalStringSchema.optional(),
});

export const transactionDraftSchema = z.discriminatedUnion("type", [
  depositDraftSchema,
  withdrawalDraftSchema,
  transferDraftSchema,
]);

export type TransactionDraft = z.infer<typeof transactionDraftSchema>;

// Staging deliberately accepts incomplete normalized drafts so imported rows and
// agents can preserve/correct validation errors without affecting the ledger.
export const stagedDraftSchema = z
  .object({
    type: z.unknown().optional(),
    date: z.unknown().optional(),
    description: z.unknown().optional(),
    payee: z.unknown().optional(),
    categoryId: z.unknown().optional(),
    notes: z.unknown().optional(),
    externalId: z.unknown().optional(),
    fromAccountId: z.unknown().optional(),
    toAccountId: z.unknown().optional(),
    amount: z.unknown().optional(),
    sourceAmount: z.unknown().optional(),
    destinationAmount: z.unknown().optional(),
  })
  .catchall(z.unknown());

export type StagedDraft = z.infer<typeof stagedDraftSchema>;

export const accountCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(accountTypes),
  currency: currencyCodeSchema,
  openingDate: isoDateSchema,
  openingBalance: decimalStringSchema,
  institution: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(2_000).optional().nullable(),
});

export const accountUpdateSchema = accountCreateSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(categoryKinds),
});

export const categoryUpdateSchema = categoryCreateSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });

export const categoryMergeSchema = z.object({
  sourceCategoryIds: z.array(z.string().uuid()).min(1).max(100),
  targetCategoryId: z.string().uuid(),
  expectedVersions: z.record(z.string(), z.number().int().positive()),
  targetExpectedVersion: z.number().int().positive(),
});

export const directTransactionCreateSchema = z.object({
  draft: transactionDraftSchema,
  idempotencyKey: idempotencyKeySchema,
  allowDuplicate: z.boolean().default(false),
});

export const transactionUpdateSchema = z.object({
  draft: transactionDraftSchema,
  expectedVersion: z.number().int().positive(),
  allowDuplicate: z.boolean().default(false),
});

export const versionedMutationSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const transactionDeletedMutationSchema = versionedMutationSchema.extend({
  deleted: z.boolean(),
  allowDuplicate: z.boolean().default(false),
});

export const stageCreateSchema = z.object({
  draft: stagedDraftSchema,
  idempotencyKey: idempotencyKeySchema,
  rawData: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();

export const stageUpdateSchema = z.object({
  draft: stagedDraftSchema,
  expectedVersion: z.number().int().positive(),
});

export const commitStageSchema = z.object({
  stagedIds: z.array(z.string().uuid()).min(1).max(5_000),
  expectedVersions: z.record(z.string(), z.number().int().positive()),
  idempotencyKey: idempotencyKeySchema,
  allowDuplicates: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

export const bulkDeleteStageSchema = z.object({
  stagedIds: z.array(z.string().uuid()).min(1).max(5_000),
  expectedVersions: z.record(z.string(), z.number().int().positive()),
});

export const dateRangeSchema = z.object({
  start: isoDateSchema.optional(),
  end: isoDateSchema.optional(),
});

export const queryBooleanSchema = z
  .union([
    z.boolean(),
    z.literal("true").transform(() => true),
    z.literal("false").transform(() => false),
  ])
  .default(false);

export const listQuerySchema = dateRangeSchema.extend({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  type: z.enum(transactionTypes).optional(),
  currency: currencyCodeSchema.optional(),
  search: z.string().trim().max(200).optional(),
  includeDeleted: queryBooleanSchema,
});

export const stageListQuerySchema = listQuerySchema.extend({
  importBatchId: z.string().uuid().optional(),
  validity: z.enum(["valid", "invalid", "duplicate"]).optional(),
});

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "DUPLICATE"
  | "CONFLICT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
};

export type Actor = {
  userId: string;
  source: ActorSource;
  clientId?: string;
};

export type ValidationIssue = {
  field: string;
  message: string;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};
