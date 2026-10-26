/**
 * Billing on, for this file only, for the reason `account-limit` gives: the
 * configuration is memoized on first read, and every integration file shares
 * one process, so it is set before anything is imported and put back after.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_ledger_file_move_plan",
  STRIPE_PUBLISHABLE_KEY: "pk_test_ledger_file_move_plan",
  STRIPE_WEBHOOK_SECRET: "whsec_ledger_file_move_plan",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { calendarDayIn } from "../../src/shared/recurrence-dates.js";
import { LEDGER_FILE_HISTORY_MAX_BYTES } from "../../src/server/config-limits.js";
import { getDb } from "../../src/server/db/client.js";
import { billingOverrides, ledgerAccounts, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  listAccounts,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { AppError } from "../../src/server/services/errors.js";
import { canonicalDecimal } from "../../src/server/services/helpers.js";
import {
  exportLedgerFile,
  moveLedgerFile,
  previewLedgerFile,
} from "../../src/server/services/ledger-file.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * A free plan's places, against a move that brings more accounts in use than
 * the plan keeps (decision D4): nothing is chosen for anybody, the move is
 * refused with the numbers until enough accounts are named to arrive
 * archived, and those arrive holding every transaction they held, closed on
 * the day of the move, and are held to the file's balances with the close
 * left out; restoring one into a free place posts its balance back. A frozen
 * account here that the file's transactions are on refuses the move up front,
 * because a move has no queue for them to wait in.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ledger_file_move_plan");
const LIMITS = { maxRows: 100_000, maxHistoryBytes: LEDGER_FILE_HISTORY_MAX_BYTES };
const TIMEZONE = "America/New_York";

const person = (id: string): Actor => ({ userId: `lf-move-plan-${id}`, source: "web" });
const source = person("source");
const free = person("free");
const frozen = person("frozen");
let file = "";
let closedAt = "";

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("it was not refused");
}

async function accountsOf(actor: Actor) {
  const rows = await getDb()
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, actor.userId), isNull(ledgerAccounts.systemKind)));
  return new Map(rows.map((row) => [row.name, row]));
}

async function counted(actor: Actor) {
  const result = await getDb().execute(sql`
    select
      (select count(*) from ledger_account where user_id = ${actor.userId})::int as accounts,
      (select count(*) from ledger_transaction where user_id = ${actor.userId})::int as entries,
      (select count(*) from posting where user_id = ${actor.userId})::int as postings,
      (select count(*) from audit_event where user_id = ${actor.userId})::int as audit
  `);
  return result.rows[0];
}

/** One account's postings netted by day, with or without its closing pairs. */
async function byDay(actor: Actor, accountId: string, closings: boolean) {
  const result = await getDb().execute(sql`
    select date::text as day, sum(amount)::text as total from posting
     where user_id = ${actor.userId} and account_id = ${accountId}::uuid
       and (${closings} or closing_account_id is null)
     group by 1 having sum(amount) <> 0 order by 1
  `);
  return (result.rows as { day: string; total: string }[]).map(
    (row) => `${row.day} ${canonicalDecimal(row.total)}`,
  );
}

async function held(actor: Actor, accountId: string) {
  const result = await getDb().execute(sql`
    select coalesce(sum(amount), 0)::text as total from posting
     where user_id = ${actor.userId} and account_id = ${accountId}::uuid
  `);
  return canonicalDecimal(String((result.rows[0] as { total: string }).total));
}

const paid = async (actor: Actor, on: boolean) => {
  await getDb().delete(billingOverrides).where(eq(billingOverrides.userId, actor.userId));
  if (!on) return;
  await getDb().insert(billingOverrides).values({
    userId: actor.userId,
    plan: "plus",
    expiresAt: null,
    reason: "test",
    operator: "test",
  });
};

const move = (actor: Actor, extra: Record<string, unknown> = {}) =>
  moveLedgerFile(actor, {
    ledgerFile: file,
    fileName: "moving.json",
    idempotencyKey: randomUUID(),
    ...extra,
  });

const opening = (name: string) => ({
  name,
  type: "checking",
  currency: "EUR",
  openingDate: "2026-01-01",
  openingBalance: "100",
});

integration("moving a Simple Balance file onto a plan that keeps three accounts in use", () => {
  beforeAll(async () => {
    await database.create();
    for (const actor of [source, free, frozen]) {
      await getDb()
        .insert(user)
        .values({ id: actor.userId, name: actor.userId, email: `${actor.userId}@example.com` });
    }
    await paid(source, true);
    await setPreferences(source, { timezone: TIMEZONE, defaultCurrency: "EUR", theme: "light" });
    const opened: Record<string, string> = {};
    for (const name of ["One", "Two", "Three", "Four", "Five", "Closed"]) {
      opened[name] = (await createAccount(source, opening(name))).id;
    }
    let n = 0;
    for (const name of Object.keys(opened)) {
      n += 1;
      await createTransaction(
        source,
        {
          type: "withdrawal",
          date: "2026-02-01",
          payee: `Shop ${n}`,
          fromAccountId: opened[name]!,
          amount: `${n}.00`,
        } as never,
        `plan-${name}`,
      );
    }
    await createTransaction(
      source,
      {
        type: "transfer",
        date: "2026-02-02",
        payee: "Move",
        fromAccountId: opened.One!,
        toAccountId: opened.Three!,
        sourceAmount: "10.00",
      } as never,
      "plan-transfer",
    );
    // Archived on a day in the past, so its close there and its close here
    // fall on that day rather than on today.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T15:00:00.000Z"));
    const closed = (await accountsOf(source)).get("Closed")!;
    await setAccountArchived(source, closed.id, closed.version, true);
    vi.useRealTimers();
    closedAt = "2026-03-01T15:00:00.000Z";

    // The free ledger already uses one of its three places.
    await createAccount(free, {
      name: "Wallet",
      type: "cash",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });

    // A ledger that had four of the file's accounts while it was on the paid
    // plan, and has just lost it: the newest is frozen.
    await paid(frozen, true);
    for (const name of ["One", "Two", "Three", "Four"]) await createAccount(frozen, opening(name));
    await paid(frozen, false);

    file = (
      await exportLedgerFile(
        source,
        { kinds: ["preferences", "accounts", "categories", "entries"] },
        LIMITS,
      )
    ).ledgerFile;
  }, 120_000);

  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the places and chooses none of them", async () => {
    const plan = (await previewLedgerFile(free, { ledgerFile: file })).movePlan;
    expect(plan.places).toEqual({ limit: 3, inUse: 1, arriving: 5, needed: 3, chosen: 0 });
    expect(plan.ok).toBe(false);
    expect(plan.problems.map((each) => each.field)).toEqual(["arriveArchived"]);
    expect(plan.records.filter((each) => each.kind === "account" && each.arrivesArchived)).toEqual([
      expect.objectContaining({ key: "Closed" }),
    ]);
  });

  it("refuses with the numbers until enough accounts are chosen, and writes nothing", async () => {
    const before = await counted(free);
    const none = await refusal(move(free));
    expect(none.code).toBe("VALIDATION_ERROR");
    expect(none.details).toMatchObject({ limit: 3, current: 1, arriving: 5, needed: 3, chosen: 0 });
    expect(none.agentMessage).toContain(
      "Name at least 3 of the file's new accounts in arriveArchived",
    );
    expect(none.agentMessage).toContain("from Settings in the browser");
    const two = await refusal(move(free, { arriveArchived: ["Four", "Five"] }));
    expect(two.details).toMatchObject({ needed: 3, chosen: 2 });
    expect(await counted(free)).toEqual(before);
  });

  it("brings the chosen accounts in archived, holding their transactions, closed today", async () => {
    const result = await move(free, { arriveArchived: ["Three", "Four", "Five"] });
    expect(result.plan.places).toMatchObject({ needed: 3, chosen: 3 });
    // Held to the file's balances with the closes left out, and passed: the
    // three closed here today, and the one closed where it came from, whose
    // zero there is not compared.
    expect(result.balances).toEqual({ checked: 5, notCompared: 1 });
    expect(result.archived).toBe(4);

    const accounts = await accountsOf(free);
    const theirs = await accountsOf(source);
    const day = calendarDayIn(new Date(), TIMEZONE);
    for (const name of ["Three", "Four", "Five"]) {
      const account = accounts.get(name)!;
      expect(account.archivedAt, name).not.toBeNull();
      expect(calendarDayIn(account.archivedAt!, TIMEZONE), name).toBe(day);
      // Every transaction it held is in it, day for day, and the close that
      // takes it to zero is today's.
      expect(await byDay(free, account.id, false), name).toEqual(
        await byDay(source, theirs.get(name)!.id, false),
      );
      expect(await held(free, account.id), name).toBe("0");
    }
    // The one archived where it came from closed on the day it closed there,
    // and holds there and here the same on every day.
    const closed = accounts.get("Closed")!;
    expect(closed.archivedAt?.toISOString()).toBe(closedAt);
    expect(await byDay(free, closed.id, true)).toEqual(
      await byDay(source, theirs.get("Closed")!.id, true),
    );
    for (const name of ["Wallet", "One", "Two"]) {
      expect(accounts.get(name)!.archivedAt, name).toBeNull();
    }
    expect((await listAccounts(free)).filter((each) => each.frozen)).toEqual([]);

    // Restoring one needs a free place, like any restore, and once it has one
    // it holds what it held where it came from.
    const three = accounts.get("Three")!;
    const blocked = await refusal(setAccountArchived(free, three.id, three.version, false));
    expect(blocked.code).toBe("CONFLICT");
    const wallet = accounts.get("Wallet")!;
    await setAccountArchived(free, wallet.id, wallet.version, true);
    await setAccountArchived(free, three.id, three.version, false);
    expect(await held(free, three.id)).toBe(await held(source, theirs.get("Three")!.id));
  });

  it("refuses up front a move whose transactions are on an account frozen here", async () => {
    const accounts = await listAccounts(frozen);
    expect(accounts.filter((each) => each.frozen).map((each) => each.name)).toEqual(["Four"]);
    const plan = (await previewLedgerFile(frozen, { ledgerFile: file })).movePlan;
    expect(plan.records.find((each) => each.key === "Four")).toMatchObject({
      outcome: "exists",
      action: "use",
    });
    const before = await counted(frozen);
    const refused = await refusal(move(frozen, { arriveArchived: ["Five"] }));
    const head =
      '"Four" is frozen here, and one of this file\'s transactions is on it. A move writes every transaction straight into the books, and a frozen account takes no new ones, so free a place for it first by archiving or deleting an account in use';
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toBe(`${head}, or upgrade under Settings.`);
    expect(refused.details).toMatchObject({ count: 1 });
    expect(refused.agentMessage).toBe(
      `${head}. Only the person who owns the ledger can raise the limit, from Settings in the browser.`,
    );
    expect(await counted(frozen)).toEqual(before);
  });
});
