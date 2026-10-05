import { sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createCategory } from "../../src/server/services/categories.js";
import { createBudgetPlan } from "../../src/server/services/budgets.js";
import { getForecast } from "../../src/server/services/forecast.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("forecast-tenancy");

const mine: Actor = { userId: "forecast-mine", source: "web" };
const theirs: Actor = { userId: "forecast-theirs", source: "web" };

/**
 * The forecast reads one person's budget plans and nobody else's.
 *
 * This exists because it did not, and nothing noticed. `forecast.ts` joined a
 * plan to its category on the category id alone — `category.id =
 * budget_plan.category_id`, with no owner — while every equivalent query in
 * `budgets.ts` carried `user_id` on both sides. The composite foreign keys
 * throughout this schema exist precisely to make a match across tenants
 * impossible, and this was the one join in the service that stepped around
 * them.
 *
 * It is harmless under today's primary key, and that is why it survived. A
 * `category` is keyed on `(id)` alone, so two people cannot hold the same
 * category id and the bare join has nothing wrong to match. The first version
 * of this test asserted the scoping directly and passed with the defect put
 * back, which is the only useful thing a test that cannot fail ever tells you.
 *
 * It stops being harmless the moment the ledger is distributed. Clustering
 * widens that key to `(user_id, id)` so that Citus can shard on the owner, and
 * from then on two people *can* hold the same category id — at which point a
 * join that omits the owner reads across tenants. Distributing also makes the
 * same query fail outright, with `complex joins are only supported when all
 * distributed tables are co-located and joined on their distribution columns`,
 * because on a cluster the owner is the distribution column.
 *
 * So this widens the key itself, on its own scratch database, and then does
 * what only the widened key allows: gives two people a category with the same
 * id. That is the schema `0023` will ship, tested before it ships.
 */
integration("the forecast and whose budget it reads", () => {
  let myCategory = "";

  beforeAll(async () => {
    await database.create();
    const db = getDb();
    await db
      .insert(user)
      .values(
        [mine, theirs].map((actor) => ({
          id: actor.userId,
          name: actor.userId,
          email: `${actor.userId}@example.test`,
          emailVerified: true,
        })),
      )
      .onConflictDoNothing();

    for (const actor of [mine, theirs]) {
      await setPreferences(actor, { timezone: "UTC", defaultCurrency: "USD" });
    }

    // The key the cluster needs, applied here so the collision below is legal.
    // Two statements, because Citus refuses DROP and ADD in one ALTER TABLE and
    // this should read the way the migration will have to.
    await db.execute(sql`alter table category drop constraint category_pkey`);
    await db.execute(sql`alter table category add primary key (user_id, id)`);

    myCategory = (await createCategory(mine, { name: "Mine", kind: "expense" })).id;

    // The same id, a different owner. Impossible under `(id)`; ordinary under
    // `(user_id, id)`. Written straight in, because the service would refuse to
    // hand out an id it already knows about.
    await db.execute(sql`
      insert into category (id, user_id, name, kind, version, created_at, updated_at)
      values (${myCategory}::uuid, ${theirs.userId}, 'Theirs', 'expense', 1, now(), now())
    `);
    const theirCategory = myCategory;

    // `percentOfIncome` rather than a plain amount. The rule is derived from the
    // row rather than asked for, and this is the arm the forecast reports as
    // unprojectable — which is where it names the category, and so the only
    // path that reads the join under test all the way to its output.
    for (const [actor, categoryId] of [
      [mine, myCategory],
      [theirs, theirCategory],
    ] as const) {
      await createBudgetPlan(actor, {
        categoryId,
        amount: "100.00",
        currency: "USD",
        percentOfIncome: "10",
        periodUnit: "month",
        activeFrom: "2026-01-01",
      });
    }
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  it("answers at all", async () => {
    // The shape of the query matters as much as its contents: this is the call
    // that returned a 500 on a distributed ledger.
    const forecast = await getForecast(mine, { periodUnit: "month" });
    expect(forecast).toBeTruthy();
  });

  it("names only the asking person's categories", async () => {
    const forecast = await getForecast(mine, { periodUnit: "month" });
    const named = JSON.stringify(forecast);
    expect(named).toContain("Mine");
    expect(named, "another person's category reached this forecast").not.toContain("Theirs");
  });

  it("shows the other person only their own", async () => {
    const forecast = await getForecast(theirs, { periodUnit: "month" });
    const named = JSON.stringify(forecast);
    expect(named).toContain("Theirs");
    expect(named, "another person's category reached this forecast").not.toContain("Mine");
  });
});
