import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { RECURRENCE_SCHEDULER_LOCK } from "../../src/server/db/advisory-locks.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { tickUnderLock } from "../../src/server/recurrence-scheduler.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import {
  createRecurrence,
  runDueRecurrences,
} from "../../src/server/services/recurrences.js";
import { listStages } from "../../src/server/services/staging.js";
import { addDays, todayIn } from "../../src/shared/recurrence-dates.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("recurrence-scheduler");

const today = todayIn("UTC");
const inDays = (days: number) => addDays(today, days);

const settled: Actor = { userId: "sweep-settled", source: "web" };
const fresh: Actor = { userId: "sweep-fresh", source: "web" };

integration("the scheduler sweep", () => {
  let settledAccountId: string;
  let freshAccountId: string;

  beforeAll(async () => {
    await database.create();
    await getDb()
      .insert(user)
      .values([
        {
          id: settled.userId,
          name: "Has opened settings",
          email: "sweep-settled@example.com",
          emailVerified: true,
        },
        {
          id: fresh.userId,
          name: "Never opened settings",
          email: "sweep-fresh@example.com",
          emailVerified: true,
        },
      ]);
    await setPreferences(settled, { timezone: "UTC", defaultCurrency: "USD" });
    const open = async (actor: Actor) =>
      (
        await createAccount(actor, {
          name: "Checking",
          type: "checking",
          currency: "USD",
          openingDate: "2020-01-01",
          openingBalance: "10000",
        })
      ).id;
    settledAccountId = await open(settled);
    freshAccountId = await open(fresh);
  });

  afterAll(async () => {
    await database.drop();
  });

  const make = (actor: Actor, accountId: string, name: string, anchorDate: string) =>
    createRecurrence(actor, {
      name,
      shape: {
        type: "withdrawal",
        payee: "Landlord",
        fromAccountId: accountId,
        amount: "1200.00",
      },
      schedule: { frequency: "monthly", anchorDate },
    });

  const staged = async (actor: Actor, recurrenceId: string) =>
    (await listStages(actor, { limit: 100, recurrenceId })).items;

  /**
   * getPreferences synthesises UTC for somebody with no stored row, so an inner
   * join here would skip every account that has never opened settings while
   * looking exactly like a scheduler that works.
   */
  it("ticks somebody who has never chosen a timezone", async () => {
    const due = await make(fresh, freshAccountId, "Rent", today);

    const summary = await runDueRecurrences();

    expect(summary.proposed).toBeGreaterThanOrEqual(1);
    expect(await staged(fresh, due.id)).toHaveLength(1);
  });

  /**
   * The SQL prefilter deliberately over-selects by a day, because a calendar
   * date is "today" somewhere on earth from UTC-12 to UTC+14. Whether a row is
   * really due is decided against that person's own date.
   */
  it("looks at a row that is a day early and proposes nothing for it", async () => {
    const early = await make(settled, settledAccountId, "Not yet", inDays(1));

    const summary = await runDueRecurrences();

    expect(summary.examined).toBeGreaterThanOrEqual(1);
    expect(await staged(settled, early.id)).toHaveLength(0);
  });

  it("stops between recurrences when it is asked to", async () => {
    await make(settled, settledAccountId, "Stopped one", today);
    await make(settled, settledAccountId, "Stopped two", today);

    const summary = await runDueRecurrences(() => true);

    expect(summary).toEqual({ examined: 0, proposed: 0, capped: false });
  });

  it("does nothing while another session holds the tick lock", async () => {
    const due = await make(settled, settledAccountId, "Contended", today);
    const holder = new PgClient({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      const taken = await holder.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1) as locked",
        [RECURRENCE_SCHEDULER_LOCK],
      );
      expect(taken.rows[0]?.locked).toBe(true);

      expect(await tickUnderLock()).toEqual({
        examined: 0,
        proposed: 0,
        capped: false,
      });
      expect(await staged(settled, due.id)).toHaveLength(0);
    } finally {
      await holder.end();
    }

    const afterRelease = await tickUnderLock();
    expect(afterRelease.proposed).toBeGreaterThanOrEqual(1);
    expect(await staged(settled, due.id)).toHaveLength(1);
  });
});
