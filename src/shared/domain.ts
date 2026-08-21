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

/**
 * The order account types are shown in, which is not the order the enum
 * declares them. The enum is stored in the database and cannot be reordered;
 * this is how a person reads down their accounts: what they hold, then what
 * they owe, then what is invested, then the catch-alls.
 */
export const accountTypeOrder: readonly UserAccountType[] = [
  "cash",
  "checking",
  "savings",
  "credit_card",
  "loan",
  "investment",
  "crypto_wallet",
  "other_asset",
  "other_liability",
];

/**
 * Accounts under a heading each, in `accountTypeOrder`, with empty headings
 * left out.
 *
 * The type is read as a plain string because the dashboard summary sends it as
 * one. A type this does not recognise is grouped under itself and sorted to the
 * end rather than dropped, so a new type shows up unstyled instead of
 * disappearing from the page.
 */
export function groupAccountsByType<T extends { type: string }>(
  accounts: readonly T[],
): { type: string; label: string; accounts: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const account of accounts) {
    const group = groups.get(account.type);
    if (group) group.push(account);
    else groups.set(account.type, [account]);
  }
  const rank = (type: string) => {
    const index = accountTypeOrder.indexOf(type as UserAccountType);
    return index === -1 ? accountTypeOrder.length : index;
  };
  return [...groups.entries()]
    .sort(
      ([left], [right]) => rank(left) - rank(right) || left.localeCompare(right),
    )
    .map(([type, items]) => ({
      type,
      label: accountTypeLabels[type as UserAccountType] ?? type,
      accounts: items,
    }));
}

export const liabilityAccountTypes = new Set<UserAccountType>([
  "credit_card",
  "loan",
  "other_liability",
]);

export const categoryKinds = ["income", "expense", "both"] as const;
export type CategoryKind = (typeof categoryKinds)[number];

export const transactionTypes = ["deposit", "withdrawal", "transfer"] as const;
export type TransactionType = (typeof transactionTypes)[number];

/**
 * Who did it. A scheduler write is not a person at a screen, and saying it was
 * would be a false statement in an audit trail.
 */
export const actorSources = ["web", "mcp", "schedule"] as const;
export type ActorSource = (typeof actorSources)[number];

export const isoDateSchema = z
  .string()
  // Year 0000 round-trips through JavaScript's Date and is out of range for
  // PostgreSQL, so the check below passes it and the cast at the far end fails,
  // which the caller sees as an unexplained 500 for a four-digit typo.
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
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

/**
 * The most category legs one entry may be split into. A split is the whole of
 * the counter-account side of the entry rewritten as several postings, so the
 * cost of a large one is paid on every read of that entry, not just on the
 * write. Fifty is far past a receipt anybody itemises by hand and still small
 * enough that a hydrated page of them is a page.
 */
export const MAX_TRANSACTION_LEGS = 50;

/**
 * One category's share of a split entry.
 *
 * The list a request carries is the list the entry should end with, so identity
 * matters: a leg sent **without** an `id` is a new one, a leg sent **with** one
 * is that leg changed, and a leg **left out** is removed. Matching legs by
 * position or by value instead would make an edit that reorders two rows look
 * like an edit that rewrote both, which is the silent destruction Firefly III's
 * API documentation warns about.
 *
 * `amount` is unsigned. Direction belongs to the entry — every leg of a
 * withdrawal is money out — so a signed leg could only ever contradict it.
 */
const transactionLegSchema = z
  .object({
    id: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional().nullable(),
    categoryName: oneLine(z.string().trim().min(1).max(120))
      .optional()
      .nullable()
      .describe(
        'A category by name rather than by id for this leg, matched and created on the same terms as the entry-level categoryName. Ignored when this leg\'s categoryId is set, for example "Groceries".',
      ),
    amount: positiveDecimalStringSchema,
    note: freeText(z.string().trim().max(240)).optional().nullable(),
  })
  .strict();

type TransactionLegInput = z.infer<typeof transactionLegSchema>;

const legsField = z
  .array(transactionLegSchema)
  .min(2, "A split needs at least two legs")
  .max(MAX_TRANSACTION_LEGS)
  .optional()
  .describe(
    "Splits this entry across several categories. Each leg carries its own amount, and the legs must add up to the entry's amount. Omit it, or send a single categoryId, for an entry that belongs to one category.",
  );

/**
 * Legs and a single category are two ways of saying the same thing, so a
 * request carrying both is refused rather than merged: guessing which one the
 * caller meant would file money under a category they did not choose. Clearing
 * the single category alongside legs is not a conflict, because `null` says
 * what the legs already say.
 *
 * A transfer is refused a split outright. Both of its sides name an account, so
 * there is no counter-account side left over for categories to partition.
 *
 * Shared with templates, whose legs are a different shape, so this reads only
 * the fields both have.
 */
function checkLegs(
  draft: {
    type?: string;
    legs?: readonly unknown[];
    categoryId?: string | null;
    categoryName?: string | null;
  },
  context: z.RefinementCtx,
) {
  if (draft.legs === undefined) return;
  if (draft.type === "transfer") {
    context.addIssue({
      code: "custom",
      path: ["legs"],
      message: "A transfer cannot be split by category",
    });
    return;
  }
  for (const field of ["categoryId", "categoryName"] as const) {
    if (draft[field] === undefined || draft[field] === null) continue;
    context.addIssue({
      code: "custom",
      path: [field],
      message: "Send either a category or legs, not both",
    });
  }
}

/**
 * Naming one existing leg twice is refused for the same reason the identity
 * rule exists at all: the two entries disagree about what that leg should
 * become, and either answer silently discards the other. Templates are exempt
 * because their legs have no ids to collide.
 */
function checkTransactionLegs(
  draft: {
    type: string;
    legs?: TransactionLegInput[];
    categoryId?: string | null;
    categoryName?: string | null;
  },
  context: z.RefinementCtx,
) {
  checkLegs(draft, context);
  const named = draft.legs?.map((leg) => leg.id).filter((id) => id !== undefined);
  if (named && new Set(named).size !== named.length) {
    context.addIssue({
      code: "custom",
      path: ["legs"],
      message: "Leg IDs must be unique",
    });
  }
}

/**
 * What a transaction says about itself apart from when it happened and where it
 * came from. Split out so a recurrence can hold the same shape without a date,
 * which its occurrence supplies, and without the provenance fields it refuses.
 */
const transactionShapeCommon = {
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
  legs: legsField,
  notes: freeText(z.string().trim().max(4_000)).optional().nullable(),
};

const transactionCommon = {
  date: isoDateSchema,
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
  ...transactionShapeCommon,
};

const depositDraftSchema = z
  .object({
    type: z.literal("deposit"),
    ...transactionCommon,
    toAccountId: z.string().uuid(),
    amount: positiveDecimalStringSchema,
  })
  .superRefine(checkTransactionLegs);

const withdrawalDraftSchema = z
  .object({
    type: z.literal("withdrawal"),
    ...transactionCommon,
    fromAccountId: z.string().uuid(),
    amount: positiveDecimalStringSchema,
  })
  .superRefine(checkTransactionLegs);

const transferDraftSchema = z
  .object({
    type: z.literal("transfer"),
    ...transactionCommon,
    fromAccountId: z.string().uuid(),
    toAccountId: z.string().uuid(),
    sourceAmount: positiveDecimalStringSchema,
    destinationAmount: positiveDecimalStringSchema.optional(),
  })
  .superRefine(checkTransactionLegs);

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
    legs: z.unknown().optional(),
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
 * The same rule for a list. `blankToAbsent` only recognises a blank string, so
 * an empty `legs` array would survive into storage as a template that says "I
 * was saved with no legs" rather than one that never mentioned legs at all.
 */
const emptyListToAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (Array.isArray(value) && value.length === 0 ? undefined : value),
    schema.optional(),
  );

/**
 * A leg of a template's split. Amounts are optional here and everything else
 * follows the rest of the template: a field the template does not carry is one
 * the form leaves as it found it.
 *
 * The amounts are decimal strings, never shares of the total. A template's own
 * amount is already optional, so proportions would be a second way of writing
 * money that only one of the two forms could ever resolve.
 *
 * Legs carry no id, because nothing resyncs a template: the stored list is the
 * whole of what it remembers, and the order is the order it was typed in.
 */
const transactionTemplateLegSchema = z
  .object({
    categoryId: blankToAbsent(z.string().uuid()),
    categoryName: blankToAbsent(oneLine(z.string().trim().max(120))),
    amount: blankToAbsent(positiveDecimalStringSchema),
    note: blankToAbsent(freeText(z.string().trim().max(240))),
  })
  .strict();

const templateLegsField = z
  .array(transactionTemplateLegSchema)
  .min(2, "A split needs at least two legs")
  .max(MAX_TRANSACTION_LEGS);

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
    legs: emptyListToAbsent(templateLegsField),
    description: blankToAbsent(freeText(z.string().trim().max(240))),
    notes: blankToAbsent(freeText(z.string().trim().max(4_000))),
  })
  .strict()
  .superRefine(checkLegs);

export type TransactionTemplateDraft = z.infer<
  typeof transactionTemplateDraftSchema
>;

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
    // Legs move as a whole list or not at all. "Add a leg to thirty templates"
    // has no meaning when each of the thirty splits a different total.
    legs: templateLegsField.nullable().optional(),
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

/**
 * How far apart two dates can be and still describe the same money moving.
 *
 * A statement row and the same purchase entered by hand rarely land on one day:
 * the bank posts when it settles. Three days either side covers that without
 * making a weekly shop of the same amount look like a repeat of last week's.
 */
export const LIKELY_DUPLICATE_DAYS = 3;

export const reportNames = [
  "net-worth",
  "income-expense",
  "categories",
  "cash-flow",
  "balance-sheet",
  "trial-balance",
] as const;
export type ReportName = (typeof reportNames)[number];

export const reportBuckets = [
  "none",
  "week",
  "month",
  "quarter",
  "year",
] as const;
export type ReportBucket = (typeof reportBuckets)[number];

/** How a report treats time: a period's own movement, or the balance it ends on. */
export const reportAccumulations = ["change", "historical"] as const;
export type ReportAccumulation = (typeof reportAccumulations)[number];

/**
 * Which accounts hold money that can be spent without selling something first.
 * Cash flow is the only report that needs the distinction, and it takes it from
 * the type the person already chose rather than from a second thing to declare.
 */
export const cashAccountTypes = ["checking", "savings", "cash"] as const;


/**
 * A ledger with a long history asked for weekly buckets is a request for
 * thousands of columns nobody can read and a response nobody wants to hold in
 * memory. Refused with the coarser bucket named, rather than served slowly.
 */
export const MAX_REPORT_BUCKETS = 600;

/**
 * The most postings one register will list. Refused rather than truncated: a
 * register is read to find the row a balance went wrong on, and one cut short
 * would close on a balance its own last row does not reach.
 */
export const MAX_REGISTER_ENTRIES = 10_000;

export const reportNameSchema = z
  .enum(reportNames)
  .describe("Which report to run.");

export const reportQuerySchema = dateRangeSchema.extend({
  report: reportNameSchema,
  bucket: z.enum(reportBuckets).optional(),
});

const queryBooleanSchema = z
  .union([
    z.boolean(),
    z.literal("true").transform(() => true),
    z.literal("false").transform(() => false),
  ])
  .default(false);

export const sortDirections = ["asc", "desc"] as const;
export type SortDirection = (typeof sortDirections)[number];

/** Every column the transaction list puts on screen can order it. */
const transactionSortFields = [
  "date",
  "payee",
  "account",
  "category",
  "amount",
] as const;
export type TransactionSortField = (typeof transactionSortFields)[number];

/** Same rule for the staged queue. */
const stageSortFields = [
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
const bulkTransactionFilterSchema = listQuerySchema
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
    expectedCount: z.number().int().nonnegative().max(MAX_BULK_SELECTION_ENTRIES),
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
    splitCount: z.number().int().nonnegative(),
    currencies: z.array(currencyCodeSchema),
  })
  .strict();

const bulkTransactionPatchSchema = z
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

const bulkTransactionEditItemSchema = z
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
    // Defaulted because this result is replayed out of an idempotency
    // record, and one written before splits existed carries no count. A
    // retry spanning the upgrade has to return the original answer, which
    // is the whole point of the key.
    splitCount: z.number().int().nonnegative().default(0),
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
    recurrenceId: z.string().uuid().optional(),
    validity: z.enum(["valid", "invalid", "duplicate"]).optional(),
  });

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
    expectedCount: z.number().int().nonnegative().max(MAX_BULK_SELECTION_ENTRIES),
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
    splitCount: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `null` clears a field; leaving one out leaves it alone. Account and type are
 * refused for a transfer, which has two sides and no single account to move,
 * exactly as they are on committed rows.
 */
const bulkStagePatchSchema = z
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
export const bulkStageEditSchema = z
  .object({
    selection: bulkStageSelectionSchema,
    patch: bulkStagePatchSchema,
    idempotencyKey: idempotencyKeySchema,
    dryRun: z.boolean().default(false),
  })
  .strict();

const bulkStageEditItemSchema = z
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
  | "REAUTHENTICATION_REQUIRED"
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

export const recurrenceFrequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequencyName = (typeof recurrenceFrequencies)[number];
export const recurrenceMonthPolicies = ["last_day", "skip"] as const;
export const recurrenceWeekendPolicies = [
  "allow",
  "skip",
  "previous_business_day",
  "next_business_day",
] as const;
/**
 * Which relative days of the month a schedule may name. -1 is the last one, and
 * there is deliberately no fifth: a month has four of some weekdays and five of
 * others, so an ordinal of 5 would silently mean different things in different
 * months. Anybody who wants the fifth means the last.
 *
 * The position schema below and the picker in the browser both derive from
 * this, so the list exists once rather than in three places that can drift.
 */
export const recurrenceOrdinals = [1, 2, 3, 4, -1] as const;
export type RecurrenceOrdinal = (typeof recurrenceOrdinals)[number];

/**
 * The most recurrences one person may keep. Unlike a template, each of these is
 * a standing instruction: one anchored years ago proposes rows every tick until
 * it catches up, so an uncapped list is a queue-flooding amplifier reachable by
 * anything holding ledger:write.
 */
export const MAX_RECURRENCES = 200;
export const MAX_RECURRENCE_INTERVAL = 366;

/**
 * One category's share of a recurring split. Unlike a template's leg the amount
 * is required: legs are how the total is divided, and a division with a part
 * missing is not something a person can complete from the queue.
 */
const recurrenceLegSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    categoryName: oneLine(z.string().trim().min(1).max(120)).optional(),
    amount: positiveDecimalStringSchema,
    note: freeText(z.string().trim().max(240)).optional(),
  })
  .strict();

function checkRecurrenceShape(
  shape: {
    type?: string;
    legs?: readonly unknown[];
    amount?: string;
    categoryId?: string | null;
    categoryName?: string | null;
  },
  context: z.RefinementCtx,
) {
  checkLegs(shape, context);
  if (!shape.legs?.length) return;
  if (shape.amount === undefined) {
    context.addIssue({
      code: "custom",
      path: ["amount"],
      message: "A split recurrence needs an amount for its legs to divide",
    });
    return;
  }
  // Checked here and not left to the ledger, because a recurrence is replayed.
  // A template's legs may be blank and a transaction's split is refused once,
  // at the point somebody is looking; a recurrence whose legs do not add up
  // proposes a row nobody can commit on every occurrence it ever reaches, and
  // the only symptom is a queue that fills with rows carrying the same
  // complaint.
  const legs = shape.legs as readonly { amount?: string }[];
  const amounts = legs.map((leg) => leg.amount);
  if (amounts.every((amount): amount is string => typeof amount === "string")) {
    if (!sumsExactly(amounts, shape.amount)) {
      context.addIssue({
        code: "custom",
        path: ["legs"],
        message:
          "A split's legs must add up to the recurrence's amount. Every occurrence it proposes carries the same division, so one that does not balance can never be committed.",
      });
    }
  }
}

/**
 * Whether the parts add up to the whole, exactly.
 *
 * Compared as integers scaled to the longest fraction, because binary floating
 * point cannot hold these values and a split a hundredth of a penny out is
 * still one that will not commit. The schema bounds every value to a leading
 * integer part and at most 18 decimal places, so there is always something to
 * the left of the point and BigInt cannot overflow.
 */
function sumsExactly(parts: readonly string[], whole: string) {
  const places = (value: string) => {
    const point = value.indexOf(".");
    return point < 0 ? 0 : value.length - point - 1;
  };
  const scale = Math.max(places(whole), ...parts.map(places));
  const asInteger = (value: string) => {
    const [integer = "0", fraction = ""] = value.split(".");
    return BigInt(integer + fraction.padEnd(scale, "0"));
  };
  return (
    parts.reduce((total, part) => total + asInteger(part), 0n) === asInteger(whole)
  );
}

const recurrenceShapeFields = {
  ...transactionShapeCommon,
  legs: z
    .array(recurrenceLegSchema)
    .min(2, "A split needs at least two legs")
    .max(MAX_TRANSACTION_LEGS)
    .optional(),
};

/**
 * What a recurrence remembers about the transaction it proposes.
 *
 * The amount is optional because the electricity bill recurs and its amount does
 * not. A proposal missing one lands in the queue flagged, which is the point:
 * somebody types the number and commits it.
 *
 * There is no date, because the occurrence supplies it. `externalId` is refused
 * rather than ignored, for the reason a template refuses it: copied onto every
 * proposal, the next real import of that bank row would be swallowed as one
 * already seen.
 */
export const recurrenceShapeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("deposit"),
      ...recurrenceShapeFields,
      toAccountId: z.string().uuid(),
      amount: positiveDecimalStringSchema.optional(),
    })
    .strict()
    .superRefine(checkRecurrenceShape),
  z
    .object({
      type: z.literal("withdrawal"),
      ...recurrenceShapeFields,
      fromAccountId: z.string().uuid(),
      amount: positiveDecimalStringSchema.optional(),
    })
    .strict()
    .superRefine(checkRecurrenceShape),
  z
    .object({
      type: z.literal("transfer"),
      ...recurrenceShapeFields,
      fromAccountId: z.string().uuid(),
      toAccountId: z.string().uuid(),
      amount: positiveDecimalStringSchema.optional(),
      destinationAmount: positiveDecimalStringSchema.optional(),
    })
    .strict()
    .superRefine(checkRecurrenceShape),
]);

export type RecurrenceShape = z.infer<typeof recurrenceShapeSchema>;

const recurrenceAnchorDateSchema = isoDateSchema.refine(
  (value) => value >= "1900-01-01" && value <= "2999-12-31",
  "Anchor the schedule to a date between 1900 and 2999",
);

/** "The second Tuesday", "the last Friday". */
const recurrencePositionSchema = z
  .object({
    ordinal: z.literal(recurrenceOrdinals),
    weekday: z.number().int().min(0).max(6),
  })
  .strict()
  .describe(
    "A relative day of the month, such as the second Tuesday or the last Friday. Ordinal -1 is the last one; weekday 0 is Sunday. Monthly and yearly only.",
  );

function checkSchedule(
  schedule: {
    frequency: string;
    interval: number;
    weekendPolicy: string;
    position?: unknown;
  },
  context: z.RefinementCtx,
) {
  // Two nominal occurrences collide when a policy can move them onto one date,
  // and the moves are up to two days: Saturday goes forward two to Monday and
  // Sunday back two to Friday. So a daily schedule of interval one OR two
  // collides, and nothing else does; an exhaustive sweep of every frequency,
  // interval and anchor weekday finds collisions in exactly those two. The
  // queue refuses to commit a selection holding rows that alike, so either
  // makes a queue nobody can clear in one go.
  const movesToABusinessDay =
    schedule.weekendPolicy === "previous_business_day" ||
    schedule.weekendPolicy === "next_business_day";
  if (schedule.frequency === "daily" && schedule.interval <= 2 && movesToABusinessDay) {
    context.addIssue({
      code: "custom",
      path: ["weekendPolicy"],
      message:
        "A daily schedule of one or two days moved onto a business day puts two occurrences on the same date, and the review queue refuses to commit rows that alike. Use allow or skip, or make the interval three days or more.",
    });
  }
  // A weekly rule's relative day is already the weekday of its anchor, and a
  // daily one has no month to count within.
  if (
    schedule.position &&
    (schedule.frequency === "daily" || schedule.frequency === "weekly")
  ) {
    context.addIssue({
      code: "custom",
      path: ["position"],
      message:
        schedule.frequency === "weekly"
          ? "A weekly schedule already repeats on the weekday of its anchor date, so it needs no relative day"
          : "A daily schedule has no month to count a relative day within",
    });
  }
}

export const recurrenceScheduleSchema = z
  .object({
    frequency: z.enum(recurrenceFrequencies),
    interval: z.number().int().min(1).max(MAX_RECURRENCE_INTERVAL).default(1),
    anchorDate: recurrenceAnchorDateSchema,
    monthPolicy: z.enum(recurrenceMonthPolicies).default("last_day"),
    weekendPolicy: z.enum(recurrenceWeekendPolicies).default("allow"),
    position: recurrencePositionSchema.nullable().optional(),
  })
  .strict()
  .superRefine(checkSchedule);

export type RecurrenceSchedule = z.infer<typeof recurrenceScheduleSchema>;

/**
 * The stored schedule needs every field, but a caller changing only the
 * frequency must not have to send the policies back or risk overwriting them
 * with a default. What is left out keeps whatever is stored, and the merged
 * result goes back through the full schema, so every refusal still applies.
 */
export const recurrenceSchedulePatchSchema = z
  .object({
    frequency: z.enum(recurrenceFrequencies).optional(),
    interval: z.number().int().min(1).max(MAX_RECURRENCE_INTERVAL).optional(),
    anchorDate: recurrenceAnchorDateSchema.optional(),
    monthPolicy: z.enum(recurrenceMonthPolicies).optional(),
    weekendPolicy: z.enum(recurrenceWeekendPolicies).optional(),
    position: recurrencePositionSchema.nullable().optional(),
  })
  .strict();

/**
 * A time of day, as the person's own clock reads it.
 *
 * `HH:MM` and nothing finer. A reminder is a thing somebody reads when they next
 * look at their mail, so seconds would be a precision the delivery cannot keep
 * and the scheduler's tick interval would make a lie of.
 */
export const clockTimeSchema = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Use a time of day as HH:MM, from 00:00 to 23:59")
  .describe(
    'A time of day in the person\'s own timezone, as "HH:MM" on a 24-hour clock, for example "08:30".',
  );

/**
 * When to remind somebody to make a transaction from a template.
 *
 * The schedule is a recurrence's, with a time added, and with one thing a
 * recurrence has no need for: `frequency` may be null, which is a single
 * reminder on the anchor date rather than a repeating one. A template is a thing
 * somebody fills in by hand, and half the reason to be reminded of one is a
 * payment that happens once.
 *
 * The fields a one-off cannot use are refused rather than ignored, the same way
 * a position on a daily schedule is: silently dropping an interval somebody
 * typed is how a reminder ends up arriving on a day nobody chose.
 */
export const templateNotificationSchema = z
  .object({
    frequency: z.enum(recurrenceFrequencies).nullable().default(null),
    interval: z.number().int().min(1).max(MAX_RECURRENCE_INTERVAL).optional(),
    anchorDate: recurrenceAnchorDateSchema,
    monthPolicy: z.enum(recurrenceMonthPolicies).optional(),
    weekendPolicy: z.enum(recurrenceWeekendPolicies).optional(),
    position: recurrencePositionSchema.nullable().optional(),
    time: clockTimeSchema,
    /**
     * The three fields a read reports and a write cannot set, accepted and then
     * ignored so a reminder can be sent back the way it came.
     *
     * `.strict()` below refuses anything else, which is what catches a typo. But
     * it also refused a caller its own output: an agent reads a template, changes
     * the time, and sends the object back — the only way it can, having no form
     * to fill in — and was told `repeats` was an unrecognised key. `repeats` is
     * `frequency !== null` restated, and the two dates are watermarks the
     * scheduler owns, so there is nothing here worth refusing.
     */
    repeats: z.boolean().optional(),
    lastNotifiedDate: z.string().nullable().optional(),
    nextNotificationDate: z.string().nullable().optional(),
  })
  .strict()
  .describe(
    'An emailed reminder to make this transaction, or null for none. `frequency` null is a single reminder on `anchorDate`; a frequency repeats it on the same schedules a recurrence offers. `time` is "HH:MM" on this person\'s own clock. A reminder that happens once refuses `interval`, both policies and `position` rather than ignoring them. On an update, leaving this out keeps whatever is stored and null removes it; a value replaces the whole rule. Needs a deployment with SMTP configured, which `whoami` reports.',
  )
  .superRefine((notification, context) => {
    if (notification.frequency === null) {
      for (const field of ["interval", "monthPolicy", "weekendPolicy", "position"] as const) {
        if (notification[field] !== undefined && notification[field] !== null) {
          context.addIssue({
            code: "custom",
            path: [field],
            message:
              "A reminder that happens once needs only its date and time. Choose a frequency to repeat it.",
          });
        }
      }
      return;
    }
    checkSchedule(
      {
        frequency: notification.frequency,
        interval: notification.interval ?? 1,
        weekendPolicy: notification.weekendPolicy ?? "allow",
        position: notification.position,
      },
      context,
    );
  });

export type TemplateNotification = z.infer<typeof templateNotificationSchema>;

export const transactionTemplateCreateSchema = z.object({
  name: oneLine(z.string().trim().min(1).max(120)),
  draft: transactionTemplateDraftSchema,
  /** A reminder to make this one. Null, or left out, is no reminder. */
  notification: templateNotificationSchema.nullable().optional(),
});

/**
 * `notification` left out keeps whatever is stored and null removes it, which is
 * why it cannot be made optional by `.partial()` alone: an update that says
 * nothing about the reminder must not be read as asking to delete it.
 */
export const transactionTemplateUpdateSchema = transactionTemplateCreateSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive() });

/**
 * Whether to send an email when the scheduler proposes from this recurrence.
 *
 * Not part of the schedule: the schedule decides when a row is proposed, and
 * this decides whether anybody hears about it. Folded in, changing the notice
 * would look like changing the dates.
 */
const recurrenceNotifySchema = z
  .boolean()
  .describe(
    "Email when this recurrence proposes a row into the review queue. The mail names what was proposed and links to the queue; it never commits anything. Needs a deployment with SMTP configured.",
  );

export const recurrenceCreateSchema = z
  .object({
    name: oneLine(z.string().trim().min(1).max(120)),
    shape: recurrenceShapeSchema,
    schedule: recurrenceScheduleSchema,
    notifyOnCreate: recurrenceNotifySchema.default(false),
  })
  .strict();

export const recurrenceUpdateSchema = z
  .object({
    name: oneLine(z.string().trim().min(1).max(120)).optional(),
    shape: recurrenceShapeSchema.optional(),
    schedule: recurrenceSchedulePatchSchema.optional(),
    notifyOnCreate: recurrenceNotifySchema.optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
