import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { createAttemptLimiter, postgresAttemptStore } from "../../src/server/http-security.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("rate_limit");

/**
 * The counter that decides whether a guess is allowed, against the real table
 * and the real statement. The unit tests use a stand-in store, which cannot
 * show that two replicas racing the same key settle on one count: that property
 * belongs to the upsert, and only PostgreSQL can be asked about it.
 */
integration("an allowance shared by every replica", () => {
  beforeAll(async () => {
    await database.create();
  });

  afterAll(async () => {
    await database.drop();
  });

  const replica = (max: number, now = () => 1_000_000) =>
    createAttemptLimiter({ max, windowMs: 60_000, now, store: postgresAttemptStore });

  const countFor = async (key: string) => {
    const rows = await getDb().execute<{ count: number }>(
      sql`select count from auth_rate_limit where key = ${`attempt:${key}`}`,
    );
    return rows.rows[0]?.count ?? null;
  };

  it("spends one allowance across separate processes", async () => {
    const first = replica(3);
    const second = replica(3);
    expect(await first.take("shared-a")).toBe(true);
    expect(await second.take("shared-a")).toBe(true);
    expect(await first.take("shared-a")).toBe(true);
    // The fourth attempt is over the allowance whichever replica makes it.
    expect(await second.take("shared-a")).toBe(false);
    expect(Number(await countFor("shared-a"))).toBe(4);
  });

  /**
   * Read-then-write would let two replicas both see the last allowed attempt
   * and both allow it. The count is settled inside the row's own lock instead,
   * so a burst of concurrent attempts is counted once each.
   */
  it("loses no attempt when replicas race the same key", async () => {
    const attempts = 20;
    const replicas = Array.from({ length: attempts }, () => replica(5));
    const allowed = await Promise.all(replicas.map((one) => one.take("shared-race")));

    expect(Number(await countFor("shared-race"))).toBe(attempts);
    // Each limiter is its own process here, so none of them refuses locally.
    // Exactly the allowance came back true, and the rest were turned away.
    expect(allowed.filter(Boolean)).toHaveLength(5);
  });

  it("starts a new window once the old one has run out", async () => {
    const early = replica(1, () => 2_000_000);
    expect(await early.take("shared-window")).toBe(true);
    expect(await replica(1, () => 2_030_000).take("shared-window")).toBe(false);
    const later = replica(1, () => 2_061_000);
    expect(await later.take("shared-window")).toBe(true);
    expect(Number(await countFor("shared-window"))).toBe(1);
  });

  it("forgets a caller that succeeded, for every replica at once", async () => {
    const first = replica(1);
    expect(await first.take("shared-clear")).toBe(true);
    await first.clear("shared-clear");
    expect(await countFor("shared-clear")).toBeNull();
    expect(await replica(1).take("shared-clear")).toBe(true);
  });

  /**
   * The table is shared with Better Auth, whose sweeper deletes rows it
   * considers expired by ITS window — ten seconds, against this store's
   * fifteen minutes. A row stamped with its window's start looked ancient ten
   * seconds in, and two ordinary sign-ins deleted the shared brute-force
   * tally mid-window. The row carries its expiry now, so a sweep older than
   * the row's own future timestamp spares it.
   */
  it("survives Better Auth's own expiry sweep for the whole window", async () => {
    const limiter = replica(3);
    expect(await limiter.take("shared-sweep")).toBe(true);
    expect(await limiter.take("shared-sweep")).toBe(true);
    // Better Auth's deleteExpiredRows shape: everything whose last_request is
    // older than now minus its ten-second window. Eleven seconds after the
    // attempts, mid-way through this store's window.
    const sweepAt = 1_000_000 + 11_000;
    await getDb().execute(
      sql`delete from auth_rate_limit where last_request < ${sweepAt - 10_000}`,
    );
    expect(await countFor("shared-sweep")).toBe(2);
    // And the tally still refuses the fourth guess, replica or not.
    expect(await limiter.take("shared-sweep")).toBe(true);
    expect(await limiter.take("shared-sweep")).toBe(false);
  });
});
