import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { ledgerAccounts, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  getAccountBalances,
  reconcileArchivedAccountClosings,
} from "../../src/server/services/accounts.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { calendarDayIn } from "../../src/shared/recurrence-dates.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("timezone_agreement");
const actor: Actor = { userId: "timezone-agreement-user", source: "web" };

/**
 * PostgreSQL reads this with the POSIX sign convention and `Intl` reads it as
 * ISO, so the two put the same instant sixteen hours apart. Any figure worked
 * out on one side and compared against the other is wrong for two thirds of
 * every day, which is why only one of them is allowed to answer.
 */
const OFFSET_ZONE = "-08:00";
const INSTANT = new Date("2026-03-15T00:15:00Z");

let savingsId = "";

integration("one answer to what day it is", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Timezone Agreement",
      email: "timezone-agreement@example.com",
      emailVerified: true,
    });
    await setPreferences(actor, { timezone: OFFSET_ZONE });
    savingsId = (
      await createAccount(actor, {
        name: "Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "500",
      })
    ).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  it("reads an offset timezone the way the rest of the application does", () => {
    expect(calendarDayIn(INSTANT, OFFSET_ZONE)).toBe("2026-03-14");
  });

  it("closes an archived account on the day it was archived, where the person lives", async () => {
    await getDb()
      .update(ledgerAccounts)
      .set({ archivedAt: INSTANT })
      .where(eq(ledgerAccounts.id, savingsId));

    await reconcileArchivedAccountClosings();

    const closings = await getDb().execute(sql`
      select distinct date::text as date
      from posting
      where user_id = ${actor.userId}
        and closing_account_id = ${savingsId}::uuid
      order by 1
    `);
    expect(closings.rows.map((row) => String(row.date))).toEqual([
      calendarDayIn(INSTANT, OFFSET_ZONE),
    ]);
  });

  /**
   * The clock is pinned rather than read, because the two conventions only
   * disagree about the date for sixteen hours out of every twenty-four. Asserting
   * that the route and `todayIn` agree would pass against the old code for a
   * third of the day, which is no assertion at all.
   *
   * At the pinned instant this person is still on the 14th while the database
   * session has reached the 15th, so a posting dated the 15th is the future to
   * them and belongs in `future` rather than in `current`.
   */
  it("reports today, and what is spendable, where the person lives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(INSTANT);
    try {
      const dated = (
        await createAccount(actor, {
          name: "Tomorrow Already",
          type: "checking",
          currency: "USD",
          openingDate: "2026-01-01",
          openingBalance: "200",
        })
      ).id;
      await getDb().execute(sql`
        insert into posting (user_id, opening_account_id, account_id, date, amount, currency)
        values (
          ${actor.userId}, ${dated}::uuid, ${dated}::uuid,
          '2026-03-15'::date, 50, 'USD'
        )
      `);

      const balances = await getAccountBalances(actor, dated, {});

      expect(balances.range.today).toBe("2026-03-14");
      expect(balances.current.balance).toBe("200");
      expect(balances.future.balance).toBe("250");
    } finally {
      vi.useRealTimers();
    }
  });
});
