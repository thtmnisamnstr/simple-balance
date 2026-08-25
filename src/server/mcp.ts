import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z, ZodError } from "zod";
import type { Actor } from "../shared/domain.js";
import { APP_VERSION } from "../shared/version.js";
import {
  accountCreateSchema,
  accountUpdateSchema,
  bulkDeleteStageSchema,
  bulkStageEditSchema,
  bulkStageFilterSelectionRequestSchema,
  bulkTransactionDeleteSchema,
  bulkTransactionEditSchema,
  bulkTransactionFilterSelectionRequestSchema,
  categoryCreateSchema,
  categoryMergeSchema,
  categoryUpdateSchema,
  commitStageSchema,
  dateRangeSchema,
  directTransactionCreateSchema,
  budgetEntrySetSchema,
  budgetPlanCreateSchema,
  budgetPlanUpdateSchema,
  budgetReportQuerySchema,
  idempotencyKeySchema,
  reportQuerySchema,
  recurrenceCreateSchema,
  recurrenceUpdateSchema,
  listQuerySchema,
  payeeListQuerySchema,
  payeeMergeSchema,
  stageCreateSchema,
  stageListQuerySchema,
  transactionTemplateBulkDeleteSchema,
  transactionTemplateBulkEditSchema,
  transactionTemplateCreateSchema,
  transactionTemplateUpdateSchema,
  stageUpdateSchema,
  transactionDeletedMutationSchema,
  transactionUpdateSchema,
  isoDateSchema,
} from "../shared/domain.js";
import { getDb, type DbTransaction } from "./db/client.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
  getAccountBalances,
  listAccounts,
  setAccountArchived,
  updateAccount,
} from "./services/accounts.js";
import { listAuditEvents } from "./services/audit.js";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategorySummaries,
  listDuplicateCategories,
  mergeCategories,
  setCategoryArchived,
  updateCategory,
} from "./services/categories.js";
import {
  listDuplicatePayees,
  listPayees,
  listPayeeSuggestions,
  mergePayees,
} from "./services/payees.js";
import {
  createTransactionTemplate,
  bulkDeleteTransactionTemplates,
  bulkEditTransactionTemplates,
  deleteTransactionTemplate,
  getTransactionTemplate,
  listTransactionTemplates,
  updateTransactionTemplate,
} from "./services/transaction-templates.js";
import { AppError, zodIssues } from "./services/errors.js";
import { getIdempotent, lockIdempotencyKey, setIdempotent } from "./services/helpers.js";
import {
  csvStageInputSchema,
  exportTransactionsCsv,
  getCsvPreview,
  importBatchListQuerySchema,
  listActiveImportBatches,
  stageCsv,
} from "./services/import-export.js";
import { getPreferences, preferencePatchSchema, setPreferences } from "./services/preferences.js";
import { summarizeOwnData } from "./services/account-deletion.js";
import { getIdentity } from "./services/identity.js";
import {
  bulkEditStages,
  commitStages,
  createStage,
  deleteStages,
  getStage,
  getStagedDuplicateReview,
  listStages,
  previewBulkStageSelection,
  updateStage,
} from "./services/staging.js";
import { listConnectedApps, revokeConnectedApp } from "./services/connected-apps.js";
import { getAccountRegister, getReport } from "./services/reports.js";
import { getSummary } from "./services/summary.js";
import {
  createBudgetPlan,
  deleteBudgetEntry,
  deleteBudgetPlan,
  getBudgetPlan,
  getBudgetReport,
  listBudgetEntries,
  listBudgetPlans,
  setBudgetEntry,
  updateBudgetPlan,
} from "./services/budgets.js";
import {
  createRecurrence,
  deleteRecurrence,
  getRecurrence,
  listRecurrences,
  updateRecurrence,
} from "./services/recurrences.js";
import {
  bulkDeleteTransactions,
  bulkEditTransactions,
  createTransaction,
  getBulkTransactionSelection,
  getTransaction,
  listTransactions,
  setTransactionDeleted,
  updateTransaction,
} from "./services/transactions.js";
import {
  accountBalancesResultSchema,
  accountResultSchema,
  auditEventResultSchema,
  bulkStageEditMcpResultSchema,
  bulkStageSelectionSnapshotResultSchema,
  bulkTransactionEditMcpResultSchema,
  bulkTransactionSelectionSnapshotResultSchema,
  categoryResultSchema,
  categorySummaryResultSchema,
  committedStagesResultSchema,
  csvExportResultSchema,
  csvStageResultSchema,
  deletedEntityResultSchema,
  deletedStagesResultSchema,
  duplicateCategoriesResultSchema,
  duplicatePayeesResultSchema,
  mcpOutputSchema,
  mergedCategoriesResultSchema,
  mergedPayeesResultSchema,
  payeeResultSchema,
  cursorPageResultSchema,
  pageResultSchema,
  stagedDuplicateReviewResultSchema,
  stagedTransactionResultSchema,
  connectedAppListSchema,
  revokedConnectedAppSchema,
  csvFilePreviewResultSchema,
  identityResultSchema,
  importBatchResultSchema,
  ownDataSummaryResultSchema,
  preferencesResultSchema,
  accountRegisterResultSchema,
  reportResultSchema,
  summaryResultSchema,
  transactionResultSchema,
  transactionTemplateBulkMcpResultSchema,
  budgetEntryResultSchema,
  budgetPlanResultSchema,
  budgetReportResultSchema,
  deletedBudgetResultSchema,
  recurrenceListResultSchema,
  recurrenceResultSchema,
  recurrenceViewResultSchema,
  transactionTemplateResultSchema,
} from "./mcp-output-schemas.js";

const toolResult = (result: unknown) => {
  const serializedResult = JSON.parse(JSON.stringify(result)) as unknown;
  return {
    structuredContent: { result: serializedResult },
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ result: serializedResult }),
      },
    ],
  };
};

async function runTool(fn: () => Promise<unknown>) {
  try {
    return toolResult(await fn());
  } catch (error) {
    if (!(error instanceof AppError) && !(error instanceof ZodError)) {
      console.error("Unexpected MCP tool error", error);
    }
    // An agent can only correct a call it can see the fault in. A schema
    // failure names the field and what was wrong with it; reporting it as an
    // unexpected error would leave the agent to guess and retry blind.
    const body =
      error instanceof AppError
        ? { code: error.code, message: error.message, details: error.details }
        : error instanceof ZodError
          ? {
              code: "VALIDATION_ERROR",
              message: "Request validation failed",
              details: zodIssues(error),
            }
          : { code: "INTERNAL_ERROR", message: "An unexpected error occurred" };
    return {
      ...toolResult({ error: body }),
      isError: true,
    };
  }
}

async function runIdempotentMcpMutation(
  actor: Actor,
  operation: string,
  key: string,
  requestPayload: unknown,
  fn: (tx: DbTransaction) => Promise<unknown>,
) {
  return getDb().transaction(async (tx) => {
    await lockIdempotencyKey(tx, actor, operation, key);
    const existing = await getIdempotent<unknown>(
      tx,
      actor,
      `mcp.${operation}`,
      key,
      requestPayload,
    );
    if (existing) return existing;
    const result = await fn(tx);
    await setIdempotent(tx, actor, `mcp.${operation}`, key, requestPayload, result);
    return result;
  });
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const additiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

function hasScope(scopes: Set<string>, scope: string) {
  return (
    scopes.has(scope) ||
    (scope === "ledger:read" && (scopes.has("ledger:stage") || scopes.has("ledger:write")))
  );
}

/**
 * A tool's own argument object, closed.
 *
 * An open object accepts an argument nobody declared, in silence, and returns
 * success — which teaches the model the argument worked and that whatever it
 * thought the argument did is a thing this surface does. The next call leans on
 * it. Closing the object turns that into an error the model can learn from
 * instead, which is the whole reason the specification recommends it.
 *
 * Schemas shared with the HTTP surface are left as they are: closing one there
 * is a decision about what a browser may send, not about what an agent may
 * hallucinate, and the two questions deserve separate answers.
 */
const toolInput = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/**
 * The record a tool acts on.
 *
 * Twenty-seven tools took a bare `z.string().uuid()`, which tells an agent the
 * shape and nothing about where to get one. Every id on this surface comes from
 * a list or a create, and none of them is guessable, so saying that is what
 * stops a model inventing a plausible UUID and getting a 404 it cannot explain.
 */
const recordIdSchema = z
  .string()
  .uuid()
  .describe(
    "The record's `id`, as returned by a list or a create on this surface. Ids are not guessable and cannot be constructed.",
  );

export function createMcpServer(actor: Actor, scopes: Set<string>) {
  const server = new McpServer(
    {
      name: "simple-balance",
      version: APP_VERSION,
    },
    {
      /**
       * What a client puts in front of the model before it picks a tool.
       *
       * The tool descriptions say what each call does; this says what the
       * surface is and which mistakes it will not forgive. Everything here is
       * something an agent otherwise learns by being refused: that money is a
       * string, that a write needs a key, that staging exists and is usually
       * the polite thing to do, and that no total crosses currencies.
       */
      instructions: [
        "Simple Balance is one person's double-entry ledger. Every figure you read or write belongs to the account that authorised this connection.",
        "",
        'Money is always an exact decimal string, never a JSON number: send "12.50", not 12.5. Totalling amounts as floats loses money, and no total may cross currencies — each currency is reported on its own.',
        "",
        "Dates are YYYY-MM-DD in the person's own timezone. A summary stops at today whatever end date you ask for, and tells you the day it used.",
        "",
        "Reading is free. Writing is not: a tool that creates something takes an idempotencyKey you choose, and a tool that changes or deletes something takes the expectedVersion you last read. If a write fails with STALE_VERSION, read the record again — do not retry with the old version.",
        "",
        "Prefer staging to committing when a person has not asked for something specific. `ledger:stage` proposes a row for them to review; `ledger:write` changes the books. Deleting is a reversal, not an erasure, so it can be undone.",
        "",
        "Amounts are always positive. Which way money moved is the transaction's type, not the sign. A deposit into a spending category is a refund and lowers that category's spending rather than counting as income.",
      ].join("\n"),
    },
  );

  if (hasScope(scopes, "ledger:read")) {
    server.registerTool(
      "list_accounts",
      {
        title: "List accounts",
        description: "List this user's accounts and balances in their native currencies.",
        inputSchema: toolInput({
          end: isoDateSchema
            .optional()
            .describe(
              "Report each balance as of this date. Does not change which accounts come back. Left out, a balance includes every posting, future-dated ones included.",
            ),
          includeArchived: z.boolean().default(false),
        }),
        outputSchema: mcpOutputSchema(z.array(accountResultSchema)),
        annotations: readAnnotations,
      },
      (input) => runTool(() => listAccounts(actor, input.end, input.includeArchived)),
    );
    server.registerTool(
      "get_account_balances",
      {
        title: "Get account balance snapshot",
        description: "Get one account's beginning, ending, current, and future balances.",
        inputSchema: dateRangeSchema.extend({ id: recordIdSchema }).strict(),
        outputSchema: mcpOutputSchema(accountBalancesResultSchema),
        annotations: readAnnotations,
      },
      ({ id, start, end }) => runTool(() => getAccountBalances(actor, id, { start, end })),
    );
    server.registerTool(
      "list_categories",
      {
        title: "List categories",
        description:
          "List income and expense categories with how many committed and staged transactions use each one, so an existing category can be reused rather than a second spelling of it created. Counts cover the whole ledger and leave out deleted transactions and staged rows already committed or discarded.",
        inputSchema: toolInput({ includeArchived: z.boolean().default(false) }),
        outputSchema: mcpOutputSchema(z.array(categorySummaryResultSchema)),
        annotations: readAnnotations,
      },
      (input) => runTool(() => listCategorySummaries(actor, input.includeArchived)),
    );
    server.registerTool(
      "list_duplicate_categories",
      {
        title: "List duplicate categories",
        description: "Find this user's categories whose names match after normalization.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(duplicateCategoriesResultSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => listDuplicateCategories(actor)),
    );
    server.registerTool(
      "list_payees",
      {
        title: "List payees",
        description:
          "Every payee spelling the ledger holds, one row per spelling as it was typed, with how many committed and staged entries carry each. A payee is text on a transaction rather than a record, so two spellings of one shop are two rows here. Use `list_duplicate_payees` to see which of them collide.",
        // The service's own schema, so what is advertised and what is accepted
        // cannot drift. They already had: this said 200 characters where the
        // service allows 160 and strips line breaks.
        inputSchema: payeeListQuerySchema.strict(),
        outputSchema: mcpOutputSchema(z.array(payeeResultSchema)),
        annotations: readAnnotations,
      },
      ({ search }) => runTool(() => listPayees(actor, { search })),
    );
    server.registerTool(
      "list_duplicate_payees",
      {
        title: "List duplicate payees",
        description:
          "Payee spellings that collide once Unicode form, whitespace and case are normalised, grouped by what they normalise to. This is the grouping `list_payees` does not do, and the normalisation is the server’s own: an agent cannot reliably reproduce it from the spellings alone. Reach for this before merging, and for `list_payees` when you want the whole list.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(duplicatePayeesResultSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => listDuplicatePayees(actor)),
    );
    server.registerTool(
      "list_transactions",
      {
        title: "List committed transactions",
        description: "Search committed deposits, withdrawals, and transfers.",
        inputSchema: listQuerySchema.strict(),
        outputSchema: mcpOutputSchema(pageResultSchema(transactionResultSchema)),
        annotations: readAnnotations,
      },
      (input) => runTool(() => listTransactions(actor, input)),
    );
    server.registerTool(
      "get_transaction",
      {
        title: "Get transaction",
        description: "Get one committed transaction by ID.",
        inputSchema: toolInput({ id: recordIdSchema }),
        outputSchema: mcpOutputSchema(transactionResultSchema),
        annotations: readAnnotations,
      },
      ({ id }) => runTool(() => getTransaction(actor, id)),
    );
    server.registerTool(
      "preview_bulk_transaction_selection",
      {
        title: "Preview a bulk transaction selection",
        description:
          "Resolve all transactions matching a filter, minus explicit exclusions, into the count and fingerprint required for a safe all-matching bulk edit.",
        inputSchema: bulkTransactionFilterSelectionRequestSchema.strict(),
        outputSchema: mcpOutputSchema(bulkTransactionSelectionSnapshotResultSchema),
        annotations: readAnnotations,
      },
      (input) => runTool(() => getBulkTransactionSelection(actor, input)),
    );
    server.registerTool(
      "get_account",
      {
        title: "Get account",
        description:
          "Get one account by ID, with the balance the account page shows: every posting it holds, including any dated in the future. Use get_account_balances to separate what has already moved from what has not. An archived account comes back too, so read archivedAt rather than assuming a result means it is in use.",
        inputSchema: toolInput({ id: recordIdSchema }),
        outputSchema: mcpOutputSchema(accountResultSchema),
        annotations: readAnnotations,
      },
      ({ id }) => runTool(() => getAccount(actor, id)),
    );
    server.registerTool(
      "get_category",
      {
        title: "Get category",
        description:
          "Get one category by ID. An archived category comes back as well, so check archivedAt before filing anything under it.",
        inputSchema: toolInput({ id: recordIdSchema }),
        outputSchema: mcpOutputSchema(categoryResultSchema),
        annotations: readAnnotations,
      },
      ({ id }) => runTool(() => getCategory(actor, id)),
    );
    server.registerTool(
      "whoami",
      {
        title: "Who this ledger belongs to",
        description:
          "The name and email of the person whose books these are, and the client id this call is authorized under, which is how you tell yourself apart in list_connected_agents. It reports nothing about how they sign in. notificationsAvailable says whether this deployment can send mail at all, which decides whether a recurrence set to email on proposal, or a template reminder, will ever arrive.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(identityResultSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => getIdentity(actor)),
    );
    server.registerTool(
      "get_preferences",
      {
        title: "Get preferences",
        description:
          "This person's timezone, default currency and colour theme. Read it before dating anything: what counts as today is decided by their timezone, not the server's, and a transaction dated by the wrong one lands on the wrong day. `theme` is `system`, `light` or `dark`, where `system` means they follow whatever their own machine is set to; it affects nothing but what their screen looks like. `chosen` is false until somebody has actually picked these rather than been given them.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(preferencesResultSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => getPreferences(actor)),
    );
    server.registerTool(
      "list_payee_suggestions",
      {
        title: "Suggest payee spellings",
        description:
          "Canonical payee spellings matching what you have so far, drawn from committed and staged entries. Use it before naming a payee: a payee is text on the transaction rather than a record, so a second spelling is a second payee in every list and report.",
        // The service's own schema rather than a second spelling of it. A bare
        // string admits a line break the service then refuses, so the tool
        // advertised calls the server would not take.
        inputSchema: toolInput({
          search: payeeListQuerySchema.shape.search.describe(
            "What has been typed so far. Left out, the most common spellings come back.",
          ),
        }),
        outputSchema: mcpOutputSchema(z.array(z.string())),
        annotations: readAnnotations,
      },
      ({ search }) => runTool(() => listPayeeSuggestions(actor, search)),
    );
    server.registerTool(
      "list_import_batches",
      {
        title: "List import batches",
        description:
          "CSV imports that still have rows waiting on Staged transactions. The id is what scopes a staged listing or a bulk edit to one file, which is how a whole import is corrected in one go.",
        inputSchema: importBatchListQuerySchema.strict(),
        outputSchema: mcpOutputSchema(cursorPageResultSchema(importBatchResultSchema)),
        annotations: readAnnotations,
      },
      (input) => runTool(() => listActiveImportBatches(actor, input)),
    );
    server.registerTool(
      "preview_csv",
      {
        title: "Preview CSV columns",
        description:
          "Read the delimiter, headers, and first rows of a CSV without staging anything or touching the ledger. Use it to work out the column mapping before calling stage_csv.",
        inputSchema: toolInput({
          csv: z.string().min(1).describe("The file's text."),
        }),
        outputSchema: mcpOutputSchema(csvFilePreviewResultSchema),
        annotations: readAnnotations,
      },
      ({ csv }) => runTool(async () => getCsvPreview(csv)),
    );
    server.registerTool(
      "summarize_own_data",
      {
        title: "Count everything in this ledger",
        description:
          "How many accounts, transactions, categories, staged rows, import batches, payees, and connected agents this person has.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(ownDataSummaryResultSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => summarizeOwnData(actor)),
    );
    server.registerTool(
      "list_recurrences",
      {
        title: "List recurring transactions",
        description:
          "List the standing instructions that propose transactions on a schedule. A recurrence never posts anything: on its due date it puts an ordinary row on Staged transactions for somebody to commit. `lastOccurrenceDate` of null means it has never run, `overdue` means its next occurrence has passed and nothing was proposed, and the three counts say what became of what it did propose. There is no holiday calendar: a business day is Monday to Friday.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(recurrenceListResultSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => listRecurrences(actor)),
    );
    server.registerTool(
      "get_recurrence",
      {
        title: "Get recurring transaction",
        description:
          "Get one recurring transaction by ID, with what it has proposed and when it next falls due.",
        inputSchema: toolInput({ id: recordIdSchema }),
        outputSchema: mcpOutputSchema(recurrenceViewResultSchema),
        annotations: readAnnotations,
      },
      ({ id }) => runTool(() => getRecurrence(actor, id)),
    );
    server.registerTool(
      "list_transaction_templates",
      {
        title: "List transaction templates",
        description:
          "List saved starting points for a transaction. A template is a partial draft: a field it does not carry is one to fill in when it is used. It records nothing and affects no balance.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(z.array(transactionTemplateResultSchema)),
        annotations: readAnnotations,
      },
      () => runTool(() => listTransactionTemplates(actor)),
    );
    server.registerTool(
      "get_transaction_template",
      {
        title: "Get transaction template",
        description: "Get one saved transaction template by ID.",
        inputSchema: toolInput({ id: recordIdSchema }),
        outputSchema: mcpOutputSchema(transactionTemplateResultSchema),
        annotations: readAnnotations,
      },
      ({ id }) => runTool(() => getTransactionTemplate(actor, id)),
    );
    server.registerTool(
      "preview_bulk_staged_selection",
      {
        title: "Preview a bulk staged selection",
        description:
          "Resolve all staged transactions matching a filter, minus explicit exclusions, into the count and fingerprint required for a safe all-matching bulk edit.",
        inputSchema: bulkStageFilterSelectionRequestSchema.strict(),
        outputSchema: mcpOutputSchema(bulkStageSelectionSnapshotResultSchema),
        annotations: readAnnotations,
      },
      (input) => runTool(() => previewBulkStageSelection(actor, input)),
    );
    server.registerTool(
      "list_staged_transactions",
      {
        title: "List staged transactions",
        description: "Review uncommitted staged transactions and validation warnings.",
        inputSchema: stageListQuerySchema.strict(),
        outputSchema: mcpOutputSchema(pageResultSchema(stagedTransactionResultSchema)),
        annotations: readAnnotations,
      },
      (input) => runTool(() => listStages(actor, input)),
    );
    server.registerTool(
      "get_staged_transaction",
      {
        title: "Get staged transaction",
        description: "Get one staged transaction by ID.",
        inputSchema: toolInput({ id: recordIdSchema }),
        outputSchema: mcpOutputSchema(stagedTransactionResultSchema),
        annotations: readAnnotations,
      },
      ({ id }) => runTool(() => getStage(actor, id)),
    );
    server.registerTool(
      "get_financial_summary",
      {
        title: "Get financial summary",
        description:
          "Calculate balances, deposits, withdrawals, and spending separately by currency. Nothing dated after today is counted, whatever end date you ask for, because money dated in the future has not moved yet; the asOf field says which day the figures are really as of.",
        inputSchema: toolInput({
          start: isoDateSchema
            .optional()
            .describe("First day to include. Left out, the summary starts from the beginning."),
          end: isoDateSchema
            .optional()
            .describe(
              "Last day to include. Left out, the summary runs to today. An end after today is treated as today.",
            ),
          includeArchived: z
            .boolean()
            .optional()
            .describe(
              "Count archived accounts and their activity too. Off by default: archiving posts an account's balance out to equity, so an archived account holds nothing and its past activity is left out of the totals.",
            ),
        }),
        outputSchema: mcpOutputSchema(summaryResultSchema),
        annotations: readAnnotations,
      },
      ({ includeArchived, ...input }) =>
        runTool(() => getSummary(actor, input, includeArchived ?? false)),
    );
    server.registerTool(
      "get_staged_duplicate",
      {
        title: "Open a staged row beside what it repeats",
        description:
          "Fetch a staged row together with the one thing it looks like a repeat of, ordered for review. The second side is the committed transaction where there is one, and otherwise the older of the two staged rows; it is null when nothing matches it any more. Only a staged side may be deleted, because the way out of a duplicate is to drop the copy that has not been recorded yet.",
        inputSchema: toolInput({
          id: recordIdSchema.describe("The staged row to review."),
        }),
        outputSchema: mcpOutputSchema(stagedDuplicateReviewResultSchema),
        annotations: readAnnotations,
      },
      ({ id }) => runTool(() => getStagedDuplicateReview(actor, id)),
    );
    server.registerTool(
      "get_report",
      {
        title: "Run a financial report",
        description:
          "Run one of six reports over a date range, returned as a matrix of rows by time bucket, separately per currency and never mixed across them. net-worth and balance-sheet are what the accounts hold at the end of each bucket; income-expense, categories and cash-flow are what moved during it; trial-balance lists every account including the server's own counter-accounts and totals zero when the books are whole. Nothing dated after today is counted whatever end you ask for, and asOf says which day the figures are really as of.",
        inputSchema: reportQuerySchema
          .extend({
            includeArchived: z
              .boolean()
              .optional()
              .describe(
                "Show rows for archived accounts. What it does depends on the report. On income-expense, categories and cash-flow it decides whether an archived account's activity is counted at all. On net-worth, balance-sheet and trial-balance it never changes a figure: an archived account held what it held for every bucket before it closed, and archiving posts that balance out to equity so it reads zero from the day it closed. There the flag only decides whether a row that is flat at zero across the whole window is listed. Each row says whether its account is archived.",
              ),
          })
          .strict(),
        outputSchema: mcpOutputSchema(reportResultSchema),
        annotations: readAnnotations,
      },
      ({ includeArchived, ...input }) =>
        runTool(() => getReport(actor, input, includeArchived ?? false)),
    );
    server.registerTool(
      "get_account_register",
      {
        title: "List one account's postings with a running balance",
        description:
          "List every posting on one account in date order with the balance before and after each of them, plus the balance the window opens and closes on. Built for finding mistakes rather than for analysis: where a balance goes wrong, this is the row it went wrong on. An archived account ends at zero, and the postings that closed it out to equity are in the list.",
        inputSchema: dateRangeSchema.extend({ id: recordIdSchema }).strict(),
        outputSchema: mcpOutputSchema(accountRegisterResultSchema),
        annotations: readAnnotations,
      },
      ({ id, start, end }) => runTool(() => getAccountRegister(actor, id, { start, end })),
    );
    server.registerTool(
      "export_transactions_csv",
      {
        title: "Export transactions as CSV",
        description:
          "Export filtered committed transactions in the round-trip CSV format. A deleted entry is never exported, whatever filter is sent: it is void, its postings net to zero, and the file has no column to say so, so reading it back would raise the voided amount from the dead.",
        // An export is the whole filtered set, so it advertises no window, and
        // no includeDeleted either: the service fixes that to false and an
        // advertised filter that changes nothing is worse than an absent one.
        inputSchema: listQuerySchema
          .omit({
            cursor: true,
            limit: true,
            page: true,
            sort: true,
            direction: true,
            includeDeleted: true,
          })
          .strict(),
        outputSchema: mcpOutputSchema(csvExportResultSchema),
        annotations: readAnnotations,
      },
      (input) => runTool(() => exportTransactionsCsv(actor, input)),
    );
    server.registerTool(
      "list_audit_events",
      {
        title: "List activity history",
        description:
          "List append-only ledger activity: every write, whether it came from the browser, an agent, or the recurrence scheduler. actorSource says which.",
        inputSchema: toolInput({
          cursor: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        }),
        outputSchema: mcpOutputSchema(cursorPageResultSchema(auditEventResultSchema)),
        annotations: readAnnotations,
      },
      (input) => runTool(() => listAuditEvents(actor, input)),
    );

    server.registerTool(
      "list_connected_agents",
      {
        title: "List connected agents",
        description:
          "List the MCP clients this person has authorized, what each may do, and whether it currently holds a live token. Includes you.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(connectedAppListSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => listConnectedApps(actor)),
    );
    server.registerTool(
      "list_budget_plans",
      {
        title: "List standing budgets",
        description:
          "List the standing budgets. One plan covers every period in its window, so a budget running all year is one row here rather than twelve. To see what was actually spent against them, call get_budget_report; this tool reports only what was intended.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(z.array(budgetPlanResultSchema)),
        annotations: readAnnotations,
      },
      () => runTool(() => listBudgetPlans(actor)),
    );
    server.registerTool(
      "get_budget_plan",
      {
        title: "Get a standing budget",
        description:
          "Get one standing budget by id, including the version a change to it will need.",
        inputSchema: toolInput({ id: recordIdSchema }),
        outputSchema: mcpOutputSchema(budgetPlanResultSchema),
        annotations: readAnnotations,
      },
      (input) => runTool(() => getBudgetPlan(actor, input.id)),
    );
    server.registerTool(
      "list_budget_entries",
      {
        title: "List single-period budget overrides",
        description:
          "List the amounts set for one period only, which override whatever standing budget covers that period. An empty list is the normal state: most budgets are plans and need no entries at all.",
        inputSchema: toolInput({}),
        outputSchema: mcpOutputSchema(z.array(budgetEntryResultSchema)),
        annotations: readAnnotations,
      },
      () => runTool(() => listBudgetEntries(actor)),
    );
    server.registerTool(
      "get_budget_report",
      {
        title: "Get budget against actual",
        description:
          "What each budgeted category was allowed and what it actually spent, period by period. A budget belongs to a period unit, and this reports one unit at a time, defaulting to month: a weekly budget will not appear in a monthly report and its category will read limit: null, so check otherPeriodUnits in the reply before telling anybody a category is unbudgeted. Spending is signed, so a refund is negative and lowers the category it came back to. Figures stop at today where this person lives, whatever end date is asked for, and asOf reports the day used. Amounts never span currencies: a period appears once per currency and there is no converted total, because this ledger holds no exchange rate. Set includeUnbudgeted to false to see only categories that have a budget. includeArchived counts spending that ran through accounts since closed and is on by default, unlike every other report: a budget's limit was never scoped to an account, so leaving that spending out makes a budget spent to the penny read as underspent. Set it false to ask the other question.",
        inputSchema: budgetReportQuerySchema.strict(),
        outputSchema: mcpOutputSchema(budgetReportResultSchema),
        annotations: readAnnotations,
      },
      (input) => runTool(() => getBudgetReport(actor, input)),
    );
  }

  if (scopes.has("ledger:stage") || scopes.has("ledger:write")) {
    server.registerTool(
      "create_staged_transaction",
      {
        title: "Stage a transaction",
        description: "Create a transaction for review without changing account balances.",
        inputSchema: stageCreateSchema.strict(),
        outputSchema: mcpOutputSchema(stagedTransactionResultSchema),
        annotations: additiveAnnotations,
      },
      (input) => runTool(() => createStage(actor, input)),
    );
    server.registerTool(
      "update_staged_transaction",
      {
        title: "Update a staged transaction",
        description:
          "Update an uncommitted staged transaction using optimistic concurrency. Replaces the row rather than patching it, so read it first; confirm with the person when they did not ask for this exact change.",
        inputSchema: toolInput({
          id: recordIdSchema,
          input: stageUpdateSchema.describe(
            "The staged row's replacement draft, whole. Fields you leave out are cleared, not kept.",
          ),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(stagedTransactionResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "stage.update", idempotencyKey, { id, input }, (tx) =>
            updateStage(actor, id, input, tx, {
              mayEditLedgerRecords: scopes.has("ledger:write"),
            }),
          ),
        ),
    );
    server.registerTool(
      "delete_staged_transactions",
      {
        title: "Delete staged transactions",
        description:
          "Delete explicitly selected staged transactions. Confirm it with the person first. A staged row removed here is gone, not reversed, because nothing was ever posted.",
        inputSchema: bulkDeleteStageSchema
          .extend({
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(deletedStagesResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "stage.delete", input.idempotencyKey, input, (tx) =>
            deleteStages(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "bulk_edit_staged_transactions",
      {
        title: "Bulk edit staged transactions",
        description:
          "Atomically edit explicit versioned staged transactions or a previewed all-matching selection. Every row is validated again afterwards, so filling in a missing account or category clears the issues that were blocking a commit. Account and type are refused on transfers, and dryRun validates without writing. A selection holding even one split refuses a category or type change outright rather than flattening the split, so the whole call fails: leave splits out of the selection, or edit their legs one entry at a time. Confirm it with the person first, and use dryRun to show them the count before writing.",
        inputSchema: bulkStageEditSchema.strict(),
        outputSchema: mcpOutputSchema(bulkStageEditMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          bulkEditStages(actor, input, undefined, {
            mayEditLedgerRecords: scopes.has("ledger:write"),
          }),
        ),
    );
    server.registerTool(
      "stage_csv",
      {
        title: "Stage CSV transactions",
        description:
          "Parse CSV text, preview it with dryRun, or place all rows in the staging queue. Categories named in the file are matched to ones that already exist. Creating a category, bringing an archived one back, or widening what it may carry are ledger:write changes, so with only ledger:stage the row is staged under the category's name and the resolution is reported as deferred; committing it, which needs ledger:write, is what makes the category.",
        inputSchema: csvStageInputSchema.strict(),
        outputSchema: mcpOutputSchema(csvStageResultSchema),
        annotations: additiveAnnotations,
      },
      (input) => {
        const options = {
          mayMutateCategories: scopes.has("ledger:write"),
        };
        // Both branches now, because stageCsv honours the key itself.
        return runTool(() => stageCsv(actor, input, undefined, options));
      },
    );
  }

  if (scopes.has("ledger:write")) {
    server.registerTool(
      "create_budget_plan",
      {
        title: "Set a standing budget",
        description:
          "Budget an amount for one category, per period, from activeFrom onward. One row covers every period in its window, so this is what to use for an ongoing budget; set_budget_entry is for changing a single period, and get_budget_report is what shows either of them against real spending. Both ends of the window are snapped to the period, so any day inside a month names that whole month and the budget applies to the month it starts in. Leave activeTo out while it is still running. Windows for one category may not overlap, so raising a budget means ending the old one at the period before the new one starts. An income category is refused because it has no spending to compare against. This is a change to the ledger's own records rather than a proposal about money, so it needs ledger:write.",
        inputSchema: budgetPlanCreateSchema
          .extend({
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(budgetPlanResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "budgetPlan.create", idempotencyKey, input, (tx) =>
            createBudgetPlan(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_budget_plan",
      {
        title: "Change a standing budget",
        description:
          "Change the amount or the window of a standing budget. Changing the amount changes every period the window covers, including ones already past, so to leave history alone end this plan and create another from the next period. Leaving activeTo out leaves it alone; sending null makes it open-ended again. Needs the current version, which get_budget_plan returns. Confirm it with the person when they did not ask for this exact change. It writes no postings, so nothing about the books moves.",
        inputSchema: budgetPlanUpdateSchema
          .extend({
            id: recordIdSchema,
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(budgetPlanResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "budgetPlan.update",
            idempotencyKey,
            { id, ...input },
            (tx) => updateBudgetPlan(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "delete_budget_plan",
      {
        title: "Delete a standing budget",
        description:
          "Delete a standing budget. It wrote no postings, so removing it leaves the books exactly as they were and changes no balance or report; only the budget page stops comparing against it. Confirm it with the person first. Needs the current version.",
        inputSchema: toolInput({
          id: recordIdSchema,
          expectedVersion: z.number().int().positive(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(deletedBudgetResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "budgetPlan.delete",
            idempotencyKey,
            { id, expectedVersion },
            (tx) => deleteBudgetPlan(actor, id, expectedVersion, tx),
          ),
        ),
    );
    server.registerTool(
      "set_budget_entry",
      {
        title: "Budget one period only",
        description:
          "Set the amount for a single period, overriding whatever standing budget covers it. Use this for a one-off, such as a larger food budget in December, and create_budget_plan for anything ongoing. periodStart is truncated to the period unit, so any day inside the period names it. Leave expectedVersion out the first time; setting one that already exists needs its version, which list_budget_entries returns.",
        inputSchema: budgetEntrySetSchema
          .extend({
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(budgetEntryResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "budgetEntry.set", idempotencyKey, input, (tx) =>
            setBudgetEntry(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "delete_budget_entry",
      {
        title: "Remove a single-period budget",
        description:
          "Remove a one-period override, so that period falls back to whatever standing budget covers it, or to no budget at all if none does. Writes no postings and changes no balance. Needs the current version. Confirm it with the person first. The period falls back to whatever the standing budget says.",
        inputSchema: toolInput({
          id: recordIdSchema,
          expectedVersion: z.number().int().positive(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(deletedBudgetResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "budgetEntry.delete",
            idempotencyKey,
            { id, expectedVersion },
            (tx) => deleteBudgetEntry(actor, id, expectedVersion, tx),
          ),
        ),
    );
    server.registerTool(
      "create_recurrence",
      {
        title: "Create recurring transaction",
        description:
          "Save a transaction shape and a schedule. On each due date it proposes an ordinary staged row and never a posting. The row keeps its place in the schedule in occurrenceDate, which never moves, while the draft's own date is that occurrence as the weekend and month-length policies leave it; with the default allow policy they are the same day. The amount may be left out for a bill whose amount varies; the row is proposed flagged for somebody to complete. A date, a template and a bank import reference are all refused. Monthly and yearly schedules may name a relative day instead of a day of the month, such as the second Tuesday or the last Friday. Nothing is ever proposed dated before the day the recurrence was created.",
        inputSchema: recurrenceCreateSchema
          .extend({
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(recurrenceResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "recurrence.create", idempotencyKey, input, (tx) =>
            createRecurrence(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_recurrence",
      {
        title: "Update recurring transaction",
        description:
          "Change a recurring transaction's name, shape or schedule. A schedule field left out keeps what is stored, so changing the frequency does not reset the month-length or weekend policy. The day it may propose from is never moved: an edit cannot conjure rows for months already dealt with. Confirm it with the person when they did not ask for this exact change. Rows already proposed are left alone.",
        inputSchema: toolInput({
          id: recordIdSchema,
          input: recurrenceUpdateSchema.describe("The recurrence's new definition."),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(recurrenceResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "recurrence.update",
            idempotencyKey,
            { id, input },
            (tx) => updateRecurrence(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "delete_recurrence",
      {
        title: "Delete recurring transaction",
        description:
          "Stop a recurring transaction. Rows it has already proposed are left exactly as they are, whether they are still in the queue or already committed, and they go on reporting which recurrence made them. Confirm it with the person first. Rows it already proposed are left alone; only future occurrences stop.",
        inputSchema: toolInput({
          id: recordIdSchema,
          expectedVersion: z.number().int().positive(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(z.object({ id: recordIdSchema })),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "recurrence.delete",
            idempotencyKey,
            { id, expectedVersion },
            (tx) => deleteRecurrence(actor, id, expectedVersion, tx),
          ),
        ),
    );
    server.registerTool(
      "revoke_connected_agent",
      {
        title: "Revoke a connected agent",
        description:
          "Cut an MCP client off from this ledger now rather than at token expiry. Its access tokens are deleted, so it stops on its next call, and its refresh token goes with them. The approval is withdrawn too, so it has to be authorized again. Pass your own client id to disconnect yourself. This is the same action as Settings > Connected agents in the browser. Confirm it with the person first. The agent loses access immediately and has to be authorized again from a browser.",
        inputSchema: toolInput({
          clientId: z
            .string()
            .min(1)
            .describe("The client id to cut off, as returned by list_connected_agents."),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(revokedConnectedAppSchema),
        annotations: destructiveAnnotations,
      },
      ({ clientId, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "connected_app.revoke",
            idempotencyKey,
            { clientId },
            (tx) => revokeConnectedApp(actor, clientId, tx),
          ),
        ),
    );
    server.registerTool(
      "create_account",
      {
        title: "Create account",
        description: "Create a checking, savings, card, cash, loan, or other account.",
        inputSchema: accountCreateSchema
          .extend({
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(accountResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "account.create", idempotencyKey, input, (tx) =>
            createAccount(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_account",
      {
        title: "Update account",
        description:
          "Update account details using the expected record version. Confirm it with the person when they did not ask for this exact change.",
        inputSchema: toolInput({
          id: recordIdSchema,
          input: accountUpdateSchema.describe("The account's new details."),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(accountResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "account.update", idempotencyKey, { id, input }, (tx) =>
            updateAccount(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "archive_account",
      {
        title: "Archive or restore account",
        description:
          "Retire an account, or bring one back. Archiving posts whatever the account still holds out to the Opening Balances equity account, so it closes at zero and drops out of balances and summaries while its history stays readable. Restoring posts the balance back. This moves money in the books, so confirm it with the person first.",
        inputSchema: toolInput({
          id: recordIdSchema,
          expectedVersion: z.number().int().positive(),
          archived: z.boolean(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(accountResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, archived, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "account.archive",
            idempotencyKey,
            { id, expectedVersion, archived },
            (tx) => setAccountArchived(actor, id, expectedVersion, archived, tx),
          ),
        ),
    );
    server.registerTool(
      "delete_account",
      {
        title: "Delete unused account",
        description:
          "Permanently delete an account, only when it is not archived and has no history or staged rows. Unarchive it first if it is archived.",
        inputSchema: toolInput({
          id: recordIdSchema,
          expectedVersion: z.number().int().positive(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(deletedEntityResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "account.delete",
            idempotencyKey,
            { id, expectedVersion },
            (tx) => deleteAccount(actor, id, expectedVersion, tx),
          ),
        ),
    );
    server.registerTool(
      "create_category",
      {
        title: "Create category",
        description: "Create an income or expense category.",
        inputSchema: categoryCreateSchema
          .extend({
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(categoryResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "category.create", idempotencyKey, input, (tx) =>
            createCategory(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_category",
      {
        title: "Update category",
        description:
          "Update a category using the expected record version. Confirm it with the person when they did not ask for this exact change.",
        inputSchema: toolInput({
          id: recordIdSchema,
          input: categoryUpdateSchema.describe("The category's new details."),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(categoryResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "category.update", idempotencyKey, { id, input }, (tx) =>
            updateCategory(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "archive_category",
      {
        title: "Archive or restore category",
        description: "Archive an in-use category or restore an archived category.",
        inputSchema: toolInput({
          id: recordIdSchema,
          expectedVersion: z.number().int().positive(),
          archived: z.boolean(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(categoryResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, archived, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "category.archive",
            idempotencyKey,
            { id, expectedVersion, archived },
            (tx) => setCategoryArchived(actor, id, expectedVersion, archived, tx),
          ),
        ),
    );
    server.registerTool(
      "set_preferences",
      {
        title: "Set preferences",
        description:
          'Set the timezone, the default currency, or the colour theme. What you leave out keeps its current value. The timezone decides what today means everywhere a date is worked out, so changing it changes which day an open-ended range stops at and which day an entry dated "today" lands on. Confirm it with the person before changing it; there is no version to check and no undo beyond setting it back. The theme is `system`, `light` or `dark`, where `system` follows whatever the person\'s own machine is set to and is the only one of the three that keeps following it when they change it. Set the theme only when asked to: it is what their screen looks like, and you cannot see it.',
        // Every field of the patch is optional, so without this an agent is
        // told `{ idempotencyKey }` alone is a valid call and finds out
        // otherwise from a runtime refusal. The service checks it too; this is
        // the same rule said where an agent can read it before calling.
        inputSchema: preferencePatchSchema
          .extend({ idempotencyKey: idempotencyKeySchema })
          .refine(
            (patch) =>
              patch.timezone !== undefined ||
              patch.defaultCurrency !== undefined ||
              patch.theme !== undefined,
            { message: "Choose at least one preference to change" },
          )
          .strict(),
        outputSchema: mcpOutputSchema(preferencesResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "preferences.set", idempotencyKey, input, (tx) =>
            setPreferences(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "create_transaction_template",
      {
        title: "Create transaction template",
        description:
          "Save a starting point for the transaction form. Every field is optional, including the type: leave one out to make it one the person fills in each time, and an amount is the usual one to omit. A stored date is used when the template is applied and an absent one means the day it is applied. A categoryName is matched against the categories already here, ignoring case, and creates one only if nothing matches. One key is refused rather than ignored: externalId, the reference a bank statement row was imported under, because copied onto every transaction made from this it would make the next real import of that row look like one already seen.",
        inputSchema: transactionTemplateCreateSchema
          .extend({
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(transactionTemplateResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "transactionTemplate.create",
            idempotencyKey,
            input,
            (tx) => createTransactionTemplate(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_transaction_template",
      {
        title: "Update transaction template",
        description:
          "Rename a template or replace what it remembers, using the expected record version. Sending a draft replaces it whole rather than merging, so a field left out of the new draft is dropped from the template. Confirm it with the person when they did not ask for this exact change. Transactions already made from it are untouched.",
        inputSchema: toolInput({
          id: recordIdSchema,
          input: transactionTemplateUpdateSchema.describe("The template's new definition."),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(transactionTemplateResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "transactionTemplate.update",
            idempotencyKey,
            { id, input },
            (tx) => updateTransactionTemplate(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "delete_transaction_template",
      {
        title: "Delete transaction template",
        description:
          "Delete a saved template. Transactions already made from it are untouched, because a template is only a starting point and nothing points back to it. Confirm it with the person first. Transactions already made from it are untouched.",
        inputSchema: toolInput({
          id: recordIdSchema,
          expectedVersion: z.number().int().positive(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(deletedEntityResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "transactionTemplate.delete",
            idempotencyKey,
            { id, expectedVersion },
            (tx) => deleteTransactionTemplate(actor, id, expectedVersion, tx),
          ),
        ),
    );
    server.registerTool(
      "bulk_edit_transaction_templates",
      {
        title: "Bulk edit transaction templates",
        description:
          "Atomically change many saved templates at once. Every template is named outright with the version it was read at, so a template that changed underneath is refused rather than overwritten. In the patch a field left out is left alone, a value sets it, and null clears it back to blank so the person fills it in when they use the template. Changing the type drops whichever account side the new type cannot hold. Nothing here posts to the ledger. Confirm it with the person first, and show them the count before writing.",
        inputSchema: transactionTemplateBulkEditSchema.strict(),
        outputSchema: mcpOutputSchema(transactionTemplateBulkMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) => runTool(() => bulkEditTransactionTemplates(actor, input)),
    );
    server.registerTool(
      "bulk_delete_transaction_templates",
      {
        title: "Bulk delete transaction templates",
        description:
          "Atomically delete many saved templates at once, each named with the version it was read at. Transactions already made from them are untouched, because a template is only a starting point and nothing points back to it. Confirm it with the person first. Transactions already made from these templates are untouched.",
        inputSchema: transactionTemplateBulkDeleteSchema.strict(),
        outputSchema: mcpOutputSchema(transactionTemplateBulkMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) => runTool(() => bulkDeleteTransactionTemplates(actor, input)),
    );
    server.registerTool(
      "delete_category",
      {
        title: "Delete unused category",
        description: "Permanently delete a category only when it is unused.",
        inputSchema: toolInput({
          id: recordIdSchema,
          expectedVersion: z.number().int().positive(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(deletedEntityResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "category.delete",
            idempotencyKey,
            { id, expectedVersion },
            (tx) => deleteCategory(actor, id, expectedVersion, tx),
          ),
        ),
    );
    server.registerTool(
      "merge_categories",
      {
        title: "Merge categories",
        description:
          "Move transaction and staging references into one target category and remove the sources. Confirm it with the person first: the source categories are gone afterwards and there is no undo.",
        inputSchema: categoryMergeSchema
          .extend({
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(mergedCategoriesResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(actor, "category.merge", idempotencyKey, input, (tx) =>
            mergeCategories(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "merge_payees",
      {
        title: "Merge payees",
        description:
          "Rewrite selected committed and staged payee spellings to one canonical name. Confirm it with the person first: the source payees are gone afterwards and there is no undo.",
        inputSchema: payeeMergeSchema.strict(),
        outputSchema: mcpOutputSchema(mergedPayeesResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) => runTool(() => mergePayees(actor, input)),
    );
    server.registerTool(
      "create_transaction",
      {
        title: "Commit a transaction",
        description:
          "Directly commit a deposit, withdrawal, or transfer. An entry that looks like one already in the books is refused with a DUPLICATE error rather than written; that is the refusal you are most likely to meet. Read what it names, and send `allowDuplicate: true` only once you are satisfied the two really are separate payments.",
        inputSchema: directTransactionCreateSchema.strict(),
        outputSchema: mcpOutputSchema(transactionResultSchema),
        annotations: additiveAnnotations,
      },
      ({ draft, idempotencyKey, allowDuplicate }) =>
        runTool(() => createTransaction(actor, draft, idempotencyKey, allowDuplicate)),
    );
    server.registerTool(
      "update_transaction",
      {
        title: "Update committed transaction",
        description:
          "Update a committed transaction and rebuild its postings atomically. Replaces the draft rather than patching it, so read the transaction first. Confirm with the person when they did not ask for this exact change; the correction is appended, so the old figures stay in the audit trail.",
        inputSchema: toolInput({
          id: recordIdSchema,
          input: transactionUpdateSchema.describe(
            "The transaction's replacement draft, whole. Fields you leave out are cleared, not kept, so read the transaction first and send it back changed.",
          ),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(transactionResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "transaction.update",
            idempotencyKey,
            { id, input },
            (tx) => updateTransaction(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "bulk_delete_transactions",
      {
        title: "Bulk delete committed transactions",
        description:
          "Atomically soft-delete explicit versioned transactions or a previewed all-matching selection. Rows already deleted are left alone, deleted rows stop affecting balances and reports, and dryRun validates without writing. Confirm it with the person first, and use dryRun to show them the count. Deleting posts a reversal rather than erasing, so it can be undone with set_transaction_deleted.",
        inputSchema: bulkTransactionDeleteSchema.strict(),
        outputSchema: mcpOutputSchema(bulkTransactionEditMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) => runTool(() => bulkDeleteTransactions(actor, input)),
    );
    server.registerTool(
      "bulk_edit_transactions",
      {
        title: "Bulk edit committed transactions",
        description:
          "Atomically edit explicit versioned transactions or a previewed all-matching selection. Transfers only accept common-field edits, account changes must preserve native currency, and dryRun validates without writing. A selection holding even one split refuses a category or type change outright rather than flattening the split, so the whole call fails: leave splits out of the selection, or edit their legs one entry at a time. Confirm it with the person first, and use dryRun to show them the count before writing.",
        inputSchema: bulkTransactionEditSchema.strict(),
        outputSchema: mcpOutputSchema(bulkTransactionEditMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) => runTool(() => bulkEditTransactions(actor, input)),
    );
    server.registerTool(
      "set_transaction_deleted",
      {
        title: "Delete or restore transaction",
        description:
          "Soft-delete a committed transaction or restore it. A restore that now conflicts with an active transaction requires allowDuplicate=true.",
        inputSchema: transactionDeletedMutationSchema
          .extend({
            id: recordIdSchema,
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
        outputSchema: mcpOutputSchema(transactionResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, expectedVersion, deleted, allowDuplicate, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "transaction.delete",
            idempotencyKey,
            { id, expectedVersion, deleted, allowDuplicate },
            (tx) => setTransactionDeleted(actor, id, expectedVersion, deleted, allowDuplicate, tx),
          ),
        ),
    );
    server.registerTool(
      "commit_staged_transactions",
      {
        title: "Commit staged transactions",
        description:
          "Validate and atomically commit explicit staged transaction IDs; supports dry-run. Committing puts money in the books, so confirm it with the person first unless they asked for exactly this. Use dryRun to show them what would happen.",
        inputSchema: commitStageSchema.strict(),
        outputSchema: mcpOutputSchema(committedStagesResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) => runTool(() => commitStages(actor, input)),
    );
  }

  return server;
}

export async function handleMcpRequest(request: Request, actor: Actor, scopes: Set<string>) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createMcpServer(actor, scopes);
  await server.connect(transport);
  return transport.handleRequest(request);
}
