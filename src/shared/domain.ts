import { z } from "zod";

export const accountTypes = [
  "checking",
  "savings",
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
  payee: z.string().trim().min(1, "Payee is required").max(160),
  description: z
    .string()
    .trim()
    .max(240)
    .optional()
    .nullable()
    .transform((value) => value || null),
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

// Payees are intentionally derived from transaction text rather than stored in
// a separate table. Source names preserve their exact spelling so variants
// that differ only by case or whitespace can still be selected and merged.
export const payeeNameSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value.trim().length > 0, "Payee is required");

export const payeeListQuerySchema = z.object({
  search: z.string().trim().max(160).optional(),
});

export const payeeSummarySchema = z.object({
  name: payeeNameSchema,
  normalizedName: z.string().min(1).max(500),
  transactionCount: z.number().int().nonnegative(),
  stagedTransactionCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});

export const payeeDuplicateGroupSchema = z.object({
  normalizedName: z.string().min(1).max(500),
  count: z.number().int().min(2),
  payees: z.array(payeeSummarySchema).min(2),
});

export const payeeMergeSchema = z
  .object({
    sourcePayees: z.array(payeeNameSchema).min(1).max(100),
    targetPayee: payeeNameSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const payeeMergeResultSchema = z.object({
  targetPayee: payeeNameSchema,
  mergedSourcePayees: z.array(payeeNameSchema).min(1),
  updatedTransactionCount: z.number().int().nonnegative(),
  updatedStagedTransactionCount: z.number().int().nonnegative(),
});

export type PayeeSummary = z.infer<typeof payeeSummarySchema>;
export type PayeeDuplicateGroup = z.infer<typeof payeeDuplicateGroupSchema>;
export type PayeeMergeInput = z.infer<typeof payeeMergeSchema>;
export type PayeeMergeResult = z.infer<typeof payeeMergeResultSchema>;

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

/**
 * The most rows one bulk selection may carry. Every bulk request that lists ids
 * is capped here, and the HTTP body limit for those routes is derived from it,
 * so raising the cap cannot leave the transport rejecting payloads the schemas
 * accept.
 */
export const MAX_BULK_SELECTION_ENTRIES = 10_000;

export const stageUpdateSchema = z.object({
  draft: stagedDraftSchema,
  expectedVersion: z.number().int().positive(),
});

export const commitStageSchema = z.object({
  stagedIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_SELECTION_ENTRIES),
  expectedVersions: z.record(z.string(), z.number().int().positive()),
  idempotencyKey: idempotencyKeySchema,
  allowDuplicates: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

export const bulkDeleteStageSchema = z.object({
  stagedIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_SELECTION_ENTRIES),
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
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  payee: z.string().trim().min(1).max(160).optional(),
  type: z.enum(transactionTypes).optional(),
  currency: currencyCodeSchema.optional(),
  search: z.string().trim().max(200).optional(),
  includeDeleted: queryBooleanSchema,
});

// Bulk filter selections deliberately omit pagination. They describe the
// complete current view, while explicit selections carry the optimistic
// versions shown to the user on the current page. Leaving `page` in would scope
// a fingerprinted selection to whichever page happened to be open.
export const bulkTransactionFilterSchema = listQuerySchema
  .omit({ cursor: true, page: true, limit: true })
  .strict();

const bulkTransactionIdSelectionSchema = z
  .object({
    mode: z.literal("ids"),
    items: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            expectedVersion: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BULK_SELECTION_ENTRIES),
  })
  .strict()
  .superRefine((selection, context) => {
    const ids = selection.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Transaction IDs must be unique",
      });
    }
  });

const bulkTransactionFilterSelectionSchema = z
  .object({
    mode: z.literal("filter"),
    filter: bulkTransactionFilterSchema,
    excludedIds: z.array(z.string().uuid()).max(MAX_BULK_SELECTION_ENTRIES).default([]),
    expectedCount: z.number().int().nonnegative(),
    expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.excludedIds).size !== selection.excludedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["excludedIds"],
        message: "Excluded transaction IDs must be unique",
      });
    }
  });

export const bulkTransactionSelectionSchema = z.discriminatedUnion("mode", [
  bulkTransactionIdSelectionSchema,
  bulkTransactionFilterSelectionSchema,
]);

export const bulkTransactionFilterSelectionRequestSchema = z
  .object({
    filter: bulkTransactionFilterSchema,
    excludedIds: z.array(z.string().uuid()).max(MAX_BULK_SELECTION_ENTRIES).default([]),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.excludedIds).size !== selection.excludedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["excludedIds"],
        message: "Excluded transaction IDs must be unique",
      });
    }
  });

export const bulkTransactionSelectionSnapshotSchema = z
  .object({
    count: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    activeCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    transferCount: z.number().int().nonnegative(),
    currencies: z.array(currencyCodeSchema),
  })
  .strict();

export const bulkTransactionPatchSchema = z
  .object({
    date: isoDateSchema.optional(),
    payee: z.string().trim().min(1, "Payee is required").max(160).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    accountId: z.string().uuid().optional(),
    description: z
      .string()
      .trim()
      .max(240)
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value)),
    notes: z
      .string()
      .trim()
      .max(4_000)
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value)),
    type: z.enum(["deposit", "withdrawal"]).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Choose at least one field to update",
  });

export const bulkTransactionEditSchema = z
  .object({
    selection: bulkTransactionSelectionSchema,
    patch: bulkTransactionPatchSchema,
    idempotencyKey: idempotencyKeySchema,
    allowDuplicates: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict();

export const bulkTransactionDeleteSchema = z
  .object({
    selection: bulkTransactionSelectionSchema,
    idempotencyKey: idempotencyKeySchema,
    dryRun: z.boolean().default(false),
  })
  .strict();

export const bulkTransactionEditItemSchema = z
  .object({
    id: z.string().uuid(),
    previousVersion: z.number().int().positive(),
    nextVersion: z.number().int().positive(),
    type: z.enum(transactionTypes),
    date: isoDateSchema,
    payee: payeeNameSchema,
  })
  .strict();

export const bulkTransactionEditResultSchema = z
  .object({
    updatedCount: z.number().int().nonnegative(),
    dryRun: z.boolean(),
    selectionCount: z.number().int().nonnegative(),
    selectionFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    activeCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    transferCount: z.number().int().nonnegative(),
    currencies: z.array(currencyCodeSchema),
    itemsTruncated: z.boolean(),
    items: z.array(bulkTransactionEditItemSchema),
  })
  .strict();

export type BulkTransactionFilter = z.infer<
  typeof bulkTransactionFilterSchema
>;
export type BulkTransactionFilterSelectionRequest = z.infer<
  typeof bulkTransactionFilterSelectionRequestSchema
>;
export type BulkTransactionSelectionSnapshot = z.infer<
  typeof bulkTransactionSelectionSnapshotSchema
>;
export type BulkTransactionPatch = z.infer<typeof bulkTransactionPatchSchema>;
export type BulkTransactionEditInput = z.infer<
  typeof bulkTransactionEditSchema
>;
export type BulkTransactionEditResult = z.infer<
  typeof bulkTransactionEditResultSchema
>;
export type BulkTransactionDeleteInput = z.infer<
  typeof bulkTransactionDeleteSchema
>;

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

/** A cursor window. Used where callers only ever stream forward. */
export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

/** A cursor window that also knows where it sits in the whole result set. */
export type PaginatedPage<T> = Page<T> & {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};
