import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { MIGRATION_LOCK } from "./advisory-locks.js";
import { closeDb, directConnectionString } from "./client.js";
import { migrationDuration, migrationRuns } from "../metrics.js";
import { log } from "../log.js";

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
    // identifier cannot be parameterized, so it is quoted rather than bound.
    await client.query(`create database "${name.replaceAll('"', '""')}"`);
    log.info(`Created database "${name}".`);
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
 * not check out. Node's own advice for these is to install the root CA
 * system-wide, which in a container means rebuilding the image; the connection
 * string can carry the CA instead, and that is what the message below says.
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
 * What two of those codes rule out, said in the refusal rather than left to a
 * guess. Each fails with the right CA named, so the reading every other code
 * gets — the named CA is not the one that signed — would send the operator
 * looking for a CA that does not exist.
 */
const TLS_FAILURE_READINGS = new Map([
  [
    "CERT_HAS_EXPIRED",
    "Here a certificate has expired, the server's or the CA's the URL names, so a " +
      "renewal rather than another CA is what fixes it: the server's certificate " +
      "on the server, or a current copy of the CA's. ",
  ],
  [
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "Here the CA is not what failed: the certificate does not carry the host the URL names. ",
  ],
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
      //
      // The verified way out comes first, because it is nearly always there:
      // a managed PostgreSQL publishes the CA that signs its certificates, and
      // a server that signed its own can be handed that certificate. Both are
      // a file, and node-postgres reads `sslrootcert` as a path and trusts
      // that file alone. The path is a placeholder rather than any profile's,
      // because this runs in every shape and only one of them has a directory
      // set aside for it. no-verify is the last resort and says what it gives
      // up: it is the one that tells nobody when a different server answers.
      throw new Error(
        `The database refused a verified TLS connection (${code}). ` +
          "To keep the check, save the certificate of the CA that signed the server's " +
          "(a managed PostgreSQL offers it for download; a server that signed its own " +
          "certificate can be given that certificate) where this process can read it, " +
          "and name it in DATABASE_URL: " +
          "?sslmode=verify-full&sslrootcert=/path/to/ca.pem. " +
          (TLS_FAILURE_READINGS.get(code) ??
            "If the URL names one already, it is not the one that signed this " +
              "server's certificate. ") +
          "The host in the URL has to be a name the certificate carries. Only where there is " +
          "no certificate to trust, use ?sslmode=no-verify: that still encrypts the " +
          "connection but stops checking who is on the other end.",
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
      log.failure("Migrations failed", error);
      await closeDb();
      process.exitCode = 1;
    });
}
