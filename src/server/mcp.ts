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
  idempotencyKeySchema,
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
import {
  getIdempotent,
  lockIdempotencyKey,
  setIdempotent,
} from "./services/helpers.js";
import {
  csvStageInputSchema,
  exportTransactionsCsv,
  getCsvPreview,
  importBatchListQuerySchema,
  listActiveImportBatches,
  stageCsv,
} from "./services/import-export.js";
import {
  getPreferences,
  preferencePatchSchema,
  setPreferences,
} from "./services/preferences.js";
import { summarizeOwnData } from "./services/account-deletion.js";
import { getIdentity } from "./services/identity.js";
import {
  bulkEditStages,
  commitStages,
  createStage,
  deleteStages,
  getStage,
  listStages,
  previewBulkStageSelection,
  updateStage,
} from "./services/staging.js";
import {
  listConnectedApps,
  revokeConnectedApp,
} from "./services/connected-apps.js";
import { getSummary } from "./services/summary.js";
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
  stagedTransactionResultSchema,
  connectedAppListSchema,
  revokedConnectedAppSchema,
  csvFilePreviewResultSchema,
  identityResultSchema,
  importBatchResultSchema,
  ownDataSummaryResultSchema,
  preferencesResultSchema,
  summaryResultSchema,
  transactionResultSchema,
  transactionTemplateBulkMcpResultSchema,
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
    await setIdempotent(
      tx,
      actor,
      `mcp.${operation}`,
      key,
      requestPayload,
      result,
    );
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

export function createMcpServer(actor: Actor, scopes: Set<string>) {
  const server = new McpServer({
    name: "simple-balance",
    version: APP_VERSION,
  });

  if (hasScope(scopes, "ledger:read")) {
    server.registerTool(
      "list_accounts",
      {
        title: "List accounts",
        description: "List this user's accounts and balances in their native currencies.",
        inputSchema: z.object({
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
        description:
          "Get one account's beginning, ending, current, and future balances.",
        inputSchema: dateRangeSchema.extend({ id: z.string().uuid() }),
        outputSchema: mcpOutputSchema(accountBalancesResultSchema),
        annotations: readAnnotations,
      },
      ({ id, start, end }) =>
        runTool(() => getAccountBalances(actor, id, { start, end })),
    );
    server.registerTool(
      "list_categories",
      {
        title: "List categories",
        description:
          "List income and expense categories with how many committed and staged transactions use each one, so an existing category can be reused rather than a second spelling of it created. Counts cover the whole ledger and leave out deleted transactions and staged rows already committed or discarded.",
        inputSchema: z.object({ includeArchived: z.boolean().default(false) }),
        outputSchema: mcpOutputSchema(z.array(categorySummaryResultSchema)),
        annotations: readAnnotations,
      },
      (input) =>
        runTool(() => listCategorySummaries(actor, input.includeArchived)),
    );
    server.registerTool(
      "list_duplicate_categories",
      {
        title: "List duplicate categories",
        description:
          "Find this user's categories whose names match after normalization.",
        inputSchema: z.object({}),
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
          "List canonical payee names derived from committed and staged transactions.",
        // The service's own schema, so what is advertised and what is accepted
        // cannot drift. They already had: this said 200 characters where the
        // service allows 160 and strips line breaks.
        inputSchema: payeeListQuerySchema,
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
          "Find payee spellings that match after Unicode, whitespace, and case normalization.",
        inputSchema: z.object({}),
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
        inputSchema: listQuerySchema,
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
        inputSchema: z.object({ id: z.string().uuid() }),
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
        inputSchema: bulkTransactionFilterSelectionRequestSchema,
        outputSchema: mcpOutputSchema(
          bulkTransactionSelectionSnapshotResultSchema,
        ),
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
        inputSchema: z.object({ id: z.string().uuid() }),
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
        inputSchema: z.object({ id: z.string().uuid() }),
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
          "The name and email of the person whose books these are, and the client id this call is authorized under, which is how you tell yourself apart in list_connected_agents. It reports nothing about how they sign in.",
        inputSchema: z.object({}),
        outputSchema: mcpOutputSchema(identityResultSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => getIdentity(actor)),
    );
    server.registerTool(
      "get_preferences",
      {
        title: "Get regional preferences",
        description:
          "This person's timezone and default currency. Read it before dating anything: what counts as today is decided by their timezone, not the server's, and a transaction dated by the wrong one lands on the wrong day.",
        inputSchema: z.object({}),
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
        inputSchema: z.object({
          search: z
            .string()
            .max(160)
            .optional()
            .describe("What has been typed so far. Left out, the most common spellings come back."),
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
          "CSV imports that still have rows waiting in the review queue. The id is what scopes a staged listing or a bulk edit to one file, which is how a whole import is corrected in one go.",
        inputSchema: importBatchListQuerySchema,
        outputSchema: mcpOutputSchema(
          cursorPageResultSchema(importBatchResultSchema),
        ),
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
        inputSchema: z.object({
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
        inputSchema: z.object({}),
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
          "List the standing instructions that propose transactions on a schedule. A recurrence never posts anything: on its due date it puts an ordinary row in the review queue for somebody to commit. `lastOccurrenceDate` of null means it has never run, `overdue` means its next occurrence has passed and nothing was proposed, and the three counts say what became of what it did propose. There is no holiday calendar: a business day is Monday to Friday.",
        inputSchema: z.object({}),
        outputSchema: mcpOutputSchema(recurrenceListResultSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => listRecurrences(actor)),
    );
    server.registerTool(
      "get_recurrence",
      {
        title: "Get recurring transaction",
        description: "Get one recurring transaction by ID, with what it has proposed and when it next falls due.",
        inputSchema: z.object({ id: z.string().uuid() }),
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
        inputSchema: z.object({}),
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
        inputSchema: z.object({ id: z.string().uuid() }),
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
        inputSchema: bulkStageFilterSelectionRequestSchema,
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
        inputSchema: stageListQuerySchema,
        outputSchema: mcpOutputSchema(
          pageResultSchema(stagedTransactionResultSchema),
        ),
        annotations: readAnnotations,
      },
      (input) => runTool(() => listStages(actor, input)),
    );
    server.registerTool(
      "get_staged_transaction",
      {
        title: "Get staged transaction",
        description: "Get one staged transaction by ID.",
        inputSchema: z.object({ id: z.string().uuid() }),
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
        inputSchema: z.object({
          start: isoDateSchema
            .optional()
            .describe("First day to include. Left out, the summary starts from the beginning."),
          end: isoDateSchema
            .optional()
            .describe("Last day to include. Left out, the summary runs to today. An end after today is treated as today."),
          includeArchived: z
            .boolean()
            .optional()
            .describe("Count archived accounts and their activity too. Off by default: archiving posts an account's balance out to equity, so an archived account holds nothing and its past activity is left out of the totals."),
        }),
        outputSchema: mcpOutputSchema(summaryResultSchema),
        annotations: readAnnotations,
      },
      ({ includeArchived, ...input }) =>
        runTool(() => getSummary(actor, input, includeArchived ?? false)),
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
        inputSchema: listQuerySchema.omit({
          cursor: true,
          limit: true,
          page: true,
          sort: true,
          direction: true,
          includeDeleted: true,
        }),
        outputSchema: mcpOutputSchema(csvExportResultSchema),
        annotations: readAnnotations,
      },
      (input) => runTool(() => exportTransactionsCsv(actor, input)),
    );
    server.registerTool(
      "list_audit_events",
      {
        title: "List activity history",
        description: "List append-only web and MCP ledger activity.",
        inputSchema: z.object({
          cursor: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        }),
        outputSchema: mcpOutputSchema(
          cursorPageResultSchema(auditEventResultSchema),
        ),
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
        inputSchema: z.object({}),
        outputSchema: mcpOutputSchema(connectedAppListSchema),
        annotations: readAnnotations,
      },
      () => runTool(() => listConnectedApps(actor)),
    );
  }

  if (scopes.has("ledger:stage") || scopes.has("ledger:write")) {
    server.registerTool(
      "create_staged_transaction",
      {
        title: "Stage a transaction",
        description: "Create a transaction for review without changing account balances.",
        inputSchema: stageCreateSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(stagedTransactionResultSchema),
        annotations: additiveAnnotations,
      },
      (input) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "stage.create",
            input.idempotencyKey,
            input,
            (tx) => createStage(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_staged_transaction",
      {
        title: "Update a staged transaction",
        description: "Update an uncommitted staged transaction using optimistic concurrency.",
        inputSchema: z.object({
          id: z.string().uuid(),
          input: stageUpdateSchema,
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(stagedTransactionResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "stage.update",
            idempotencyKey,
            { id, input },
            (tx) => updateStage(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "delete_staged_transactions",
      {
        title: "Delete staged transactions",
        description: "Delete explicitly selected staged transactions.",
        inputSchema: bulkDeleteStageSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(deletedStagesResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "stage.delete",
            input.idempotencyKey,
            input,
            (tx) => deleteStages(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "bulk_edit_staged_transactions",
      {
        title: "Bulk edit staged transactions",
        description:
          "Atomically edit explicit versioned staged transactions or a previewed all-matching selection. Every row is validated again afterwards, so filling in a missing account or category clears the issues that were blocking a commit. Account and type are refused on transfers, and dryRun validates without writing.",
        inputSchema: bulkStageEditSchema,
        outputSchema: mcpOutputSchema(bulkStageEditMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          input.dryRun
            ? bulkEditStages(actor, input)
            : runIdempotentMcpMutation(
                actor,
                "stage.bulkEdit",
                input.idempotencyKey,
                input,
                (tx) => bulkEditStages(actor, input, tx),
              ),
        ),
    );
    server.registerTool(
      "stage_csv",
      {
        title: "Stage CSV transactions",
        description:
          "Parse CSV text, preview it with dryRun, or place all rows in the staging queue.",
        inputSchema: csvStageInputSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(csvStageResultSchema),
        annotations: additiveAnnotations,
      },
      (input) =>
        runTool(() =>
          input.dryRun
            ? stageCsv(actor, input)
            : runIdempotentMcpMutation(
                actor,
                "csv.stage",
                input.idempotencyKey,
                input,
                (tx) => stageCsv(actor, input, tx),
              ),
        ),
    );
  }

  if (scopes.has("ledger:write")) {
    server.registerTool(
      "create_recurrence",
      {
        title: "Create recurring transaction",
        description:
          "Save a transaction shape and a schedule. On each due date it proposes an ordinary staged row and never a posting. The row keeps its place in the schedule in occurrenceDate, which never moves, while the draft's own date is that occurrence as the weekend and month-length policies leave it; with the default allow policy they are the same day. The amount may be left out for a bill whose amount varies; the row is proposed flagged for somebody to complete. A date, a template and a bank import reference are all refused. Monthly and yearly schedules may name a relative day instead of a day of the month, such as the second Tuesday or the last Friday. Nothing is ever proposed dated before the day the recurrence was created.",
        inputSchema: recurrenceCreateSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(recurrenceResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "recurrence.create",
            idempotencyKey,
            input,
            (tx) => createRecurrence(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_recurrence",
      {
        title: "Update recurring transaction",
        description:
          "Change a recurring transaction's name, shape or schedule. A schedule field left out keeps what is stored, so changing the frequency does not reset the month-length or weekend policy. The day it may propose from is never moved: an edit cannot conjure rows for months already dealt with.",
        inputSchema: z.object({
          id: z.string().uuid(),
          input: recurrenceUpdateSchema,
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
          "Stop a recurring transaction. Rows it has already proposed are left exactly as they are, whether they are still in the queue or already committed, and they go on reporting which recurrence made them.",
        inputSchema: z.object({
          id: z.string().uuid(),
          expectedVersion: z.number().int().positive(),
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(z.object({ id: z.string().uuid() })),
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
          "Cut an MCP client off from this ledger now rather than at token expiry. Its access tokens are deleted, so it stops on its next call, and its refresh token goes with them. The approval is withdrawn too, so it has to be authorized again. Pass your own client id to disconnect yourself. This is the same action as Settings > Connected agents in the browser.",
        inputSchema: z.object({
          clientId: z
            .string()
            .min(1)
            .describe(
              "The client id to cut off, as returned by list_connected_agents.",
            ),
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
        inputSchema: accountCreateSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(accountResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "account.create",
            idempotencyKey,
            input,
            (tx) => createAccount(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_account",
      {
        title: "Update account",
        description: "Update account details using the expected record version.",
        inputSchema: z.object({
          id: z.string().uuid(),
          input: accountUpdateSchema,
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(accountResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "account.update",
            idempotencyKey,
            { id, input },
            (tx) => updateAccount(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "archive_account",
      {
        title: "Archive or restore account",
        description:
          "Retire an account, or bring one back. Archiving posts whatever the account still holds out to the Opening Balances equity account, so it closes at zero and drops out of balances and summaries while its history stays readable. Restoring posts the balance back. This moves money in the books, so confirm it with the person first.",
        inputSchema: z.object({
          id: z.string().uuid(),
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
        description: "Permanently delete an account only when it has no history or staged rows.",
        inputSchema: z.object({
          id: z.string().uuid(),
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
        inputSchema: categoryCreateSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(categoryResultSchema),
        annotations: additiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "category.create",
            idempotencyKey,
            input,
            (tx) => createCategory(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "update_category",
      {
        title: "Update category",
        description: "Update a category using the expected record version.",
        inputSchema: z.object({
          id: z.string().uuid(),
          input: categoryUpdateSchema,
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(categoryResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ id, input, idempotencyKey }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "category.update",
            idempotencyKey,
            { id, input },
            (tx) => updateCategory(actor, id, input, tx),
          ),
        ),
    );
    server.registerTool(
      "archive_category",
      {
        title: "Archive or restore category",
        description: "Archive an in-use category or restore an archived category.",
        inputSchema: z.object({
          id: z.string().uuid(),
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
        title: "Set regional preferences",
        description:
          "Set the timezone or the default currency. What you leave out keeps its current value. The timezone decides what today means everywhere a date is worked out, so changing it changes which day an open-ended range stops at and which day an entry dated \"today\" lands on. Confirm it with the person before changing it; there is no version to check and no undo beyond setting it back.",
        inputSchema: preferencePatchSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(preferencesResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "preferences.set",
            idempotencyKey,
            input,
            (tx) => setPreferences(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "create_transaction_template",
      {
        title: "Create transaction template",
        description:
          "Save a starting point for the transaction form. Every field is optional, including the type: leave one out to make it one the person fills in each time, and an amount is the usual one to omit. A stored date is used when the template is applied and an absent one means the day it is applied. A categoryName is matched against the categories already here, ignoring case, and creates one only if nothing matches. One key is refused rather than ignored: externalId, the reference a bank statement row was imported under, because copied onto every transaction made from this it would make the next real import of that row look like one already seen.",
        inputSchema: transactionTemplateCreateSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
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
          "Rename a template or replace what it remembers, using the expected record version. Sending a draft replaces it whole rather than merging, so a field left out of the new draft is dropped from the template.",
        inputSchema: z.object({
          id: z.string().uuid(),
          input: transactionTemplateUpdateSchema,
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
          "Delete a saved template. Transactions already made from it are untouched, because a template is only a starting point and nothing points back to it.",
        inputSchema: z.object({
          id: z.string().uuid(),
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
          "Atomically change many saved templates at once. Every template is named outright with the version it was read at, so a template that changed underneath is refused rather than overwritten. In the patch a field left out is left alone, a value sets it, and null clears it back to blank so the person fills it in when they use the template. Changing the type drops whichever account side the new type cannot hold. Nothing here posts to the ledger.",
        inputSchema: transactionTemplateBulkEditSchema,
        outputSchema: mcpOutputSchema(transactionTemplateBulkMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          input.dryRun
            ? bulkEditTransactionTemplates(actor, input)
            : runIdempotentMcpMutation(
                actor,
                "transaction_template.bulk_edit",
                input.idempotencyKey,
                input,
                (tx) => bulkEditTransactionTemplates(actor, input, tx),
              ),
        ),
    );
    server.registerTool(
      "bulk_delete_transaction_templates",
      {
        title: "Bulk delete transaction templates",
        description:
          "Atomically delete many saved templates at once, each named with the version it was read at. Transactions already made from them are untouched, because a template is only a starting point and nothing points back to it.",
        inputSchema: transactionTemplateBulkDeleteSchema,
        outputSchema: mcpOutputSchema(transactionTemplateBulkMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          input.dryRun
            ? bulkDeleteTransactionTemplates(actor, input)
            : runIdempotentMcpMutation(
                actor,
                "transaction_template.bulk_delete",
                input.idempotencyKey,
                input,
                (tx) => bulkDeleteTransactionTemplates(actor, input, tx),
              ),
        ),
    );
    server.registerTool(
      "delete_category",
      {
        title: "Delete unused category",
        description: "Permanently delete a category only when it is unused.",
        inputSchema: z.object({
          id: z.string().uuid(),
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
          "Move transaction and staging references into one target category and remove the sources.",
        inputSchema: categoryMergeSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
        outputSchema: mcpOutputSchema(mergedCategoriesResultSchema),
        annotations: destructiveAnnotations,
      },
      ({ idempotencyKey, ...input }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "category.merge",
            idempotencyKey,
            input,
            (tx) => mergeCategories(actor, input, tx),
          ),
      ),
    );
    server.registerTool(
      "merge_payees",
      {
        title: "Merge payees",
        description:
          "Rewrite selected committed and staged payee spellings to one canonical name.",
        inputSchema: payeeMergeSchema,
        outputSchema: mcpOutputSchema(mergedPayeesResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "payee.merge",
            input.idempotencyKey,
            input,
            (tx) => mergePayees(actor, input, tx),
          ),
        ),
    );
    server.registerTool(
      "create_transaction",
      {
        title: "Commit a transaction",
        description: "Directly commit a deposit, withdrawal, or transfer.",
        inputSchema: directTransactionCreateSchema,
        outputSchema: mcpOutputSchema(transactionResultSchema),
        annotations: additiveAnnotations,
      },
      ({ draft, idempotencyKey, allowDuplicate }) =>
        runTool(() =>
          runIdempotentMcpMutation(
            actor,
            "transaction.create",
            idempotencyKey,
            { draft, allowDuplicate },
            (tx) =>
              createTransaction(
                actor,
                draft,
                idempotencyKey,
                allowDuplicate,
                tx,
              ),
          ),
        ),
    );
    server.registerTool(
      "update_transaction",
      {
        title: "Update committed transaction",
        description: "Update a committed transaction and rebuild its postings atomically.",
        inputSchema: z.object({
          id: z.string().uuid(),
          input: transactionUpdateSchema,
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
          "Atomically soft-delete explicit versioned transactions or a previewed all-matching selection. Rows already deleted are left alone, deleted rows stop affecting balances and reports, and dryRun validates without writing.",
        inputSchema: bulkTransactionDeleteSchema,
        outputSchema: mcpOutputSchema(bulkTransactionEditMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          input.dryRun
            ? bulkDeleteTransactions(actor, input)
            : runIdempotentMcpMutation(
                actor,
                "transaction.bulk_delete",
                input.idempotencyKey,
                input,
                (tx) => bulkDeleteTransactions(actor, input, tx),
              ),
        ),
    );
    server.registerTool(
      "bulk_edit_transactions",
      {
        title: "Bulk edit committed transactions",
        description:
          "Atomically edit explicit versioned transactions or a previewed all-matching selection. Transfers only accept common-field edits, account changes must preserve native currency, and dryRun validates without writing.",
        inputSchema: bulkTransactionEditSchema,
        outputSchema: mcpOutputSchema(bulkTransactionEditMcpResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          input.dryRun
            ? bulkEditTransactions(actor, input)
            : runIdempotentMcpMutation(
                actor,
                "transaction.bulk_edit",
                input.idempotencyKey,
                input,
                (tx) => bulkEditTransactions(actor, input, tx),
              ),
        ),
    );
    server.registerTool(
      "set_transaction_deleted",
      {
        title: "Delete or restore transaction",
        description:
          "Soft-delete a committed transaction or restore it. A restore that now conflicts with an active transaction requires allowDuplicate=true.",
        inputSchema: transactionDeletedMutationSchema.extend({
          id: z.string().uuid(),
          idempotencyKey: idempotencyKeySchema,
        }),
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
            (tx) =>
              setTransactionDeleted(
                actor,
                id,
                expectedVersion,
                deleted,
                allowDuplicate,
                tx,
              ),
          ),
        ),
    );
    server.registerTool(
      "commit_staged_transactions",
      {
        title: "Commit staged transactions",
        description:
          "Validate and atomically commit explicit staged transaction IDs; supports dry-run.",
        inputSchema: commitStageSchema,
        outputSchema: mcpOutputSchema(committedStagesResultSchema),
        annotations: destructiveAnnotations,
      },
      (input) =>
        runTool(() =>
          input.dryRun
            ? commitStages(actor, input)
            : runIdempotentMcpMutation(
                actor,
                "stage.commit",
                input.idempotencyKey,
                input,
                (tx) => commitStages(actor, input, tx),
              ),
        ),
    );
  }

  return server;
}

export async function handleMcpRequest(
  request: Request,
  actor: Actor,
  scopes: Set<string>,
) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createMcpServer(actor, scopes);
  await server.connect(transport);
  return transport.handleRequest(request);
}
