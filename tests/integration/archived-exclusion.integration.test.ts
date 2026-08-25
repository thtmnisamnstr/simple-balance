import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import {
  createAccount,
  getAccount,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import { getSummary } from "../../src/server/services/summary.js";
import { createTransaction, updateTransaction } from "../../src/server/services/transactions.js";
import { archivedEntriesCte, withClause } from "../../src/server/services/report-sql.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("archived_exclusion");
const actor: Actor = { userId: "archived-exclusion-user", source: "web" };

const range = { start: "2026-01-01", end: "2026-12-31" };
let keySeed = 0;
const nextKey = () => `archived-${String((keySeed += 1)).padStart(6, "0")}`;

let liveId = "";
let doomedId = "";
let foodId = "";

const archive = async (id: string, archived: boolean) => {
  const loaded = await getAccount(actor, id);
  await setAccountArchived(actor, id, loaded.version, archived);
};

const usd = (summary: Awaited<ReturnType<typeof getSummary>>) =>
  summary.currencies.find((entry) => entry.currency === "USD");

const spend = (summary: Awaited<ReturnType<typeof getSummary>>) =>
  Object.fromEntries(
    (usd(summary)?.spendingByCategory ?? []).map((row) => [row.category, row.amount]),
  );

integration("the archived-account exclusion, hoisted", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Archived Exclusion",
      email: "archived-exclusion@example.com",
      emailVerified: true,
    });
    liveId = (
      await createAccount(actor, {
        name: "Live Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "1000",
      })
    ).id;
    doomedId = (
      await createAccount(actor, {
        name: "Doomed Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "500",
      })
    ).id;
    foodId = (await createCategory(actor, { name: "Food", kind: "expense" })).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  it("counts an entry on a live account", async () => {
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-03-01",
        payee: "Grocer",
        amount: "40",
        fromAccountId: liveId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
    const summary = await getSummary(actor, range);
    expect(usd(summary)!.withdrawals).toBe("40");
    expect(spend(summary)).toEqual({ Food: "40" });
  });

  /**
   * The netting rule. Swapping the grouped subquery for a plain `exists` passes
   * every other test in this file and fails this one: the stale postings left
   * on the archived account still match by row, so the corrected entry stays
   * suppressed even though no money runs through that account any more.
   */
  it("keeps an entry whose archived postings were corrected away", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-03-02",
        payee: "Misfiled",
        amount: "25",
        fromAccountId: doomedId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
    await updateTransaction(actor, created.id, {
      expectedVersion: created.version,
      draft: {
        type: "withdrawal",
        date: "2026-03-02",
        payee: "Misfiled",
        amount: "25",
        fromAccountId: liveId,
        categoryId: foodId,
      } as never,
    });
    await archive(doomedId, true);

    const summary = await getSummary(actor, range);
    expect(usd(summary)!.withdrawals).toBe("65");
    expect(spend(summary)).toEqual({ Food: "65" });
  });

  it("excludes an entry that still runs through an archived account", async () => {
    await archive(doomedId, false);
    const stuck = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-03-03",
        payee: "Stranded",
        amount: "11",
        fromAccountId: doomedId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
    expect(stuck.id).toBeTruthy();
    await archive(doomedId, true);

    const summary = await getSummary(actor, range);
    expect(usd(summary)!.withdrawals).toBe("65");
    expect(spend(summary)).toEqual({ Food: "65" });
  });

  it("counts it again when asked to include archived accounts", async () => {
    const summary = await getSummary(actor, range, true);
    expect(usd(summary)!.withdrawals).toBe("76");
    expect(spend(summary)).toEqual({ Food: "76" });
  });

  it("still sums to zero in every currency", async () => {
    const result = await getDb().execute(sql`
      select p.currency, sum(p.amount)::text as total
      from posting p
      where p.user_id = ${actor.userId}
      group by p.currency
    `);
    expect(result.rows.map((row) => `${row.currency}=${Number(row.total)}`)).toEqual(["USD=0"]);
  });

  /**
   * The exclusion has the same answer for every posting in the query, so asking
   * it per posting is the difference between one aggregate and one subquery
   * execution per candidate row. A `SubPlan` node is what asking per row looks
   * like, and it appears whatever the row count, because the grouped `having`
   * inside the subquery is what stops the planner flattening it to an anti-join.
   *
   * Plans the shipped fragment rather than a copy of it: `archivedEntriesCte` is
   * what the reports and the summary both build this from, so a change there is
   * a change here.
   */
  it("answers the exclusion once rather than once per posting", async () => {
    const text = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = await tx.execute(sql`
        explain
        ${withClause(archivedEntriesCte(actor.userId))}
        select p.currency, sum(p.amount)
        from posting p
        join ledger_account a
          on a.user_id = p.user_id and a.id = p.account_id
        left join archived_entries ae on ae.transaction_id = p.transaction_id
        where p.user_id = ${actor.userId}
          and a.system_kind in ('income', 'expense')
          and ae.transaction_id is null
        group by p.currency
      `);
      return plan.rows.map((row) => Object.values(row)[0]).join("\n");
    });

    expect(text).not.toContain("SubPlan");
  });
});
