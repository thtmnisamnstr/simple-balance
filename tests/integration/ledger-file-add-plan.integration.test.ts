/**
 * Billing on, for this file only, for the reason `account-limit` gives: the
 * configuration is memoized on first read, and every integration file shares
 * one process, so it is set before anything is imported and put back after.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_ledger_file_plan",
  STRIPE_PUBLISHABLE_KEY: "pk_test_ledger_file_plan",
  STRIPE_WEBHOOK_SECRET: "whsec_ledger_file_plan",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { MAX_FREE_ACCOUNTS } from "../../src/shared/domain.js";
import { LEDGER_FILE_CONTENT_MAX_BYTES } from "../../src/server/config-limits.js";
import { getDb } from "../../src/server/db/client.js";
import {
  billingOverrides,
  ledgerAccounts,
  stagedTransactions,
  user,
} from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createAccount, setAccountArchived } from "../../src/server/services/accounts.js";
import { AppError } from "../../src/server/services/errors.js";
import { canonicalDecimal } from "../../src/server/services/helpers.js";
import {
  addLedgerFile,
  exportLedgerFile,
  previewLedgerFile,
} from "../../src/server/services/ledger-file.js";
import { commitStages } from "../../src/server/services/staging.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * A free plan's places, against a file that brings more accounts than it
 * keeps (decision D4): nothing is chosen for anybody, the add is refused with
 * the numbers until enough accounts are named to arrive archived, an account
 * archived where the file came from arrives archived and costs nothing, and
 * the rows naming an account that arrived archived wait in Staged until it is
 * restored into a free place, then commit like any other.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ledger_file_add_plan");
const LIMITS = { maxRows: 100_000, maxContentBytes: LEDGER_FILE_CONTENT_MAX_BYTES };

const person = (id: string): Actor => ({ userId: `lf-plan-${id}`, source: "web" });
const source = person("source");
const free = person("free");
const paid = person("paid");
let file = "";

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

async function waitingFor(actor: Actor, accountId: string) {
  const rows = await getDb()
    .select()
    .from(stagedTransactions)
    .where(
      and(eq(stagedTransactions.userId, actor.userId), eq(stagedTransactions.status, "staged")),
    );
  return rows.filter((row) => JSON.stringify(row.draft).includes(accountId));
}

async function commit(actor: Actor, rows: readonly { id: string; version: number }[]) {
  return commitStages(actor, {
    stagedIds: rows.map((row) => row.id),
    expectedVersions: Object.fromEntries(rows.map((row) => [row.id, row.version])),
    idempotencyKey: randomUUID(),
  });
}

async function held(actor: Actor, accountId: string) {
  const result = await getDb().execute(sql`
    select coalesce(sum(amount), 0)::text as total from posting
     where user_id = ${actor.userId} and account_id = ${accountId}::uuid
  `);
  return canonicalDecimal(String((result.rows[0] as { total: string }).total));
}

async function counted(actor: Actor) {
  const result = await getDb().execute(sql`
    select
      (select count(*) from ledger_account where user_id = ${actor.userId})::int as accounts,
      (select count(*) from staged_transaction where user_id = ${actor.userId})::int as staged,
      (select count(*) from posting where user_id = ${actor.userId})::int as postings,
      (select count(*) from audit_event where user_id = ${actor.userId})::int as audit
  `);
  return result.rows[0];
}

const add = (actor: Actor, extra: Record<string, unknown> = {}) =>
  addLedgerFile(actor, {
    ledgerFile: file,
    fileName: "moving.json",
    idempotencyKey: randomUUID(),
    ...extra,
  });

integration("adding a Simple Balance file on a plan that keeps three accounts in use", () => {
  beforeAll(async () => {
    await database.create();
    for (const actor of [source, free, paid]) {
      await getDb()
        .insert(user)
        .values({ id: actor.userId, name: actor.userId, email: `${actor.userId}@example.com` });
    }
    // The ledger the file comes from is on the paid plan, which keeps every
    // account in use, and so is one of the two it goes to.
    for (const actor of [source, paid]) {
      await getDb().insert(billingOverrides).values({
        userId: actor.userId,
        plan: "plus",
        expiresAt: null,
        reason: "test",
        operator: "test",
      });
    }
    const opened: Record<string, string> = {};
    for (const name of ["One", "Two", "Three", "Four", "Five", "Closed"]) {
      opened[name] = (
        await createAccount(source, {
          name,
          type: "checking",
          currency: "EUR",
          openingDate: "2026-01-01",
          openingBalance: "100",
        })
      ).id;
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
    const closed = (await accountsOf(source)).get("Closed")!;
    await setAccountArchived(source, closed.id, closed.version, true);

    // The free ledger already uses one of its three places.
    await createAccount(free, {
      name: "Wallet",
      type: "cash",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });

    file = (
      await exportLedgerFile(source, { kinds: ["accounts", "categories", "entries"] }, LIMITS)
    ).ledgerFile;
  }, 120_000);

  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("counts the places and chooses none of them", async () => {
    const preview = await previewLedgerFile(free, { ledgerFile: file });
    expect(MAX_FREE_ACCOUNTS).toBe(3);
    // Five accounts in use where the file came from, and one it had archived,
    // which arrives archived and costs nothing.
    expect(preview.plan.places).toEqual({
      limit: 3,
      inUse: 1,
      arriving: 5,
      needed: 3,
      chosen: 0,
    });
    expect(preview.plan.ok).toBe(false);
    expect(preview.plan.problems.map((each) => each.field)).toEqual(["arriveArchived"]);
    expect(
      preview.plan.records.filter((each) => each.kind === "account" && each.arrivesArchived),
    ).toEqual([expect.objectContaining({ key: "Closed" })]);
  });

  it("refuses with the numbers until enough accounts are chosen, and writes nothing", async () => {
    const before = await counted(free);
    const none = await refusal(add(free));
    expect(none.code).toBe("VALIDATION_ERROR");
    expect(none.details).toMatchObject({
      limit: 3,
      current: 1,
      arriving: 5,
      needed: 3,
      chosen: 0,
    });
    const two = await refusal(add(free, { arriveArchived: ["Four", "Five"] }));
    expect(two.details).toMatchObject({ needed: 3 });
    expect(await counted(free)).toEqual(before);

    // An agent is told what it can send, and that only the person can upgrade.
    const server = createMcpServer(
      { userId: free.userId, source: "mcp", clientId: "plan-agent" },
      new Set(["ledger:write"]),
    );
    const client = new Client({ name: "plan", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.listTools();
      const reply = await client.callTool({
        name: "add_ledger_file",
        arguments: { ledgerFile: file, fileName: "moving.json", idempotencyKey: randomUUID() },
      });
      expect(reply.isError).toBe(true);
      const text = JSON.stringify(reply.structuredContent);
      expect(text).toContain("arriveArchived");
      expect(text).toContain("from Settings in the browser");
      // Only moves that work: a new account takes no decision, so a skip
      // would change nothing, and freeing a place here does.
      expect(text).toContain("archive or delete accounts here first to free places");
      expect(text).not.toContain("skip decision");
      expect(text).not.toContain("Output validation error");
    } finally {
      await client.close();
      await server.close();
    }
    expect(await counted(free)).toEqual(before);
  });

  it("brings the chosen accounts in archived, whose rows wait until a place is free", async () => {
    const result = await add(free, { arriveArchived: ["Three", "Four", "Five"] });
    expect(result.plan.places).toMatchObject({ needed: 3, chosen: 3 });

    const accounts = await accountsOf(free);
    for (const name of ["Three", "Four", "Five", "Closed"]) {
      expect(accounts.get(name)!.archivedAt, name).not.toBeNull();
    }
    for (const name of ["Wallet", "One", "Two"]) {
      expect(accounts.get(name)!.archivedAt, name).toBeNull();
    }
    // Every row stages, archived account or not; the ones that cannot commit
    // yet are counted as needing review.
    expect(result.staged).toBe(7);
    expect(result.needsReview).toBeGreaterThanOrEqual(4);
    const three = accounts.get("Three")!;
    const waiting = await waitingFor(free, three.id);
    expect(waiting).toHaveLength(2);
    expect(waiting.every((row) => (row.validationIssues as unknown[]).length > 0)).toBe(true);
    // An archived account closes at zero, so nothing it holds counts yet.
    expect(await held(free, three.id)).toBe("0");

    // The rows on accounts in use commit now; the transfer into Three waits.
    const one = accounts.get("One")!;
    const ready = (await waitingFor(free, one.id)).filter(
      (row) => !JSON.stringify(row.draft).includes(three.id),
    );
    await commit(free, ready);

    // Restoring Three needs a free place, like any restore, and once it has
    // one its rows commit and it holds what it held where it came from.
    const blocked = await refusal(setAccountArchived(free, three.id, three.version, false));
    expect(blocked.code).toBe("CONFLICT");
    const wallet = accounts.get("Wallet")!;
    await setAccountArchived(free, wallet.id, wallet.version, true);
    await setAccountArchived(free, three.id, three.version, false);
    await commit(free, await waitingFor(free, three.id));
    const theirs = await accountsOf(source);
    expect(await held(free, three.id)).toBe(await held(source, theirs.get("Three")!.id));
    expect(await held(free, one.id)).toBe(await held(source, theirs.get("One")!.id));

    // The account archived where it came from does the same.
    const two = (await accountsOf(free)).get("Two")!;
    await commit(free, await waitingFor(free, two.id));
    await setAccountArchived(free, two.id, two.version, true);
    const closed = (await accountsOf(free)).get("Closed")!;
    await setAccountArchived(free, closed.id, closed.version, false);
    await commit(free, await waitingFor(free, closed.id));
    const reopened = (await accountsOf(free)).get("Closed")!;
    await setAccountArchived(free, reopened.id, reopened.version, true);
    expect(await held(free, closed.id)).toBe(await held(source, theirs.get("Closed")!.id));
  });

  it("takes the choice where no limit is in force too, and counts no place for it", async () => {
    const preview = await previewLedgerFile(paid, { ledgerFile: file });
    expect(preview.plan.places).toMatchObject({ limit: null, needed: 0 });
    expect(preview.plan.ok).toBe(true);
    await add(paid, { arriveArchived: ["One"] });
    const accounts = await accountsOf(paid);
    expect(accounts.get("One")!.archivedAt).not.toBeNull();
    expect(accounts.get("Two")!.archivedAt).toBeNull();
  });
});
