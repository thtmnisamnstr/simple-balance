import { z } from "zod";
import {
  accountTypes,
  actorSources,
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
const decimalSchema = z.string();
const nullableStringSchema = z.string().nullable();
const timestampSchema = z.string();

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

export const bulkTransactionSelectionSnapshotResultSchema =
  bulkTransactionSelectionSnapshotSchema;

export const bulkTransactionEditMcpResultSchema =
  bulkTransactionEditResultSchema;

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
    nextCursor: nullableStringSchema,
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

export const transactionTemplateResultSchema = z
  .object({
    ...versionedEntitySchema,
    name: z.string(),
    draft: transactionTemplateDraftSchema,
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
  rows: z.array(
    z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  ),
  errors: z.array(z.string()),
});

export const identityResultSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  clientId: nullableStringSchema,
  source: z.string(),
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
});

export const bulkStageSelectionSnapshotResultSchema =
  bulkStageSelectionSnapshotSchema;

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
