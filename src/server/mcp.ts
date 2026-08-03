import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z, ZodError } from "zod";
import type { Actor } from "../shared/domain.js";
import { APP_VERSION } from "../shared/version.js";
import {
  accountCreateSchema,
  accountUpdateSchema,
  bulkDeleteStageSchema,
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
  listQuerySchema,
  payeeListQuerySchema,
  payeeMergeSchema,
  stageCreateSchema,
  stageListQuerySchema,
  stageUpdateSchema,
  transactionDeletedMutationSchema,
  transactionUpdateSchema,
  isoDateSchema,
} from "../shared/domain.js";
import { getDb, type DbTransaction } from "./db/client.js";
import {
  createAccount,
  deleteAccount,
  getAccountBalances,
  listAccounts,
  setAccountArchived,
  updateAccount,
} from "./services/accounts.js";
import { listAuditEvents } from "./services/audit.js";
import {
  createCategory,
  deleteCategory,
  listCategories,
  listDuplicateCategories,
  mergeCategories,
  setCategoryArchived,
  updateCategory,
} from "./services/categories.js";
import {
  listDuplicatePayees,
  listPayees,
  mergePayees,
} from "./services/payees.js";
import { AppError, zodIssues } from "./services/errors.js";
import {
  getIdempotent,
  lockIdempotencyKey,
  setIdempotent,
} from "./services/helpers.js";
import {
  csvStageInputSchema,
  exportTransactionsCsv,
  stageCsv,
} from "./services/import-export.js";
import {
  commitStages,
  createStage,
  deleteStages,
  getStage,
  listStages,
  updateStage,
} from "./services/staging.js";
import {
  listConnectedApps,
  revokeConnectedApp,
} from "./services/connected-apps.js";
import { getSummary } from "./services/summary.js";
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
  bulkTransactionEditMcpResultSchema,
  bulkTransactionSelectionSnapshotResultSchema,
  categoryResultSchema,
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
  summaryResultSchema,
  transactionResultSchema,
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
        description: "List income and expense categories.",
        inputSchema: z.object({ includeArchived: z.boolean().default(false) }),
        outputSchema: mcpOutputSchema(z.array(categoryResultSchema)),
        annotations: readAnnotations,
      },
      (input) => runTool(() => listCategories(actor, input.includeArchived)),
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
        description: "Export filtered committed transactions in the round-trip CSV format.",
        // An export is the whole filtered set, so it advertises no window.
        inputSchema: listQuerySchema.omit({
          cursor: true,
          limit: true,
          page: true,
          sort: true,
          direction: true,
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
