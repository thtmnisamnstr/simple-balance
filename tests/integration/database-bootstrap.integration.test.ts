import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);

/** A name nothing else will be using, so the run starts from truly nothing. */
const createdDatabase = "simple_balance_bootstrap_probe";

function urlFor(databaseName: string) {
  const url = new URL(connection!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function onMaintenance<T>(run: (client: Client) => Promise<T>) {
  const url = new URL(connection!);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

integration("starting against a server that has never seen this database", () => {
  beforeAll(async () => {
    await onMaintenance((client) => client.query(`drop database if exists ${createdDatabase}`));
  });

  afterAll(async () => {
    await closeDb();
    await onMaintenance((client) => client.query(`drop database if exists ${createdDatabase}`));
  });

  // Pointing a fresh container at a fresh PostgreSQL server is the ordinary way
  // to start. Failing there with a driver-level error would send someone off to
  // run CREATE DATABASE by hand before the app would come up at all.
  it("creates the database and migrates it", async () => {
    const existsBefore = await onMaintenance((client) =>
      client.query("select 1 from pg_database where datname = $1", [createdDatabase]),
    );
    expect(existsBefore.rowCount).toBe(0);

    process.env.DATABASE_URL = urlFor(createdDatabase);
    await runMigrations();

    const existsAfter = await onMaintenance((client) =>
      client.query("select 1 from pg_database where datname = $1", [createdDatabase]),
    );
    expect(existsAfter.rowCount).toBe(1);

    const client = new Client({ connectionString: urlFor(createdDatabase) });
    await client.connect();
    try {
      const tables = await client.query<{ count: string }>(
        "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
      );
      expect(Number(tables.rows[0]!.count)).toBeGreaterThan(10);
    } finally {
      await client.end();
    }

    // Starting again against the same database changes nothing and does not
    // trip over the database now existing.
    await closeDb();
    process.env.DATABASE_URL = urlFor(createdDatabase);
    await expect(runMigrations()).resolves.toBeUndefined();
  });
});
