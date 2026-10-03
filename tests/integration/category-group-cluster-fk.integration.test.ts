import { sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createCategory, listCategories } from "../../src/server/services/categories.js";
import {
  createCategoryGroup,
  deleteCategoryGroup,
} from "../../src/server/services/category-groups.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("group-cluster-fk");

const actor: Actor = { userId: "group-fk-owner", source: "web" };

/**
 * Deleting a category group under the foreign key a Citus cluster forces.
 *
 * On a single database `category.group_id` is `on delete set null`, so deleting
 * a group and leaving its categories behind is something the database does and
 * the service never thinks about. On a cluster it cannot be: Citus refuses
 * `SET NULL` whenever the distribution column is part of the constraint, and
 * refuses PostgreSQL 15's `SET NULL (group_id)` column-list spelling for the
 * same reason, so `0023_citus_distribution.sql` installs the key as `NO ACTION`.
 * Under `NO ACTION` the delete does not orphan anything — it fails outright.
 *
 * So the service clears the column itself, and this is the only arrangement in
 * which that statement is observable: on the schema the rest of the suite runs
 * against, the foreign key would do the same work and a test here would pass
 * with the service line deleted. This installs the cluster's key on its own
 * scratch database first, which makes the assertion able to fail. Confirmed by
 * removing the statement: the delete comes back a foreign key violation and the
 * category keeps its group.
 *
 * Only the one table is rewritten. `0023` does considerably more, and none of
 * the rest bears on what a group delete does.
 */
integration("deleting a category group on the cluster's foreign key", () => {
  let groupId = "";
  let categoryId = "";

  beforeAll(async () => {
    await database.create();
    const db = getDb();
    await db
      .insert(user)
      .values({
        id: actor.userId,
        name: actor.userId,
        email: `${actor.userId}@example.test`,
        emailVerified: true,
      })
      .onConflictDoNothing();
    await setPreferences(actor, { timezone: "UTC", defaultCurrency: "USD" });

    // The three statements `0023` applies to this table, in its order. The
    // foreign key comes off first because the primary key it points at cannot be
    // dropped while it does, and the two halves of the key change are separate
    // statements because Citus refuses DROP and ADD in one ALTER TABLE.
    await db.execute(
      sql`alter table category drop constraint category_group_id_category_group_id_fk`,
    );
    await db.execute(sql`alter table category_group drop constraint category_group_pkey`);
    await db.execute(sql`alter table category_group add primary key (user_id, id)`);
    await db.execute(sql`
      alter table category
        add constraint category_group_owner_fk
        foreign key (user_id, group_id) references category_group (user_id, id)
    `);

    const group = await createCategoryGroup(actor, { name: "Household", policy: "standalone" });
    groupId = group.id;
    const category = await createCategory(actor, {
      name: "Rent",
      kind: "expense",
      groupId,
    });
    categoryId = category.id;
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  it("installs the key the cluster forces", async () => {
    const db = getDb();
    const result = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'category_group_owner_fk'
    `);
    const row = result.rows[0];
    // No `ON DELETE` clause at all is NO ACTION, which is the point: if this
    // ever reads `SET NULL` the rest of the file is testing nothing.
    expect(row?.definition).toContain("FOREIGN KEY (user_id, group_id)");
    expect(row?.definition).not.toContain("ON DELETE");
  });

  it("deletes the group and leaves the category behind without one", async () => {
    await expect(deleteCategoryGroup(actor, groupId, 1)).resolves.toEqual({ id: groupId });

    const categories = await listCategories(actor);
    const kept = categories.find((row) => row.id === categoryId);
    expect(kept).toBeDefined();
    expect(kept?.groupId).toBeNull();
  });
});
