import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { idempotencyRecords, user } from "../../src/server/db/schema.js";
import { IDEMPOTENCY_SWEEP_BATCH } from "../../src/server/config-limits.js";
import { pruneIdempotencyRecords } from "../../src/server/services/helpers.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("idempotency_retention");
const userId = "retention-user";

/**
 * The retention sweep, which is the one thing in this feature that is SQL.
 *
 * `http.md` called an unpruned `idempotency_record` the one real gap in that
 * section, and Zalando says why: the key cache "is not intended as request log,
 * and therefore should have a limited lifetime, else it could easily exceed the
 * data resource in size". Every create, commit and bulk write stores a full
 * JSONB copy of its response in it.
 *
 * The first case is the one that matters most. **Off is the default**, and a
 * deployment that sets nothing has to keep every record it has — otherwise this
 * would be a release deleting data nobody asked it to delete, which is exactly
 * what the upgrade invariant forbids.
 */
const record = (key: string, createdAt: Date) => ({
  userId,
  operation: "transaction.create",
  key,
  requestHash: "a".repeat(64),
  response: { id: key },
  createdAt,
  updatedAt: createdAt,
});

const remaining = async () =>
  (
    await getDb()
      .select({ key: idempotencyRecords.key })
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.userId, userId))
  ).map((row) => row.key);

integration("pruning used idempotency keys", () => {
  const original = process.env.IDEMPOTENCY_RETENTION_HOURS;

  beforeAll(async () => {
    await database.create();
    await getDb()
      .insert(user)
      .values({ id: userId, name: "Retention", email: "retention@example.com" });
  });

  afterAll(async () => {
    await database.drop();
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.IDEMPOTENCY_RETENTION_HOURS;
    else process.env.IDEMPOTENCY_RETENTION_HOURS = original;
    await getDb().delete(idempotencyRecords).where(eq(idempotencyRecords.userId, userId));
  });

  const hours = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000);

  it("keeps every record when nothing asked for a window", async () => {
    delete process.env.IDEMPOTENCY_RETENTION_HOURS;
    await getDb()
      .insert(idempotencyRecords)
      .values([record("ancient", hours(24 * 400)), record("fresh", hours(1))]);

    const swept = await pruneIdempotencyRecords();

    // No query at all, which is the other half of "off": a deployment that
    // never asked pays a function call per tick rather than a table read.
    expect(swept).toEqual({ swept: 0, capped: false });
    expect((await remaining()).sort()).toEqual(["ancient", "fresh"]);
  });

  it("removes what is older than the window and nothing else", async () => {
    process.env.IDEMPOTENCY_RETENTION_HOURS = "24";
    await getDb()
      .insert(idempotencyRecords)
      .values([
        record("old", hours(48)),
        record("just-inside", hours(23)),
        record("just-outside", hours(25)),
        record("new", hours(1)),
      ]);

    const swept = await pruneIdempotencyRecords();

    expect(swept.swept).toBe(2);
    expect(swept.capped).toBe(false);
    expect((await remaining()).sort()).toEqual(["just-inside", "new"]);
  });

  it("takes the window from the clock it is given", async () => {
    // The sweep takes `now` rather than reading the clock, so a test can move
    // time without stubbing `Date` for everything else in the process.
    process.env.IDEMPOTENCY_RETENTION_HOURS = "24";
    await getDb()
      .insert(idempotencyRecords)
      .values([record("recent", hours(1))]);

    expect((await pruneIdempotencyRecords()).swept).toBe(0);
    // The same row, judged from a day later.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect((await pruneIdempotencyRecords(tomorrow)).swept).toBe(1);
  });

  it("says when it filled its batch, so a backlog drains rather than rushing", async () => {
    // A deployment turning retention on after a year has a year of records to
    // remove, and one unbounded delete would hold a lock over the whole table.
    // The scheduler comes back every few minutes; `capped` is what tells the
    // log a second pass is owed.
    process.env.IDEMPOTENCY_RETENTION_HOURS = "1";
    const many = Array.from({ length: IDEMPOTENCY_SWEEP_BATCH + 5 }, (_, index) =>
      record(`bulk-${index}`, hours(48)),
    );
    // Inserted in chunks: a single statement with five thousand rows exceeds
    // what the driver will bind in one go.
    for (let at = 0; at < many.length; at += 1_000) {
      await getDb()
        .insert(idempotencyRecords)
        .values(many.slice(at, at + 1_000));
    }

    const first = await pruneIdempotencyRecords();
    expect(first.swept).toBe(IDEMPOTENCY_SWEEP_BATCH);
    expect(first.capped).toBe(true);

    const second = await pruneIdempotencyRecords();
    expect(second.swept).toBe(5);
    expect(second.capped).toBe(false);
    expect(await remaining()).toEqual([]);
  });

  /**
   * The sweep reads by age, and an index has to be able to serve that.
   *
   * Without one it is a full scan of the table it runs every few minutes to
   * keep small — the shape of the problem it exists to solve. The primary key
   * is (user, operation, key) and cannot help, so `0021` adds one on
   * `created_at`.
   *
   * Costs are priced out of the way rather than the plan being read as the
   * planner would choose it. On a small table a sequential scan is correct and
   * cheaper, so what is under test is whether an index *can* produce this read
   * — if none can, a scan appears despite the cost. The same technique as the
   * default-ordering test in `sorting.integration.test.ts`, and for the same
   * reason: asserting a particular index name is flaky in a shared database
   * where another file's rows move the statistics.
   */
  it("reads the age by index rather than by scanning the table it keeps small", async () => {
    await getDb()
      .insert(idempotencyRecords)
      .values([record("old", hours(48))]);
    const text = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = await tx.execute(
        sql`explain select 1 from "idempotency_record"
            where "created_at" < now() - interval '24 hours'`,
      );
      return plan.rows.map((row) => Object.values(row)[0]).join("\n");
    });
    expect(text).toContain("Index");
    expect(text).not.toContain("Seq Scan");
  });

  it("leaves another person's records alone", async () => {
    // A sweep reads by age and nothing else, which is correct — but it must not
    // become a query that scopes to one tenant and then misses the rest.
    process.env.IDEMPOTENCY_RETENTION_HOURS = "24";
    await getDb()
      .insert(user)
      .values({ id: "other-retention", name: "Other", email: "other-retention@example.com" });
    await getDb()
      .insert(idempotencyRecords)
      .values([
        record("mine", hours(48)),
        { ...record("theirs", hours(48)), userId: "other-retention" },
      ]);

    expect((await pruneIdempotencyRecords()).swept).toBe(2);
    const left = await getDb()
      .select({ key: idempotencyRecords.key })
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.userId, "other-retention"),
          eq(idempotencyRecords.operation, "transaction.create"),
        ),
      );
    expect(left).toEqual([]);
  });
});
