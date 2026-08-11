import { sql } from "drizzle-orm";
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

    expect(summary).toEqual({ examined: 0, proposed: 0, failed: 0, capped: false });
  });

  /**
   * The sweep is the one loop in the product that serves every tenant at once,
   * and it is ordered most-overdue first. One recurrence that throws every time
   * is therefore first every time, so without a guard here it would stop
   * everybody else's recurrences on the whole deployment, silently and for
   * good.
   */
  it("carries on past a recurrence that throws, and keeps saying it is there", async () => {
    // Ordered by (next_occurrence_date, user_id, id), and "sweep-fresh" sorts
    // before "sweep-settled", so the broken one is examined first. That is the
    // case that matters: one tenant's bad row must not be able to stop another
    // tenant's schedule.
    const broken = await make(fresh, freshAccountId, "Broken shape", today);
    const healthy = await make(settled, settledAccountId, "Still fine", today);
    // A shape no longer parseable: what a hand-edited row, or one written by a
    // future version of the contract, looks like from here.
    await getDb().execute(sql`
      update recurrence set shape = '{"type":"withdrawal"}'::jsonb
       where id = ${broken.id}::uuid
    `);

    const summary = await runDueRecurrences();

    expect(summary.failed).toBe(1);
    expect(await staged(settled, healthy.id)).toHaveLength(1);
    expect(await staged(fresh, broken.id)).toHaveLength(0);

    // Still first in line on the next tick, still counted, still not fatal.
    expect((await runDueRecurrences()).failed).toBe(1);
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
        failed: 0,
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
