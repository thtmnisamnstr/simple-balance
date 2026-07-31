import { z } from "zod";
import {
  accountTypes,
  bulkTransactionEditResultSchema,
  bulkTransactionSelectionSnapshotSchema,
  categoryKinds,
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
    importBatchId: uuidSchema.nullable(),
    committedTransactionId: uuidSchema.nullable(),
    deletedAt: timestampSchema.nullable(),
  })
  .passthrough();

export function pageResultSchema<T extends z.ZodType>(itemSchema: T) {
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

export const csvExportResultSchema = z.object({
  csv: z.string(),
  rowCount: z.number().int().nonnegative(),
});

export const auditEventResultSchema = z
  .object({
    id: uuidSchema,
    userId: z.string(),
    actorSource: z.enum(["web", "mcp"]),
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
      resolution: z.enum(["existing", "new", "updated"]),
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

export const deletedEntityResultSchema = z.object({
  id: uuidSchema,
  deleted: z.literal(true),
});

export const deletedStagesResultSchema = z.object({
  deletedIds: z.array(uuidSchema),
});

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
