import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Indexes `0023` has to drop because the cluster copies every one of them to
 * every shard, and because the thing they were for is gone by then.
 *
 * Step 2a already states the cost side: `create_distributed_table` replicates
 * an index thirty-two times over. What it does not cover is an index made
 * redundant by something other than the widened primary key, and
 * `category_group_reference_idx` is that case. It is `category(group_id)` with
 * no `user_id`, and `src/server/db/schema.ts` says it exists for one thing:
 * PostgreSQL's ON DELETE SET NULL action on the single-column `group_id` key
 * runs `where group_id = $1`, which `category_group_idx (user_id, group_id)`
 * cannot serve. `0023` drops that key and step 6 replaces it with a composite
 * NO ACTION one whose check carries the owner, so on a cluster the index
 * answers nothing at all.
 *
 * Held here rather than left to a reader, because both halves are invisible
 * from either end: the schema cannot see that the cluster replaced its key, and
 * the migration's own list is about unique constraints.
 *
 * The other half of the rule is that it stays in `schema.ts`. A plain
 * PostgreSQL keeps the single-column SET NULL key — `0016` says why the tenant
 * cannot be in it — so dropping it there would put a sequential scan of the
 * cross-tenant category table behind every group delete.
 */

const migration = readFileSync(
  new URL("../drizzle/0023_citus_distribution.sql", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("../src/server/db/schema.ts", import.meta.url), "utf8");

describe("the index a distributed ledger has no reader for", () => {
  it("is dropped by the Citus migration", () => {
    expect(migration).toContain("drop index if exists category_group_reference_idx");
  });

  it("is dropped before the tables are distributed, or the shards get a copy each", () => {
    const dropped = migration.indexOf("drop index if exists category_group_reference_idx");
    // The statement form rather than the name, which step 2a's prose also uses.
    const distributed = migration.search(/^\s*perform create_(?:distributed|reference)_table\(/m);

    expect(dropped).toBeGreaterThan(-1);
    expect(distributed).toBeGreaterThan(-1);
    expect(dropped).toBeLessThan(distributed);
  });

  it("stays in the schema, which is what a plain PostgreSQL still runs", () => {
    expect(schema).toContain('index("category_group_reference_idx").on(table.groupId)');
  });

  it("has no reader left on a cluster: nothing filters group_id without the owner", () => {
    // The composite key `category_group_owner_fk (user_id, group_id)` is what
    // step 6 puts back, and `category_group_idx` serves its check. If that
    // constraint ever gained an ON DELETE action, the bare predicate would
    // return and the drop above would be wrong.
    expect(migration).toContain(
      'alter table category add constraint "category_group_owner_fk" FOREIGN KEY (user_id, group_id) REFERENCES category_group(user_id, id)\'',
    );
  });
});
