import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { MAX_RECURRENCES } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { recurrences, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  createRecurrence,
  deleteRecurrence,
  getRecurrence,
  listRecurrences,
  nextOccurrenceDateFor,
  proposeDueOccurrences,
  ruleOf,
  updateRecurrence,
} from "../../src/server/services/recurrences.js";
import {
  commitStages,
  deleteStages,
  listStages,
} from "../../src/server/services/staging.js";
import {
  addDays,
  occurrencesBetween,
  todayIn,
  weekdayOf,
} from "../../src/shared/recurrence-dates.js";

// Every date is built from the day the suite runs, because a recurrence never
// reaches back before the day it was made: an anchor written down as a literal
// would stop meaning anything the moment it fell into the past.
const today = todayIn("UTC");
const inDays = (days: number) => addDays(today, days);
const nextSaturday = (() => {
  let date = inDays(1);
  while (weekdayOf(date) !== 6) date = addDays(date, 1);
  return date;
})();

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("recurrences");
const actor: Actor = { userId: "integration-recurrences", source: "web" };

const ledgerCounts = async () => {
  const result = await getDb().execute(sql`
    select
      (select count(*)::int from posting) as postings,
      (select count(*)::int from ledger_transaction) as transactions,
      (select count(*)::int from transaction_leg) as legs
  `);
  return result.rows[0] as { postings: number; transactions: number; legs: number };
};

const stagedFor = async (recurrenceId: string) =>
  (await listStages(actor, { limit: 100, recurrenceId })).items;

/** Every row the recurrence proposed, whatever became of it. */
const everyRowFrom = async (recurrenceId: string) => {
  const result = await getDb().execute(sql`
    select id, status, recurrence_id, occurrence_date, raw_data
    from staged_transaction
    where user_id = ${actor.userId} and recurrence_id = ${recurrenceId}::uuid
    order by occurrence_date
  `);
  return result.rows as {
    id: string;
    status: string;
    recurrence_id: string;
    occurrence_date: string;
    raw_data: { recurrence?: { recurrenceName?: string } } | null;
  }[];
};

integration("recurring transactions", () => {
  let checkingId: string;
  let rentCategoryId: string;

  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Recurrence Tenant",
      email: "recurrences@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2020-01-01",
        openingBalance: "10000",
      })
    ).id;
    rentCategoryId = (
      await createCategory(actor, { name: "Rent", kind: "expense" })
    ).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  const make = (name: string, over: Record<string, unknown> = {}) =>
    createRecurrence(actor, {
      name,
      shape: {
        type: "withdrawal",
        payee: "Landlord",
        fromAccountId: checkingId,
        categoryId: rentCategoryId,
        amount: "1200.00",
        ...((over.shape as object) ?? {}),
      },
      schedule: {
        frequency: "monthly",
        anchorDate: inDays(1),
        ...((over.schedule as object) ?? {}),
      },
    });

  it("names a shape, a schedule and both awkward-date policies", async () => {
    const created = await make("C1 monthly", {
      schedule: {
        frequency: "monthly",
        anchorDate: inDays(1),
        monthPolicy: "skip",
        weekendPolicy: "previous_business_day",
        interval: 3,
      },
    });
    expect(created).toMatchObject({
      name: "C1 monthly",
      frequency: "monthly",
      interval: 3,
      monthPolicy: "skip",
      weekendPolicy: "previous_business_day",
      lastOccurrenceDate: null,
    });

    const relative = await make("C1 relative", {
      schedule: {
        frequency: "monthly",
        anchorDate: inDays(1),
        position: { ordinal: -1, weekday: 5 },
      },
    });
    expect(relative.positionOrdinal).toBe(-1);
    expect(relative.positionWeekday).toBe(5);
  });

  it("keeps an optional amount absent rather than storing a zero", async () => {
    const created = await make("C1 variable", { shape: { amount: undefined } });
    expect(created.shape).not.toHaveProperty("amount");
  });

  it("writes a staged row and touches nothing in the ledger", async () => {
    const before = await ledgerCounts();
    const created = await make("C2 proposes", {
      schedule: { frequency: "monthly", anchorDate: inDays(1) },
    });
    const outcome = await proposeDueOccurrences(actor, created.id, inDays(70), 50);
    expect(outcome).toBe("proposed");
    expect(await ledgerCounts()).toEqual(before);

    const rows = await stagedFor(created.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe("staged");
      expect(row.importBatchId).toBeNull();
      expect(row.committedTransactionId).toBeNull();
    }
  });

  it("tells a scheduler that is silent from one with nothing to say", async () => {
    const created = await make("C3 silence", {
      schedule: { frequency: "monthly", anchorDate: inDays(1) },
    });
    const fresh = await getRecurrence(actor, created.id);
    expect(fresh.lastOccurrenceDate).toBeNull();
    expect(fresh.proposedCount).toBe(0);
    expect(fresh.committedCount).toBe(0);
    expect(fresh.discardedCount).toBe(0);

    await proposeDueOccurrences(actor, created.id, inDays(1), 50);
    const proposed = await getRecurrence(actor, created.id);
    expect(proposed.lastOccurrenceDate).toBe(inDays(1));
    expect(proposed.proposedCount).toBe(1);

    const rows = await stagedFor(created.id);
    await deleteStages(actor, {
      stagedIds: rows.map((row) => row.id),
      expectedVersions: Object.fromEntries(
        rows.map((row) => [row.id, row.version]),
      ),
      idempotencyKey: "c3-discard",
    });
    const after = await getRecurrence(actor, created.id);
    expect(after.lastOccurrenceDate).toBe(inDays(1));
    expect(after.proposedCount).toBe(0);
    expect(after.discardedCount).toBe(1);
  });

  it("proposes every occurrence missed during six weeks of downtime, once each", async () => {
    const created = await make("C4 weekly", {
      schedule: { frequency: "weekly", anchorDate: inDays(1) },
    });
    await proposeDueOccurrences(actor, created.id, inDays(43), 50);
    const first = await stagedFor(created.id);
    expect(first.map((row) => row.occurrenceDate).sort()).toEqual([
      inDays(1),
      inDays(8),
      inDays(15),
      inDays(22),
      inDays(29),
      inDays(36),
      inDays(43),
    ]);

    expect(await proposeDueOccurrences(actor, created.id, inDays(43), 50)).toBe(
      "nothing_due",
    );
    expect(await stagedFor(created.id)).toHaveLength(first.length);
  });

  it("proposes each occurrence once when two ticks race", async () => {
    const created = await make("C4 race", {
      schedule: { frequency: "weekly", anchorDate: inDays(1) },
    });
    const settled = await Promise.allSettled([
      proposeDueOccurrences(actor, created.id, inDays(29), 50),
      proposeDueOccurrences(actor, created.id, inDays(29), 50),
    ]);
    // One writes and the other finds nothing left, or one loses on the unique
    // key. What must never happen is the same occurrence proposed twice.
    expect(settled.map((one) => one.status)).toContain("fulfilled");

    const occurrences = (await stagedFor(created.id))
      .map((row) => row.occurrenceDate)
      .sort();
    // Against the arithmetic, not merely against itself. Uniqueness alone is
    // guaranteed by staged_recurrence_occurrence_unique, so asserting it proved
    // the index exists rather than that the race is safe; what a lost race
    // actually costs is an occurrence nobody proposed at all.
    const [row] = await getDb()
      .select()
      .from(recurrences)
      .where(eq(recurrences.id, created.id));
    const expected = occurrencesBetween(
      ruleOf(row!),
      addDays(today, -1),
      inDays(29),
      50,
    ).map((one) => one.occurrenceDate);
    expect(occurrences).toEqual(expected.sort());
    // And the watermark agrees with what was written, so neither run left it
    // ahead of the rows it stands for.
    expect(row!.nextOccurrenceDate).toBe(nextOccurrenceDateFor(row!));
  });

  it("resumes after a capped run and reaches the same total", async () => {
    const created = await make("C4 capped", {
      schedule: { frequency: "weekly", anchorDate: inDays(1) },
    });
    expect(await proposeDueOccurrences(actor, created.id, inDays(43), 3)).toBe(
      "capped",
    );
    expect(await stagedFor(created.id)).toHaveLength(3);
    await proposeDueOccurrences(actor, created.id, inDays(43), 50);
    expect(await stagedFor(created.id)).toHaveLength(7);
  });

  it("dates a row its own occurrence rather than the day the tick ran", async () => {
    const created = await make("C5 dating", {
      schedule: { frequency: "monthly", anchorDate: inDays(1) },
    });
    await proposeDueOccurrences(actor, created.id, inDays(70), 50);
    for (const row of await stagedFor(created.id)) {
      const draft = row.draft as { date?: string; externalId?: unknown };
      expect(draft.date).toBe(row.occurrenceDate);
      expect(draft).not.toHaveProperty("externalId");
      expect(row.importBatchId).toBeNull();
    }
  });

  it("moves the posted date off a weekend while the occurrence keeps its own", async () => {
    const created = await make("C5 weekend", {
      schedule: {
        frequency: "weekly",
        anchorDate: nextSaturday,
        weekendPolicy: "previous_business_day",
      },
    });
    await proposeDueOccurrences(actor, created.id, nextSaturday, 50);
    const rows = await stagedFor(created.id);
    const saturday = rows.find((row) => row.occurrenceDate === nextSaturday);
    expect(saturday, "the Saturday occurrence keeps its own date").toBeDefined();
    expect((saturday!.draft as { date: string }).date).toBe(
      addDays(nextSaturday, -1),
    );
  });

  it("proposes a row naming an account that no longer resolves, and says which field", async () => {
    const spare = await createAccount(actor, {
      name: "Closing soon",
      type: "checking",
      currency: "USD",
      openingDate: "2020-01-01",
      openingBalance: "0",
    });
    const created = await createRecurrence(actor, {
      name: "C6 dead account",
      shape: {
        type: "withdrawal",
        payee: "Landlord",
        fromAccountId: spare.id,
        amount: "50.00",
      },
      schedule: { frequency: "monthly", anchorDate: inDays(1) },
    });
    await setAccountArchived(actor, spare.id, spare.version, true);

    await proposeDueOccurrences(actor, created.id, inDays(1), 50);
    const [row] = await stagedFor(created.id);
    expect(row.status).toBe("staged");
    expect(
      row.validationIssues.some((issue) => issue.field === "fromAccountId"),
    ).toBe(true);
  });

  it("still names the field when the amount is missing too", async () => {
    const spare = await createAccount(actor, {
      name: "Also closing",
      type: "checking",
      currency: "USD",
      openingDate: "2020-01-01",
      openingBalance: "0",
    });
    const created = await createRecurrence(actor, {
      name: "C6 no amount",
      shape: { type: "withdrawal", payee: "Utility", fromAccountId: spare.id },
      schedule: { frequency: "monthly", anchorDate: inDays(1) },
    });
    await setAccountArchived(actor, spare.id, spare.version, true);

    await proposeDueOccurrences(actor, created.id, inDays(1), 50);
    const [row] = await stagedFor(created.id);
    const fields = row.validationIssues.map((issue) => issue.field);
    expect(fields).toContain("fromAccountId");
    expect(fields).toContain("amount");
  });

  it("leaves proposed and committed rows untouched when the recurrence goes", async () => {
    const created = await make("C7 provenance", {
      schedule: { frequency: "weekly", anchorDate: inDays(1) },
    });
    await proposeDueOccurrences(actor, created.id, inDays(15), 50);
    const rows = await stagedFor(created.id);
    expect(rows.length).toBeGreaterThan(1);

    await commitStages(actor, {
      stagedIds: [rows[0]!.id],
      expectedVersions: { [rows[0]!.id]: rows[0]!.version },
      idempotencyKey: "c7-commit",
      allowDuplicates: true,
    });

    const current = await getRecurrence(actor, created.id);
    await deleteRecurrence(actor, created.id, current.version);

    const survivors = await everyRowFrom(created.id);
    expect(survivors).toHaveLength(rows.length);
    for (const row of survivors) {
      expect(row.recurrence_id).toBe(created.id);
      expect(row.raw_data?.recurrence?.recurrenceName).toBe("C7 provenance");
    }
    expect(survivors.some((row) => row.status === "committed")).toBe(true);
  });

  /**
   * The two features that shipped together, meeting. A recurrence holding legs
   * proposes a split, and the split has to survive the round trip through the
   * queue and settle to zero like any other, or the categories on the entry are
   * a story about money that was never divided that way.
   */
  it("proposes a split and commits it as one, still settling to zero", async () => {
    const householdId = (
      await createCategory(actor, { name: "Household", kind: "expense" })
    ).id;
    const created = await createRecurrence(actor, {
      name: "Split shop",
      shape: {
        type: "withdrawal",
        payee: "Supermarket",
        fromAccountId: checkingId,
        amount: "100.00",
        legs: [
          { categoryId: rentCategoryId, amount: "60.00" },
          { categoryId: householdId, amount: "40.00" },
        ],
      },
      schedule: { frequency: "monthly", anchorDate: inDays(1) },
    });

    await proposeDueOccurrences(actor, created.id, inDays(2), 50);
    const [proposed] = await stagedFor(created.id);
    expect(proposed).toBeDefined();
    expect(proposed!.validationIssues).toEqual([]);
    expect(proposed!.draft.legs).toHaveLength(2);

    await commitStages(actor, {
      stagedIds: [proposed!.id],
      expectedVersions: { [proposed!.id]: proposed!.version },
      idempotencyKey: "split-recurrence-commit",
      allowDuplicates: true,
    });

    const committed = await getDb().execute(sql`
      select st.committed_transaction_id as id
        from staged_transaction st
       where st.id = ${proposed!.id}::uuid
    `);
    const transactionId = (committed.rows[0] as { id: string | null }).id;
    expect(transactionId).not.toBeNull();

    const legs = await getDb().execute(sql`
      select tl.id, tl.amount::text as amount, tl.category_id
        from transaction_leg tl
       where tl.transaction_id = ${transactionId}::uuid
       order by tl.ordinal
    `);
    expect(legs.rows).toHaveLength(2);
    expect(
      (legs.rows as { amount: string }[]).map((row) => Number(row.amount)),
    ).toEqual([60, 40]);

    // Every leg posts under its own leg id, and the whole entry still settles.
    const postings = await getDb().execute(sql`
      select sum(amount)::text as total,
             count(*) filter (where leg_id is not null)::int as legged
        from posting
       where transaction_id = ${transactionId}::uuid
    `);
    const summary = postings.rows[0] as { total: string; legged: number };
    expect(Number(summary.total)).toBe(0);
    expect(summary.legged).toBe(2);
  });

  it("refuses to reach back before the day it was made", async () => {
    const created = await make("Backfill", {
      schedule: { frequency: "monthly", anchorDate: addDays(today, -2200) },
    });
    // Six years of monthly occurrences sit behind the anchor. Only the ones
    // falling after the day it was made may ever be proposed.
    await proposeDueOccurrences(actor, created.id, inDays(40), 200);
    const afterFirst = await stagedFor(created.id);
    expect(afterFirst.length).toBeLessThanOrEqual(2);
    expect(afterFirst.every((row) => row.occurrenceDate! >= today)).toBe(true);

    const current = await getRecurrence(actor, created.id);
    await updateRecurrence(actor, created.id, {
      expectedVersion: current.version,
      schedule: { anchorDate: addDays(today, -2600) },
    });
    await proposeDueOccurrences(actor, created.id, inDays(40), 200);
    const afterMove = await stagedFor(created.id);
    expect(afterMove.every((row) => row.occurrenceDate! >= today)).toBe(true);
    expect(afterMove.length).toBeLessThanOrEqual(3);
  });

  it("keeps the cached due date agreeing with the rule after every tick", async () => {
    const rows = await getDb().select().from(recurrences);
    for (const row of rows) {
      expect(row.nextOccurrenceDate, row.name).toBe(nextOccurrenceDateFor(row));
    }
  });

  it("refuses to keep more recurrences than the cap allows", async () => {
    const existing = (await listRecurrences(actor)).items.length;
    for (let index = existing; index < MAX_RECURRENCES; index += 1) {
      await make(`Filler ${index}`);
    }
    await expect(make("One too many")).rejects.toThrow(/You can keep 200/);
  });
});
