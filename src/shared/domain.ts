import { z } from "zod";

/** Types a person can pick when creating an account. */
export const userAccountTypes = [
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

/**
 * Double-entry needs somewhere for the other half of a deposit or withdrawal to
 * land. Those counter-accounts are created by the server, never by a person, so
 * the stored enum carries one extra type the create form does not offer.
 */
export const accountTypes = [...userAccountTypes, "system"] as const;

export type UserAccountType = (typeof userAccountTypes)[number];
export type AccountType = (typeof accountTypes)[number];

/** Which side of the books a server-owned counter-account represents. */
export const systemAccountKinds = [
  "income",
  "expense",
  "exchange",
  "equity",
] as const;
export type SystemAccountKind = (typeof systemAccountKinds)[number];

export const accountTypeLabels: Record<UserAccountType, string> = {
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

export const liabilityAccountTypes = new Set<UserAccountType>([
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
  }, "Date is not valid")
  .describe("Calendar date as YYYY-MM-DD, for example 2026-03-14.");

export const currencyCodeSchema = z
  .string()
  .regex(
    /^[A-Z]{2,12}$/,
    "Use an uppercase ISO currency code or supported crypto asset symbol",
  )
  .describe(
    "Uppercase currency code, for example USD or EUR, or a crypto asset symbol such as BTC. An account's currency is fixed once it is in use.",
  );

export const decimalStringSchema = z
  .string()
  .regex(
    /^-?(?:0|[1-9]\d{0,25})(?:\.\d{1,18})?$/,
    "Use a decimal string with at most 26 integer and 18 fractional digits",
  )
  .describe(
    'Money as a decimal STRING, for example "1234.56". Never a JSON number: binary floating point cannot hold these values exactly. Up to 26 digits before the point and 18 after.',
  );

export const positiveDecimalStringSchema = decimalStringSchema
  .refine(
    (value) => !value.startsWith("-") && value !== "0" && !/^0\.0+$/.test(value),
    "Amount must be greater than zero",
  )
  .describe(
    'How much money moved, as a decimal string greater than zero, for example "42.50". Direction comes from the transaction type, so this is never negative.',
  );

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .describe(
    "A key you choose to make this write safe to retry. Sending the same key again returns the original result instead of recording a second time. Use a fresh one per intended action, for example a UUID.",
  );

/**
 * Control characters a person cannot have meant to type. A NUL byte in
 * particular is rejected by PostgreSQL's own text encoding, so without this it
 * travels all the way to the driver and comes back as an unexplained server
 * error rather than as the invalid input it is.
 *
 * Line breaks and tabs are left alone for the fields where they read naturally.
 */
const forbiddenAnywhere = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const forbiddenOnOneLine = /[\u0000-\u001F\u007F]/u;

const oneLine = <T extends z.ZodString>(schema: T) =>
  schema.refine(
    (value) => !forbiddenOnOneLine.test(value),
    "Text cannot contain line breaks or control characters",
  );

const freeText = <T extends z.ZodString>(schema: T) =>
  schema.refine(
    (value) => !forbiddenAnywhere.test(value),
    "Text cannot contain control characters",
  );

const transactionCommon = {
  date: isoDateSchema,
  payee: oneLine(z.string().trim().min(1, "Payee is required").max(160)),
  description: freeText(z.string().trim().max(240))
    .optional()
    .nullable()
    .transform((value) => value || null),
  categoryId: z.string().uuid().optional().nullable(),
  // Naming a category instead of picking one. The name is matched against the
  // categories this ledger already has, ignoring case and surrounding space, and
  // only creates one when nothing matches. That is the same rule a CSV import
  // follows, so typing "groceries" where "Groceries" exists files the entry
  // under the category already there rather than starting a second spelling of
  // it. Ignored when categoryId is given, since an id is already an answer.
  categoryName: oneLine(z.string().trim().min(1).max(120))
    .optional()
    .nullable()
    .describe(
      'A category by name rather than by id, matched case-insensitively against your existing categories and created only if it is genuinely new. Ignored when categoryId is set. Use this when you know what to call it but not its id, for example "Groceries".',
    ),
  notes: freeText(z.string().trim().max(4_000)).optional().nullable(),
  externalId: oneLine(z.string().trim().max(200)).optional().nullable(),
  // Which template this was made from, kept so a template can report what came
  // of it. Provenance only: nothing reads it back into the entry.
  templateId: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .describe(
      "The template this entry was started from, if any. Recorded so a template can report the transactions made from it; it changes nothing about the entry itself.",
    ),
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

/**
 * The most templates one person may keep. The list is unpaginated and fetched
 * whenever the transaction form opens, and each row carries a JSON draft, so it
 * is heavier per row than the category list it otherwise resembles.
 */
export const MAX_TRANSACTION_TEMPLATES = 200;

/**
 * A field left blank is a field the template does not have. Storing `""` would
 * make "not saved" and "saved as nothing" the same value in the JSON, and the
 * form applying it could not tell which one the user meant.
 */
const blankToAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

/**
 * What a template remembers. These are the transaction form's own field names
 * rather than the posted draft's, because a template is a starting point for
 * that form and nothing else reads it.
 *
 * Every field is optional, including the type. Only the name identifies a
 * template, and a field it does not carry is one the form leaves as it found
 * it, rather than one it blanks.
 *
 * `externalId` is refused rather than ignored, and is the only one. It is the
 * reference a bank statement row was imported under, so copied into a template
 * it would be copied into every transaction made from it, and the next real
 * import of that row would be swallowed as one already seen. A date and a
 * category name are both stored: each can surprise a person using the template,
 * but each is visible in the form before anything is submitted.
 */
export const transactionTemplateDraftSchema = z
  .object({
    type: blankToAbsent(z.enum(transactionTypes)),
    date: blankToAbsent(isoDateSchema),
    payee: blankToAbsent(oneLine(z.string().trim().max(160))),
    fromAccountId: blankToAbsent(z.string().uuid()),
    toAccountId: blankToAbsent(z.string().uuid()),
    amount: blankToAbsent(positiveDecimalStringSchema),
    destinationAmount: blankToAbsent(positiveDecimalStringSchema),
    categoryId: blankToAbsent(z.string().uuid()),
    categoryName: blankToAbsent(oneLine(z.string().trim().max(120))),
    description: blankToAbsent(freeText(z.string().trim().max(240))),
    notes: blankToAbsent(freeText(z.string().trim().max(4_000))),
  })
  .strict();

export type TransactionTemplateDraft = z.infer<
  typeof transactionTemplateDraftSchema
>;

export const transactionTemplateCreateSchema = z.object({
  name: oneLine(z.string().trim().min(1).max(120)),
  draft: transactionTemplateDraftSchema,
});

export const transactionTemplateUpdateSchema = transactionTemplateCreateSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });

/**
 * Every selected template is named outright, with the version it was read at.
 *
 * The filtered-selection contract the ledger uses exists for rows the browser
 * has never loaded, which `MAX_TRANSACTION_TEMPLATES` makes impossible here:
 * the whole list is already in hand, so it can name every id and every version
 * honestly rather than describing them and asking the server to agree.
 */
export const transactionTemplateBulkSelectionSchema = z
  .object({
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
      .max(MAX_TRANSACTION_TEMPLATES),
  })
  .strict()
  .superRefine((selection, context) => {
    const ids = selection.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Template IDs must be unique",
      });
    }
  });

/**
 * A template field is blank on purpose, so a mass edit needs a third answer
 * beyond set and leave alone: `null` clears the field back to one the person
 * fills in when they use the template. An empty string is refused rather than
 * read as a clear, because blank and absent being different is the whole of
 * what a stored draft records.
 */
export const transactionTemplateBulkPatchSchema = z
  .object({
    type: z.enum(transactionTypes).nullable().optional(),
    date: isoDateSchema.nullable().optional(),
    payee: oneLine(z.string().trim().min(1).max(160)).nullable().optional(),
    fromAccountId: z.string().uuid().nullable().optional(),
    toAccountId: z.string().uuid().nullable().optional(),
    amount: positiveDecimalStringSchema.nullable().optional(),
    destinationAmount: positiveDecimalStringSchema.nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    categoryName: oneLine(z.string().trim().min(1).max(120)).nullable().optional(),
    description: freeText(z.string().trim().min(1).max(240))
      .nullable()
      .optional(),
    notes: freeText(z.string().trim().min(1).max(4_000)).nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Choose at least one field to change",
  });

export const transactionTemplateBulkEditSchema = z
  .object({
    selection: transactionTemplateBulkSelectionSchema,
    patch: transactionTemplateBulkPatchSchema,
    idempotencyKey: idempotencyKeySchema,
    dryRun: z.boolean().default(false),
  })
  .strict();

export const transactionTemplateBulkDeleteSchema = z
  .object({
    selection: transactionTemplateBulkSelectionSchema,
    idempotencyKey: idempotencyKeySchema,
    dryRun: z.boolean().default(false),
  })
  .strict();

export const transactionTemplateBulkResultSchema = z
  .object({
    dryRun: z.boolean(),
    changedCount: z.number().int().nonnegative(),
    items: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type TransactionTemplateBulkPatch = z.infer<
  typeof transactionTemplateBulkPatchSchema
>;
export type TransactionTemplateBulkSelection = z.infer<
  typeof transactionTemplateBulkSelectionSchema
>;
export type TransactionTemplateBulkResult = z.infer<
  typeof transactionTemplateBulkResultSchema
>;

export const accountCreateSchema = z.object({
  name: oneLine(z.string().trim().min(1).max(120)).describe(
    "What you call this account. Unique among your accounts.",
  ),
  type: z.enum(userAccountTypes).describe(
    "What kind of account this is. credit_card, loan, and other_liability are money you owe; the rest are money you hold.",
  ),
  currency: currencyCodeSchema,
  openingDate: isoDateSchema.describe(
    "The day this account's history starts. The opening balance is recorded on this date, and transactions before it are not counted in a balance as of a later day.",
  ),
  openingBalance: decimalStringSchema.describe(
    'What the account held on its opening date, as a signed decimal string. Positive for money you hold. NEGATIVE for money you owe, so a credit card with 500 outstanding opens at "-500". Use "0" to start from nothing.',
  ),
  institution: oneLine(z.string().trim().max(160)).optional().nullable(),
  notes: freeText(z.string().trim().max(2_000)).optional().nullable(),
});

export const accountUpdateSchema = accountCreateSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });

export const categoryCreateSchema = z.object({
  name: oneLine(z.string().trim().min(1).max(120)),
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
export const payeeNameSchema = oneLine(z.string().min(1).max(160)).refine(
  (value) => value.trim().length > 0,
  "Payee is required",
);

export const payeeListQuerySchema = z.object({
  search: oneLine(z.string().trim().max(160)).optional(),
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

export const sortDirections = ["asc", "desc"] as const;
export type SortDirection = (typeof sortDirections)[number];

/** Every column the transaction list puts on screen can order it. */
export const transactionSortFields = [
  "date",
  "payee",
  "account",
  "category",
  "amount",
] as const;
export type TransactionSortField = (typeof transactionSortFields)[number];

/** Same rule for the staged queue. */
export const stageSortFields = [
  "date",
  "payee",
  "account",
  "category",
  "status",
  "amount",
] as const;
export type StageSortField = (typeof stageSortFields)[number];

export const listQuerySchema = dateRangeSchema.extend({
  sort: z.enum(transactionSortFields).default("date"),
  direction: z.enum(sortDirections).default("desc"),
  cursor: z.string().min(1).max(500).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  payee: oneLine(z.string().trim().min(1).max(160)).optional(),
  type: z.enum(transactionTypes).optional(),
  currency: currencyCodeSchema.optional(),
  search: oneLine(z.string().trim().max(200)).optional(),
  includeDeleted: queryBooleanSchema,
});

// Bulk filter selections deliberately omit pagination. They describe the
// complete current view, while explicit selections carry the optimistic
// versions shown to the user on the current page. Leaving `page` in would scope
// a fingerprinted selection to whichever page happened to be open.
// Order is presentation, not scope. Leaving it in would make two requests that
// select the same rows look like different selections to the fingerprint.
export const bulkTransactionFilterSchema = listQuerySchema
  .omit({ cursor: true, page: true, limit: true, sort: true, direction: true })
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

/** Named so an agent can tell the two selection shapes apart without guessing. */
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

/**
 * `currency` and `includeDeleted` are dropped rather than inherited. A draft
 * carries no currency of its own, and a staged row is in the queue or gone
 * rather than deleted, so both would be accepted and then ignored.
 */
export const stageListQuerySchema = listQuerySchema
  .omit({ currency: true, includeDeleted: true })
  .extend({
    sort: z.enum(stageSortFields).default("date"),
    importBatchId: z.string().uuid().optional(),
    validity: z.enum(["valid", "invalid", "duplicate"]).optional(),
  });

/**
 * Changing many staged rows at once, on the same terms as committed ones.
 *
 * The selection is the same shape and carries the same guarantees: a list of
 * ids each with the version it was read at, or "everything matching this view"
 * with a count and a fingerprint of the exact set. What differs is what is being
 * changed. A staged row is a draft rather than an entry in the books, so nothing
 * here moves money; it rewrites the draft and revalidates it, and the queue
 * shows what would happen at commit.
 */
/**
 * Only the fields `stageFilterConditions` actually applies, with the paging and
 * ordering that describe a view rather than scope it taken out.
 *
 * `.strict()` is the load-bearing part: a filter this cannot honour is an error
 * rather than a key quietly dropped, because a selection resolves twice and an
 * ignored filter makes the count and the fingerprint agree about the wrong set.
 */
export const bulkStageFilterSchema = stageListQuerySchema
  .omit({
    cursor: true,
    page: true,
    limit: true,
    sort: true,
    direction: true,
  })
  .strict();

const bulkStageIdSelectionSchema = z
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
        message: "Staged transaction IDs must be unique",
      });
    }
  });

const bulkStageFilterSelectionSchema = z
  .object({
    mode: z.literal("filter"),
    filter: bulkStageFilterSchema,
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
        message: "Excluded staged transaction IDs must be unique",
      });
    }
  });

export const bulkStageSelectionSchema = z.discriminatedUnion("mode", [
  bulkStageIdSelectionSchema,
  bulkStageFilterSelectionSchema,
]);

export const bulkStageFilterSelectionRequestSchema = z
  .object({
    filter: bulkStageFilterSchema,
    excludedIds: z.array(z.string().uuid()).max(MAX_BULK_SELECTION_ENTRIES).default([]),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.excludedIds).size !== selection.excludedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["excludedIds"],
        message: "Excluded staged transaction IDs must be unique",
      });
    }
  });

export const bulkStageSelectionSnapshotSchema = z
  .object({
    count: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    invalidCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative(),
    transferCount: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `null` clears a field; leaving one out leaves it alone. Account and type are
 * refused for a transfer, which has two sides and no single account to move,
 * exactly as they are on committed rows.
 */
export const bulkStagePatchSchema = z
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

export const bulkStageEditSchema = z
  .object({
    selection: bulkStageSelectionSchema,
    patch: bulkStagePatchSchema,
    idempotencyKey: idempotencyKeySchema,
    dryRun: z.boolean().default(false),
  })
  .strict();

export const bulkStageEditItemSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    issueCount: z.number().int().nonnegative(),
    possiblyDuplicate: z.boolean(),
  })
  .strict();

export const bulkStageEditResultSchema = z
  .object({
    dryRun: z.boolean(),
    updatedCount: z.number().int().nonnegative(),
    // What the queue will look like afterwards, which is the thing somebody is
    // usually editing in bulk to change.
    validCount: z.number().int().nonnegative(),
    invalidCount: z.number().int().nonnegative(),
    items: z.array(bulkStageEditItemSchema),
  })
  .strict();

export type BulkStagePatch = z.infer<typeof bulkStagePatchSchema>;
export type BulkStageEditResult = z.infer<typeof bulkStageEditResultSchema>;

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "DUPLICATE"
  | "CONFLICT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

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
