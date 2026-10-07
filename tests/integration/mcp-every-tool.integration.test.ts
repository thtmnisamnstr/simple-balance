import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import {
  categories,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  transactions,
  user,
} from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createBudgetPlan } from "../../src/server/services/budgets.js";
import { createCategory } from "../../src/server/services/categories.js";
import { createRecurrence } from "../../src/server/services/recurrences.js";
import { createStage } from "../../src/server/services/staging.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * Every tool no integration test called by name, called by name.
 *
 * `AGENTS.md` says a tool whose result does not satisfy its declared output
 * schema fails the call with an `Output validation error` naming the offending
 * path, and that a new tool is exercised over a real connection rather than
 * trusted to its schema. Thirty-nine of the seventy-seven never were. The reads
 * among them did answer the sweep in `mcp-tools.integration.test.ts`, but over a
 * ledger with nothing in most lists, and an empty array satisfies every item
 * schema there is. So each is called here against rows that make its answer
 * non-trivial: a duplicate category and payee, a staged row repeating a
 * committed one, a budget that rolls over beside a one-period override, a
 * recurrence for the forecast to project, and an agent to revoke.
 *
 * Two checks stand behind every call. The server validates against the Zod
 * schema and turns a mismatch into an error result. The client validates
 * against the published JSON Schema — which is what an agent's SDK actually
 * holds, and where a closed object refuses a key the Zod schema would quietly
 * strip — but only for tools it has listed, so `beforeAll` lists them first.
 */
const TOOLS_UNDER_TEST = [
  "list_accounts",
  "get_account_balances",
  "list_categories",
  "list_duplicate_categories",
  "list_duplicate_payees",
  "list_transactions",
  "get_transaction",
  "preview_bulk_staged_selection",
  "list_staged_transactions",
  "get_staged_transaction",
  "get_financial_summary",
  "get_staged_duplicate",
  "get_account_register",
  "export_transactions_csv",
  "list_audit_events",
  "list_category_groups",
  "list_budget_plans",
  "get_budget_plan",
  "list_budget_entries",
  "get_forecast",
  "get_budget_report",
  "update_staged_transaction",
  "bulk_edit_staged_transactions",
  "create_category_group",
  "update_category_group",
  "delete_category_group",
  "update_budget_plan",
  "delete_budget_plan",
  "set_budget_entry",
  "delete_budget_entry",
  "revoke_connected_agent",
  "archive_account",
  "set_active_accounts",
  "delete_account",
  "update_category",
  "archive_category",
  "delete_category",
  "merge_categories",
  "set_transaction_deleted",
] as const;

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("mcp_every_tool");
const actor: Actor = { userId: "mcp-every-tool", source: "mcp", clientId: "every-tool" };
const otherAgent = "every-tool-other-agent";

let client: Client;
let server: ReturnType<typeof createMcpServer>;
const called = new Set<string>();

let checkingId = "";
let savingsId = "";
let spareId = "";
let groceriesId = "";
let diningId = "";
let rentId = "";
let unusedId = "";
let duplicateGroceriesId = "";
let groceriesTransactionId = "";
let voidableTransactionId = "";
let repeatStageId = "";
let hardwareStageId = "";
let groceriesPlanId = "";
let diningPlanId = "";

type Versioned = { id: string; version: number };

/**
 * One call, held to the three things a broken output schema would disturb.
 *
 * A throw is rethrown with the tool's name on it, because the client's own
 * schema check throws rather than returning, and its message names the path
 * but not the tool.
 */
async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  called.add(name);
  let out: Awaited<ReturnType<Client["callTool"]>>;
  try {
    out = await client.callTool({ name, arguments: args });
  } catch (error) {
    throw new Error(`${name} threw: ${String(error)}`, { cause: error });
  }
  const whole = JSON.stringify(out);
  expect(whole, name).not.toContain("Output validation error");
  expect(out.isError, `${name}: ${whole}`).toBeFalsy();
  expect(out.structuredContent, `${name} returned no structured content`).toBeDefined();
  return (out.structuredContent as { result: T }).result;
}

const versionOf = async (tool: "get_category" | "get_account", id: string) =>
  (await call<Versioned>(tool, { id })).version;

integration("every tool no other integration test calls, over a real connection", () => {
  beforeAll(async () => {
    await database.create();
    const db = getDb();
    await db.insert(user).values({
      id: actor.userId,
      name: "Every Tool",
      email: "every-tool@example.com",
      emailVerified: true,
    });

    const open = async (name: string, type: "checking" | "savings", openingBalance: string) =>
      (
        await createAccount(actor, {
          name,
          type,
          currency: "USD",
          openingDate: "2026-01-01",
          openingBalance,
        })
      ).id;
    checkingId = await open("Checking", "checking", "1000");
    savingsId = await open("Savings", "savings", "500");
    // Never holds an entry, so `delete_account` has something it may delete.
    spareId = await open("Spare", "checking", "0");

    const category = async (name: string, kind: "income" | "expense") =>
      (await createCategory(actor, { name, kind })).id;
    groceriesId = await category("Groceries", "expense");
    const salaryId = await category("Salary", "income");
    diningId = await category("Dining", "expense");
    rentId = await category("Rent", "expense");
    unusedId = await category("Unused", "expense");
    // Inserted beneath the service, which refuses a second spelling of a name
    // it already holds: this is the row a ledger from before that check has.
    [{ id: duplicateGroceriesId }] = await db
      .insert(categories)
      .values({ userId: actor.userId, name: "  GROCERIES ", kind: "expense" })
      .returning({ id: categories.id });

    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2026-01-31",
        payee: "Employer",
        toAccountId: checkingId,
        amount: "3000.00",
        description: null,
        categoryId: salaryId,
      },
      "seed-salary",
    );
    groceriesTransactionId = (
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-02-10",
          payee: "Corner Market",
          fromAccountId: checkingId,
          amount: "42.50",
          description: null,
          categoryId: groceriesId,
        },
        "seed-groceries",
      )
    ).id;
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-14",
        payee: "Bistro",
        fromAccountId: checkingId,
        amount: "60.00",
        description: null,
        categoryId: diningId,
      },
      "seed-dining",
    );
    // A write canonicalizes a payee to the spelling already in use, so the
    // colliding spelling is put there directly, as an older ledger would hold it.
    const respelled = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-21",
        payee: "Placeholder",
        fromAccountId: checkingId,
        amount: "35.00",
        description: null,
        categoryId: diningId,
      },
      "seed-dining-again",
    );
    await db
      .update(transactions)
      .set({ payee: "  bistro " })
      .where(eq(transactions.id, respelled.id));
    voidableTransactionId = (
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-01",
          payee: "Hardware Depot",
          fromAccountId: checkingId,
          amount: "18.00",
          description: null,
          categoryId: groceriesId,
        },
        "seed-voidable",
      )
    ).id;

    // The same purchase as the committed groceries entry, which is what gives
    // `get_staged_duplicate` a second side to return rather than null.
    repeatStageId = (
      await createStage(actor, {
        draft: {
          type: "withdrawal",
          date: "2026-02-10",
          payee: "Corner Market",
          fromAccountId: checkingId,
          amount: "42.50",
          categoryId: groceriesId,
        },
        idempotencyKey: "seed-stage-repeat",
      })
    ).id;
    hardwareStageId = (
      await createStage(actor, {
        draft: {
          type: "withdrawal",
          date: "2026-03-05",
          payee: "Hardware Store",
          fromAccountId: checkingId,
          amount: "25.00",
          categoryId: groceriesId,
        },
        idempotencyKey: "seed-stage-hardware",
      })
    ).id;

    await createRecurrence(actor, {
      name: "Rent",
      shape: {
        type: "withdrawal",
        payee: "Landlord",
        fromAccountId: checkingId,
        categoryId: rentId,
        amount: "1200.00",
      },
      schedule: { frequency: "monthly", anchorDate: "2026-01-15" },
    });
    // Rolling over, so the report carries its carry fields and `rollover`
    // rather than leaving them null.
    groceriesPlanId = (
      await createBudgetPlan(actor, {
        categoryId: groceriesId,
        amount: "400.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2026-01-01",
        rollover: true,
      })
    ).id;
    diningPlanId = (
      await createBudgetPlan(actor, {
        categoryId: diningId,
        amount: "150.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2026-01-01",
      })
    ).id;

    // Another agent's standing grant, the shape Better Auth's consent flow
    // leaves behind, so revoking it does not cut off the connection doing it.
    await db.insert(oauthApplication).values({
      id: `app-${otherAgent}`,
      name: "Other Agent",
      clientId: otherAgent,
      redirectUrls: "http://127.0.0.1:7777/callback",
      type: "web",
    });
    await db.insert(oauthConsent).values({
      id: `consent-${otherAgent}`,
      clientId: otherAgent,
      userId: actor.userId,
      scopes: "openid ledger:read",
      consentGiven: true,
    });
    await db.insert(oauthAccessToken).values({
      id: `token-${otherAgent}`,
      accessToken: `access-${otherAgent}`,
      refreshToken: `refresh-${otherAgent}`,
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      clientId: otherAgent,
      userId: actor.userId,
      scopes: "openid ledger:read",
    });

    server = createMcpServer(actor, new Set(["ledger:read", "ledger:stage", "ledger:write"]));
    client = new Client({ name: "every-tool", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    // Without this the client has no published schema to hold a reply to.
    await client.listTools();
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await database.drop();
  });

  it("answers every read over the ledger with the schema it declares", async () => {
    const accounts = await call<{ id: string }[]>("list_accounts", { includeArchived: true });
    expect(accounts).toHaveLength(3);
    expect(
      await call("get_account_balances", {
        id: checkingId,
        start: "2026-01-01",
        end: "2026-03-31",
      }),
    ).toMatchObject({ accountId: checkingId, currency: "USD" });
    expect(await call<unknown[]>("list_categories", { includeArchived: true })).toHaveLength(6);

    const duplicateCategories = await call<{ normalizedName: string; count: number }[]>(
      "list_duplicate_categories",
    );
    expect(duplicateCategories).toEqual([
      expect.objectContaining({ normalizedName: "groceries", count: 2 }),
    ]);
    const duplicatePayees =
      await call<{ normalizedName: string; count: number }[]>("list_duplicate_payees");
    expect(duplicatePayees).toEqual([
      expect.objectContaining({ normalizedName: "bistro", count: 2 }),
    ]);

    const page = await call<{ items: unknown[] }>("list_transactions", { limit: 200 });
    expect(page.items).toHaveLength(5);
    expect(await call("get_transaction", { id: groceriesTransactionId })).toMatchObject({
      payee: "Corner Market",
    });
    expect(
      await call("get_financial_summary", { start: "2026-01-01", includeArchived: true }),
    ).toHaveProperty("asOf");
    expect(
      await call<{ items: unknown[] }>("get_account_register", {
        id: checkingId,
        start: "2026-01-01",
      }),
    ).toHaveProperty("closingBalance");
    const exported = await call<{ csv: string; rowCount: number }>("export_transactions_csv", {
      start: "2026-01-01",
    });
    expect(exported.rowCount).toBe(5);
    const audit = await call<{ items: unknown[] }>("list_audit_events", { limit: 200 });
    expect(audit.items.length).toBeGreaterThan(0);
  });

  it("answers every read over the staging queue with the schema it declares", async () => {
    const preview = await call<{ count: number; duplicateCount: number }>(
      "preview_bulk_staged_selection",
      { filter: {} },
    );
    expect(preview).toMatchObject({ count: 2, duplicateCount: 1 });
    const queue = await call<{ items: unknown[] }>("list_staged_transactions", { limit: 200 });
    expect(queue.items).toHaveLength(2);
    expect(await call("get_staged_transaction", { id: hardwareStageId })).toMatchObject({
      id: hardwareStageId,
    });
    expect(await call("get_staged_duplicate", { id: repeatStageId })).toMatchObject({
      first: { kind: "staged" },
      second: { kind: "committed", committed: { id: groceriesTransactionId } },
    });
  });

  it("edits staged rows one at a time and as a previewed selection", async () => {
    const before = await call<Versioned & { draft: Record<string, unknown> }>(
      "get_staged_transaction",
      { id: hardwareStageId },
    );
    // Sent whole, because an update writes the draft it is given rather than
    // patching the stored one. The category is kept: with ledger:write, moving
    // the last row off one removes it, and this is not the test for that.
    const updated = await call<Versioned & { draft: Record<string, unknown> }>(
      "update_staged_transaction",
      {
        id: hardwareStageId,
        input: {
          expectedVersion: before.version,
          draft: { ...before.draft, payee: "Hardware Store Downtown", notes: "Receipt in drawer" },
        },
        idempotencyKey: "every-tool-stage-update",
      },
    );
    expect(updated.draft).toMatchObject({ payee: "Hardware Store Downtown" });

    // Filter mode, so the count and fingerprint the preview hands back are the
    // ones the write is checked against.
    const preview = await call<{ count: number; fingerprint: string }>(
      "preview_bulk_staged_selection",
      { filter: {} },
    );
    const edited = await call<{ dryRun: boolean; updatedCount: number }>(
      "bulk_edit_staged_transactions",
      {
        selection: {
          mode: "filter",
          filter: {},
          expectedCount: preview.count,
          expectedFingerprint: preview.fingerprint,
        },
        patch: { notes: "Reviewed in bulk" },
        idempotencyKey: "every-tool-stage-bulk",
      },
    );
    expect(edited).toMatchObject({ dryRun: false, updatedCount: 2 });
  });

  it("runs groups and budgets through every tool that changes or reads them", async () => {
    const group = await call<Versioned & { name: string }>("create_category_group", {
      name: "Everyday",
      policy: "standalone",
      idempotencyKey: "every-tool-group-create",
    });
    expect(group.name).toBe("Everyday");
    expect(
      await call("update_category", {
        id: groceriesId,
        input: { groupId: group.id, expectedVersion: await versionOf("get_category", groceriesId) },
        idempotencyKey: "every-tool-category-group",
      }),
    ).toMatchObject({ groupId: group.id });
    const renamed = await call<Versioned & { name: string }>("update_category_group", {
      id: group.id,
      name: "Day to day",
      expectedVersion: group.version,
      idempotencyKey: "every-tool-group-rename",
    });
    expect(renamed.name).toBe("Day to day");
    expect(await call("list_category_groups")).toEqual([
      expect.objectContaining({ id: group.id, name: "Day to day" }),
    ]);

    expect(await call<unknown[]>("list_budget_plans")).toHaveLength(2);
    const dining = await call<Versioned>("get_budget_plan", { id: diningPlanId });
    const raised = await call<Versioned & { amount: string }>("update_budget_plan", {
      id: diningPlanId,
      amount: "175.00",
      expectedVersion: dining.version,
      idempotencyKey: "every-tool-plan-update",
    });
    expect(raised.amount).toBe("175");

    const entry = await call<Versioned & { amount: string }>("set_budget_entry", {
      categoryId: groceriesId,
      currency: "USD",
      periodUnit: "month",
      periodStart: "2026-02-01",
      amount: "500.00",
      idempotencyKey: "every-tool-entry-set",
    });
    expect(await call("list_budget_entries")).toEqual([expect.objectContaining({ id: entry.id })]);

    const report = await call<{ periods: unknown[]; rollover: unknown }>("get_budget_report", {
      start: "2026-01-01",
      end: "2026-03-31",
      periodUnit: "month",
    });
    expect(report.periods.length).toBeGreaterThanOrEqual(3);
    expect(report.rollover).not.toBeNull();
    // Each basis is a different shape of reply, and a single call would hold
    // only one of them to the schema.
    for (const basis of ["recurring", "recurring_and_budgets", "recurring_and_history"]) {
      expect(await call("get_forecast", { basis, periods: 3 }), basis).toMatchObject({ basis });
    }

    expect(
      await call("delete_budget_entry", {
        id: entry.id,
        expectedVersion: entry.version,
        idempotencyKey: "every-tool-entry-delete",
      }),
    ).toEqual({ id: entry.id });
    expect(
      await call("delete_budget_plan", {
        id: diningPlanId,
        expectedVersion: raised.version,
        idempotencyKey: "every-tool-plan-delete",
      }),
    ).toEqual({ id: diningPlanId });
    expect(
      await call("delete_category_group", {
        id: group.id,
        expectedVersion: renamed.version,
        idempotencyKey: "every-tool-group-delete",
      }),
    ).toEqual({ id: group.id });
    expect(await call<unknown[]>("list_budget_plans")).toEqual([
      expect.objectContaining({ id: groceriesPlanId }),
    ]);
  });

  it("archives, restores, keeps active and deletes accounts", async () => {
    const archived = await call<Versioned & { archivedAt: string | null }>("archive_account", {
      id: savingsId,
      expectedVersion: await versionOf("get_account", savingsId),
      archived: true,
      idempotencyKey: "every-tool-account-archive",
    });
    expect(archived.archivedAt).not.toBeNull();
    const restored = await call<Versioned & { archivedAt: string | null }>("archive_account", {
      id: savingsId,
      expectedVersion: archived.version,
      archived: false,
      idempotencyKey: "every-tool-account-restore",
    });
    expect(restored.archivedAt).toBeNull();

    // Nothing is frozen where no plan is sold, so the one set it accepts is
    // the one already active, which is exactly what makes it safe to resend.
    const accounts =
      await call<{ id: string; active: boolean; archivedAt: string | null }[]>("list_accounts");
    const active = accounts.filter((account) => account.active && account.archivedAt === null);
    expect(active.length).toBeGreaterThan(0);
    const kept = await call<{ id: string }[]>("set_active_accounts", {
      accountIds: active.map((account) => account.id),
    });
    expect(new Set(kept.map((account) => account.id))).toEqual(
      new Set(active.map((account) => account.id)),
    );

    expect(
      await call("delete_account", {
        id: spareId,
        expectedVersion: await versionOf("get_account", spareId),
        idempotencyKey: "every-tool-account-delete",
      }),
    ).toEqual({ id: spareId, deleted: true });
  });

  it("archives, merges and deletes categories", async () => {
    // In use by a committed entry and by nothing waiting in the queue, which is
    // the one state archiving accepts without complaint.
    expect(
      await call("archive_category", {
        id: diningId,
        expectedVersion: await versionOf("get_category", diningId),
        archived: true,
        idempotencyKey: "every-tool-category-archive",
      }),
    ).toMatchObject({ id: diningId, archivedAt: expect.any(String) });

    const merged = await call<{
      targetCategory: { id: string };
      mergedSourceCategoryIds: string[];
    }>("merge_categories", {
      sourceCategoryIds: [duplicateGroceriesId],
      targetCategoryId: groceriesId,
      expectedVersions: {
        [duplicateGroceriesId]: await versionOf("get_category", duplicateGroceriesId),
      },
      targetExpectedVersion: await versionOf("get_category", groceriesId),
      idempotencyKey: "every-tool-category-merge",
    });
    expect(merged.targetCategory.id).toBe(groceriesId);
    expect(merged.mergedSourceCategoryIds).toEqual([duplicateGroceriesId]);

    expect(
      await call("delete_category", {
        id: unusedId,
        expectedVersion: await versionOf("get_category", unusedId),
        idempotencyKey: "every-tool-category-delete",
      }),
    ).toEqual({ id: unusedId, deleted: true });
  });

  it("deletes a transaction and restores it", async () => {
    const before = await call<Versioned>("get_transaction", { id: voidableTransactionId });
    const voided = await call<Versioned & { deletedAt: string | null }>("set_transaction_deleted", {
      id: voidableTransactionId,
      expectedVersion: before.version,
      deleted: true,
      idempotencyKey: "every-tool-transaction-delete",
    });
    expect(voided.deletedAt).not.toBeNull();
    const restored = await call<Versioned & { deletedAt: string | null }>(
      "set_transaction_deleted",
      {
        id: voidableTransactionId,
        expectedVersion: voided.version,
        deleted: false,
        idempotencyKey: "every-tool-transaction-restore",
      },
    );
    expect(restored.deletedAt).toBeNull();
  });

  it("revokes another agent's access", async () => {
    expect(
      await call("revoke_connected_agent", {
        clientId: otherAgent,
        idempotencyKey: "every-tool-revoke",
      }),
    ).toEqual({ clientId: otherAgent, name: "Other Agent", revokedTokenCount: 1 });
  });

  // Last, so a tool dropped from a test above fails here by name rather than
  // going quietly back to never being called.
  it("called every tool on the list", () => {
    expect(TOOLS_UNDER_TEST.filter((name) => !called.has(name))).toEqual([]);
  });
});
