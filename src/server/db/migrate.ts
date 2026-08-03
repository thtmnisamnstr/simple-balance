import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { MIGRATION_LOCK } from "./advisory-locks.js";
import { closeDb, getPool } from "./client.js";

/**
 * PostgreSQL's code for "that database does not exist". The driver reports it
 * on connect, before anything can be done about it.
 */
const UNDEFINED_DATABASE = "3D000";

/**
 * Create the database named in DATABASE_URL if the server does not have it yet.
 *
 * Pointing a fresh container at a fresh PostgreSQL server is the ordinary way
 * to start, and it should not require going and running CREATE DATABASE by hand
 * first. The connection string is reused as-is against the server's own
 * `postgres` database, so no extra configuration is involved.
 *
 * Doing nothing at all is the common path: this only runs after a connection
 * has already failed for this specific reason.
 */
async function createDatabaseIfMissing(connectionString: string) {
  const url = new URL(connectionString);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name) throw new Error("DATABASE_URL must name a database");

  const maintenance = new URL(connectionString);
  maintenance.pathname = "/postgres";
  const client = new Client({
    connectionString: maintenance.toString(),
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `The database "${name}" does not exist, and connecting to the server's ` +
        `"postgres" database to create it failed. Create it yourself with ` +
        `CREATE DATABASE "${name}"; and start again.`,
      { cause: error },
    );
  }

  try {
    // The name comes from the operator's own connection string, and an
    // identifier cannot be parameterised, so it is quoted rather than bound.
    await client.query(`create database "${name.replaceAll('"', '""')}"`);
    console.info(`Created database "${name}".`);
  } catch (error) {
    // Another container starting at the same moment may have won the race,
    // which is a success for our purposes.
    const code = (error as { code?: string }).code;
    if (code !== "42P04") {
      throw new Error(
        `The database "${name}" does not exist and could not be created. ` +
          `The connecting role needs the CREATEDB privilege, or you can run ` +
          `CREATE DATABASE "${name}"; yourself.`,
        { cause: error },
      );
    }
  } finally {
    await client.end();
  }
}

export async function runMigrations() {
  // Session advisory locks belong to one PostgreSQL connection. Holding a
  // dedicated pool client prevents the lock, migration, and unlock from being
  // dispatched through different pooled sessions.
  const client = await connectForMigration();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    locked = true;
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    try {
      if (locked) {
        await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
      }
    } finally {
      client.release();
    }
  }
}

/**
 * A pool client, creating the database first if the server has never seen it.
 */
async function connectForMigration() {
  try {
    return await getPool().connect();
  } catch (error) {
    if ((error as { code?: string }).code !== UNDEFINED_DATABASE) throw error;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw error;
    await createDatabaseIfMissing(connectionString);
    return getPool().connect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => closeDb())
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exitCode = 1;
    });
}
