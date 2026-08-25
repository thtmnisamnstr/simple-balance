import { z } from "zod";
import {
  accountTypes,
  actorSources,
  budgetPeriodUnits,
  transactionTemplateBulkResultSchema,
  transactionTemplateDraftSchema,
  bulkStageEditResultSchema,
  bulkStageSelectionSnapshotSchema,
  bulkTransactionEditResultSchema,
  bulkTransactionSelectionSnapshotSchema,
  categoryKinds,
  isoDateSchema,
  recurrenceFrequencies,
  recurrenceMonthPolicies,
  recurrenceWeekendPolicies,
  transactionTypes,
} from "../shared/domain.js";

const uuidSchema = z.string().uuid();

/**
 * The output side's primitives, each carrying what it is.
 *
 * These used to be bare `z.string()`, so an agent reading `list_accounts`
 * learned that `balance` is "a string" — true, useless, and the single largest
 * gap on the output side, because one undescribed primitive is repeated across
 * more than a thousand output properties. The input side already published
 * described schemas for the same values; describing them here makes the two
 * halves of the surface say the same thing about the same value.
 *
 * The shape stays `z.string()` rather than borrowing the input side's regex:
 * an output schema is a promise about what this server sends, and a pattern
 * there would make a client refuse a reply it should accept if the pattern and
 * the formatter ever drifted.
 */
const decimalSchema = z
  .string()
  .describe(
    "An exact decimal string, never a JSON number. Compare and total these with decimal arithmetic; parsing one into a float loses money at the eighteenth place.",
  );
const nullableStringSchema = z.string().nullable();
const timestampSchema = z
  .string()
  .describe("An RFC 3339 instant in UTC, for example 2026-03-04T09:15:00.000Z.");

const toolErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export function mcpOutputSchema<T extends z.ZodType>(successSchema: T) {
  return z.object({
    result: z.union([successSchema, toolErrorSchema]),
  });
}

const versionedEntitySchema = {
  id: uuidSchema,
  userId: z.string(),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

const balancePresentationSchema = z.object({
  label: z.string(),
  amount: decimalSchema,
});

export const accountResultSchema = z
  .object({
    ...versionedEntitySchema,
    name: z.string(),
    type: z.enum(accountTypes),
    currency: z.string(),
    institution: nullableStringSchema,
    notes: nullableStringSchema,
    openingDate: z.string(),
    openingBalance: decimalSchema,
    archivedAt: timestampSchema.nullable(),
    balance: decimalSchema,
    balancePresentation: balancePresentationSchema,
  })
  .passthrough();

export const accountBalancesResultSchema = z.object({
  accountId: uuidSchema,
  currency: z.string(),
  range: z.object({
    start: nullableStringSchema,
    end: nullableStringSchema,
    today: z.string(),
  }),
  beginning: z.object({
    balance: decimalSchema,
    balancePresentation: balancePresentationSchema,
  }),
  ending: z.object({
    balance: decimalSchema,
    balancePresentation: balancePresentationSchema,
  }),
  current: z.object({
    balance: decimalSchema,
    balancePresentation: balancePresentationSchema,
  }),
  future: z.object({
    balance: decimalSchema,
    balancePresentation: balancePresentationSchema,
  }),
});

export const categoryResultSchema = z
  .object({
    ...versionedEntitySchema,
    name: z.string(),
    kind: z.enum(categoryKinds),
    archivedAt: timestampSchema.nullable(),
  })
  .passthrough();

/**
 * Declared separately rather than by widening `categoryResultSchema`, which is
 * also what a merge result and a duplicate group report. Those come from
 * sources that carry no counts, and a schema promising fields they do not have
 * is worse than no promise at all.
 */
export const categorySummaryResultSchema = z
  .object({
    ...versionedEntitySchema,
    name: z.string(),
    kind: z.enum(categoryKinds),
    archivedAt: timestampSchema.nullable(),
    transactionCount: z.number().int().nonnegative(),
    stagedTransactionCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  })
  .passthrough();

const accountReferenceSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    currency: z.string(),
  })
  .passthrough();

const categoryReferenceSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    kind: z.string(),
  })
  .passthrough();

export const transactionResultSchema = z
  .object({
    ...versionedEntitySchema,
    type: z.enum(transactionTypes),
    date: z.string(),
    payee: z.string(),
    description: nullableStringSchema,
    categoryId: uuidSchema.nullable(),
    templateId: uuidSchema.nullable().optional(),
    notes: nullableStringSchema,
    externalId: nullableStringSchema,
    sourceAccountId: uuidSchema.nullable(),
    destinationAccountId: uuidSchema.nullable(),
    sourceAmount: decimalSchema.nullable(),
    destinationAmount: decimalSchema.nullable(),
    sourceCurrency: nullableStringSchema,
    destinationCurrency: nullableStringSchema,
    effectiveRate: decimalSchema.nullable(),
    deletedAt: timestampSchema.nullable(),
    sourceAccount: accountReferenceSchema.nullable(),
    destinationAccount: accountReferenceSchema.nullable(),
    category: categoryReferenceSchema.nullable(),
    legCount: z.number().int().nonnegative().optional(),
    // Empty for an entry filed under one category, which is most of them. Each
    // leg carries the id an edit has to send back to keep meaning that leg.
    legs: z.array(
      z.object({
        id: uuidSchema,
        categoryId: uuidSchema.nullable(),
        category: categoryReferenceSchema.nullable(),
        amount: decimalSchema,
        note: nullableStringSchema,
      }),
    ),
  })
  .passthrough();

export const bulkTransactionSelectionSnapshotResultSchema = bulkTransactionSelectionSnapshotSchema;

export const bulkTransactionEditMcpResultSchema = bulkTransactionEditResultSchema;

const validationIssueSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export const stagedTransactionResultSchema = z
  .object({
    ...versionedEntitySchema,
    status: z.enum(["staged", "committed", "deleted"]),
    draft: z.unknown(),
    rawData: z.unknown().nullable(),
    validationIssues: z.array(validationIssueSchema),
    duplicateOfId: uuidSchema.nullable(),
    // Nullable because null means "not worked out", not "no": only the list
    // query compares a row against the rest of the queue, so every other tool
    // returns null here. Declaring it as a plain boolean would make those
    // results fail this schema and be dropped without a word.
    repeatsStagedRow: z.boolean().nullable(),
    likelyDuplicateOfId: uuidSchema.nullable(),
    importBatchId: uuidSchema.nullable(),
    // Where a proposed row came from, and which instance of the schedule it is.
    // Declared rather than left to passthrough, because a caller reading the
    // schema to find out what a staged row carries would otherwise never learn
    // these exist. occurrenceDate is the schedule's own date, which never
    // moves; the draft's date is that occurrence as the policies leave it.
    recurrenceId: uuidSchema.nullable(),
    occurrenceDate: isoDateSchema.nullable(),
    committedTransactionId: uuidSchema.nullable(),
    deletedAt: timestampSchema.nullable(),
  })
  .passthrough();

/**
 * One side of a duplicate review. `kind` says which of the two objects is
 * filled, rather than the two being a union: the output wrapper spends both
 * members of its `anyOf` on success and error, so a union here would publish a
 * third and the tool would be refused.
 */
const duplicateReviewSideSchema = z.object({
  kind: z.enum(["staged", "committed"]),
  staged: stagedTransactionResultSchema.nullable(),
  committed: transactionResultSchema.nullable(),
});

export const stagedDuplicateReviewResultSchema = z.object({
  first: duplicateReviewSideSchema,
  second: duplicateReviewSideSchema.nullable(),
});

export function pageResultSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: nullableStringSchema.describe(
      "Send this as `cursor` to get the next page. Null means there is no next page under this ordering — either because this is the last one, or because the ordering cannot be resumed at all. `cursorAvailable` tells you which.",
    ),
    cursorAvailable: z
      .boolean()
      .describe(
        "Whether this ordering can be resumed with a cursor. False means page through by number instead: some orderings have no keyset to resume from, and under those `nextCursor` is always null even when more rows exist.",
      ),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    totalCount: z.number().int().min(0),
    totalPages: z.number().int().min(1),
  });
}

/**
 * A list that only walks forward. The audit log has no total and no page
 * numbers, so describing it with the numbered shape would promise fields it
 * never sends and fail validation on every call.
 */
export function cursorPageResultSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: nullableStringSchema,
  });
}

export const duplicateCategoriesResultSchema = z.array(
  z.object({
    normalizedName: z.string(),
    count: z.number().int().min(2),
    categories: z.array(categoryResultSchema),
  }),
);

export const payeeResultSchema = z.object({
  name: z.string(),
  normalizedName: z.string(),
  transactionCount: z.number().int().nonnegative(),
  stagedTransactionCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});

export const duplicatePayeesResultSchema = z.array(
  z.object({
    normalizedName: z.string(),
    count: z.number().int().min(2),
    payees: z.array(payeeResultSchema),
  }),
);

export const summaryResultSchema = z.object({
  range: z.object({
    start: nullableStringSchema,
    end: nullableStringSchema,
  }),
  asOf: z.string(),
  includesArchived: z.boolean(),
  currencies: z.array(
    z.object({
      currency: z.string(),
      balance: decimalSchema,
      deposits: decimalSchema,
      withdrawals: decimalSchema,
      netCashFlow: decimalSchema,
      accounts: z.array(
        z.object({
          id: uuidSchema,
          name: z.string(),
          type: z.string(),
          balance: decimalSchema,
          archivedAt: nullableStringSchema,
        }),
      ),
      spendingByCategory: z.array(
        z.object({
          categoryId: uuidSchema.nullable(),
          category: z.string(),
          amount: decimalSchema,
        }),
      ),
    }),
  ),
});

/**
 * One shape for every preset rather than a union per report. The output wrapper
 * spends both members of its `anyOf` on success and error, so a success schema
 * that is itself a union publishes three and the tool is refused.
 *
 * There is deliberately no total above `currencies`. Without exchange rates a
 * figure spanning them could only come from the rates implied by past
 * transfers, which is what those transfers cost, not what the money is worth.
 */
export const reportResultSchema = z.object({
  report: z.string(),
  range: z.object({
    start: nullableStringSchema,
    end: nullableStringSchema,
  }),
  asOf: z.string(),
  bucket: z.string(),
  accumulation: z.string(),
  includesArchived: z.boolean(),
  buckets: z.array(z.object({ start: z.string(), end: z.string() })),
  currencies: z.array(
    z.object({
      currency: z.string(),
      rows: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          kind: nullableStringSchema,
          archived: z.boolean(),
          values: z.array(decimalSchema),
          total: decimalSchema,
        }),
      ),
      totals: z.array(decimalSchema),
    }),
  ),
});

export const accountRegisterResultSchema = z.object({
  accountId: uuidSchema,
  accountName: z.string(),
  type: z.string(),
  currency: z.string(),
  archivedAt: nullableStringSchema,
  range: z.object({
    start: nullableStringSchema,
    end: nullableStringSchema,
  }),
  asOf: z.string(),
  openingBalance: decimalSchema,
  closingBalance: decimalSchema,
  entries: z.array(
    z.object({
      postingId: uuidSchema,
      transactionId: uuidSchema.nullable(),
      date: z.string(),
      amount: decimalSchema,
      balanceBefore: decimalSchema,
      balanceAfter: decimalSchema,
      origin: z.string(),
    }),
  ),
});

export const csvExportResultSchema = z.object({
  csv: z.string(),
  rowCount: z.number().int().nonnegative(),
});

export const auditEventResultSchema = z
  .object({
    id: uuidSchema,
    userId: z.string(),
    actorSource: z.enum(actorSources),
    clientId: nullableStringSchema,
    entityType: z.string(),
    entityId: z.string(),
    operation: z.string(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    createdAt: timestampSchema,
  })
  .passthrough();

const csvPreviewRowSchema = z
  .object({
    draft: z.unknown().nullable(),
    issues: z.array(validationIssueSchema),
  })
  .passthrough();

const csvReferenceResolutionSchema = z.object({
  categories: z.array(
    z.object({
      inputName: z.string(),
      resolvedName: z.string(),
      categoryId: uuidSchema.nullable(),
      kind: z.enum(categoryKinds),
      resolution: z.enum(["existing", "new", "updated", "deferred"]),
      unarchived: z.boolean(),
    }),
  ),
  payees: z.array(
    z.object({
      inputPayee: z.string(),
      resolvedPayee: z.string(),
      resolution: z.enum(["existing", "new"]),
    }),
  ),
});

const csvPreviewSchema = z.object({
  fileName: z.string(),
  rowCount: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
  sample: z.array(csvPreviewRowSchema),
  referenceResolution: csvReferenceResolutionSchema,
});

export const csvStageResultSchema = z.union([
  csvPreviewSchema,
  csvPreviewSchema.extend({
    importBatchId: uuidSchema,
    stagedIds: z.array(uuidSchema),
  }),
]);

/**
 * A reminder to make this template's transaction. Null when there is none.
 *
 * `frequency` null is a reminder that happens once, which `repeats` says outright
 * so a caller does not have to infer it. `nextNotificationDate` null means
 * nothing further is owed, which for a one-off is how it says it has been sent.
 */
export const templateNotificationResultSchema = z.object({
  frequency: z.enum(recurrenceFrequencies).nullable(),
  interval: z.number().int().positive(),
  anchorDate: z.string(),
  monthPolicy: z.enum(recurrenceMonthPolicies),
  weekendPolicy: z.enum(recurrenceWeekendPolicies),
  position: z.object({ ordinal: z.number().int(), weekday: z.number().int() }).nullable(),
  time: z.string(),
  repeats: z.boolean(),
  lastNotifiedDate: nullableStringSchema,
  nextNotificationDate: nullableStringSchema,
});

export const transactionTemplateResultSchema = z
  .object({
    ...versionedEntitySchema,
    name: z.string(),
    draft: transactionTemplateDraftSchema,
    notification: templateNotificationResultSchema.nullable(),
    transactionCount: z.number().int().nonnegative().optional(),
    stagedTransactionCount: z.number().int().nonnegative().optional(),
    totalTransactionCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const transactionTemplateBulkMcpResultSchema =
  transactionTemplateBulkResultSchema.passthrough();

export const preferencesResultSchema = z
  .object({
    userId: z.string(),
    timezone: z.string(),
    defaultCurrency: z.string(),
    theme: z.string(),
    chosen: z.boolean(),
  })
  .passthrough();

export const importBatchResultSchema = z.object({
  id: uuidSchema,
  fileName: z.string(),
  rowCount: z.number().int().nonnegative(),
  stagedCount: z.number().int().nonnegative(),
  createdAt: timestampSchema,
});

export const csvFilePreviewResultSchema = z.object({
  delimiter: z.string(),
  headers: z.array(z.string()),
  // A row with more fields than headers carries the surplus as an array under
  // `__parsed_extra`, so cells are not all strings. Insisting they were failed
  // this tool's output on exactly the malformed file it is called to diagnose.
  rows: z.array(z.record(z.string(), z.union([z.string(), z.array(z.string())]))),
  errors: z.array(z.string()),
});

export const identityResultSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  clientId: nullableStringSchema,
  source: z.string(),
  /** Whether a reminder or a proposal notice can actually be delivered. */
  notificationsAvailable: z.boolean(),
});

export const ownDataSummaryResultSchema = z.object({
  accounts: z.number().int().nonnegative(),
  transactions: z.number().int().nonnegative(),
  categories: z.number().int().nonnegative(),
  stagedTransactions: z.number().int().nonnegative(),
  recurrences: z.number().int().nonnegative(),
  importBatches: z.number().int().nonnegative(),
  payees: z.number().int().nonnegative(),
  connectedAgents: z.number().int().nonnegative(),
});

export const deletedEntityResultSchema = z.object({
  id: uuidSchema,
  deleted: z.literal(true),
});

export const deletedStagesResultSchema = z.object({
  deletedIds: z.array(uuidSchema),
  dryRun: z
    .boolean()
    .describe("True when nothing was written and the ids are what would have been deleted."),
});

export const bulkStageSelectionSnapshotResultSchema = bulkStageSelectionSnapshotSchema;

export const bulkStageEditMcpResultSchema = bulkStageEditResultSchema;

export const mergedCategoriesResultSchema = z.object({
  targetCategory: categoryResultSchema,
  mergedSourceCategoryIds: z.array(uuidSchema),
  updatedTransactionCount: z.number().int().nonnegative(),
  updatedStagedTransactionCount: z.number().int().nonnegative(),
});

export const mergedPayeesResultSchema = z.object({
  targetPayee: z.string(),
  mergedSourcePayees: z.array(z.string()),
  updatedTransactionCount: z.number().int().nonnegative(),
  updatedStagedTransactionCount: z.number().int().nonnegative(),
});

export const committedStagesResultSchema = z.union([
  z.object({
    valid: z.literal(true),
    count: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        stagedId: uuidSchema,
        draft: z.unknown(),
      }),
    ),
  }),
  z.object({
    committed: z.array(
      z.object({
        stagedId: uuidSchema,
        transactionId: uuidSchema,
      }),
    ),
  }),
]);

export const connectedAppSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  authorizedAt: nullableStringSchema,
  lastIssuedAt: nullableStringSchema,
  expiresAt: nullableStringSchema,
  activeTokenCount: z.number().int().nonnegative(),
  hasLiveAccess: z.boolean(),
});

export const connectedAppListSchema = z.array(connectedAppSchema);

export const revokedConnectedAppSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  revokedTokenCount: z.number().int().nonnegative(),
});

const recurrenceOccurrenceSchema = z.object({
  occurrenceDate: z.string(),
  postedDate: nullableStringSchema,
});

/**
 * What a recurrence proposes, described rather than deferred.
 *
 * Not `recurrenceShapeSchema` itself: that one carries `.transform()` on its
 * nullable text fields, and a transform has no JSON Schema representation, so
 * declaring it makes every tool registration fail with "Transforms cannot be
 * represented in JSON Schema". This says the same thing in terms a schema can
 * publish. It is read-only, so the fields an agent must send are the write
 * schema's business and the discriminated union does not have to be repeated.
 */
const recurrenceShapeResultSchema = z.object({
  type: z.enum(transactionTypes),
  payee: z.string(),
  fromAccountId: z.string().uuid().optional(),
  toAccountId: z.string().uuid().optional(),
  amount: z.string().optional(),
  destinationAmount: z.string().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  legs: z
    .array(
      z.object({
        categoryId: z.string().uuid().optional(),
        categoryName: z.string().optional(),
        amount: z.string(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  description: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const recurrenceResultSchema = z
  .object({
    ...versionedEntitySchema,
    name: z.string(),
    shape: recurrenceShapeResultSchema,
    frequency: z.enum(recurrenceFrequencies),
    interval: z.number().int().positive(),
    anchorDate: z.string(),
    monthPolicy: z.enum(recurrenceMonthPolicies),
    weekendPolicy: z.enum(recurrenceWeekendPolicies),
    positionOrdinal: z.number().int().nullable(),
    positionWeekday: z.number().int().nullable(),
    proposesFrom: z.string(),
    // Null is "has never run", which is what tells a scheduler that is silent
    // from one that has nothing to say.
    lastOccurrenceDate: nullableStringSchema,
    nextOccurrenceDate: z.string(),
    notifyOnCreate: z.boolean(),
  })
  .passthrough();

export const recurrenceViewResultSchema = recurrenceResultSchema.extend({
  nextOccurrence: recurrenceOccurrenceSchema,
  overdue: z.boolean(),
  proposedCount: z.number().int().nonnegative(),
  committedCount: z.number().int().nonnegative(),
  discardedCount: z.number().int().nonnegative(),
});

export const recurrenceListResultSchema = z.object({
  today: z.string(),
  items: z.array(recurrenceViewResultSchema),
});

/**
 * A budget is a plan or an entry, and the difference matters to an agent:
 * changing a plan changes every period it covers, and changing an entry changes
 * one. `source` on a report row says which of the two produced the figure, so
 * an agent proposing a change knows which one to reach for.
 */
export const budgetPlanResultSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    categoryName: z.string(),
    currency: z.string().describe("ISO-like code, upper case."),
    periodUnit: z.enum(budgetPeriodUnits),
    amount: z.string().describe("Decimal string. Never a number."),
    activeFrom: isoDateSchema.describe(
      "First day of the first period this amount applies to. Any day inside a period names that period, so this always comes back snapped to one.",
    ),
    activeTo: isoDateSchema
      .nullable()
      .describe(
        "First day of the last period it applies to, or null while it is still running. Snapped to the period, like activeFrom.",
      ),
    version: z.number().int().positive(),
  })
  .passthrough();

export const budgetEntryResultSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    categoryName: z.string(),
    currency: z.string(),
    periodUnit: z.enum(budgetPeriodUnits),
    periodStart: isoDateSchema.describe("First day of the period, already truncated to the unit."),
    amount: z.string().describe("Decimal string. Never a number."),
    version: z.number().int().positive(),
  })
  .passthrough();

export const budgetReportResultSchema = z.object({
  periodUnit: z.enum(budgetPeriodUnits),
  start: isoDateSchema,
  asOf: isoDateSchema.describe(
    "The day the figures stop at, which is never later than today where this person lives.",
  ),
  otherPeriodUnits: z
    .array(z.enum(budgetPeriodUnits))
    .describe(
      "Period units this person budgets in that are not the one reported here. A budget belongs to a period unit, so a weekly budget does not appear in a monthly report and its category reads limit: null. If this is not empty, call again with one of these before concluding anything is unbudgeted.",
    ),
  periods: z.array(
    z.object({
      periodStart: isoDateSchema,
      start: isoDateSchema.describe(
        "The period's own first day. Never clipped to the range asked for: a limit belongs to a whole period, so the range chooses which periods to report rather than slicing them.",
      ),
      end: isoDateSchema.describe("The period's own last day."),
      partial: z
        .boolean()
        .describe(
          "True while the period is still running, so its spending is a total so far rather than a finished one. Do not report a partial period as under budget.",
        ),
      currency: z.string(),
      budgeted: z.string().describe("Sum of the limits, as a decimal string."),
      spent: z.string().describe("Sum of the actuals, as a decimal string."),
      rows: z.array(
        z.object({
          categoryId: nullableStringSchema.describe("Null is the share of a split nobody filed."),
          category: z.string(),
          limit: nullableStringSchema.describe(
            "Null means nothing budgeted this category for this period at this period unit. Check otherPeriodUnits before reporting it as unbudgeted.",
          ),
          actual: z
            .string()
            .describe("Signed. A refund is negative and lowers the category it came back to."),
          remaining: nullableStringSchema.describe(
            "Limit minus actual. Negative is over. Null when there is no limit.",
          ),
          source: z
            .enum(["entry", "plan", "none"])
            .describe("Which record produced the limit, so a change reaches the right one."),
        }),
      ),
    }),
  ),
});

export const deletedBudgetResultSchema = z.object({ id: z.string().uuid() });
