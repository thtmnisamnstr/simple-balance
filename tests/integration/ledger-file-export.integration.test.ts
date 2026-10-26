import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import {
  defaultLedgerFileKinds,
  parseLedgerFileText,
  type LedgerFile,
  type LedgerFileAccount,
} from "../../src/shared/ledger-file.js";
import { addDays, todayIn } from "../../src/shared/recurrence-dates.js";
import { LEDGER_FILE_HISTORY_MAX_BYTES } from "../../src/server/config-limits.js";
import { getDb } from "../../src/server/db/client.js";
import {
  auditEvents,
  categories,
  ledgerAccounts,
  recurrences,
  templateNotifications,
  transactionTemplates,
  user,
} from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createAccount, setAccountArchived } from "../../src/server/services/accounts.js";
import { createBudgetPlan, setBudgetEntry } from "../../src/server/services/budgets.js";
import {
  createCategory,
  setCategoryArchived,
  updateCategory,
} from "../../src/server/services/categories.js";
import { createCategoryGroup } from "../../src/server/services/category-groups.js";
import { AppError } from "../../src/server/services/errors.js";
import { canonicalDecimal } from "../../src/server/services/helpers.js";
import { exportLedgerFile } from "../../src/server/services/ledger-file.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { createRecurrence } from "../../src/server/services/recurrences.js";
import { createStage } from "../../src/server/services/staging.js";
import { createTransactionTemplate } from "../../src/server/services/transaction-templates.js";
import {
  createTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * The Simple Balance file against a real ledger with every kind of record in
 * it: a transfer, a conversion, a split with a share filed nowhere, a refund
 * filed against a category widened afterwards, an archived account with its
 * closing, a deleted entry made from a template, templates with reminders,
 * recurrences, budgets on a category and on a group, and rows still waiting in
 * Staged transactions.
 *
 * Every check field is compared with the postings summed here by hand rather
 * than with the read the exporter uses, so the comparison is between the file
 * and the books and not between one function and itself.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ledger_file_export");
const actor: Actor = { userId: "ledger-file-owner", source: "web" };
const stranger: Actor = { userId: "ledger-file-stranger", source: "web" };
const ROUTE_CAP = 100_000;
const ROUTE_LIMITS = { maxRows: ROUTE_CAP, maxHistoryBytes: LEDGER_FILE_HISTORY_MAX_BYTES };
const TIMEZONE = "Europe/Berlin";

let checkingId = "";
let savingsId = "";
let brokerageId = "";
let cardId = "";
let groceriesId = "";
let marketId = "";
let refundId = "";
let recategorizedId = "";
let splitId = "";
let transferId = "";
let conversionId = "";
let voidedId = "";
let futureId = "";
let strangerAccountId = "";
let counterAccountId = "";

const everything = { kinds: [...defaultLedgerFileKinds] };

async function exportFile(
  input: unknown,
  maxRows = ROUTE_CAP,
  maxHistoryBytes = LEDGER_FILE_HISTORY_MAX_BYTES,
  as: Actor = actor,
) {
  const result = await exportLedgerFile(as, input, { maxRows, maxHistoryBytes });
  const parsed = parseLedgerFileText(result.ledgerFile);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues, null, 2));
  return { ...result, file: parsed.file };
}

/** What the postings say an account held at the end of `through`, summed here rather than by the exporter. */
async function postingSum(accountId: string, through: string, as: Actor = actor) {
  const result = await getDb().execute(sql`
    select coalesce(sum(amount), 0)::text as total
    from posting
    where user_id = ${as.userId} and account_id = ${accountId}::uuid and date <= ${through}::date
  `);
  return canonicalDecimal(String((result.rows[0] as { total: string }).total));
}

const whole = (file: LedgerFile, key: string) => {
  const found = file.accounts.find((account) => account.key === key);
  if (found?.detail !== "full") throw new Error(`${key} is not a whole account in this file`);
  return found;
};

const entryById = (file: LedgerFile, id: string) => file.entries.find((entry) => entry.id === id);

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("the export was not refused");
}

integration("exporting a Simple Balance file", () => {
  beforeAll(async () => {
    await database.create();
    const db = getDb();
    for (const [person, email] of [
      [actor, "ledger-file-owner@example.com"],
      [stranger, "ledger-file-stranger@example.com"],
    ] as const) {
      await db.insert(user).values({ id: person.userId, name: email, email, emailVerified: true });
    }
    await setPreferences(actor, { timezone: TIMEZONE, defaultCurrency: "EUR", theme: "dark" });

    const open = async (name: string, fields: Record<string, unknown> = {}) =>
      (
        await createAccount(actor, {
          name,
          type: "checking",
          currency: "EUR",
          openingDate: "2025-01-01",
          openingBalance: "1000",
          ...fields,
        })
      ).id;
    checkingId = await open("Checking", { institution: "Sparkasse" });
    savingsId = await open("Savings", { type: "savings", openingBalance: "500" });
    brokerageId = await open("Brokerage", {
      type: "investment",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
      inBudget: false,
    });
    cardId = await open("Old card", { type: "credit_card", openingBalance: "-100" });

    const home = await createCategoryGroup(actor, { name: "Home", policy: "standalone" });
    groceriesId = (
      await createCategory(actor, { name: "Groceries", kind: "expense", groupId: home.id })
    ).id;
    const householdId = (
      await createCategory(actor, { name: "Household", kind: "expense", groupId: home.id })
    ).id;
    const salaryId = (await createCategory(actor, { name: "Salary", kind: "income" })).id;
    const market = await createCategory(actor, { name: "Market", kind: "expense" });
    marketId = market.id;
    const hobby = await createCategory(actor, { name: "Old hobby", kind: "expense" });
    // A second spelling of a name the ledger already has, written beneath the
    // service the way a ledger from before the folded check holds one.
    await db
      .insert(categories)
      .values({ userId: actor.userId, name: "GROCERIES", kind: "expense" });

    const entry = async (key: string, draft: Record<string, unknown>) =>
      (await createTransaction(actor, draft as never, key, true)).id;
    await entry("salary", {
      type: "deposit",
      date: "2026-01-31",
      payee: "Employer",
      toAccountId: checkingId,
      amount: "3000.00",
      categoryId: salaryId,
    });
    await entry("groceries", {
      type: "withdrawal",
      date: "2026-02-02",
      payee: "Rewe",
      fromAccountId: checkingId,
      amount: "54.23",
      categoryId: groceriesId,
      description: "Weekly shop",
      notes: "Receipt in the drawer",
      externalId: "BANK-77",
    });
    splitId = await entry("split", {
      type: "withdrawal",
      date: "2026-02-04",
      payee: "Market hall",
      fromAccountId: checkingId,
      amount: "80.00",
      legs: [
        { categoryId: groceriesId, amount: "60.00" },
        { categoryId: householdId, amount: "15.00", note: "bulbs" },
        { categoryId: null, amount: "5.00" },
      ],
    });
    transferId = await entry("transfer", {
      type: "transfer",
      date: "2026-02-10",
      payee: "To savings",
      fromAccountId: checkingId,
      toAccountId: savingsId,
      sourceAmount: "200.00",
    });
    conversionId = await entry("conversion", {
      type: "transfer",
      date: "2026-02-12",
      payee: "Broker",
      fromAccountId: checkingId,
      toAccountId: brokerageId,
      sourceAmount: "1000.00",
      destinationAmount: "1081.40",
    });
    // A refund into spending, which posts to the expense counter-account, and
    // then the category widened to `both`, which reposts nothing: written fresh
    // today the same entry would be income.
    refundId = await entry("refund", {
      type: "deposit",
      date: "2026-02-15",
      payee: "Market hall",
      toAccountId: checkingId,
      amount: "12.99",
      categoryId: marketId,
    });
    // Income at first, then moved under the spending category, which appends a
    // delta: what it put on income nets back to nothing, and the expense side
    // is the only one left holding it. Only the side that does not net to zero
    // is the side it posted to.
    const storeCredit = {
      type: "deposit",
      date: "2026-02-17",
      payee: "Store credit",
      toAccountId: checkingId,
      amount: "7.00",
    };
    recategorizedId = await entry("recategorized", { ...storeCredit, categoryId: salaryId });
    await updateTransaction(actor, recategorizedId, {
      draft: { ...storeCredit, categoryId: marketId },
      expectedVersion: 1,
    });
    await updateCategory(actor, marketId, { kind: "both", expectedVersion: market.version });
    await entry("card", {
      type: "withdrawal",
      date: "2026-01-15",
      payee: "Hobby shop",
      fromAccountId: cardId,
      amount: "20.00",
      categoryId: hobby.id,
    });
    const card = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, cardId));
    await setAccountArchived(actor, cardId, card[0]!.version, true);
    await setCategoryArchived(actor, hobby.id, hobby.version, true);
    futureId = await entry("future", {
      type: "withdrawal",
      date: "2099-01-01",
      payee: "Someday",
      fromAccountId: checkingId,
      amount: "1.00",
    });

    const coffee = await createTransactionTemplate(actor, {
      name: "Coffee",
      draft: {
        type: "withdrawal",
        payee: "Kiosk",
        fromAccountId: checkingId,
        categoryId: groceriesId,
        amount: "3.50",
      },
      notification: { anchorDate: "2026-03-01", time: "08:30" },
    });
    await createTransactionTemplate(actor, {
      name: "Rent",
      draft: { type: "withdrawal", fromAccountId: savingsId, categoryName: "Housing" },
      notification: {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-01-01",
        position: { ordinal: 1, weekday: 1 },
        time: "07:00",
      },
    });
    // The reminder that already went out, which is the watermark the file
    // carries so the copy it moves to does not send it again.
    await db
      .update(templateNotifications)
      .set({ lastNotifiedDate: "2026-03-01", nextNotificationDate: null })
      .where(eq(templateNotifications.templateId, coffee.id));
    // An account id nothing resolves any more, which is what a template made
    // before deleting an account checked its templates still holds. Written
    // beneath the service, because the service now refuses to make one.
    await db
      .update(transactionTemplates)
      .set({
        draft: sql`jsonb_set(${transactionTemplates.draft}, '{fromAccountId}', to_jsonb(gen_random_uuid()::text))`,
      })
      .where(eq(transactionTemplates.name, "Rent"));
    voidedId = await entry("voided", {
      type: "withdrawal",
      date: "2026-02-20",
      payee: "Kiosk",
      fromAccountId: checkingId,
      amount: "3.50",
      categoryId: groceriesId,
      templateId: coffee.id,
    });
    await setTransactionDeleted(actor, voidedId, 1, true);

    await createRecurrence(actor, {
      name: "Pay",
      shape: {
        type: "deposit",
        toAccountId: checkingId,
        amount: "3000.00",
        payee: "Employer",
        categoryId: salaryId,
      },
      schedule: { frequency: "monthly", anchorDate: "2026-01-31", weekendPolicy: "allow" },
    });
    await createRecurrence(actor, {
      name: "Sweep",
      shape: {
        type: "transfer",
        fromAccountId: checkingId,
        toAccountId: savingsId,
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
    await db
      .update(recurrences)
      .set({ lastOccurrenceDate: "2026-09-30" })
      .where(eq(recurrences.name, "Pay"));

    await createBudgetPlan(actor, {
      categoryId: groceriesId,
      currency: "EUR",
      periodUnit: "month",
      amount: "400.00",
      activeFrom: "2026-01-01",
      rollover: true,
      rolloverCap: "200",
    });
    await createBudgetPlan(actor, {
      groupId: home.id,
      currency: "EUR",
      periodUnit: "month",
      amount: "1500.00",
      activeFrom: "2026-01-01",
      lookbackPeriods: 3,
    });
    await setBudgetEntry(actor, {
      categoryId: groceriesId,
      currency: "EUR",
      periodUnit: "month",
      periodStart: "2026-03-01",
      amount: "550.00",
    });

    await createStage(actor, {
      idempotencyKey: "staged-bakery",
      draft: {
        type: "withdrawal",
        date: "2026-10-20",
        payee: "Bäckerei Müller",
        fromAccountId: checkingId,
        amount: 12.5,
        categoryName: "Bakery",
        categoryKind: "expense",
      },
      rawData: { Datum: "20.10.2026", Betrag: "-12,50 €" },
    });
    await createStage(actor, {
      idempotencyKey: "staged-partial",
      draft: {
        type: "transfer",
        sourceAmount: "50.00",
        payee: "To savings",
        toAccountId: savingsId,
      },
    });

    strangerAccountId = (
      await createAccount(stranger, {
        name: "Stranger's purse",
        type: "checking",
        currency: "EUR",
        openingDate: "2025-01-01",
        openingBalance: "7",
      })
    ).id;
    await createTransaction(
      stranger,
      {
        type: "withdrawal",
        date: "2026-02-03",
        payee: "Not yours at all",
        fromAccountId: strangerAccountId,
        amount: "1.00",
      } as never,
      "stranger-entry",
    );
    const [counter] = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        sql`${ledgerAccounts.userId} = ${actor.userId} and ${ledgerAccounts.systemKind} is not null`,
      )
      .limit(1);
    counterAccountId = counter!.id;
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  it("writes a file its own reader accepts, holding every kind that was asked for", async () => {
    const { file, rowCount, fileName } = await exportFile(everything);
    expect(file.scope).toEqual({
      kinds: defaultLedgerFileKinds,
      accounts: "all",
      start: null,
      end: null,
    });
    expect(file.preferences).toEqual({ timezone: TIMEZONE, defaultCurrency: "EUR", theme: "dark" });
    expect(file.throughDate).toBe(todayIn(TIMEZONE));
    expect(fileName).toBe(`simple-balance-${todayIn(TIMEZONE)}.json`);
    expect(file.accounts.map((account) => [account.key, account.detail])).toEqual([
      ["Checking", "full"],
      ["Savings", "full"],
      ["Brokerage", "full"],
      ["Old card", "full"],
    ]);
    expect(file.groups).toEqual([
      { key: "Home", name: "Home", detail: "full", policy: "standalone" },
    ]);
    expect(
      file.categories.map((category) => [category.key, category.kind, category.group]),
    ).toEqual([
      ["Groceries", "expense", "Home"],
      ["Household", "expense", "Home"],
      ["Salary", "income", null],
      ["Market", "both", null],
      ["Old hobby", "expense", null],
      ["GROCERIES (2)", "expense", null],
    ]);
    expect(file.templates.map((template) => template.key)).toEqual(["Coffee", "Rent"]);
    expect(file.recurrences.map((recurrence) => recurrence.key)).toEqual(["Pay", "Sweep"]);
    expect(file.budgets.plans).toHaveLength(2);
    expect(file.budgets.entries).toHaveLength(1);
    expect(file.staged).toHaveLength(2);
    expect(file.history).toBeUndefined();
    // Ten entries, the deleted one among them, because deleted entries are in
    // the default kinds.
    expect(file.entries).toHaveLength(10);
    expect(rowCount).toBe(10 + 2 + 1);
  });

  /**
   * The balance is what the postings hold at the end of the file's last day —
   * so the entry dated 2099 is in the file and not in the figure — and the
   * archived card holds nothing, because archiving posted it out to equity.
   */
  it("checks every whole account against what its postings hold at the end of the file's day", async () => {
    const { file } = await exportFile(everything);
    for (const account of file.accounts) {
      if (account.detail !== "full") continue;
      const id = {
        Checking: checkingId,
        Savings: savingsId,
        Brokerage: brokerageId,
        "Old card": cardId,
      }[account.key]!;
      expect(account.balance, account.key).toBe(await postingSum(id, file.throughDate));
    }
    expect(whole(file, "Old card")).toMatchObject({ balance: "0", inUse: false });
    expect(whole(file, "Checking").balance).not.toBe(await postingSum(checkingId, "2099-01-01"));
    expect(entryById(file, futureId)).toMatchObject({ date: "2099-01-01" });
  });

  it("carries an archived account's instant, and the opening it was declared with", async () => {
    const { file } = await exportFile(everything);
    const [stored] = await getDb()
      .select({ archivedAt: ledgerAccounts.archivedAt })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.id, cardId));
    expect(whole(file, "Old card")).toMatchObject({
      type: "credit_card",
      openingDate: "2025-01-01",
      openingBalance: "-100",
      archivedAt: stored!.archivedAt!.toISOString(),
      carriedForward: null,
    });
    expect(whole(file, "Checking")).toMatchObject({ institution: "Sparkasse", inUse: true });
    expect(whole(file, "Brokerage")).toMatchObject({ currency: "USD", inBudget: false });
  });

  it("writes each entry once, with both sides of a transfer and both amounts of a conversion", async () => {
    const { file } = await exportFile(everything);
    expect(entryById(file, transferId)).toEqual({
      id: transferId,
      type: "transfer",
      date: "2026-02-10",
      from: "Checking",
      to: "Savings",
      sourceAmount: "200",
      destinationAmount: "200",
      payee: "To savings",
    });
    expect(entryById(file, conversionId)).toMatchObject({
      from: "Checking",
      to: "Brokerage",
      sourceAmount: "1000",
      destinationAmount: "1081.4",
    });
    expect(entryById(file, splitId)).toMatchObject({
      legs: [
        { category: "Groceries", amount: "60" },
        { category: "Household", amount: "15", note: "bulbs" },
        { category: null, amount: "5" },
      ],
    });
    expect(entryById(file, splitId)).not.toHaveProperty("category");
    expect(file.entries.find((entry) => entry.payee === "Rewe")).toMatchObject({
      description: "Weekly shop",
      notes: "Receipt in the drawer",
      externalId: "BANK-77",
    });
  });

  /**
   * Read off the postings and compared with what the categories say now. The
   * refund debited expense when it was written; its category takes both kinds
   * today, under which a fresh deposit credits income, so the file says which
   * one this entry actually hit. Nothing else in the ledger disagrees.
   */
  it("says where a refund posted when its category no longer would", async () => {
    const { file } = await exportFile(everything);
    const sides = await getDb().execute(sql`
      select a.system_kind as kind, sum(p.amount)::text as total
      from posting p join ledger_account a on a.user_id = p.user_id and a.id = p.account_id
      where p.user_id = ${actor.userId} and p.transaction_id = ${refundId}::uuid
        and a.system_kind in ('income', 'expense')
      group by a.system_kind
    `);
    expect(sides.rows).toEqual([{ kind: "expense", total: expect.stringMatching(/^-?12\.99/) }]);
    expect(entryById(file, refundId)).toMatchObject({ category: "Market", postedAs: "expense" });
    expect(entryById(file, recategorizedId)).toMatchObject({
      category: "Market",
      postedAs: "expense",
    });
    expect(
      file.entries
        .filter((entry) => "postedAs" in entry)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([refundId, recategorizedId].sort());
  });

  it("carries a deleted entry as deleted, with the template it was made from, only when asked", async () => {
    const { file } = await exportFile(everything);
    expect(entryById(file, voidedId)).toMatchObject({ deleted: true, template: "Coffee" });
    const live = await exportFile({ kinds: ["accounts", "entries"] });
    expect(entryById(live.file, voidedId)).toBeUndefined();
    expect(live.file.entries).toHaveLength(9);
  });

  it("carries templates with their reminders and watermarks, and drops what no longer resolves", async () => {
    const { file } = await exportFile(everything);
    const [coffee, rent] = file.templates;
    expect(coffee).toMatchObject({
      detail: "full",
      draft: {
        type: "withdrawal",
        payee: "Kiosk",
        from: "Checking",
        category: "Groceries",
        amount: "3.50",
      },
      notification: {
        frequency: null,
        anchorDate: "2026-03-01",
        time: "08:30",
        lastNotifiedDate: "2026-03-01",
      },
    });
    // Its account no longer resolves, so the draft keeps everything but that.
    expect(rent).toMatchObject({
      draft: { type: "withdrawal", categoryName: "Housing" },
      notification: {
        frequency: "monthly",
        position: { ordinal: 1, weekday: 1 },
        lastNotifiedDate: null,
      },
    });
    expect(rent).not.toHaveProperty("draft.from");
  });

  it("carries recurrences with their schedules and the last occurrence each decided", async () => {
    const { file } = await exportFile(everything);
    expect(file.recurrences).toEqual([
      {
        key: "Pay",
        name: "Pay",
        shape: {
          type: "deposit",
          to: "Checking",
          amount: "3000.00",
          payee: "Employer",
          description: null,
          category: "Salary",
        },
        schedule: {
          frequency: "monthly",
          interval: 1,
          anchorDate: "2026-01-31",
          monthPolicy: "last_day",
          weekendPolicy: "allow",
          position: null,
        },
        notifyOnCreate: false,
        lastOccurrenceDate: "2026-09-30",
      },
      expect.objectContaining({
        key: "Sweep",
        shape: expect.objectContaining({ type: "transfer", from: "Checking", to: "Savings" }),
        schedule: expect.objectContaining({ position: { ordinal: 2, weekday: 2 } }),
        notifyOnCreate: true,
        lastOccurrenceDate: null,
      }),
    ]);
  });

  it("carries budgets on a category and on a group, and the one period overridden", async () => {
    const { file } = await exportFile(everything);
    expect(file.budgets.plans).toEqual([
      expect.objectContaining({
        category: "Groceries",
        amount: "400",
        rollover: true,
        rolloverCap: "200",
      }),
      expect.objectContaining({ group: "Home", amount: "1500", lookbackPeriods: 3, priority: 0 }),
    ]);
    expect(file.budgets.entries).toEqual([
      {
        category: "Groceries",
        currency: "EUR",
        periodUnit: "month",
        periodStart: "2026-03-01",
        amount: "550",
      },
    ]);
  });

  it("carries rows still waiting in Staged transactions, a number turned into its text", async () => {
    const { file } = await exportFile(everything);
    expect(file.staged.map((row) => row.draft)).toEqual([
      {
        type: "withdrawal",
        date: "2026-10-20",
        from: "Checking",
        amount: "12.5",
        payee: "Bäckerei Müller",
        categoryName: "Bakery",
        categoryKind: "expense",
      },
      { type: "transfer", to: "Savings", sourceAmount: "50.00", payee: "To savings" },
    ]);
    expect(file.staged[0]!.rawData).toEqual({ Datum: "20.10.2026", Betrag: "-12,50 €" });
  });

  it("names records of a kind left out by reference, so the file still resolves", async () => {
    // With the deleted entries, because the one entry made from a template is
    // one of them, and its provenance is what makes the template a reference.
    const { file } = await exportFile({ kinds: ["entries", "deletedEntries"] });
    expect(file.accounts.every((account) => account.detail === "reference")).toBe(true);
    expect(file.accounts.map((account) => account.key)).toEqual([
      "Checking",
      "Savings",
      "Brokerage",
      "Old card",
    ]);
    expect(file.categories.every((category) => category.detail === "reference")).toBe(true);
    expect(file.templates).toEqual([{ key: "Coffee", name: "Coffee", detail: "reference" }]);
    expect(file.preferences).toBeNull();
  });

  /**
   * Checking and Savings chosen together: the transfer between them is one
   * entry, not one per account, and the conversion to the brokerage — which was
   * not chosen — names it as a reference.
   */
  it("writes a transfer between two chosen accounts once, and the far side of another as a reference", async () => {
    const { file, fileName } = await exportFile({
      kinds: ["accounts", "categories", "entries", "deletedEntries"],
      accountIds: [checkingId, savingsId],
    });
    expect(fileName).toBe(`simple-balance-accounts-${todayIn(TIMEZONE)}.json`);
    expect(file.entries.filter((entry) => entry.id === transferId)).toHaveLength(1);
    expect(file.accounts.map((account) => [account.key, account.detail])).toEqual([
      ["Checking", "full"],
      ["Savings", "full"],
      ["Brokerage", "reference"],
    ]);
    expect(file.entries.map((entry) => entry.id)).not.toContain(
      (await exportFile(everything)).file.entries.find((entry) => entry.payee === "Hobby shop")!.id,
    );
    // Only the categories those entries name, whole, with the group they sit in.
    expect(file.categories.map((category) => [category.key, category.detail])).toEqual([
      ["Groceries", "full"],
      ["Household", "full"],
      ["Salary", "full"],
      ["Market", "full"],
    ]);
    expect(file.groups.map((group) => [group.key, group.detail])).toEqual([["Home", "full"]]);
    expect(file.templates).toEqual([{ key: "Coffee", name: "Coffee", detail: "reference" }]);
    for (const account of file.accounts.filter(
      (it): it is Extract<LedgerFileAccount, { detail: "full" }> => it.detail === "full",
    )) {
      const id = account.key === "Checking" ? checkingId : savingsId;
      expect(account.balance).toBe(await postingSum(id, file.throughDate));
    }
  });

  it("opens a ranged file at the balance carried to the day before it starts", async () => {
    const { file } = await exportFile({
      kinds: ["accounts", "entries"],
      accountIds: [checkingId, brokerageId],
      start: "2026-02-04",
      end: "2026-02-28",
    });
    expect(file.throughDate).toBe("2026-02-28");
    expect(
      file.entries.every((entry) => entry.date >= "2026-02-04" && entry.date <= "2026-02-28"),
    ).toBe(true);
    // The first day is in the range, and what it moved is in the entries
    // rather than in the balance carried into it.
    expect(file.entries.map((entry) => entry.id)).toContain(splitId);
    expect(file.entries.map((entry) => entry.payee)).not.toContain("Rewe");
    const checking = whole(file, "Checking");
    expect(checking.carriedForward).toEqual({
      date: "2026-02-04",
      amount: await postingSum(checkingId, "2026-02-03"),
    });
    expect(checking.carriedForward!.amount).not.toBe(await postingSum(checkingId, "2026-02-04"));
    expect(checking.balance).toBe(await postingSum(checkingId, "2026-02-28"));
    // Opened before the range and moved nothing until inside it, so what it
    // carries in is the zero it opened at — carried all the same, because every
    // account of a ranged file opens at what it held, whatever that is.
    expect(whole(file, "Brokerage").carriedForward).toEqual({
      date: "2026-02-04",
      amount: "0",
    });
  });

  it("carries the accounts alone when it is account details only", async () => {
    const { file, rowCount } = await exportFile({ kinds: ["accounts"], accountIds: [savingsId] });
    expect(file.accounts.map((account) => account.key)).toEqual(["Savings"]);
    expect(file.entries).toEqual([]);
    expect(rowCount).toBe(0);
    expect(whole(file, "Savings").balance).toBeUndefined();
  });

  /**
   * The history is the one place source ids travel, because the log is about
   * them, so an event about this person's settings still names them by id. What
   * it never carries is the owner stamped on every snapshot, or which agent did
   * something: both are this copy's, and the walk that drops them is the one
   * every agent's reply already goes through.
   */
  it("keeps the activity history only when asked, without the owner on every snapshot", async () => {
    const { ledgerFile, file } = await exportFile({ kinds: ["history"] });
    expect(file.history!.length).toBeGreaterThan(20);
    expect(file.history![0]).toMatchObject({ actorSource: "web", operation: expect.any(String) });
    expect(ledgerFile).not.toContain('"userId"');
    expect(ledgerFile).not.toContain('"clientId"');
    const withoutHistory = await exportFile(everything);
    expect(withoutHistory.ledgerFile).not.toContain(actor.userId);
  });

  it("shows nobody else's ledger, and finds no account of theirs or of the books' own", async () => {
    const { ledgerFile } = await exportFile({ kinds: [...defaultLedgerFileKinds, "history"] });
    expect(ledgerFile).not.toContain("Stranger");
    expect(ledgerFile).not.toContain("Not yours at all");
    expect(ledgerFile).not.toContain(stranger.userId);
    for (const accountId of [strangerAccountId, counterAccountId]) {
      const error = await refusal(exportFile({ kinds: ["accounts"], accountIds: [accountId] }));
      expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, details: { accountId } });
    }
    // And the other way round: the stranger's own file holds the stranger's
    // ledger and none of this one, with no settings because none were chosen.
    const theirs = await exportLedgerFile(stranger, everything, ROUTE_LIMITS);
    expect(theirs.ledgerFile).not.toContain("Checking");
    const parsed = parseLedgerFileText(theirs.ledgerFile);
    expect(parsed.ok && parsed.file.preferences).toBeNull();
  });

  it("counts before it reads, and refuses a file over the cap with both numbers", async () => {
    const error = await refusal(exportFile(everything, 12));
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", details: { limit: 12, count: 13 } });
    expect(error.message).toContain("export one range at a time");
    // At the cap exactly, nothing is refused.
    await expect(exportFile(everything, 13)).resolves.toMatchObject({ rowCount: 13 });
  });

  it("writes nothing, not even a record that it was asked", async () => {
    const count = async () =>
      (
        await getDb().execute(sql`
          select
            (select count(*)::int from audit_event where user_id = ${actor.userId}) as audit,
            (select count(*)::int from posting where user_id = ${actor.userId}) as postings
        `)
      ).rows[0];
    const before = await count();
    await exportFile({ kinds: [...defaultLedgerFileKinds, "history"] });
    expect(await count()).toEqual(before);
  });

  /**
   * Over a real connection, so the reply is held to the output schema the
   * agent's own SDK compiles. The file is the same file: only the moment it
   * was made differs between two exports of an unchanged ledger.
   */
  it("answers the MCP tool with the same file, held to its published schema", async () => {
    const server = createMcpServer(
      { userId: actor.userId, source: "mcp", clientId: "ledger-file-agent" },
      new Set(["ledger:read"]),
    );
    const client = new Client({ name: "ledger-file", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.listTools();
      const reply = await client.callTool({ name: "export_ledger_file", arguments: everything });
      const whole = JSON.stringify(reply);
      expect(whole).not.toContain("Output validation error");
      expect(reply.isError, whole).toBeFalsy();
      const result = (
        reply.structuredContent as {
          result: { ledgerFile: string; rowCount: number; fileName: string };
        }
      ).result;
      const direct = await exportLedgerFile(actor, everything, ROUTE_LIMITS);
      const withoutInstant = (text: string) => text.replace(/"exportedAt": "[^"]+"/, "");
      expect(withoutInstant(result.ledgerFile)).toBe(withoutInstant(direct.ledgerFile));
      expect(result).toMatchObject({ rowCount: direct.rowCount, fileName: direct.fileName });

      // The tool's own cap is one import part's worth, and a refusal is an
      // error result carrying the same numbers.
      const refused = await client.callTool({
        name: "export_ledger_file",
        arguments: { kinds: ["accounts"], accountIds: [strangerAccountId] },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        result: { error: { code: "NOT_FOUND", details: { accountId: strangerAccountId } } },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  /**
   * Ledgers of their own, so what these need does not move the counts and
   * lists every test above holds the main one to.
   */
  describe("a range against what the file has to carry", () => {
    const late: Actor = { userId: "ledger-file-late", source: "web" };
    const ahead: Actor = { userId: "ledger-file-ahead", source: "web" };
    const keeper: Actor = { userId: "ledger-file-keeper", source: "web" };
    let lateId = "";
    let insideId = "";
    let plainId = "";
    let aheadToday = "";

    /** What an entry moved in or out of one account, signed the way its postings are. */
    const movedOn = (entry: LedgerFile["entries"][number], key: string) => {
      if (entry.deleted) return new Decimal(0);
      if (entry.type === "transfer") {
        if (entry.from === key) return new Decimal(entry.sourceAmount).neg();
        return entry.to === key ? new Decimal(entry.destinationAmount) : new Decimal(0);
      }
      if (entry.type === "deposit") return new Decimal(entry.to === key ? entry.amount : 0);
      return new Decimal(entry.from === key ? entry.amount : 0).neg();
    };

    beforeAll(async () => {
      const db = getDb();
      for (const person of [late, ahead, keeper]) {
        const email = `${person.userId}@example.com`;
        await db
          .insert(user)
          .values({ id: person.userId, name: email, email, emailVerified: true });
      }

      // Opened on the day somebody first used the product, then filled from
      // statements older than that: the form's opening date is today by
      // default, and nothing refuses an entry dated before it.
      lateId = (
        await createAccount(late, {
          name: "Late opened",
          type: "checking",
          currency: "EUR",
          openingDate: "2026-10-01",
          openingBalance: "100",
        })
      ).id;
      insideId = (
        await createAccount(late, {
          name: "Opened inside",
          type: "checking",
          currency: "EUR",
          openingDate: "2026-07-15",
          openingBalance: "10",
        })
      ).id;
      const write = (as: Actor, key: string, draft: Record<string, unknown>) =>
        createTransaction(as, draft as never, key, true);
      await write(late, "late-before", {
        type: "withdrawal",
        date: "2026-03-01",
        payee: "Old statement",
        fromAccountId: lateId,
        amount: "20.00",
      });
      await write(late, "late-inside", {
        type: "deposit",
        date: "2026-07-01",
        payee: "Old statement",
        toAccountId: lateId,
        amount: "50.00",
      });
      await write(late, "inside-inside", {
        type: "withdrawal",
        date: "2026-08-01",
        payee: "Kiosk",
        fromAccountId: insideId,
        amount: "5.00",
      });

      await setPreferences(ahead, { timezone: TIMEZONE, defaultCurrency: "EUR", theme: "system" });
      aheadToday = todayIn(TIMEZONE);
      plainId = (
        await createAccount(ahead, {
          name: "Plain",
          type: "checking",
          currency: "EUR",
          openingDate: "2025-01-01",
          openingBalance: "1000",
        })
      ).id;
      await write(ahead, "ahead-gap", {
        type: "withdrawal",
        date: addDays(aheadToday, 10),
        payee: "Scheduled",
        fromAccountId: plainId,
        amount: "3.00",
      });
      await write(ahead, "ahead-inside", {
        type: "withdrawal",
        date: addDays(aheadToday, 30),
        payee: "Scheduled",
        fromAccountId: plainId,
        amount: "7.00",
      });

      // Pacific time, which is eight hours behind UTC in early March, and
      // events either side of both ends of the first of March there.
      await setPreferences(keeper, {
        timezone: "America/Los_Angeles",
        defaultCurrency: "USD",
        theme: "system",
      });
      const event = (operation: string, createdAt: string, after: unknown = { payee: operation }) =>
        ({
          userId: keeper.userId,
          actorSource: "web",
          entityType: "transaction",
          entityId: operation,
          operation,
          before: null,
          after,
          createdAt: new Date(createdAt),
        }) as const;
      await db
        .insert(auditEvents)
        .values([
          event("before-the-day", "2026-03-01T07:59:59.999Z"),
          event("first-moment", "2026-03-01T08:00:00.000Z"),
          event("last-moment", "2026-03-02T07:59:59.999Z"),
          event("next-day", "2026-03-02T08:00:00.000Z"),
          event("long-note", "2026-04-01T12:00:00.000Z", { notes: "x".repeat(5_000) }),
        ]);
    });

    /**
     * Money dated before both the account's opening and the range is in the
     * balance and in no entry, so it is carried, and a copy rebuilt from the
     * carry, the entries and the opening reaches the balance the file checks.
     */
    it("carries what an account held before the range, whenever it was opened", async () => {
      const { file } = await exportFile(
        {
          kinds: ["accounts", "entries"],
          accountIds: [lateId, insideId],
          start: "2026-06-01",
          end: "2026-09-30",
        },
        ROUTE_CAP,
        LEDGER_FILE_HISTORY_MAX_BYTES,
        late,
      );
      expect(file.throughDate).toBe("2026-09-30");
      const lateOpened = whole(file, "Late opened");
      expect(lateOpened.carriedForward).toEqual({
        date: "2026-06-01",
        amount: await postingSum(lateId, "2026-05-31", late),
      });
      expect(lateOpened.carriedForward!.amount).toBe("-20");
      // Opened inside the range with nothing before it: a carry of nothing,
      // carried all the same, because every account of a ranged file has one.
      expect(whole(file, "Opened inside").carriedForward).toEqual({
        date: "2026-06-01",
        amount: "0",
      });
      for (const [key, id] of [
        ["Late opened", lateId],
        ["Opened inside", insideId],
      ] as const) {
        const account = whole(file, key);
        expect(account.balance).toBe(await postingSum(id, file.throughDate, late));
        const rebuilt = file.entries
          .reduce((total, entry) => total.plus(movedOn(entry, key)), new Decimal(0))
          .plus(account.carriedForward!.amount)
          .plus(account.openingDate <= file.throughDate ? account.openingBalance : 0);
        expect(canonicalDecimal(rebuilt.toFixed()), key).toBe(account.balance);
      }

      // The same ledger as Everything with the range, and a range on the
      // history alone, which carries nothing forward: it has no entries to add
      // up, and so no balance for a carry to reach.
      const everythingRanged = await exportFile(
        { kinds: ["accounts", "entries"], start: "2026-06-01", end: "2026-09-30" },
        ROUTE_CAP,
        LEDGER_FILE_HISTORY_MAX_BYTES,
        late,
      );
      expect(whole(everythingRanged.file, "Late opened").carriedForward?.amount).toBe("-20");
      const historyRanged = await exportFile(
        { kinds: ["accounts", "history"], start: "2026-06-01" },
        ROUTE_CAP,
        LEDGER_FILE_HISTORY_MAX_BYTES,
        late,
      );
      for (const account of historyRanged.file.accounts) {
        expect(account).toMatchObject({ carriedForward: null });
        expect(account.detail === "full" && account.balance).toBe(undefined);
      }
    });

    /**
     * Its checks would describe today, a day before the range, when a copy
     * rebuilt from it holds nothing yet. The carry still counts the scheduled
     * money between today and the first day, because those entries are not in
     * the file either.
     */
    it("writes no balance check for a range that starts after today", async () => {
      const start = addDays(aheadToday, 20);
      const { file } = await exportFile(
        { kinds: ["accounts", "entries"], start },
        ROUTE_CAP,
        LEDGER_FILE_HISTORY_MAX_BYTES,
        ahead,
      );
      expect(file.throughDate).toBe(aheadToday);
      const plain = whole(file, "Plain");
      expect(plain.balance).toBeUndefined();
      expect(plain.carriedForward).toEqual({
        date: start,
        amount: await postingSum(plainId, addDays(start, -1), ahead),
      });
      expect(plain.carriedForward!.amount).toBe("997");
      expect(file.entries.map((entry) => entry.date)).toEqual([addDays(aheadToday, 30)]);

      // The first day the range is already open on is today, and from there the
      // check is back: a copy opened today at the carry holds it today.
      const tomorrow = await exportFile(
        { kinds: ["accounts", "entries"], start: addDays(aheadToday, 1) },
        ROUTE_CAP,
        LEDGER_FILE_HISTORY_MAX_BYTES,
        ahead,
      );
      expect(whole(tomorrow.file, "Plain").balance).toBeUndefined();
      const fromToday = await exportFile(
        { kinds: ["accounts", "entries"], start: aheadToday },
        ROUTE_CAP,
        LEDGER_FILE_HISTORY_MAX_BYTES,
        ahead,
      );
      expect(whole(fromToday.file, "Plain").balance).toBe(
        await postingSum(plainId, aheadToday, ahead),
      );
    });

    /**
     * The range narrows the history by the day its events happened where the
     * person lives, in the count as in the read, so a history over the cap has
     * a way out and the refusal names it.
     */
    it("narrows the activity history to the days of the range, where the person lives", async () => {
      const day = { kinds: ["history"], start: "2026-03-01", end: "2026-03-01" };
      const { file } = await exportFile(day, 2, LEDGER_FILE_HISTORY_MAX_BYTES, keeper);
      expect(file.history!.map((event) => event.operation)).toEqual([
        "first-moment",
        "last-moment",
      ]);
      expect(file.scope).toMatchObject({ kinds: ["history"], start: "2026-03-01" });

      const refused = await refusal(exportFile({ kinds: ["history"] }, 2, Infinity, keeper));
      expect(refused).toMatchObject({ code: "VALIDATION_ERROR", details: { limit: 2 } });
      expect(refused.message).toContain(
        "activity events, and one export holds at most 2. Narrow the activity history with a start and end date, and export one range at a time.",
      );
    });

    it("refuses a history whose snapshots outweigh their limit, and lets a range through", async () => {
      const error = await refusal(exportFile({ kinds: ["history"] }, ROUTE_CAP, 4_000, keeper));
      expect(error).toMatchObject({ code: "VALIDATION_ERROR", details: { limit: 4_000 } });
      expect((error.details as { bytes: number }).bytes).toBeGreaterThan(5_000);
      expect(error.message).toContain(
        "Narrow the activity history with a start and end date, and export one range at a time.",
      );
      const { file } = await exportFile(
        { kinds: ["history"], start: "2026-03-01", end: "2026-03-02" },
        ROUTE_CAP,
        4_000,
        keeper,
      );
      expect(file.history!.map((event) => event.operation)).toEqual([
        "first-moment",
        "last-moment",
        "next-day",
      ]);
    });
  });
});
