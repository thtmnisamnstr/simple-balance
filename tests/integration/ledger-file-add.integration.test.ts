import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import {
  defaultLedgerFileKinds,
  ledgerFileRecordCount,
  parseLedgerFileText,
  serializeLedgerFile,
  splitLedgerFile,
  type LedgerFile,
} from "../../src/shared/ledger-file.js";
import {
  ledgerBudgetKey,
  ledgerReferenceOpeningDate,
  mergeLedgerFileFacts,
  planLedgerFileAdd,
  type LedgerFileAddResult,
  type LedgerFileDecision,
  type LedgerFilePreview,
} from "../../src/shared/ledger-file-import.js";
import { addDays, todayIn } from "../../src/shared/recurrence-dates.js";
import { LEDGER_FILE_HISTORY_MAX_BYTES } from "../../src/server/config-limits.js";
import { getDb } from "../../src/server/db/client.js";
import {
  auditEvents,
  budgetEntries,
  categories,
  importBatches,
  ledgerAccounts,
  recurrences,
  stagedTransactions,
  templateNotifications,
  transactionTemplates,
  transactions,
  user,
  userPreferences,
} from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import {
  createAccount,
  setAccountArchived,
  updateAccount,
} from "../../src/server/services/accounts.js";
import { createBudgetPlan, setBudgetEntry } from "../../src/server/services/budgets.js";
import {
  createCategory,
  setCategoryArchived,
  updateCategory,
} from "../../src/server/services/categories.js";
import { createCategoryGroup } from "../../src/server/services/category-groups.js";
import { AppError } from "../../src/server/services/errors.js";
import { canonicalDecimal } from "../../src/server/services/helpers.js";
import {
  addLedgerFile,
  exportLedgerFile,
  previewLedgerFile,
} from "../../src/server/services/ledger-file.js";
import { runDueNotifications } from "../../src/server/services/notifications.js";
import { getPreferences, setPreferences } from "../../src/server/services/preferences.js";
import { createRecurrence, runDueRecurrences } from "../../src/server/services/recurrences.js";
import {
  commitStages,
  createStage,
  deleteStages,
  listStages,
} from "../../src/server/services/staging.js";
import { createTransactionTemplate } from "../../src/server/services/transaction-templates.js";
import {
  createTransaction,
  getTransaction,
  listTransactions,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * Adding a Simple Balance file to a ledger, against a real database and the
 * real exporter: a source ledger with every kind of record in it is exported,
 * and the file is previewed and added into an empty ledger, into one that
 * already holds records of the same names, part by part, twice, and back into
 * the ledger it came from.
 *
 * What the owner decided is asserted by outcome. Records that are not
 * transactions are created at once and a record already here is decided by the
 * person; entries stage, complete, carrying their origin, and an origin already
 * here is skipped rather than flagged; the books the entries make, once
 * committed, are the books they came from.
 */

const sent: { about?: string }[] = [];
vi.mock("../../src/server/mail.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/mail.js")>();
  return {
    ...real,
    mailEnabled: () => true,
    sendMail: async (message: { about?: string }) => {
      sent.push(message);
      return true;
    },
  };
});

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ledger_file_add");
const TIMEZONE = "Europe/Berlin";
const LIMITS = { maxRows: 100_000, maxHistoryBytes: LEDGER_FILE_HISTORY_MAX_BYTES };

const person = (id: string): Actor => ({ userId: `lf-add-${id}`, source: "web" });
const source = person("source");
const stranger = person("stranger");

const everything = { kinds: defaultLedgerFileKinds.filter((kind) => kind !== "history") };
let wholeFile = "";
let parsedWhole: LedgerFile;
let liveOrigins: string[] = [];
let stagedOrigins: string[] = [];
const ids: Record<string, string> = {};
let strangerAccountId = "";

async function seedUser(actor: Actor) {
  await getDb()
    .insert(user)
    .values({ id: actor.userId, name: actor.userId, email: `${actor.userId}@example.com` });
}

async function exportOf(actor: Actor, selection: unknown = everything) {
  return (await exportLedgerFile(actor, selection, LIMITS)).ledgerFile;
}

function read(text: string): LedgerFile {
  const parsed = parseLedgerFileText(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.file;
}

const add = (
  actor: Actor,
  ledgerFile: string,
  extra: Record<string, unknown> = {},
): Promise<LedgerFileAddResult> =>
  addLedgerFile(actor, {
    ledgerFile,
    fileName: "simple-balance.json",
    idempotencyKey: randomUUID(),
    ...extra,
  });

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("it was not refused");
}

const record = (preview: { plan: LedgerFilePreview["plan"] }, kind: string, key: string) => {
  const found = preview.plan.records.find((each) => each.kind === kind && each.key === key);
  if (!found) throw new Error(`no ${kind} ${key}`);
  return found;
};

async function waiting(actor: Actor) {
  return getDb()
    .select()
    .from(stagedTransactions)
    .where(
      and(eq(stagedTransactions.userId, actor.userId), eq(stagedTransactions.status, "staged")),
    );
}

async function accountsOf(actor: Actor) {
  const rows = await getDb()
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, actor.userId), isNull(ledgerAccounts.systemKind)));
  return new Map(rows.map((row) => [row.name, row]));
}

/** Every posting an account holds, on every day, summed here rather than by a service. */
async function held(actor: Actor, accountId: string) {
  const result = await getDb().execute(sql`
    select coalesce(sum(amount), 0)::text as total from posting
     where user_id = ${actor.userId} and account_id = ${accountId}::uuid
  `);
  return canonicalDecimal(String((result.rows[0] as { total: string }).total));
}

/** A count of everything a person owns, so a refused add can be shown to have written nothing. */
async function footprint(actor: Actor) {
  const result = await getDb().execute(sql`
    select
      (select count(*) from ledger_account where user_id = ${actor.userId})::int as accounts,
      (select count(*) from category where user_id = ${actor.userId})::int as categories,
      (select count(*) from category_group where user_id = ${actor.userId})::int as groups,
      (select count(*) from transaction_template where user_id = ${actor.userId})::int as templates,
      (select count(*) from recurrence where user_id = ${actor.userId})::int as recurrences,
      (select count(*) from budget_plan where user_id = ${actor.userId})::int as plans,
      (select count(*) from budget_entry where user_id = ${actor.userId})::int as amounts,
      (select count(*) from staged_transaction where user_id = ${actor.userId})::int as staged,
      (select count(*) from import_batch where user_id = ${actor.userId})::int as batches,
      (select count(*) from posting where user_id = ${actor.userId})::int as postings,
      (select count(*) from audit_event where user_id = ${actor.userId})::int as audit,
      (select count(*) from user_preferences where user_id = ${actor.userId})::int as settings
  `);
  return result.rows[0];
}

/** Commit every waiting row whose origin is one of these, in one call. */
async function commitOrigins(actor: Actor, origins: readonly string[]) {
  const rows = (await waiting(actor)).filter(
    (row) => row.importOrigin !== null && origins.includes(row.importOrigin),
  );
  return commitStages(actor, {
    stagedIds: rows.map((row) => row.id),
    expectedVersions: Object.fromEntries(rows.map((row) => [row.id, row.version])),
    idempotencyKey: randomUUID(),
  });
}

/** An agent's connection over the real MCP protocol, in memory. */
async function connectAgent(actor: Actor, scopes: string[]) {
  const server = createMcpServer(
    { ...actor, source: "mcp", clientId: "ledger-file-agent" },
    new Set(scopes),
  );
  const client = new Client({ name: "ledger-file", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

integration("adding a Simple Balance file to a ledger", () => {
  beforeAll(async () => {
    await database.create();
    const db = getDb();
    for (const id of [
      "source",
      "stranger",
      "empty",
      "overlap",
      "accounts",
      "parts",
      "settings-chosen",
      "settings-file",
      "replay",
      "commit-race",
      "agent",
      "scoped",
      "origin-a",
      "origin-b",
      "two-files",
      "filed-source",
      "filed-dest",
      "records-cap",
      "parts-ref",
      "budget-parts",
      "views",
    ]) {
      await seedUser(person(id));
    }
    await setPreferences(source, { timezone: TIMEZONE, defaultCurrency: "EUR", theme: "dark" });

    const open = async (name: string, fields: Record<string, unknown> = {}) =>
      (
        await createAccount(source, {
          name,
          type: "checking",
          currency: "EUR",
          openingDate: "2025-01-01",
          openingBalance: "1000",
          ...fields,
        })
      ).id;
    ids.checking = await open("Checking", { institution: "Sparkasse", notes: "Main" });
    ids.savings = await open("Savings", { type: "savings", openingBalance: "500" });
    ids.brokerage = await open("Brokerage", {
      type: "investment",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
      inBudget: false,
    });
    ids.card = await open("Old card", { type: "credit_card", openingBalance: "-100" });

    const home = await createCategoryGroup(source, { name: "Home", policy: "standalone" });
    ids.groceries = (
      await createCategory(source, { name: "Groceries", kind: "expense", groupId: home.id })
    ).id;
    ids.household = (
      await createCategory(source, { name: "Household", kind: "expense", groupId: home.id })
    ).id;
    ids.salary = (await createCategory(source, { name: "Salary", kind: "income" })).id;
    const market = await createCategory(source, { name: "Market", kind: "expense" });
    const hobby = await createCategory(source, { name: "Old hobby", kind: "expense" });

    const coffee = await createTransactionTemplate(source, {
      name: "Coffee",
      draft: {
        type: "withdrawal",
        payee: "Kiosk",
        fromAccountId: ids.checking,
        categoryId: ids.groceries,
        amount: "3.50",
      },
      notification: { anchorDate: "2026-03-01", time: "08:30" },
    });
    ids.coffee = coffee.id;
    await createTransactionTemplate(source, {
      name: "Rent",
      draft: { type: "withdrawal", fromAccountId: ids.savings, categoryName: "Housing" },
      notification: {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-01-01",
        position: { ordinal: 1, weekday: 1 },
        time: "07:00",
      },
    });
    // The one-time reminder already went out, which is the watermark a file
    // carries so the copy it moves to does not send it again.
    await db
      .update(templateNotifications)
      .set({ lastNotifiedDate: "2026-03-01", nextNotificationDate: null })
      .where(eq(templateNotifications.templateId, coffee.id));

    const entry = async (key: string, draft: Record<string, unknown>) =>
      (await createTransaction(source, draft as never, `source-${key}`, true)).id;
    await entry("salary", {
      type: "deposit",
      date: "2026-01-31",
      payee: "Employer",
      toAccountId: ids.checking,
      amount: "3000.00",
      categoryId: ids.salary,
    });
    await entry("groceries", {
      type: "withdrawal",
      date: "2026-02-02",
      payee: "Rewe",
      fromAccountId: ids.checking,
      amount: "54.23",
      categoryId: ids.groceries,
      description: "Weekly shop",
      notes: "Receipt in the drawer",
      externalId: "BANK-77",
    });
    await entry("split", {
      type: "withdrawal",
      date: "2026-02-04",
      payee: "Market hall",
      fromAccountId: ids.checking,
      amount: "80.00",
      legs: [
        { categoryId: ids.groceries, amount: "60.00" },
        { categoryId: ids.household, amount: "15.00", note: "bulbs" },
        { categoryId: null, amount: "5.00" },
      ],
    });
    ids.transfer = await entry("transfer", {
      type: "transfer",
      date: "2026-02-10",
      payee: "To savings",
      fromAccountId: ids.checking,
      toAccountId: ids.savings,
      sourceAmount: "200.00",
    });
    ids.conversion = await entry("conversion", {
      type: "transfer",
      date: "2026-02-12",
      payee: "Broker",
      fromAccountId: ids.checking,
      toAccountId: ids.brokerage,
      sourceAmount: "1000.00",
      destinationAmount: "1081.40",
    });
    await entry("refund", {
      type: "deposit",
      date: "2026-02-15",
      payee: "Market hall",
      toAccountId: ids.checking,
      amount: "12.99",
      categoryId: market.id,
    });
    await updateCategory(source, market.id, { kind: "both", expectedVersion: market.version });
    // Two coffees on one morning: two entries the ledger committed separately,
    // alike in every field the duplicate check reads.
    ids.coffeeOne = await entry("coffee-one", {
      type: "withdrawal",
      date: "2026-02-21",
      payee: "Kiosk",
      fromAccountId: ids.checking,
      amount: "3.50",
      categoryId: ids.groceries,
      templateId: coffee.id,
    });
    ids.coffeeTwo = await entry("coffee-two", {
      type: "withdrawal",
      date: "2026-02-21",
      payee: "Kiosk",
      fromAccountId: ids.checking,
      amount: "3.50",
      categoryId: ids.groceries,
      templateId: coffee.id,
    });
    await entry("card", {
      type: "withdrawal",
      date: "2026-01-15",
      payee: "Hobby shop",
      fromAccountId: ids.card,
      amount: "20.00",
      categoryId: hobby.id,
    });
    const card = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, ids.card));
    await setAccountArchived(source, ids.card, card[0]!.version, true);
    await setCategoryArchived(source, hobby.id, hobby.version, true);
    ids.voided = await entry("voided", {
      type: "withdrawal",
      date: "2026-02-20",
      payee: "Kiosk",
      fromAccountId: ids.checking,
      amount: "4.00",
      categoryId: ids.groceries,
    });
    await setTransactionDeleted(source, ids.voided, 1, true);
    // Edited once, so its postings are a delta on a delta and the file still
    // carries one entry.
    ids.edited = await entry("edited", {
      type: "withdrawal",
      date: "2026-02-25",
      payee: "Hardware store",
      fromAccountId: ids.checking,
      amount: "30.00",
      categoryId: ids.household,
    });
    await updateTransaction(source, ids.edited, {
      draft: {
        type: "withdrawal",
        date: "2026-02-26",
        payee: "Hardware store",
        fromAccountId: ids.checking,
        amount: "33.00",
        categoryId: ids.household,
      },
      expectedVersion: 1,
    });
    await entry("future", {
      type: "withdrawal",
      date: "2099-01-01",
      payee: "Someday",
      fromAccountId: ids.checking,
      amount: "1.00",
    });

    await createRecurrence(source, {
      name: "Pay",
      shape: {
        type: "deposit",
        toAccountId: ids.checking,
        amount: "3000.00",
        payee: "Employer",
        categoryId: ids.salary,
      },
      schedule: { frequency: "monthly", anchorDate: "2026-01-31", weekendPolicy: "allow" },
    });
    await createRecurrence(source, {
      name: "Sweep",
      shape: {
        type: "transfer",
        fromAccountId: ids.checking,
        toAccountId: ids.savings,
        amount: "100.00",
        payee: "To savings",
      },
      schedule: {
        frequency: "monthly",
        anchorDate: "2026-01-01",
        position: { ordinal: 2, weekday: 2 },
      },
      notifyOnCreate: true,
    });
    // A weekly one that fell due today and was proposed today, where the
    // file came from: arriving today must not propose today again.
    const today = todayIn(TIMEZONE);
    await createRecurrence(source, {
      name: "Market day",
      shape: {
        type: "withdrawal",
        fromAccountId: ids.checking,
        amount: "25.00",
        payee: "Farmers market",
        categoryId: ids.groceries,
      },
      schedule: { frequency: "weekly", anchorDate: today },
    });
    await db
      .update(recurrences)
      .set({ lastOccurrenceDate: "2026-09-30" })
      .where(and(eq(recurrences.name, "Pay"), eq(recurrences.userId, source.userId)));
    await db
      .update(recurrences)
      .set({ lastOccurrenceDate: today, nextOccurrenceDate: addDays(today, 7) })
      .where(and(eq(recurrences.name, "Market day"), eq(recurrences.userId, source.userId)));

    await createBudgetPlan(source, {
      categoryId: ids.groceries,
      currency: "EUR",
      periodUnit: "month",
      amount: "400.00",
      activeFrom: "2026-01-01",
      rollover: true,
      rolloverCap: "200",
    });
    await createBudgetPlan(source, {
      groupId: home.id,
      currency: "EUR",
      periodUnit: "month",
      amount: "1500.00",
      activeFrom: "2026-01-01",
      lookbackPeriods: 3,
    });
    for (const [periodStart, amount] of [
      ["2026-03-01", "550.00"],
      ["2026-04-01", "420.00"],
    ] as const) {
      await setBudgetEntry(source, {
        categoryId: ids.groceries,
        currency: "EUR",
        periodUnit: "month",
        periodStart,
        amount,
      });
    }

    await createStage(source, {
      idempotencyKey: "source-staged-bakery",
      draft: {
        type: "withdrawal",
        date: "2026-10-20",
        payee: "Bäckerei Müller",
        fromAccountId: ids.checking,
        amount: "12.50",
        categoryName: "Bakery",
        categoryKind: "expense",
      },
      rawData: { Datum: "20.10.2026", Betrag: "-12,50 €" },
    });
    await createStage(source, {
      idempotencyKey: "source-staged-partial",
      draft: {
        type: "transfer",
        sourceAmount: "50.00",
        payee: "To savings",
        toAccountId: ids.savings,
      },
    });

    // A stranger with an account of the same name, the same currency and the
    // same opening, so a match across people would have every reason to be
    // made — and an entry, so an origin lookup across people could find one.
    strangerAccountId = (
      await createAccount(stranger, {
        name: "Checking",
        type: "checking",
        currency: "EUR",
        openingDate: "2025-01-01",
        openingBalance: "1000",
        institution: "Sparkasse",
        notes: "Main",
      })
    ).id;
    await createTransaction(
      stranger,
      {
        type: "withdrawal",
        date: "2026-02-03",
        payee: "Not yours",
        fromAccountId: strangerAccountId,
        amount: "1.00",
      } as never,
      "stranger-entry",
    );

    wholeFile = await exportOf(source);
    parsedWhole = read(wholeFile);
    liveOrigins = parsedWhole.entries.filter((each) => !each.deleted).map((each) => each.id);
    stagedOrigins = parsedWhole.staged.map((each) => each.id);
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("previews an empty ledger as everything new, and writes nothing to do it", async () => {
    const empty = person("empty");
    const before = await footprint(empty);
    const preview = await previewLedgerFile(empty, { ledgerFile: wholeFile });
    expect(await footprint(empty)).toEqual(before);

    expect(preview.plan.ok).toBe(true);
    expect(preview.plan.problems).toEqual([]);
    expect(
      preview.plan.records
        .filter((each) => each.outcome !== "create")
        .map((each) => `${each.kind} ${each.key}`),
    ).toEqual([]);
    // A stranger's identical Checking is not this person's, and is not matched.
    expect(record(preview, "account", "Checking").existing).toBeNull();
    expect(preview.here.accounts).toEqual([]);
    expect(preview.rows).toEqual({ alreadyHere: 0, stagedAlreadyHere: 0 });
    expect(preview.plan.rows).toMatchObject({
      deleted: 1,
      alreadyHere: 0,
      toStage: liveOrigins.length + stagedOrigins.length,
    });
    expect(preview.move).toEqual({ qualifies: true, reason: null });
    // The account archived where the file came from arrives archived.
    expect(record(preview, "account", "Old card")).toMatchObject({ arrivesArchived: true });
    expect(preview.plan.preferences).toMatchObject({ inFile: true, action: "apply" });
  });

  it("adds a whole ledger to an empty one: records at once, entries to Staged", async () => {
    const empty = person("empty");
    const result = await add(empty, wholeFile);
    expect(result.staged).toBe(liveOrigins.length + stagedOrigins.length);
    expect(result.importBatchId).not.toBeNull();
    expect(result.budgetEntries).toEqual({ created: 2, skipped: 0 });
    // The plan carried out, with the id of everything this part made.
    const checking = record(result, "account", "Checking");
    expect(checking.action).toBe("create");
    expect(checking.id).toMatch(/^[0-9a-f-]{36}$/);

    const accounts = await accountsOf(empty);
    expect([...accounts.keys()].sort()).toEqual(["Brokerage", "Checking", "Old card", "Savings"]);
    expect(accounts.get("Old card")!.archivedAt).not.toBeNull();
    expect(accounts.get("Checking")).toMatchObject({ institution: "Sparkasse", notes: "Main" });
    expect(accounts.get("Brokerage")).toMatchObject({ currency: "USD", inBudget: false });

    // Settings nobody here had chosen are the file's.
    expect(await getPreferences(empty)).toMatchObject({
      chosen: true,
      timezone: TIMEZONE,
      defaultCurrency: "EUR",
      theme: "dark",
    });

    // A category archived where it came from arrives in use, so the entries
    // filed under it can be committed.
    const hobby = await getDb()
      .select()
      .from(categories)
      .where(and(eq(categories.userId, empty.userId), eq(categories.name, "Old hobby")));
    expect(hobby[0]!.archivedAt).toBeNull();

    // Every create says where it came from.
    const operations = await getDb()
      .select({ entityType: auditEvents.entityType, operation: auditEvents.operation })
      .from(auditEvents)
      .where(eq(auditEvents.userId, empty.userId));
    for (const kind of [
      "account",
      "category",
      "category_group",
      "transaction_template",
      "recurrence",
      "budget_plan",
      "budget_entry",
      "staged_transaction",
    ]) {
      expect(
        operations.filter(
          (each) => each.entityType === kind && each.operation === "create_from_ledger_file",
        ).length,
        kind,
      ).toBeGreaterThan(0);
    }

    // The batch says it was a Simple Balance file.
    const [batch] = await getDb()
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, result.importBatchId!));
    expect(batch).toMatchObject({ kind: "ledger_file", rowCount: result.staged, delimiter: "" });

    // Every entry waits with its origin and both sides of a transfer filled in.
    const rows = await waiting(empty);
    expect(rows.map((row) => row.importOrigin).sort()).toEqual(
      [...liveOrigins, ...stagedOrigins].sort(),
    );
    const transfer = rows.find((row) => row.importOrigin === ids.transfer)!;
    expect(transfer.draft).toMatchObject({
      type: "transfer",
      fromAccountId: accounts.get("Checking")!.id,
      toAccountId: accounts.get("Savings")!.id,
      sourceAmount: "200",
      destinationAmount: "200",
    });
    expect(transfer.validationIssues).toEqual([]);
    const conversion = rows.find((row) => row.importOrigin === ids.conversion)!;
    expect(conversion.draft).toMatchObject({
      toAccountId: accounts.get("Brokerage")!.id,
      sourceAmount: "1000",
      destinationAmount: "1081.4",
    });
    // Two look-alikes with different origins are not badged as each other,
    // waiting side by side in the queue.
    const flagged = await listStages(empty, { validity: "duplicate" });
    for (const origin of [ids.coffeeOne, ids.coffeeTwo]) {
      const coffee = rows.find((row) => row.importOrigin === origin)!;
      expect(coffee.duplicateOfId).toBeNull();
      expect(flagged.items.map((each) => each.id)).not.toContain(coffee.id);
    }
    // Deleted entries are not added.
    expect(rows.some((row) => row.importOrigin === ids.voided)).toBe(false);
  });

  it("adds records that a second preview reads as the same ones, so nothing is asked", async () => {
    const empty = person("empty");
    const again = await previewLedgerFile(empty, { ledgerFile: wholeFile });
    const notSame = again.plan.records.filter((each) => each.outcome !== "exists");
    expect(notSame.map((each) => `${each.kind} ${each.key} ${each.outcome}`)).toEqual([]);
    expect(again.plan.ok).toBe(true);
    // Every entry is waiting by its origin, and every staged row too.
    expect(again.rows).toEqual({
      alreadyHere: liveOrigins.length,
      stagedAlreadyHere: stagedOrigins.length,
    });
    expect(again.plan.rows.toStage).toBe(0);
    // Only rows that came from files are here, so a whole move would qualify.
    expect(again.move.qualifies).toBe(true);
  });

  it("writes nothing the second time the same file is added", async () => {
    const empty = person("empty");
    const before = await footprint(empty);
    const result = await add(empty, wholeFile);
    expect(result).toMatchObject({ staged: 0, importBatchId: null, needsReview: 0 });
    expect(result.budgetEntries).toEqual({ created: 0, skipped: 2 });
    expect(result.plan.records.every((each) => each.action !== "create")).toBe(true);
    // Nothing at all, not even an audit row.
    expect(await footprint(empty)).toEqual(before);
  });

  it("brings the templates' reminders and the recurrences' watermarks with them", async () => {
    const empty = person("empty");
    const [coffee] = await getDb()
      .select({ notification: templateNotifications })
      .from(templateNotifications)
      .innerJoin(
        transactionTemplates,
        eq(transactionTemplates.id, templateNotifications.templateId),
      )
      .where(
        and(eq(transactionTemplates.userId, empty.userId), eq(transactionTemplates.name, "Coffee")),
      );
    expect(coffee!.notification).toMatchObject({
      lastNotifiedDate: "2026-03-01",
      nextNotificationDate: null,
    });
    // A spent one-time reminder sends nothing at the next sweep.
    sent.length = 0;
    await runDueNotifications();
    const templateId = coffee!.notification.templateId;
    expect(sent.filter((message) => message.about?.includes(templateId))).toEqual([]);

    const today = todayIn(TIMEZONE);
    const [marketDay] = await getDb()
      .select()
      .from(recurrences)
      .where(and(eq(recurrences.userId, empty.userId), eq(recurrences.name, "Market day")));
    expect(marketDay).toMatchObject({
      lastOccurrenceDate: today,
      proposesFrom: addDays(today, 1),
    });
    const [pay] = await getDb()
      .select()
      .from(recurrences)
      .where(and(eq(recurrences.userId, empty.userId), eq(recurrences.name, "Pay")));
    expect(pay).toMatchObject({ lastOccurrenceDate: "2026-09-30", proposesFrom: today });
    // Arriving on a day the source already proposed does not propose it again.
    await runDueRecurrences();
    const proposed = await getDb()
      .select()
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.userId, empty.userId),
          eq(stagedTransactions.recurrenceId, marketDay!.id),
        ),
      );
    expect(proposed).toEqual([]);
  });

  it("makes the same books once its entries are committed, and copies each origin", async () => {
    const empty = person("empty");
    const accounts = await accountsOf(empty);
    // An account archived where it came from holds its rows until it is
    // restored, like any archived account, and goes back once they are in.
    const card = accounts.get("Old card")!;
    await setAccountArchived(empty, card.id, card.version, false);

    // The two look-alike coffees commit together without allowDuplicates,
    // because their origins say they are two entries.
    const committed = await commitOrigins(empty, liveOrigins);
    expect("committed" in committed && committed.committed.length).toBe(liveOrigins.length);

    const restored = (await accountsOf(empty)).get("Old card")!;
    await setAccountArchived(empty, restored.id, restored.version, true);

    const sources = await accountsOf(source);
    for (const [name, mine] of await accountsOf(empty)) {
      expect(await held(empty, mine.id), name).toBe(await held(source, sources.get(name)!.id));
    }

    const origins = await getDb()
      .select({ importOrigin: transactions.importOrigin })
      .from(transactions)
      .where(eq(transactions.userId, empty.userId));
    expect(origins.map((row) => row.importOrigin).sort()).toEqual([...liveOrigins].sort());

    // A third coffee from another file, with an origin of its own, is neither
    // badged as the two in the books nor refused beside them.
    const coffee = parsedWhole.entries.find((each) => each.id === ids.coffeeOne)!;
    const third = serializeLedgerFile({
      ...parsedWhole,
      budgets: { plans: [], entries: [] },
      staged: [],
      entries: [{ ...coffee, id: randomUUID() }],
    });
    const added = await add(empty, third);
    const [row] = (await waiting(empty)).filter(
      (each) => each.importBatchId === added.importBatchId,
    );
    expect(row!.duplicateOfId).toBeNull();
    const flagged = await listStages(empty, { validity: "duplicate" });
    expect(flagged.items.map((each) => each.id)).not.toContain(row!.id);
    await commitStages(empty, {
      stagedIds: [row!.id],
      expectedVersions: { [row!.id]: row!.version },
      idempotencyKey: randomUUID(),
    });

    // A look-alike typed here has no origin, and is still flagged against the
    // entries the file brought.
    const typed = await refusal(
      createTransaction(
        empty,
        {
          type: "withdrawal",
          date: "2026-02-21",
          payee: "Kiosk",
          fromAccountId: accounts.get("Checking")!.id,
          amount: "3.50",
        } as never,
        randomUUID(),
      ),
    );
    expect(typed.code).toBe("DUPLICATE");
  });

  it("skips an entry already here by origin, deleted or not, and stages a discarded row again", async () => {
    const empty = person("empty");
    // Deleting is a decision about the entry, so importing it again would undo it.
    const [groceries] = await getDb()
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, empty.userId), eq(transactions.payee, "Rewe")));
    await setTransactionDeleted(empty, groceries!.id, groceries!.version, true);
    // A discarded staged row is no decision about the entry.
    const [bakery] = (await waiting(empty)).filter((row) =>
      JSON.stringify(row.draft).includes("Bäckerei"),
    );
    await deleteStages(empty, {
      stagedIds: [bakery!.id],
      expectedVersions: { [bakery!.id]: bakery!.version },
    });

    const preview = await previewLedgerFile(empty, { ledgerFile: wholeFile });
    expect(preview.rows).toEqual({
      alreadyHere: liveOrigins.length,
      stagedAlreadyHere: stagedOrigins.length - 1,
    });
    const result = await add(empty, wholeFile);
    expect(result.staged).toBe(1);
    const again = (await waiting(empty)).filter((row) => row.importOrigin === bakery!.importOrigin);
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(bakery!.id);
  });

  it("is skipped by the ledger it came from, all the way round", async () => {
    // From the source to the empty ledger and back: every entry's origin is the
    // source's own id, and every staged row's the source's own row.
    // The one entry that began in another file — the third coffee — is new
    // here, and the only thing that is.
    const back = await exportOf(person("empty"));
    const returned = read(back);
    const live = returned.entries.filter((each) => !each.deleted);
    const fromHere = live.filter((each) => liveOrigins.includes(each.id));
    expect(fromHere).toHaveLength(live.length - 1);
    const preview = await previewLedgerFile(source, { ledgerFile: back });
    expect(preview.rows).toEqual({
      alreadyHere: fromHere.length,
      stagedAlreadyHere: returned.staged.length,
    });
    expect(preview.plan.rows.toStage).toBe(1);
    // Hand-typed entries here, so a whole move is not offered.
    expect(preview.move).toEqual({ qualifies: false, reason: expect.stringContaining("Staged") });
    expect(
      preview.plan.records
        .filter((each) => each.outcome !== "exists")
        .map((each) => `${each.kind} ${each.key}`),
    ).toEqual([]);
    const before = await footprint(source);
    const result = await add(source, back);
    expect(result.staged).toBe(1);
    const after = await footprint(source);
    expect(after).toEqual({
      ...before,
      staged: Number(before!.staged) + 1,
      batches: Number(before!.batches) + 1,
      audit: Number(before!.audit) + 2,
    });
  });

  it("asks about every record already here that differs, and writes nothing until it is told", async () => {
    const overlap = person("overlap");
    await setPreferences(overlap, { timezone: TIMEZONE, defaultCurrency: "EUR", theme: "dark" });
    const checking = await createAccount(overlap, {
      name: "CHECKING",
      type: "checking",
      currency: "EUR",
      openingDate: "2024-01-01",
      openingBalance: "10",
    });
    await createAccount(overlap, {
      name: "Savings",
      type: "savings",
      currency: "USD",
      openingDate: "2025-01-01",
      openingBalance: "500",
    });
    await createCategoryGroup(overlap, { name: "Home", policy: "standalone" });
    await createCategory(overlap, { name: "Groceries", kind: "income" });
    await createCategory(overlap, { name: "Salary", kind: "income" });

    const preview = await previewLedgerFile(overlap, { ledgerFile: wholeFile });
    expect(record(preview, "group", "Home").outcome).toBe("exists");
    expect(record(preview, "category", "Salary").outcome).toBe("exists");
    expect(record(preview, "account", "Checking")).toMatchObject({
      outcome: "duplicate",
      choices: ["use_existing", "skip", "rename"],
      existing: { id: checking.id, name: "CHECKING" },
    });
    // In another currency the two can never be one account.
    expect(record(preview, "account", "Savings")).toMatchObject({
      outcome: "duplicate",
      choices: ["skip", "rename"],
    });
    expect(record(preview, "category", "Groceries").outcome).toBe("duplicate");
    expect(preview.plan.ok).toBe(false);

    // Undecided: refused with the preview's own problems, and nothing written.
    const before = await footprint(overlap);
    const undecided = await refusal(add(overlap, wholeFile));
    expect(undecided.code).toBe("VALIDATION_ERROR");
    expect((undecided.details as { issues: unknown[] }).issues).toEqual(preview.plan.problems);
    expect(undecided.message).toBe(preview.plan.problems[0]!.message);
    // Using the one here is refused where the currency differs.
    const decisions: LedgerFileDecision[] = [
      { kind: "account", key: "Checking", action: "use_existing" },
      { kind: "account", key: "Savings", action: "use_existing" },
      { kind: "category", key: "Groceries", action: "rename", name: "Groceries (A)" },
    ];
    const wrong = await refusal(add(overlap, wholeFile, { decisions }));
    expect(wrong.code).toBe("VALIDATION_ERROR");
    expect((wrong.details as { issues: { field: string }[] }).issues[0]!.field).toBe(
      "decisions.1.action",
    );
    expect(await footprint(overlap)).toEqual(before);

    decisions[1] = { kind: "account", key: "Savings", action: "rename", name: "Savings (EUR)" };
    const result = await add(overlap, wholeFile, { decisions });
    expect(record(result, "account", "Checking")).toMatchObject({
      action: "use",
      id: checking.id,
    });
    expect(record(result, "account", "Savings")).toMatchObject({
      action: "create",
      importName: "Savings (EUR)",
    });

    // The account here is used and not touched.
    const accounts = await accountsOf(overlap);
    expect(accounts.get("CHECKING")).toMatchObject({
      version: checking.version,
      openingBalance: "10.000000000000000000",
    });
    expect(accounts.get("Savings (EUR)")).toMatchObject({ currency: "EUR" });
    // The transfer between them stages whole, onto the account here and the copy.
    const transfer = (await waiting(overlap)).find((row) => row.importOrigin === ids.transfer)!;
    expect(transfer.draft).toMatchObject({
      fromAccountId: checking.id,
      toAccountId: accounts.get("Savings (EUR)")!.id,
    });
    // An entry filed under the category brought in under another name lands
    // under the copy, not the income category of the same name here.
    const copies = await getDb()
      .select()
      .from(categories)
      .where(and(eq(categories.userId, overlap.userId), eq(categories.name, "Groceries (A)")));
    expect(copies[0]).toMatchObject({ kind: "expense" });
    const shop = (await waiting(overlap)).find((row) =>
      JSON.stringify(row.draft).includes("Rewe"),
    )!;
    expect(shop.draft).toMatchObject({ categoryId: copies[0]!.id });
    // The budget on the category follows it to the copy.
    expect(result.budgetEntries.created).toBe(2);

    // Adding again with the same decisions finds the copies it made and asks nothing.
    const again = await add(overlap, wholeFile, { decisions });
    expect(again.staged).toBe(0);
    expect(again.plan.records.filter((each) => each.action === "create")).toEqual([]);
  });

  it("lands a transfer once from two accounts' files", async () => {
    const owner = person("accounts");
    const detailsOnly = await exportOf(source, {
      kinds: ["accounts"],
      accountIds: [ids.checking, ids.savings],
    });
    const first = await add(owner, detailsOnly);
    expect(first.staged).toBe(0);

    const ofChecking = await exportOf(source, {
      kinds: ["accounts", "categories", "entries"],
      accountIds: [ids.checking],
    });
    const previewChecking = await previewLedgerFile(owner, { ledgerFile: ofChecking });
    expect(record(previewChecking, "account", "Checking").outcome).toBe("exists");
    expect(record(previewChecking, "account", "Savings").outcome).toBe("exists");
    expect(record(previewChecking, "account", "Brokerage").outcome).toBe("missing");
    await add(owner, ofChecking, {
      decisions: [{ kind: "account", key: "Brokerage", action: "create" }],
    });

    const ofSavings = await exportOf(source, {
      kinds: ["accounts", "categories", "entries"],
      accountIds: [ids.savings],
    });
    const previewSavings = await previewLedgerFile(owner, { ledgerFile: ofSavings });
    expect(previewSavings.rows.alreadyHere).toBe(1);
    const second = await add(owner, ofSavings);
    expect(second.staged).toBe(0);

    const transfers = (await waiting(owner)).filter((row) => row.importOrigin === ids.transfer);
    expect(transfers).toHaveLength(1);
    const accounts = await accountsOf(owner);
    expect(transfers[0]!.draft).toMatchObject({
      fromAccountId: accounts.get("Checking")!.id,
      toAccountId: accounts.get("Savings")!.id,
    });
    expect(transfers[0]!.validationIssues).toEqual([]);
    // Brokerage, made from a reference, opens at zero on its first entry.
    expect(accounts.get("Brokerage")).toMatchObject({
      openingDate: "2026-02-12",
      openingBalance: "0.000000000000000000",
      currency: "USD",
    });
  });

  it("applies a file in parts, each all or nothing, and resumes after a part fails", async () => {
    const owner = person("parts");
    const split = splitLedgerFile(parsedWhole, { maxRows: 4, maxBytes: 16 * 1024 * 1024 });
    if (!split.ok) throw new Error(split.message);
    const parts = split.parts.map(serializeLedgerFile);
    expect(parts.length).toBeGreaterThan(2);

    // The page's way: preview each part, merge, and plan the whole file.
    const previews = [];
    for (const part of parts) previews.push(await previewLedgerFile(owner, { ledgerFile: part }));
    const whole = planLedgerFileAdd({
      file: parsedWhole,
      facts: mergeLedgerFileFacts(previews),
    }).plan;
    expect(whole.ok).toBe(true);
    expect(whole.rows.toStage).toBe(liveOrigins.length + stagedOrigins.length);

    const run = randomUUID();
    const send = (index: number, extra: Record<string, unknown> = {}) =>
      addLedgerFile(owner, {
        ledgerFile: parts[index]!,
        fileName: "parts.json",
        idempotencyKey: `${run}-${index + 1}`,
        part: { index: index + 1, count: parts.length },
        ...extra,
      });

    const firstResult = await send(0);
    // The records were all created by the first part; the second part reads
    // every one as the same, and asks nothing.
    const secondPreview = await previewLedgerFile(owner, { ledgerFile: parts[1]! });
    expect(
      secondPreview.plan.records
        .filter((each) => each.outcome !== "exists")
        .map((each) => each.key),
    ).toEqual([]);

    // A part that fails writes nothing, and the same part sent again goes in.
    const before = await footprint(owner);
    const failed = await refusal(
      send(1, { decisions: [{ kind: "account", key: "Nowhere", action: "skip" }] }),
    );
    expect(failed.code).toBe("VALIDATION_ERROR");
    expect(await footprint(owner)).toEqual(before);
    // A key is bound to what it was sent with.
    const reused = await refusal(send(0, { fileName: "something else.json" }));
    expect(reused.code).toBe("CONFLICT");

    for (let index = 1; index < parts.length; index += 1) {
      await addLedgerFile(owner, {
        ledgerFile: parts[index]!,
        fileName: "parts.json",
        idempotencyKey: `${run}-retry-${index + 1}`,
        part: { index: index + 1, count: parts.length },
      });
    }
    // Sending the first part again with its key replays it, writing nothing.
    const atEnd = await footprint(owner);
    expect(await send(0)).toEqual(firstResult);
    expect(await footprint(owner)).toEqual(atEnd);

    const rows = await waiting(owner);
    expect(rows.map((row) => row.importOrigin).sort()).toEqual(
      [...liveOrigins, ...stagedOrigins].sort(),
    );
    const plans = await getDb().execute(
      sql`select count(*)::int as n from budget_plan where user_id = ${owner.userId}`,
    );
    expect((plans.rows[0] as { n: number }).n).toBe(2);
  });

  it("applies the file's settings over a choice made here only when asked", async () => {
    const chosen = person("settings-chosen");
    await setPreferences(chosen, { timezone: "UTC", defaultCurrency: "USD", theme: "light" });
    const preview = await previewLedgerFile(chosen, { ledgerFile: wholeFile });
    expect(preview.plan.preferences).toMatchObject({
      chosenHere: true,
      differs: true,
      action: "undecided",
    });
    const refused = await refusal(add(chosen, wholeFile));
    expect(
      (refused.details as { issues: { field: string }[] }).issues.map((each) => each.field),
    ).toEqual(["preferences"]);
    await add(chosen, wholeFile, { preferences: "keep" });
    expect(await getPreferences(chosen)).toMatchObject({
      timezone: "UTC",
      defaultCurrency: "USD",
      theme: "light",
    });

    const toFile = person("settings-file");
    await setPreferences(toFile, { timezone: "UTC", defaultCurrency: "USD", theme: "light" });
    await add(toFile, wholeFile, { preferences: "file" });
    expect(await getPreferences(toFile)).toMatchObject({
      timezone: TIMEZONE,
      defaultCurrency: "EUR",
      theme: "dark",
    });
  });

  it("replays a part sent again with its key, and refuses the key with another request", async () => {
    const owner = person("replay");
    const key = randomUUID();
    const first = await addLedgerFile(owner, {
      ledgerFile: wholeFile,
      fileName: "replay.json",
      idempotencyKey: key,
    });
    const before = await footprint(owner);
    const second = await addLedgerFile(owner, {
      ledgerFile: wholeFile,
      fileName: "replay.json",
      idempotencyKey: key,
    });
    expect(second).toEqual(first);
    expect(await footprint(owner)).toEqual(before);
    const conflicting = await refusal(
      addLedgerFile(owner, {
        ledgerFile: wholeFile,
        fileName: "replay.json",
        idempotencyKey: key,
        preferences: "keep",
      }),
    );
    expect(conflicting.code).toBe("CONFLICT");
  });

  it("refuses an entry already in the books at commit with a sentence, not a constraint", async () => {
    const owner = person("commit-race");
    await add(owner, wholeFile);
    const rows = await waiting(owner);
    const [salary] = rows.filter((row) => JSON.stringify(row.draft).includes("Employer"));
    const [rewe] = rows.filter((row) => JSON.stringify(row.draft).includes("Rewe"));
    await commitStages(owner, {
      stagedIds: [salary!.id],
      expectedVersions: { [salary!.id]: salary!.version },
      idempotencyKey: randomUUID(),
    });
    // Another path put the same origin in the books in between: written
    // beneath the services, the way only a race could.
    await getDb()
      .update(transactions)
      .set({ importOrigin: rewe!.importOrigin })
      .where(and(eq(transactions.userId, owner.userId), eq(transactions.payee, "Employer")));
    const refused = await refusal(
      commitStages(owner, {
        stagedIds: [rewe!.id],
        expectedVersions: { [rewe!.id]: rewe!.version },
        idempotencyKey: randomUUID(),
      }),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toBe(
      "This entry is already in the ledger, so it was not committed again.",
    );
    expect(refused.details).toEqual({ id: rewe!.id });
  });

  it("matches and touches nothing of anybody else's", async () => {
    const owner = person("scoped");
    const theirs = await footprint(stranger);
    const preview = await previewLedgerFile(owner, { ledgerFile: wholeFile });
    expect(preview.here.accounts).toEqual([]);
    expect(Object.values(preview.here.ids.account)).not.toContain(strangerAccountId);

    // The stranger's own entry, exported, is no origin here.
    const theirFile = await exportOf(stranger, { kinds: ["accounts", "entries"] });
    expect((await previewLedgerFile(owner, { ledgerFile: theirFile })).rows.alreadyHere).toBe(0);

    // A file naming an account only by reference cannot be matched to theirs.
    // One of this person's own in the currency is here, so matching is a
    // choice the plan offers and the stranger's id is what it refuses.
    await createAccount(owner, {
      name: "Own euros",
      type: "checking",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    const ofChecking = await exportOf(source, {
      kinds: ["accounts", "categories", "entries"],
      accountIds: [ids.checking],
    });
    const refused = await refusal(
      add(owner, ofChecking, {
        decisions: [
          { kind: "account", key: "Savings", action: "match", id: strangerAccountId },
          { kind: "account", key: "Brokerage", action: "leave_staged" },
        ],
      }),
    );
    expect(refused.message).toBe("No account here has that id.");
    expect(await footprint(stranger)).toEqual(theirs);
    const settings = await getDb()
      .select()
      .from(userPreferences)
      .where(inArray(userPreferences.userId, [stranger.userId]));
    expect(settings).toEqual([]);
  });

  it("is two tools over a real connection, the add only behind ledger:write", async () => {
    const connect = async (scopes: string[]) => {
      const server = createMcpServer(
        { userId: person("agent").userId, source: "mcp", clientId: "ledger-file-agent" },
        new Set(scopes),
      );
      const client = new Client({ name: "ledger-file", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, server };
    };
    const names = async (scopes: string[]) => {
      const { client, server } = await connect(scopes);
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      await client.close();
      await server.close();
      return listed;
    };
    for (const scope of ["ledger:read", "ledger:stage"]) {
      const listed = await names([scope]);
      expect(listed, scope).toContain("preview_ledger_file");
      expect(listed, scope).not.toContain("add_ledger_file");
    }
    expect(await names(["ledger:write"])).toEqual(
      expect.arrayContaining(["preview_ledger_file", "add_ledger_file"]),
    );

    const { client, server } = await connect(["ledger:write"]);
    try {
      await client.listTools();
      const preview = await client.callTool({
        name: "preview_ledger_file",
        arguments: { ledgerFile: wholeFile },
      });
      expect(JSON.stringify(preview)).not.toContain("Output validation error");
      expect(preview.isError, JSON.stringify(preview).slice(0, 2000)).toBeFalsy();
      const previewed = (preview.structuredContent as { result: LedgerFilePreview }).result;
      expect(previewed.plan.ok).toBe(true);
      expect(previewed.plan.rows.toStage).toBe(liveOrigins.length + stagedOrigins.length);

      const added = await client.callTool({
        name: "add_ledger_file",
        arguments: {
          ledgerFile: wholeFile,
          fileName: "agent.json",
          idempotencyKey: randomUUID(),
        },
      });
      expect(JSON.stringify(added)).not.toContain("Output validation error");
      expect(added.isError, JSON.stringify(added).slice(0, 2000)).toBeFalsy();
      const result = (added.structuredContent as { result: LedgerFileAddResult }).result;
      expect(result.staged).toBe(liveOrigins.length + stagedOrigins.length);

      // A refusal is an error result carrying the problems.
      const refused = await client.callTool({
        name: "add_ledger_file",
        arguments: {
          ledgerFile: wholeFile,
          fileName: "agent.json",
          idempotencyKey: randomUUID(),
          decisions: [{ kind: "group", key: "Nowhere", action: "skip" }],
        },
      });
      expect(JSON.stringify(refused)).not.toContain("Output validation error");
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.structuredContent)).toContain("VALIDATION_ERROR");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses a part over the row cap before reading the ledger", async () => {
    const template = parsedWhole.entries.find((each) => each.type === "deposit" && !each.deleted)!;
    const big: LedgerFile = {
      ...parsedWhole,
      budgets: { plans: [], entries: [] },
      staged: [],
      entries: Array.from({ length: 10_001 }, (_, n) => ({
        ...template,
        id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
      })),
    };
    const refused = await refusal(
      previewLedgerFile(person("scoped"), { ledgerFile: serializeLedgerFile(big) }),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.details).toEqual({ limit: 10_000, count: 10_001 });
  });
  /**
   * A row waiting in Staged with no origin — a CSV's, one typed into the
   * queue — is exported under its own id. Committing it gives the entry no
   * origin, so without more the next export wrote it under the entry's own id,
   * a ledger the first file went into took it for a different entry, and the
   * duplicate check stood aside because the two origins differed: the money
   * twice, and no flag. The entry is exported under the row's id instead, and
   * a committed row's id is an origin this ledger already has.
   */
  it("keeps a waiting row's identity once it is committed, so a later file adds nothing", async () => {
    const a = person("origin-a");
    const b = person("origin-b");
    const checking = await createAccount(a, {
      name: "Checking",
      type: "checking",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "100",
    });
    const draft = {
      type: "withdrawal",
      date: "2026-03-01",
      payee: "Bakery",
      fromAccountId: checking.id,
      amount: "30.00",
    };
    const row = await createStage(a, { idempotencyKey: "origin-a-row", draft });
    const kinds = { kinds: ["accounts", "entries", "staged"] };
    const first = await exportOf(a, kinds);
    expect(read(first).staged.map((each) => each.id)).toEqual([row.id]);

    await add(b, first);
    await commitOrigins(b, [row.id]);
    await commitStages(a, {
      stagedIds: [row.id],
      expectedVersions: { [row.id]: row.version },
      idempotencyKey: randomUUID(),
    });
    const there = (await accountsOf(b)).get("Checking")!;
    const balance = await held(b, there.id);
    expect(balance).toBe("70");

    // The entry the row became is written under the row's id, and the ledger
    // that took the first file skips it.
    const second = await exportOf(a, kinds);
    expect(read(second).entries.map((each) => each.id)).toEqual([row.id]);
    const preview = await previewLedgerFile(b, { ledgerFile: second });
    expect(preview.rows).toEqual({ alreadyHere: 1, stagedAlreadyHere: 0 });
    expect(preview.plan.rows.toStage).toBe(0);
    expect((await add(b, second)).staged).toBe(0);
    expect(await waiting(b)).toEqual([]);
    expect(await held(b, there.id)).toBe(balance);

    // The ledger it came from skips its own older file: the row is in the
    // books now, and staging it again is the same money twice.
    const back = await previewLedgerFile(a, { ledgerFile: first });
    expect(back.rows).toEqual({ alreadyHere: 0, stagedAlreadyHere: 1 });
    expect((await add(a, first)).staged).toBe(0);

    // And the entry's own origin stays empty, so committing the same row a
    // second time is still the duplicate the check refuses.
    const again = await createStage(a, { idempotencyKey: "origin-a-again", draft });
    const refused = await refusal(
      commitStages(a, {
        stagedIds: [again.id],
        expectedVersions: { [again.id]: again.version },
        idempotencyKey: randomUUID(),
      }),
    );
    expect(refused.code).toBe("DUPLICATE");
  });

  /**
   * Checking's file, then Savings' file, with no details-only file first:
   * Savings is created from a reference by the first, at zero, and the
   * second's whole Savings differs from it. The question says by how much,
   * because using the one here keeps its opening and nothing later checks.
   */
  it("says what using the account here does to its opening, and an opening edit makes it right", async () => {
    const owner = person("two-files");
    const chosen = (accountId: string) =>
      exportOf(source, { kinds: ["accounts", "categories", "entries"], accountIds: [accountId] });
    const ofChecking = await chosen(ids.checking);
    const made = await add(owner, ofChecking, {
      decisions: [
        { kind: "account", key: "Savings", action: "create" },
        { kind: "account", key: "Brokerage", action: "create" },
      ],
    });
    expect(record(made, "account", "Savings").message).toContain(
      "it opens at zero on the day of the first transaction naming it",
    );

    const ofSavings = await chosen(ids.savings);
    const preview = await previewLedgerFile(owner, { ledgerFile: ofSavings });
    expect(record(preview, "account", "Savings").message).toBe(
      "There is already an account called \"Savings\" here, and it differs from the file's in its opening. Here it opens on 2026-02-10 at 0 EUR, and the file's on 2025-01-01 at 500 EUR. Using the one here keeps its own opening, so the 500 EUR more that the file's opens with does not come with it; bringing it in under another name keeps the file's.",
    );
    await add(owner, ofSavings, {
      decisions: [{ kind: "account", key: "Savings", action: "use_existing" }],
    });
    await commitOrigins(owner, [ids.transfer]);
    const savings = (await accountsOf(owner)).get("Savings")!;
    await updateAccount(owner, savings.id, {
      openingDate: "2025-01-01",
      openingBalance: "500",
      expectedVersion: savings.version,
    });
    expect(await held(owner, savings.id)).toBe(await held(source, ids.savings));
  });

  /**
   * A template, a split template and a recurring transaction filed under a
   * category the file only names, left for review. Each part has to read what
   * the part before it made as the same records, and adding the whole file
   * again has to write nothing, or the second part asks a question the
   * preview never had and refuses with it.
   */
  it("adds a file in parts under a category left for review, and the whole file again as nothing", async () => {
    const from = person("filed-source");
    const to = person("filed-dest");
    const checking = (
      await createAccount(from, {
        name: "Checking",
        type: "checking",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    const dining = (await createCategory(from, { name: "Dining", kind: "expense" })).id;
    await createTransactionTemplate(from, {
      name: "Lunch",
      draft: { type: "withdrawal", fromAccountId: checking, categoryId: dining, amount: "12.00" },
    });
    await createTransactionTemplate(from, {
      name: "Split lunch",
      draft: {
        type: "withdrawal",
        fromAccountId: checking,
        payee: "Canteen",
        amount: "12.00",
        legs: [
          { categoryId: dining, amount: "8.00" },
          { categoryName: "Treats", amount: "4.00" },
        ],
      },
    });
    await createRecurrence(from, {
      name: "Lunch money",
      shape: {
        type: "withdrawal",
        fromAccountId: checking,
        amount: "50.00",
        payee: "Canteen",
        categoryId: dining,
      },
      schedule: { frequency: "monthly", anchorDate: "2026-01-05", weekendPolicy: "allow" },
    });
    for (let n = 1; n <= 5; n += 1) {
      await createTransaction(
        from,
        {
          type: "withdrawal",
          date: `2026-02-0${n}`,
          payee: `Cafe ${n}`,
          fromAccountId: checking,
          amount: "9.00",
          categoryId: dining,
        } as never,
        `filed-${n}`,
      );
    }
    const text = await exportOf(from, {
      kinds: ["accounts", "entries", "templates", "recurrences"],
    });
    const file = read(text);
    expect(file.categories).toEqual([
      expect.objectContaining({ key: "Dining", detail: "reference" }),
    ]);
    const split = splitLedgerFile(file, { maxRows: 2, maxBytes: 16 * 1024 * 1024 });
    if (!split.ok) throw new Error(split.message);
    expect(split.parts).toHaveLength(3);

    const decisions: LedgerFileDecision[] = [
      { kind: "category", key: "Dining", action: "leave_staged" },
    ];
    for (const [at, part] of split.parts.entries()) {
      const result = await addLedgerFile(to, {
        ledgerFile: serializeLedgerFile(part),
        fileName: "filed.json",
        idempotencyKey: randomUUID(),
        part: { index: at + 1, count: split.parts.length },
        decisions,
      });
      expect(result.plan.problems, `part ${at + 1}`).toEqual([]);
    }
    const before = await footprint(to);
    const again = await add(to, text, { decisions });
    expect(again.staged).toBe(0);
    expect(again.plan.records.filter((each) => each.action === "create")).toEqual([]);
    expect(await footprint(to)).toEqual(before);
  });

  /**
   * Records are bounded at the row cap's number on their own: every one is
   * created or matched in the part's one transaction under every namespace
   * lock, and a part of nothing but records held a connection for as long as
   * the list was long.
   */
  it("refuses a part with more records than one part may carry, before reading the ledger", async () => {
    const owner = person("records-cap");
    const many: LedgerFile = {
      ...parsedWhole,
      categories: [
        ...parsedWhole.categories,
        ...Array.from({ length: 10_001 }, (_, n) => ({
          key: `Bulk ${n}`,
          name: `Bulk ${n}`,
          detail: "full" as const,
          kind: "expense" as const,
          group: null,
          archivedAt: null,
        })),
      ],
    };
    const text = serializeLedgerFile(many);
    const count = ledgerFileRecordCount(many);
    const before = await footprint(owner);
    for (const refused of [
      await refusal(previewLedgerFile(owner, { ledgerFile: text })),
      await refusal(add(owner, text)),
    ]) {
      expect(refused.code).toBe("VALIDATION_ERROR");
      expect(refused.details).toEqual({ limit: 10_000, count });
    }
    expect(await footprint(owner)).toEqual(before);
  });

  /**
   * An account the file only names is created by the first part, which in a
   * file cut by date holds none of the entries naming it. The page sends the
   * whole file's day with the decision, so the account opens where a single
   * part would have opened it rather than on the file's last day.
   */
  it("opens an account made from a reference on the same day in parts as in one", async () => {
    const owner = person("parts-ref");
    const whole = read(
      await exportOf(source, {
        kinds: ["accounts", "categories", "entries"],
        accountIds: [ids.checking],
      }),
    );
    const split = splitLedgerFile(whole, { maxRows: 2, maxBytes: 16 * 1024 * 1024 });
    if (!split.ok) throw new Error(split.message);
    expect(split.parts[0]!.entries.some((each) => each.type === "transfer")).toBe(false);
    const decisions: LedgerFileDecision[] = ["Savings", "Brokerage"].map((key) => ({
      kind: "account",
      key,
      action: "create",
      openingDate: ledgerReferenceOpeningDate(whole, key),
    }));
    for (const [at, part] of split.parts.entries()) {
      await addLedgerFile(owner, {
        ledgerFile: serializeLedgerFile(part),
        fileName: "parts.json",
        idempotencyKey: randomUUID(),
        part: { index: at + 1, count: split.parts.length },
        decisions,
      });
    }
    const accounts = await accountsOf(owner);
    expect(accounts.get("Savings")).toMatchObject({ openingDate: "2026-02-10" });
    // The day the single-part add of the same accounts opens it on.
    expect(accounts.get("Brokerage")).toMatchObject({ openingDate: "2026-02-12" });
  });

  /**
   * The splitter puts budget amounts after every entry, so the first parts of
   * a large file carry none of them. A budget whose amounts meet different
   * ones here is asked about once, for the whole file, and that answer travels
   * with every part — on both transports.
   */
  it("takes the same budget decision with every part, from the service and over MCP", async () => {
    const owner = person("budget-parts");
    await add(owner, wholeFile);
    const [march] = await getDb()
      .select()
      .from(budgetEntries)
      .where(
        and(eq(budgetEntries.userId, owner.userId), eq(budgetEntries.periodStart, "2026-03-01")),
      );
    await setBudgetEntry(owner, {
      categoryId: march!.categoryId,
      currency: "EUR",
      periodUnit: "month",
      periodStart: "2026-03-01",
      amount: "999",
      expectedVersion: march!.version,
    });
    const split = splitLedgerFile(parsedWhole, { maxRows: 4, maxBytes: 16 * 1024 * 1024 });
    if (!split.ok) throw new Error(split.message);
    const parts = split.parts.map(serializeLedgerFile);
    expect(split.parts[0]!.budgets.entries).toEqual([]);
    const previews = [];
    for (const part of parts) previews.push(await previewLedgerFile(owner, { ledgerFile: part }));
    const key = ledgerBudgetKey(parsedWhole.budgets.entries[0]!);
    const whole = planLedgerFileAdd({ file: parsedWhole, facts: mergeLedgerFileFacts(previews) });
    expect(whole.plan.problems.map((each) => `${each.kind} ${each.key}`)).toEqual([
      `budget_entry ${key}`,
    ]);
    const decisions: LedgerFileDecision[] = [{ kind: "budget_entry", key, action: "skip" }];
    for (const [at, part] of parts.entries()) {
      const result = await addLedgerFile(owner, {
        ledgerFile: part,
        fileName: "budget-parts.json",
        idempotencyKey: randomUUID(),
        part: { index: at + 1, count: parts.length },
        decisions,
      });
      expect(result.plan.ok, `part ${at + 1}`).toBe(true);
    }

    const agent = await connectAgent(owner, ["ledger:write"]);
    try {
      for (const [at, part] of parts.entries()) {
        const added = await agent.client.callTool({
          name: "add_ledger_file",
          arguments: {
            ledgerFile: part,
            fileName: "budget-parts.json",
            idempotencyKey: randomUUID(),
            part: { index: at + 1, count: parts.length },
            decisions,
          },
        });
        expect(JSON.stringify(added)).not.toContain("Output validation error");
        expect(added.isError, `part ${at + 1}: ${JSON.stringify(added).slice(0, 500)}`).toBeFalsy();
      }
    } finally {
      await agent.close();
    }
    const [kept] = await getDb()
      .select()
      .from(budgetEntries)
      .where(
        and(eq(budgetEntries.userId, owner.userId), eq(budgetEntries.periodStart, "2026-03-01")),
      );
    expect(canonicalDecimal(kept!.amount)).toBe("999");
  });

  /**
   * An origin is how a ledger recognizes an entry it was handed. No form or
   * tool acts on it, so no view of an entry or a staged row carries it, nor
   * the history either is served in — on either transport.
   */
  it("never sends an origin in a view of an entry or a staged row", async () => {
    const owner = person("views");
    await add(owner, wholeFile);
    const [salary] = (await waiting(owner)).filter((row) =>
      JSON.stringify(row.draft).includes("Employer"),
    );
    const committed = await commitStages(owner, {
      stagedIds: [salary!.id],
      expectedVersions: { [salary!.id]: salary!.version },
      idempotencyKey: randomUUID(),
    });
    const entryId = (committed as { committed: { transactionId: string }[] }).committed[0]!
      .transactionId;
    const [stored] = await getDb().select().from(transactions).where(eq(transactions.id, entryId));
    expect(stored!.importOrigin).not.toBeNull();
    const typed = await createTransaction(
      owner,
      {
        type: "withdrawal",
        date: "2026-03-01",
        payee: "Typed",
        fromAccountId: stored!.destinationAccountId,
        amount: "1.00",
      } as never,
      "views-typed",
    );
    const replies = [
      await listStages(owner, {}),
      await listTransactions(owner, {}),
      await getTransaction(owner, entryId),
      typed,
      committed,
      await getDb().select().from(auditEvents).where(eq(auditEvents.userId, owner.userId)),
    ];
    for (const reply of replies) expect(JSON.stringify(reply)).not.toContain("importOrigin");

    const agent = await connectAgent(owner, ["ledger:read"]);
    try {
      for (const [name, args] of [
        ["list_transactions", {}],
        ["list_staged_transactions", {}],
        ["get_transaction", { id: entryId }],
      ] as const) {
        const reply = await agent.client.callTool({ name, arguments: args });
        expect(reply.isError, name).toBeFalsy();
        expect(JSON.stringify(reply), name).not.toContain("importOrigin");
      }
    } finally {
      await agent.close();
    }
  });
});
