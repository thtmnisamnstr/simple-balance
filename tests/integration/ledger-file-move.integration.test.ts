import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import {
  defaultLedgerFileKinds,
  ledgerFileRowCount,
  parseLedgerFileText,
  serializeLedgerFile,
  splitLedgerFile,
  type LedgerFile,
  type LedgerFileEntry,
} from "../../src/shared/ledger-file.js";
import {
  LEDGER_FILE_MOVE_BLOCKED,
  ledgerBudgetPlanKey,
  type LedgerFileDrift,
} from "../../src/shared/ledger-file-import.js";
import type { LedgerFileMoveResult } from "../../src/shared/ledger-file-move.js";
import { addDays, todayIn } from "../../src/shared/recurrence-dates.js";
import { LEDGER_FILE_HISTORY_MAX_BYTES } from "../../src/server/config-limits.js";
import { getDb } from "../../src/server/db/client.js";
import {
  auditEvents,
  categories,
  ledgerAccounts,
  recurrences,
  stagedTransactions,
  templateNotifications,
  transactionTemplates,
  transactions,
  user,
} from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { ledgerFileRowsMoved, ledgerFileRowsStaged } from "../../src/server/metrics.js";
import { createAccount, setAccountArchived } from "../../src/server/services/accounts.js";
import {
  createBudgetPlan,
  getBudgetReport,
  setBudgetEntry,
  type BudgetReportView,
} from "../../src/server/services/budgets.js";
import {
  createCategory,
  setCategoryArchived,
  updateCategory,
} from "../../src/server/services/categories.js";
import { createCategoryGroup } from "../../src/server/services/category-groups.js";
import { AppError } from "../../src/server/services/errors.js";
import { canonicalDecimal, decimal } from "../../src/server/services/helpers.js";
import {
  addLedgerFile,
  exportLedgerFile,
  moveLedgerFile,
  previewLedgerFile,
} from "../../src/server/services/ledger-file.js";
import { runDueNotifications } from "../../src/server/services/notifications.js";
import { getPreferences, setPreferences } from "../../src/server/services/preferences.js";
import { createRecurrence, runDueRecurrences } from "../../src/server/services/recurrences.js";
import { commitStages, createStage } from "../../src/server/services/staging.js";
import { createTransactionTemplate } from "../../src/server/services/transaction-templates.js";
import {
  createTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * Moving a Simple Balance file straight into the books, against a real
 * database and the real exporter: a ledger holding every kind of record is
 * exported and moved into an empty one, whole and in parts, and the books it
 * makes are compared with the books it came from posting by posting.
 *
 * What makes the move trustworthy is asserted by outcome, day by day: every
 * account holds on every day what it held where the file came from, archived
 * ones closed on the day they closed there; a deleted entry is history that
 * nets to nothing; a spent reminder stays spent and a proposed occurrence is
 * not proposed again; the budgets report the same; and the ledger the move
 * made exports as the file it was made from. Where it differs, it differs only
 * as the plan said it would — a refund whose category was widened since posts
 * by the kind it has now, and the plan's drift says by how much.
 */

const sent: { to?: string; subject?: string; body?: string }[] = [];
vi.mock("../../src/server/mail.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/mail.js")>();
  return {
    ...real,
    mailEnabled: () => true,
    sendMail: async (message: { to: string; subject: string; body: string }) => {
      sent.push(message);
      return true;
    },
  };
});

/**
 * The one race a move cannot be made to lose through the services: another
 * import writing a transaction under the same origin between this part's
 * lookup and its write. Armed with an origin, the next write of it is made
 * twice, so PostgreSQL's own unique index refuses the second exactly as it
 * would refuse the loser of the race.
 */
const race: { origin: string | null } = { origin: null };
vi.mock("../../src/server/services/transactions.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/services/transactions.js")>();
  return {
    ...real,
    createTransactionWithinTx: async (
      ...args: Parameters<typeof real.createTransactionWithinTx>
    ) => {
      const options = args[5];
      if (race.origin !== null && options?.importOrigin === race.origin) {
        race.origin = null;
        await real.createTransactionWithinTx(...args);
      }
      return real.createTransactionWithinTx(...args);
    },
  };
});

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ledger_file_move");
const TIMEZONE = "Europe/Berlin";
const LIMITS = { maxRows: 100_000, maxHistoryBytes: LEDGER_FILE_HISTORY_MAX_BYTES };
const everything = { kinds: defaultLedgerFileKinds.filter((kind) => kind !== "history") };

const person = (id: string): Actor => ({ userId: `lf-move-${id}`, source: "web" });
const source = person("source");
const small = person("small");
const stranger = person("stranger");

let wholeFile = "";
let parsedWhole: LedgerFile;
let smallFile = "";
let parsedSmall: LedgerFile;
const ids: Record<string, string> = {};
let strangerAccountId = "";
const today = () => todayIn(TIMEZONE);

async function seedUser(actor: Actor) {
  await getDb()
    .insert(user)
    .values({ id: actor.userId, name: actor.userId, email: `${actor.userId}@example.com` });
}

function read(text: string): LedgerFile {
  const parsed = parseLedgerFileText(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.file;
}

const exportOf = async (actor: Actor) =>
  (await exportLedgerFile(actor, everything, LIMITS)).ledgerFile;

const move = (
  actor: Actor,
  ledgerFile: string,
  extra: Record<string, unknown> = {},
): Promise<LedgerFileMoveResult> =>
  moveLedgerFile(actor, {
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

/** A count of everything a person owns, so a refused part can be shown to have written nothing. */
async function footprint(actor: Actor) {
  const result = await getDb().execute(sql`
    select
      (select count(*) from ledger_account where user_id = ${actor.userId})::int as accounts,
      (select count(*) from category where user_id = ${actor.userId})::int as categories,
      (select count(*) from category_group where user_id = ${actor.userId})::int as groups,
      (select count(*) from transaction_template where user_id = ${actor.userId})::int as templates,
      (select count(*) from template_notification where user_id = ${actor.userId})::int as reminders,
      (select count(*) from recurrence where user_id = ${actor.userId})::int as recurrences,
      (select count(*) from budget_plan where user_id = ${actor.userId})::int as plans,
      (select count(*) from budget_entry where user_id = ${actor.userId})::int as amounts,
      (select count(*) from ledger_transaction where user_id = ${actor.userId})::int as entries,
      (select count(*) from transaction_leg where user_id = ${actor.userId})::int as legs,
      (select count(*) from staged_transaction where user_id = ${actor.userId})::int as staged,
      (select count(*) from import_batch where user_id = ${actor.userId})::int as batches,
      (select count(*) from posting where user_id = ${actor.userId})::int as postings,
      (select count(*) from audit_event where user_id = ${actor.userId})::int as audit,
      (select count(*) from user_preferences where user_id = ${actor.userId})::int as settings
  `);
  return result.rows[0];
}

/**
 * Every account's postings netted by day: a person's account by its name, the
 * ledger's own by kind and currency, and a day that nets to nothing left out.
 * Two ledgers that agree on this agree on every account's balance on every
 * day, since a balance on a day is the sum of these up to it.
 */
async function postingsByDay(actor: Actor, { closings }: { closings: boolean }) {
  const result = await getDb().execute(sql`
    select case when a.system_kind is null then a.name
                else a.system_kind || ':' || a.currency end as account,
           p.date::text as day,
           sum(p.amount)::text as total
      from posting p
      join ledger_account a on a.user_id = p.user_id and a.id = p.account_id
     where p.user_id = ${actor.userId}
       and (${closings} or p.closing_account_id is null)
     group by 1, 2
    having sum(p.amount) <> 0
  `);
  return new Map(
    (result.rows as { account: string; day: string; total: string }[]).map((row) => [
      `${row.account} ${row.day}`,
      canonicalDecimal(row.total),
    ]),
  );
}

/**
 * The source's books as the moved ledger has to hold them: the same, except
 * that each refund the file marked `postedAs` posts its other half to the side
 * the categories here choose, on its own day. That is the drift a move reports
 * rather than reproduces, so the difference is worked out from the file and
 * then held to the plan's own `drift`.
 */
function expectedAfterDrift(
  books: ReadonlyMap<string, string>,
  file: LedgerFile,
  drift: readonly LedgerFileDrift[],
) {
  const expected = new Map(books);
  const bump = (key: string, by: ReturnType<typeof decimal>) => {
    const next = decimal(expected.get(key) ?? "0").plus(by);
    if (next.isZero()) expected.delete(key);
    else expected.set(key, canonicalDecimal(next));
  };
  const currencyOf = new Map(file.accounts.map((account) => [account.key, account.currency]));
  const totals = new Map<string, ReturnType<typeof decimal>>();
  for (const entry of file.entries) {
    if (entry.deleted || entry.type === "transfer" || entry.postedAs === undefined) continue;
    const currency = currencyOf.get(entry.type === "deposit" ? entry.to : entry.from)!;
    const group = drift.find(
      (each) =>
        each.currency === currency && each.type === entry.type && each.from === entry.postedAs,
    )!;
    // A deposit credits its counter-account and a withdrawal debits it.
    const counter = decimal(entry.amount).times(entry.type === "deposit" ? -1 : 1);
    bump(`${group.from}:${currency} ${entry.date}`, counter.negated());
    bump(`${group.to}:${currency} ${entry.date}`, counter);
    const slot = `${currency}|${entry.type}|${group.from}|${group.to}`;
    totals.set(slot, (totals.get(slot) ?? decimal("0")).plus(entry.amount));
  }
  expect(
    drift.map((group) => ({
      slot: `${group.currency}|${group.type}|${group.from}|${group.to}`,
      amount: canonicalDecimal(group.amount),
    })),
  ).toEqual([...totals].map(([slot, amount]) => ({ slot, amount: canonicalDecimal(amount) })));
  return expected;
}

/** Income and spending by category and month, from the postings, by category name. */
async function byCategoryAndMonth(actor: Actor) {
  const result = await getDb().execute(sql`
    select coalesce(c.name, '(none)') as category,
           to_char(p.date, 'YYYY-MM') as month,
           a.system_kind as side,
           sum(p.amount)::text as total
      from posting p
      join ledger_account a on a.user_id = p.user_id and a.id = p.account_id
      join ledger_transaction t on t.user_id = p.user_id and t.id = p.transaction_id
      left join transaction_leg l on l.user_id = p.user_id and l.id = p.leg_id
      left join category c
        on c.user_id = p.user_id and c.id = coalesce(l.category_id, t.category_id)
     where p.user_id = ${actor.userId} and a.system_kind in ('income', 'expense')
     group by 1, 2, 3
    having sum(p.amount) <> 0
  `);
  return new Map(
    (result.rows as { category: string; month: string; side: string; total: string }[]).map(
      (row) => [`${row.category} ${row.month} ${row.side}`, canonicalDecimal(row.total)],
    ),
  );
}

/**
 * Every id a person's records go by, as words both ledgers share, so two
 * reports can be compared once their ids, which two ledgers assign apart, are
 * read as what they stand for.
 */
async function labels(actor: Actor) {
  const result = await getDb().execute(sql`
    select id::text as id, 'category:' || name as label from category where user_id = ${actor.userId}
    union all
    select id::text, 'group:' || name from category_group where user_id = ${actor.userId}
    union all
    select id::text, case when system_kind is null then 'account:' || name
                          else 'counter:' || system_kind || ':' || currency end
      from ledger_account where user_id = ${actor.userId}
    union all
    select p.id::text,
           'plan:' || coalesce(c.name, g.name) || ':' || p.currency || ':' || p.active_from
      from budget_plan p
      left join category c on c.user_id = p.user_id and c.id = p.category_id
      left join category_group g on g.user_id = p.user_id and g.id = p.group_id
     where p.user_id = ${actor.userId}
    union all
    select id::text, 'template:' || name from transaction_template where user_id = ${actor.userId}
    union all
    select id::text, 'recurrence:' || name from recurrence where user_id = ${actor.userId}
    union all
    select id::text, 'entry:' || coalesce(import_origin, id)::text
      from ledger_transaction where user_id = ${actor.userId}
  `);
  return new Map(
    (result.rows as { id: string; label: string }[]).map((row) => [row.id, row.label]),
  );
}

const relabeled = (value: unknown, names: ReadonlyMap<string, string>) =>
  JSON.parse(
    JSON.stringify(value).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      (id) => names.get(id) ?? id,
    ),
  ) as unknown;

/**
 * A file in the form two ledgers' exports of one ledger can be compared in:
 * without the instant it was made, and with each list of records, and the
 * staged rows, in key order. Records created in one part share the instant
 * its transaction began, so a ledger a move made lists them by id where the
 * one it came from lists them in the order they were made; the keys and
 * every reference between them are the same either way.
 */
function comparable(text: string) {
  const file = read(text);
  const by = <T>(rows: readonly T[], key: (row: T) => string) =>
    [...rows].sort((left, right) => (key(left) < key(right) ? -1 : 1));
  const byKey = <T extends { key: string }>(rows: readonly T[]) => by(rows, (row) => row.key);
  return {
    ...file,
    exportedAt: null,
    groups: byKey(file.groups),
    categories: byKey(file.categories),
    accounts: byKey(file.accounts),
    templates: byKey(file.templates),
    recurrences: byKey(file.recurrences),
    budgets: {
      plans: by(file.budgets.plans, ledgerBudgetPlanKey),
      entries: by(
        file.budgets.entries,
        (entry) =>
          `${entry.category ?? ""}|${entry.group ?? ""}|${entry.currency}|${entry.periodStart}`,
      ),
    },
    staged: by(file.staged, (row) => row.id),
  };
}

/** An agent's connection over the real MCP protocol, in memory. */
async function connectAgent(actor: Actor, scopes: string[]) {
  const server = createMcpServer(
    { ...actor, source: "mcp", clientId: "ledger-file-move-agent" },
    new Set(scopes),
  );
  const client = new Client({ name: "ledger-file-move", version: "1.0.0" });
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

/** Pinned, for the writes that have to have happened on a day in the past. */
const at = (instant: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
};

/** The file cut into three parts by the splitter itself, with its limits lowered. */
function inThree(file: LedgerFile) {
  const split = splitLedgerFile(file, {
    maxRows: Math.ceil(ledgerFileRowCount(file) / 3),
    maxBytes: 16 * 1024 * 1024,
  });
  if (!split.ok) throw new Error(split.message);
  return split.parts.map(serializeLedgerFile);
}

integration("moving a Simple Balance file straight into the books", () => {
  beforeAll(async () => {
    await database.create();
    const db = getDb();
    for (const id of [
      "source",
      "small",
      "stranger",
      "whole",
      "parts",
      "typed",
      "waiting",
      "refused",
      "race",
      "agent",
      "scoped",
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

    // A one-time reminder that goes out at the sweep below, and a monthly one
    // that has not come round yet.
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
    await createTransactionTemplate(source, {
      name: "Rent",
      draft: { type: "withdrawal", fromAccountId: ids.savings, categoryName: "Housing" },
      notification: {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2027-01-01",
        position: { ordinal: 1, weekday: 1 },
        time: "07:00",
      },
    });

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
    // A split with a leg filed nowhere.
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
    await entry("transfer", {
      type: "transfer",
      date: "2026-02-10",
      payee: "To savings",
      fromAccountId: ids.checking,
      toAccountId: ids.savings,
      sourceAmount: "200.00",
    });
    // A conversion, with both amounts that actually moved.
    await entry("conversion", {
      type: "transfer",
      date: "2026-02-12",
      payee: "Broker",
      fromAccountId: ids.checking,
      toAccountId: ids.brokerage,
      sourceAmount: "1000.00",
      destinationAmount: "1081.40",
    });
    // A refund against a spending category's kind, which debits spending.
    await entry("refund", {
      type: "deposit",
      date: "2026-02-14",
      payee: "Rewe",
      toAccountId: ids.checking,
      amount: "9.99",
      categoryId: ids.groceries,
    });
    // A refund filed under a category widened afterwards: it posted to
    // spending, and a fresh one under "both" would be income.
    ids.drifted = await entry("drifted", {
      type: "deposit",
      date: "2026-02-15",
      payee: "Market hall",
      toAccountId: ids.checking,
      amount: "12.99",
      categoryId: market.id,
    });
    await updateCategory(source, market.id, { kind: "both", expectedVersion: market.version });
    // Two coffees on one morning, alike in every field the duplicate check reads.
    for (const key of ["coffee-one", "coffee-two"]) {
      await entry(key, {
        type: "withdrawal",
        date: "2026-02-21",
        payee: "Kiosk",
        fromAccountId: ids.checking,
        amount: "3.50",
        categoryId: ids.groceries,
        templateId: coffee.id,
      });
    }
    // Made from a template, and deleted.
    ids.coffeeDeleted = await entry("coffee-deleted", {
      type: "withdrawal",
      date: "2026-02-22",
      payee: "Kiosk",
      fromAccountId: ids.checking,
      amount: "3.50",
      categoryId: ids.groceries,
      templateId: coffee.id,
    });
    await setTransactionDeleted(source, ids.coffeeDeleted, 1, true);
    // The archived account's history, either side of the day it is archived.
    await entry("card-before", {
      type: "withdrawal",
      date: "2026-01-15",
      payee: "Hobby shop",
      fromAccountId: ids.card,
      amount: "20.00",
      categoryId: hobby.id,
    });
    ids.cardDeleted = await entry("card-deleted", {
      type: "withdrawal",
      date: "2026-02-20",
      payee: "Kiosk",
      fromAccountId: ids.card,
      amount: "4.00",
      categoryId: ids.groceries,
    });
    await entry("card-after", {
      type: "withdrawal",
      date: "2026-04-01",
      payee: "Lamp shop",
      fromAccountId: ids.card,
      amount: "7.00",
      categoryId: ids.household,
    });
    await entry("hobby-after", {
      type: "withdrawal",
      date: "2026-04-02",
      payee: "Hobby shop",
      fromAccountId: ids.checking,
      amount: "6.00",
      categoryId: hobby.id,
    });
    // Edited once, so its postings are a delta on a delta.
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
    // Scheduled: dated after today, so no balance today counts it.
    await entry("scheduled", {
      type: "withdrawal",
      date: addDays(today(), 40),
      payee: "Insurance",
      fromAccountId: ids.checking,
      amount: "120.00",
      categoryId: ids.household,
    });

    // Archived on days in the past, and the card's deleted entry deleted after
    // it was archived, so its close is the re-close a void makes.
    at("2026-03-15T10:00:00.000Z");
    const card = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, ids.card));
    await setAccountArchived(source, ids.card, card[0]!.version, true);
    at("2026-03-20T10:00:00.000Z");
    await setCategoryArchived(source, hobby.id, hobby.version, true);
    vi.useRealTimers();
    await setTransactionDeleted(source, ids.cardDeleted, 1, true);

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
    // Due today, and proposed today by the sweep below.
    await createRecurrence(source, {
      name: "Market day",
      shape: {
        type: "withdrawal",
        fromAccountId: ids.checking,
        amount: "25.00",
        payee: "Farmers market",
        categoryId: ids.groceries,
      },
      schedule: { frequency: "weekly", anchorDate: today() },
    });

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

    // The reminder goes out, and the recurrence proposes today's occurrence:
    // the two watermarks a move has to carry.
    sent.length = 0;
    await runDueNotifications();
    expect(sent.length).toBeGreaterThan(0);
    await runDueRecurrences();

    // A stranger with an account like the source's and an entry of their own.
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

    // A small ledger for the refusals, the race and the agent.
    const smallChecking = (ids.smallChecking = (
      await createAccount(small, {
        name: "Checking",
        type: "checking",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "100",
      })
    ).id);
    const smallSavings = (
      await createAccount(small, {
        name: "Savings",
        type: "savings",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    const food = await createCategory(small, { name: "Food", kind: "expense" });
    const smallEntry = async (key: string, draft: Record<string, unknown>) =>
      (await createTransaction(small, draft as never, `small-${key}`)).id;
    await smallEntry("pay", {
      type: "deposit",
      date: "2026-02-01",
      payee: "Employer",
      toAccountId: smallChecking,
      amount: "100.00",
    });
    await smallEntry("food", {
      type: "withdrawal",
      date: "2026-02-02",
      payee: "Shop",
      fromAccountId: smallChecking,
      amount: "20.00",
      categoryId: food.id,
    });
    await smallEntry("sweep", {
      type: "transfer",
      date: "2026-02-03",
      payee: "Sweep",
      fromAccountId: smallChecking,
      toAccountId: smallSavings,
      sourceAmount: "30.00",
    });
    const mistake = await smallEntry("mistake", {
      type: "withdrawal",
      date: "2026-02-04",
      payee: "Mistake",
      fromAccountId: smallChecking,
      amount: "5.00",
    });
    await setTransactionDeleted(small, mistake, 1, true);
    await createStage(small, {
      idempotencyKey: "small-staged",
      draft: { type: "withdrawal", date: "2026-02-05", payee: "Later", amount: "1.00" },
    });
    smallFile = await exportOf(small);
    parsedSmall = read(smallFile);
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  afterEach(() => {
    vi.useRealTimers();
    race.origin = null;
  });

  it("carries what a move needs: deleted entries, archive instants, both watermarks", () => {
    expect(
      parsedWhole.entries
        .filter((each) => each.deleted)
        .map((each) => each.id)
        .sort(),
    ).toEqual([ids.coffeeDeleted, ids.cardDeleted].sort());
    expect(parsedWhole.accounts.find((each) => each.key === "Old card")).toMatchObject({
      archivedAt: "2026-03-15T10:00:00.000Z",
      balance: "0",
    });
    expect(parsedWhole.categories.find((each) => each.key === "Old hobby")).toMatchObject({
      archivedAt: "2026-03-20T10:00:00.000Z",
    });
    expect(parsedWhole.recurrences.find((each) => each.key === "Market day")).toMatchObject({
      lastOccurrenceDate: today(),
    });
    const coffee = parsedWhole.templates.find((each) => each.key === "Coffee")!;
    expect(coffee.detail === "full" && coffee.notification?.lastNotifiedDate).toBeTruthy();
    expect(parsedWhole.entries.find((each) => each.id === ids.drifted)).toMatchObject({
      postedAs: "expense",
    });
    // The queued row and today's proposal both wait in the file.
    expect(parsedWhole.staged.length).toBe(2);
  });

  it("previews an empty ledger as one a move may go into, writing nothing", async () => {
    const whole = person("whole");
    const before = await footprint(whole);
    const preview = await previewLedgerFile(whole, { ledgerFile: wholeFile });
    expect(await footprint(whole)).toEqual(before);
    expect(preview.move).toEqual({ qualifies: true, reason: null });
    expect(preview.movePlan.ok).toBe(true);
    const live = parsedWhole.entries.filter((each) => !each.deleted).length;
    expect(preview.movePlan.move).toMatchObject({
      toWrite: live,
      toVoid: 2,
      alreadyHere: 0,
      waiting: 0,
      templateDropped: 0,
      recurrencesDeferred: 0,
    });
    const balance = (key: string) => {
      const account = parsedWhole.accounts.find((each) => each.key === key)!;
      return account.detail === "full" ? account.balance : undefined;
    };
    expect(preview.movePlan.move!.checks).toEqual([
      {
        key: "Checking",
        name: "Checking",
        currency: "EUR",
        balance: balance("Checking"),
        compared: true,
      },
      {
        key: "Savings",
        name: "Savings",
        currency: "EUR",
        balance: balance("Savings"),
        compared: true,
      },
      { key: "Brokerage", name: "Brokerage", currency: "USD", balance: "1081.4", compared: true },
      { key: "Old card", name: "Old card", currency: "EUR", balance: "0", compared: false },
    ]);
    expect(preview.movePlan.move!.drift).toEqual([
      {
        currency: "EUR",
        type: "deposit",
        from: "expense",
        to: "income",
        entries: 1,
        amount: "12.99",
        categories: ["Market"],
      },
    ]);
  });

  it("moves a whole ledger in one part, and the books are the ones it came from", async () => {
    const whole = person("whole");
    const counted = async () => ({
      moved: (await ledgerFileRowsMoved.get()).values[0]?.value ?? 0,
      staged: (await ledgerFileRowsStaged.get()).values[0]?.value ?? 0,
    });
    const before = await counted();
    const key = randomUUID();
    const result = await move(whole, wholeFile, { idempotencyKey: key });
    const live = parsedWhole.entries.filter((each) => !each.deleted).length;
    // Counted once the part has committed, the voided ones included, and
    // never again for a replay of it.
    expect(await counted()).toEqual({
      moved: before.moved + parsedWhole.entries.length,
      staged: before.staged + 2,
    });
    expect(await move(whole, wholeFile, { idempotencyKey: key })).toEqual(result);
    expect(await counted()).toEqual({
      moved: before.moved + parsedWhole.entries.length,
      staged: before.staged + 2,
    });
    expect(result).toMatchObject({
      part: { index: 1, count: 1 },
      written: { entries: live, deleted: 2 },
      skipped: { entries: 0, deleted: 0, staged: 0 },
      staged: 2,
      budgetEntries: { created: 2, skipped: 0 },
      archived: 1,
      balances: { checked: 3, notCompared: 1 },
    });
    expect(result.importBatchId).not.toBeNull();

    // Every account on every day, closings included: the archived card closed
    // on the day it was archived there, and the scheduled entry on its day.
    const drift = result.plan.move!.drift;
    expect(await postingsByDay(whole, { closings: true })).toEqual(
      expectedAfterDrift(await postingsByDay(source, { closings: true }), parsedWhole, drift),
    );
    // The trial balance nets to zero in every currency.
    const nets = await getDb().execute(sql`
      select currency, sum(amount)::text as total from posting
       where user_id = ${whole.userId} group by currency
    `);
    for (const row of nets.rows as { total: string }[]) {
      expect(canonicalDecimal(row.total)).toBe("0");
    }

    // Income and spending by category and month, except the one refund the
    // plan said would count as income here.
    const theirs = await byCategoryAndMonth(source);
    const mine = await byCategoryAndMonth(whole);
    expect(theirs.get("Market 2026-02 expense")).toBe("-12.99");
    expect(mine.get("Market 2026-02 income")).toBe("-12.99");
    theirs.delete("Market 2026-02 expense");
    mine.delete("Market 2026-02 income");
    expect(mine).toEqual(theirs);

    // Archived as they were, at the same instants.
    const [card] = await getDb()
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.userId, whole.userId), eq(ledgerAccounts.name, "Old card")));
    expect(card!.archivedAt?.toISOString()).toBe("2026-03-15T10:00:00.000Z");
    const [hobby] = await getDb()
      .select()
      .from(categories)
      .where(and(eq(categories.userId, whole.userId), eq(categories.name, "Old hobby")));
    expect(hobby!.archivedAt?.toISOString()).toBe("2026-03-20T10:00:00.000Z");

    // The deleted entries are history: void, netting to nothing, under their
    // origins, and said in Activity to have arrived deleted.
    const voided = await getDb()
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, whole.userId), isNotNull(transactions.deletedAt)));
    expect(voided.map((row) => row.importOrigin).sort()).toEqual(
      [ids.coffeeDeleted, ids.cardDeleted].sort(),
    );
    for (const row of voided) {
      const net = await getDb().execute(sql`
        select coalesce(sum(amount), 0)::text as total from posting
         where user_id = ${whole.userId} and transaction_id = ${row.id}::uuid
      `);
      expect(canonicalDecimal((net.rows[0] as { total: string }).total)).toBe("0");
    }
    const [coffeeTemplate] = await getDb()
      .select()
      .from(transactionTemplates)
      .where(
        and(eq(transactionTemplates.userId, whole.userId), eq(transactionTemplates.name, "Coffee")),
      );
    expect(voided.find((row) => row.importOrigin === ids.coffeeDeleted)!.templateId).toBe(
      coffeeTemplate!.id,
    );
    const operations = await getDb()
      .select({ operation: auditEvents.operation, entityId: auditEvents.entityId })
      .from(auditEvents)
      .where(and(eq(auditEvents.userId, whole.userId), eq(auditEvents.entityType, "transaction")));
    expect(
      operations
        .filter((each) => each.operation === "delete_from_ledger_file")
        .map((each) => each.entityId)
        .sort(),
    ).toEqual(voided.map((row) => row.id).sort());
    expect(operations.filter((each) => each.operation === "create_from_ledger_file").length).toBe(
      parsedWhole.entries.length,
    );
    expect(operations.filter((each) => each.operation === "delete")).toEqual([]);

    // Every entry carries its origin, and each origin is in the books once.
    const origins = await getDb()
      .select({ importOrigin: transactions.importOrigin })
      .from(transactions)
      .where(eq(transactions.userId, whole.userId));
    expect(origins.map((row) => row.importOrigin).sort()).toEqual(
      parsedWhole.entries.map((each) => each.id).sort(),
    );

    // The file's settings, since nothing here had chosen any.
    expect(await getPreferences(whole)).toMatchObject({
      chosen: true,
      timezone: TIMEZONE,
      defaultCurrency: "EUR",
      theme: "dark",
    });
    // The queue's rows wait here as they waited there.
    const waiting = await getDb()
      .select()
      .from(stagedTransactions)
      .where(
        and(eq(stagedTransactions.userId, whole.userId), eq(stagedTransactions.status, "staged")),
      );
    expect(waiting.map((row) => row.importOrigin).sort()).toEqual(
      parsedWhole.staged.map((row) => row.id).sort(),
    );
    // And the ledger is still one a file may be moved into.
    expect((await previewLedgerFile(whole, { ledgerFile: wholeFile })).move.qualifies).toBe(true);
  });

  it("budgets report the same, and the period totals move only by the drift", async () => {
    const whole = person("whole");
    const query = { start: "2026-01-01", end: today(), periodUnit: "month" };
    // The refund under Market posted to spending there and to income here,
    // which no budget is about: its row goes, and the month it fell in spends
    // and earns 12.99 more here, the amount the plan's drift states.
    const drifted = (report: BudgetReportView, shift: boolean) => ({
      ...report,
      periods: report.periods.map((period) => {
        const month = shift && period.currency === "EUR" && period.periodStart === "2026-02-01";
        return {
          ...period,
          rows: period.rows.filter((row) => row.category !== "Market"),
          spent: month ? canonicalDecimal(decimal(period.spent).plus("12.99")) : period.spent,
          income: month ? canonicalDecimal(decimal(period.income).plus("12.99")) : period.income,
        };
      }),
    });
    const theirs = relabeled(
      drifted(await getBudgetReport(source, query), true),
      await labels(source),
    );
    const mine = relabeled(
      drifted(await getBudgetReport(whole, query), false),
      await labels(whole),
    );
    expect(mine).toEqual(theirs);
  });

  it("sends no spent reminder again, and proposes no occurrence twice", async () => {
    const whole = person("whole");
    const remindersOf = async (actor: Actor) =>
      (
        await getDb()
          .select({
            name: transactionTemplates.name,
            lastNotifiedDate: templateNotifications.lastNotifiedDate,
            nextNotificationDate: templateNotifications.nextNotificationDate,
          })
          .from(templateNotifications)
          .innerJoin(
            transactionTemplates,
            eq(transactionTemplates.id, templateNotifications.templateId),
          )
          .where(eq(templateNotifications.userId, actor.userId))
      ).sort((left, right) => left.name.localeCompare(right.name));
    const mine = await remindersOf(whole);
    expect(mine).toEqual(await remindersOf(source));
    expect(mine.find((row) => row.name === "Coffee")).toMatchObject({
      nextNotificationDate: null,
    });
    sent.length = 0;
    await runDueNotifications();
    expect(sent.filter((message) => message.to === `${whole.userId}@example.com`)).toEqual([]);

    const [marketDay] = await getDb()
      .select()
      .from(recurrences)
      .where(and(eq(recurrences.userId, whole.userId), eq(recurrences.name, "Market day")));
    expect(marketDay).toMatchObject({
      lastOccurrenceDate: today(),
      proposesFrom: addDays(today(), 1),
    });
    await runDueRecurrences();
    const proposed = await getDb()
      .select()
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.userId, whole.userId),
          isNotNull(stagedTransactions.recurrenceId),
        ),
      );
    expect(proposed).toEqual([]);
  });

  it("exports as the file it was made from, apart from when it was made", async () => {
    const back = await exportOf(person("whole"));
    // The one refund the plan reported posts by the kind its category has
    // here, so the file the moved ledger writes no longer says it posted
    // elsewhere. Everything else is the source's, origins included.
    const theirs = comparable(wholeFile);
    const mine = comparable(back);
    const reported = (entries: readonly LedgerFileEntry[]) =>
      entries.filter((each) => each.type !== "transfer" && each.postedAs !== undefined);
    expect(reported(mine.entries)).toEqual([]);
    expect(reported(theirs.entries).map((each) => each.id)).toEqual([ids.drifted]);
    expect(mine).toEqual({
      ...theirs,
      entries: theirs.entries.map((each) => {
        if (each.type === "transfer") return each;
        const { postedAs: _postedAs, ...rest } = each;
        return rest;
      }),
    });
  });

  it("moves the same file in parts, each all or nothing, and resumes after one fails", async () => {
    const owner = person("parts");
    const parts = inThree(parsedWhole);
    expect(parts).toHaveLength(3);
    const run = randomUUID();
    const send = (index: number, ledgerFile = parts[index]!, key = `${run}-${index + 1}`) =>
      moveLedgerFile(owner, {
        ledgerFile,
        fileName: "parts.json",
        idempotencyKey: key,
        part: { index: index + 1, count: parts.length },
      });

    const results: LedgerFileMoveResult[] = [];
    const first = await send(0);
    results.push(first);
    expect(first.balances).toBeNull();
    expect(first.plan.move!.recurrencesDeferred).toBe(2);
    // Nothing that proposes exists until the last part, so nothing nobody
    // imported can reach Staged while the move is under way.
    expect(
      await getDb().select().from(recurrences).where(eq(recurrences.userId, owner.userId)),
    ).toEqual([]);

    // A transaction in the middle of the second part that the ledger refuses,
    // which the plan cannot foresee: the part is refused whole, with the
    // service's own reason said about that transaction.
    const second = read(parts[1]!);
    const middle = second.entries[Math.floor(second.entries.length / 2)]!;
    const broken: LedgerFileEntry = {
      id: randomUUID(),
      type: "transfer",
      date: middle.date,
      from: "Checking",
      to: "Savings",
      sourceAmount: "10.00",
      destinationAmount: "11.00",
      payee: "Sweep",
    };
    const before = await footprint(owner);
    const refused = await refusal(
      send(
        1,
        serializeLedgerFile({ ...second, entries: [...second.entries, broken] }),
        `${run}-broken`,
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toBe(
      `The transfer of 10.00 dated ${middle.date} with Sweep could not be written: Same-currency transfer amounts must match. Nothing in this part was written.`,
    );
    expect(refused.details).toMatchObject({
      origin: broken.id,
      date: middle.date,
      payee: "Sweep",
      amount: "10.00",
    });
    expect(await footprint(owner)).toEqual(before);

    // Resumed: the part as it was goes in.
    results.push(await send(1));

    // The last part carries the balances, and one that does not come out
    // refuses the part with its numbers and writes nothing of it.
    const last = read(parts[2]!);
    const checking = last.accounts.find((each) => each.key === "Checking")!;
    const truth = checking.detail === "full" ? checking.balance! : "";
    const claimed = canonicalDecimal(decimal(truth).minus(10));
    const tampered = serializeLedgerFile({
      ...last,
      accounts: last.accounts.map((each) =>
        each.key === "Checking" && each.detail === "full" ? { ...each, balance: claimed } : each,
      ),
    });
    const atLast = await footprint(owner);
    const mismatch = await refusal(send(2, tampered, `${run}-tampered`));
    expect(mismatch.code).toBe("CONFLICT");
    expect(mismatch.message).toBe(
      `After this part, "Checking" would hold ${truth} EUR on ${last.throughDate}, and the file says ${claimed} EUR: 10 EUR more than the file. Nothing in this part was written. If "Checking" here held transactions that are not in this file, rename it under Accounts and check the file again, so the file's comes in as a new account, or add the file instead, which sends its transactions to Staged. If it holds some of this file's transactions as an earlier copy of the file had them, a move passes over those rather than changing them, and they can only be put right by hand.`,
    );
    // An agent sending parts is sent to the earlier ones first.
    expect(mismatch.agentMessage).toContain("Call preview_ledger_file on each earlier part");
    expect(mismatch.details).toMatchObject({
      throughDate: last.throughDate,
      key: "Checking",
      currency: "EUR",
      expected: claimed,
      actual: truth,
      difference: "10",
    });
    expect(await footprint(owner)).toEqual(atLast);

    const done = await send(2);
    results.push(done);
    expect(done.balances).toEqual({ checked: 3, notCompared: 1 });
    expect(done.plan.move!.recurrencesDeferred).toBe(0);

    // Sent again with its key, the part replays what it did and writes nothing.
    const finished = await footprint(owner);
    expect(await send(2)).toEqual(done);
    expect(await footprint(owner)).toEqual(finished);
    // The key is bound to what it was sent with.
    const reused = await refusal(
      moveLedgerFile(owner, {
        ledgerFile: parts[2]!,
        fileName: "another name.json",
        idempotencyKey: `${run}-3`,
        part: { index: 3, count: 3 },
      }),
    );
    expect(reused.code).toBe("CONFLICT");
    // Sent again under a new key, a finished part finds everything already
    // here, writes nothing, and the balances still come out.
    const again = await send(2, parts[2]!, `${run}-again`);
    expect(again).toMatchObject({
      written: { entries: 0, deleted: 0 },
      staged: 0,
      importBatchId: null,
      budgetEntries: { created: 0 },
      archived: 0,
      balances: { checked: 3, notCompared: 1 },
    });
    expect(again.skipped.entries + again.skipped.deleted).toBe(last.entries.length);
    const resentFirst = await send(0, parts[0]!, `${run}-first-again`);
    expect(resentFirst.written).toEqual({ entries: 0, deleted: 0 });
    expect(await footprint(owner)).toEqual(finished);

    // The same books as the one-part move: the source's, drift aside, the
    // drift being each part's own, for the transactions it carried.
    expect(await postingsByDay(owner, { closings: true })).toEqual(
      expectedAfterDrift(
        await postingsByDay(source, { closings: true }),
        parsedWhole,
        results.flatMap((result) => result.plan.move!.drift),
      ),
    );
    expect(comparable(await exportOf(owner))).toEqual(comparable(await exportOf(person("whole"))));
  });

  it("is refused once a transaction is typed here, and the rest can still be added", async () => {
    const owner = person("typed");
    const parts = inThree(parsedWhole);
    const part = (index: number) => ({ index: index + 1, count: parts.length });
    await moveLedgerFile(owner, {
      ledgerFile: parts[0]!,
      fileName: "parts.json",
      idempotencyKey: randomUUID(),
      part: part(0),
    });
    const [checking] = await getDb()
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.userId, owner.userId), eq(ledgerAccounts.name, "Checking")));
    await createTransaction(
      owner,
      {
        type: "withdrawal",
        date: "2026-10-01",
        payee: "Typed by hand",
        fromAccountId: checking!.id,
        amount: "2.00",
      } as never,
      randomUUID(),
    );
    const preview = await previewLedgerFile(owner, { ledgerFile: parts[1]! });
    expect(preview.move).toEqual({ qualifies: false, reason: LEDGER_FILE_MOVE_BLOCKED });
    expect(preview.movePlan.problems[0]).toEqual({
      field: "move",
      message: LEDGER_FILE_MOVE_BLOCKED,
    });

    const before = await footprint(owner);
    const refused = await refusal(
      moveLedgerFile(owner, {
        ledgerFile: parts[1]!,
        fileName: "parts.json",
        idempotencyKey: randomUUID(),
        part: part(1),
      }),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toBe(LEDGER_FILE_MOVE_BLOCKED);
    expect(refused.agentMessage).toBe(
      "This ledger holds entries that did not come from a Simple Balance file, so a file cannot be moved into it. Call add_ledger_file with the same parts and decisions instead; its entries go to Staged for review.",
    );
    expect(await footprint(owner)).toEqual(before);

    // Adding is still offered, and stages the rest.
    expect(preview.plan.ok).toBe(true);
    const added = await addLedgerFile(owner, {
      ledgerFile: parts[1]!,
      fileName: "parts.json",
      idempotencyKey: randomUUID(),
      part: part(1),
    });
    expect(added.staged).toBeGreaterThan(0);
  });

  it("is refused while an earlier add's rows wait, and committing them clears it", async () => {
    const owner = person("waiting");
    await addLedgerFile(owner, {
      ledgerFile: smallFile,
      fileName: "small.json",
      idempotencyKey: randomUUID(),
    });
    const live = parsedSmall.entries.filter((each) => !each.deleted);
    const preview = await previewLedgerFile(owner, { ledgerFile: smallFile });
    expect(preview.rows.waiting).toBe(live.length);
    const before = await footprint(owner);
    const refused = await refusal(move(owner, smallFile));
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toBe(
      `${live.length} of this file's transactions are waiting in Staged from an earlier import of it. Commit or discard them there first: a move writes each transaction straight into the books, once.`,
    );
    expect(refused.details).toMatchObject({ count: live.length });
    expect(refused.agentMessage).toBe(
      `${live.length} of this file's transactions are waiting in Staged from an earlier import of it. Commit them with commit_staged_transactions or discard them with delete_staged_transactions, then call preview_ledger_file again: a move writes each transaction straight into the books, once.`,
    );
    expect(await footprint(owner)).toEqual(before);

    const rows = (
      await getDb()
        .select()
        .from(stagedTransactions)
        .where(
          and(eq(stagedTransactions.userId, owner.userId), eq(stagedTransactions.status, "staged")),
        )
    ).filter((row) => live.some((each) => each.id === row.importOrigin));
    await commitStages(owner, {
      stagedIds: rows.map((row) => row.id),
      expectedVersions: Object.fromEntries(rows.map((row) => [row.id, row.version])),
      idempotencyKey: randomUUID(),
    });
    const moved = await move(owner, smallFile);
    expect(moved).toMatchObject({
      written: { entries: 0, deleted: 1 },
      skipped: { entries: live.length, deleted: 0, staged: 1 },
      balances: { checked: 2, notCompared: 0 },
    });
  });

  it("rolls a part back whole when the ledger refuses one of its transactions", async () => {
    const owner = person("refused");
    const broken: LedgerFileEntry = {
      id: randomUUID(),
      type: "transfer",
      date: "2026-02-03",
      from: "Checking",
      to: "Savings",
      sourceAmount: "10.00",
      destinationAmount: "11.00",
      payee: "Sweep",
    };
    const file = serializeLedgerFile({ ...parsedSmall, entries: [...parsedSmall.entries, broken] });
    // The plan cannot see it coming: a preview says the move is ready.
    expect((await previewLedgerFile(owner, { ledgerFile: file })).movePlan.ok).toBe(true);
    const before = await footprint(owner);
    const refused = await refusal(move(owner, file));
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.status).toBe(422);
    expect(refused.message).toBe(
      "The transfer of 10.00 dated 2026-02-03 with Sweep could not be written: Same-currency transfer amounts must match. Nothing in this part was written.",
    );
    expect(await footprint(owner)).toEqual(before);
  });

  it("answers another import landing the same transaction first with a sentence", async () => {
    const owner = person("race");
    race.origin = parsedSmall.entries[1]!.id;
    const before = await footprint(owner);
    const refused = await refusal(move(owner, smallFile));
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toBe(
      "Another import wrote this file's transactions a moment ago. Check the file again.",
    );
    expect(refused.agentMessage).toBe(
      "Another import wrote this file's transactions a moment ago. Call preview_ledger_file again, and send what it now says.",
    );
    expect(await footprint(owner)).toEqual(before);
    // Nothing was left behind, so the same move goes in now.
    expect((await move(owner, smallFile)).balances).toEqual({ checked: 2, notCompared: 0 });
  });

  it("matches and touches nothing of anybody else's", async () => {
    const owner = person("scoped");
    const theirs = await footprint(stranger);
    const preview = await previewLedgerFile(owner, { ledgerFile: wholeFile });
    expect(preview.here.accounts).toEqual([]);
    expect(preview.move.qualifies).toBe(true);
    // The stranger's typed entry keeps their own ledger from taking a move.
    const intoTheirs = await refusal(move(stranger, smallFile));
    expect(intoTheirs.message).toBe(LEDGER_FILE_MOVE_BLOCKED);
    expect(await footprint(stranger)).toEqual(theirs);

    // A file naming Savings only by reference, into a ledger with an account
    // of its own in the currency, so matching is a choice the plan offers and
    // the stranger's id is what it refuses.
    await createAccount(owner, {
      name: "Own euros",
      type: "checking",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    const ofChecking = (
      await exportLedgerFile(
        small,
        { kinds: ["accounts", "categories", "entries"], accountIds: [ids.smallChecking!] },
        LIMITS,
      )
    ).ledgerFile;
    const planned = (await previewLedgerFile(owner, { ledgerFile: ofChecking })).movePlan;
    expect(planned.records.find((each) => each.key === "Savings")).toMatchObject({
      outcome: "missing",
      choices: ["match", "create"],
    });
    const named = await refusal(
      move(owner, ofChecking, {
        decisions: [{ kind: "account", key: "Savings", action: "match", id: strangerAccountId }],
      }),
    );
    expect(named.message).toBe("No account here has that id.");
    expect(await footprint(stranger)).toEqual(theirs);
    const moved = await move(owner, ofChecking, {
      decisions: [{ kind: "account", key: "Savings", action: "create" }],
    });
    expect(Object.values(moved.plan.records.map((each) => each.id))).not.toContain(
      strangerAccountId,
    );
    expect(await footprint(stranger)).toEqual(theirs);
  });

  it("is a tool over a real connection, behind ledger:write and nothing less", async () => {
    for (const scope of ["ledger:read", "ledger:stage"]) {
      const agent = await connectAgent(person("agent"), [scope]);
      try {
        const names = (await agent.client.listTools()).tools.map((tool) => tool.name);
        expect(names, scope).not.toContain("move_ledger_file");
        const call = await agent.client.callTool({
          name: "move_ledger_file",
          arguments: {
            ledgerFile: smallFile,
            fileName: "small.json",
            idempotencyKey: randomUUID(),
          },
        });
        expect(call.isError, scope).toBe(true);
      } finally {
        await agent.close();
      }
    }
    expect(await footprint(person("agent"))).toMatchObject({ entries: 0, accounts: 0 });

    const agent = await connectAgent(person("agent"), ["ledger:write"]);
    try {
      const tool = (await agent.client.listTools()).tools.find(
        (each) => each.name === "move_ledger_file",
      )!;
      expect(tool.annotations).toMatchObject({ destructiveHint: true });
      const preview = await agent.client.callTool({
        name: "preview_ledger_file",
        arguments: { ledgerFile: smallFile },
      });
      expect(preview.isError).toBeFalsy();
      expect(
        (preview.structuredContent as { result: { movePlan: { ok: boolean } } }).result.movePlan.ok,
      ).toBe(true);
      const moved = await agent.client.callTool({
        name: "move_ledger_file",
        arguments: { ledgerFile: smallFile, fileName: "small.json", idempotencyKey: randomUUID() },
      });
      expect(JSON.stringify(moved.content)).not.toContain("Output validation error");
      expect(moved.isError).toBeFalsy();
      expect(moved.structuredContent).toMatchObject({
        result: {
          written: { entries: parsedSmall.entries.length - 1, deleted: 1 },
          balances: { checked: 2, notCompared: 0 },
        },
      });
      // A refusal reaches the agent as a refusal, not as a broken schema.
      const stray = await agent.client.callTool({
        name: "move_ledger_file",
        arguments: {
          ledgerFile: smallFile,
          fileName: "small.json",
          idempotencyKey: randomUUID(),
          decisions: [{ kind: "account", key: "Nowhere", action: "skip" }],
        },
      });
      expect(stray.isError).toBe(true);
      expect(JSON.stringify(stray.content)).not.toContain("Output validation error");
    } finally {
      await agent.close();
    }
  });
});
