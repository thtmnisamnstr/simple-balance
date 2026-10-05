import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verify } from "../../scripts/capacity/verify.mjs";
import { runMigrations } from "../../src/server/db/migrate.js";

const run = promisify(execFile);
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_capacity_${process.pid}_${Date.now()}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
const root = path.resolve(import.meta.dirname, "../..");

let adminClient: PgClient;
let seededUrl: string;

/**
 * The capacity generator, run for real at the smallest scale that still has
 * every shape in it.
 *
 * `scripts/capacity/seed.mjs` is three hundred lines of SQL that nothing
 * exercises between capacity runs, and a capacity run happens a few times a
 * release. Left alone it would rot against the schema — a renamed column, a new
 * NOT NULL, a check constraint that tightened — and the first anybody would know
 * is an hour into building a thirty-million-row dataset for a proof somebody is
 * waiting on.
 *
 * So CI builds a small one every time. `--scale 10000` is eleven users: one from
 * each cohort, the heavy one included, which is what keeps the second currency,
 * the split-free ledger, the void-and-restore entries and the opening postings
 * all present. It takes a couple of seconds.
 *
 * The assertions are `verify.mjs` itself rather than a copy of it, so the thing
 * CI checks is the thing that guards a real run.
 */
integration("the capacity generator", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);

    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    seededUrl = databaseUrl.toString();
    process.env.DATABASE_URL = seededUrl;
    await runMigrations();

    await run("node", ["scripts/capacity/seed.mjs", "--scale", "10000"], {
      cwd: root,
      env: { ...process.env, CAPACITY_DATABASE_URL: seededUrl },
      // The generator is fast at this scale, but a machine under CI load is not.
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  }, 240_000);

  afterAll(async () => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await adminClient?.query(`drop database if exists "${databaseName}" with (force)`);
    await adminClient?.end();
  });

  it("produces a ledger that balances", async () => {
    const client = new PgClient({ connectionString: seededUrl });
    await client.connect();
    try {
      const { failures } = await verify(client);
      expect(failures).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("produces every shape the population is supposed to contain", async () => {
    const client = new PgClient({ connectionString: seededUrl });
    await client.connect();
    try {
      const one = async (text: string) => (await client.query(text)).rows[0];

      // Both currencies, which only the heavy cohort has — so this is also the
      // check that a scaled-down run still includes it.
      const currencies = await one(
        "select count(distinct currency)::int as n from ledger_account where system_kind is null",
      );
      expect(currencies.n, "the second currency survived the scaling").toBe(2);

      // The counter-accounts, one of each kind per currency, as
      // `ensureSystemAccount` would have made them.
      const kinds = await one(
        "select count(distinct system_kind)::int as n from ledger_account where system_kind is not null",
      );
      expect(kinds.n).toBe(4);

      // One entry in twenty carries six postings rather than two.
      const voided = await one(`
        select
          count(*) filter (where n = 6)::int as six,
          count(*)::int as total
        from (select transaction_id, count(*)::int as n from posting
              where transaction_id is not null group by transaction_id) s`);
      expect(voided.six / voided.total).toBeCloseTo(0.05, 3);

      // One in five carries a later version and an audit row and no posting.
      const edited = await one(`
        select
          (select count(*) from ledger_transaction where version > 1)::int as edited,
          (select count(*) from ledger_transaction)::int as total,
          (select count(*) from audit_event)::int as audits`);
      expect(edited.edited / edited.total).toBeCloseTo(0.2, 3);
      expect(edited.audits).toBe(edited.edited);

      // And the recurrences the schedule needs the scheduler to find.
      const due = await one(
        "select count(*)::int as n from recurrence where next_occurrence_date <= current_date",
      );
      expect(due.n).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });
});
