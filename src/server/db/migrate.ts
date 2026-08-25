import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { MIGRATION_LOCK } from "./advisory-locks.js";
import { closeDb, directConnectionString } from "./client.js";
import { migrationDuration, migrationRuns } from "../metrics.js";

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
  // Timed including the wait for the lock, which is the number worth having:
  // on a rolling deploy the second process spends that whole time doing
  // nothing, and readiness is what it costs.
  const stop = migrationDuration.startTimer();
  // Session advisory locks belong to one PostgreSQL connection. Holding a
  // dedicated pool client prevents the lock, migration, and unlock from being
  // dispatched through different pooled sessions.
  const client = await connectForMigration();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    locked = true;
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    migrationRuns.inc({ outcome: "ok" });
  } catch (error) {
    // Counted before it is rethrown. Readiness already fails on this, but a
    // failed migration and a database that was never reachable look the same
    // from outside, and only one of the two is fixed by waiting.
    migrationRuns.inc({ outcome: "failed" });
    throw error;
  } finally {
    stop();
    try {
      if (locked) {
        await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
      }
    } finally {
      await client.end();
    }
  }
}

/**
 * Certificate failures node-postgres reports when TLS is on but the chain does
 * not check out. A self-hosted PostgreSQL almost always presents a certificate
 * it signed itself, and Node's own advice for this is to install the root CA,
 * which there is no root CA for.
 */
const TLS_TRUST_FAILURES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * A connection of its own, creating the database first if the server has never
 * seen it.
 *
 * Not borrowed from the application pool, because the lock below is
 * session-level and a transaction pooler would hand the lock, the migration and
 * the unlock to three different server connections. This one goes to
 * DIRECT_DATABASE_URL when there is a pooler to go past.
 */
async function connectForMigration() {
  const connect = async () => {
    const client = new Client({ connectionString: directConnectionString() });
    await client.connect();
    return client;
  };
  try {
    return await connect();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code && TLS_TRUST_FAILURES.has(code)) {
      // `sslmode=require` reads as "encrypt, do not check the certificate" in
      // libpq, and node-postgres does check it, so the setting most people
      // reach for is the one that fails here.
      throw new Error(
        `The database refused a verified TLS connection (${code}). ` +
          "If it presents a certificate it signed itself, which a self-hosted " +
          "PostgreSQL usually does, use ?sslmode=no-verify in DATABASE_URL: " +
          "that still encrypts the connection but stops checking who signed " +
          "the certificate. Use ?sslmode=verify-full only when the server has " +
          "a certificate from a CA this container already trusts.",
        { cause: error },
      );
    }
    if (code !== UNDEFINED_DATABASE) throw error;
    await createDatabaseIfMissing(directConnectionString());
    return connect();
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
