import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { readSecret } from "../config-files.js";
import { configuredDatabasePoolSize } from "../config-limits.js";
import { databaseTransactionDuration, trackDatabasePool } from "../metrics.js";
import * as schema from "./schema.js";

let pool: Pool | undefined;
let authBootstrapLockPool: Pool | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getPool() {
  if (!pool) {
    // Through `readSecret` rather than `process.env`, so a value that arrived
    // as `DATABASE_URL_FILE` reaches the pool without ever having been assigned
    // into this process's environment. This is the read that made a resolver
    // writing back into `process.env` look necessary; it is not.
    const connectionString = readSecret("DATABASE_URL");
    if (!connectionString) throw new Error("DATABASE_URL is required");
    pool = new Pool({
      connectionString,
      max: configuredDatabasePoolSize(),
      connectionTimeoutMillis: 10_000,
    });
    // An idle client whose connection drops - a database restart, a network
    // blip, an idle timeout on a proxy - emits on the pool rather than on any
    // request. Unhandled, that is an uncaught exception and the process exits,
    // so a momentary blip takes the container down instead of being retried on
    // the next query. pg has already removed and destroyed the client by the
    // time this runs; there is nothing to do but say so.
    pool.on("error", (error) => {
      console.error("Idle database client error", error);
    });
    // Handed to the metrics registry rather than read from it, because a scrape
    // must never be the thing that opens a database connection: reading
    // `getPool()` from a collector would create one on a process that has not
    // touched the database yet.
    trackDatabasePool(pool);
  }
  return pool;
}

export function getDb() {
  if (!database) {
    database = drizzle(getPool(), { schema });
  }
  return database;
}

/**
 * Keep the cross-process owner-bootstrap lock off the application pool.
 *
 * The lock holder calls Better Auth, which needs the main pool. A dedicated
 * single-connection pool prevents a small application pool from deadlocking
 * while also bounding this process to one PostgreSQL lock connection.
 */
/**
 * The connection string for work a transaction pooler cannot carry.
 *
 * Two things here hold a session-level advisory lock across statements: the
 * migration lock and the first-account claim. PgBouncer in transaction mode
 * hands each statement whichever server connection is free, so the lock is
 * taken on one and released on another, which is to say not held at all. Point
 * DIRECT_DATABASE_URL past the pooler and both keep working; leave it unset and
 * everything uses one string, which is right for every deployment that has no
 * pooler in the first place.
 */
export function directConnectionString() {
  // Resolving on first read is also what makes `npm run db:migrate` work with a
  // `_FILE` value: that script calls `runMigrations`, which reaches this
  // function and never calls `getConfig`, so nothing there has to know a
  // resolver exists.
  const direct = readSecret("DIRECT_DATABASE_URL")?.trim();
  const connectionString = direct || readSecret("DATABASE_URL");
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return connectionString;
}

export function getAuthBootstrapLockPool() {
  if (!authBootstrapLockPool) {
    authBootstrapLockPool = new Pool({
      connectionString: directConnectionString(),
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
  }
  return authBootstrapLockPool;
}

export async function closeDb() {
  await Promise.all([pool?.end(), authBootstrapLockPool?.end()]);
  pool = undefined;
  authBootstrapLockPool = undefined;
  database = undefined;
}

export type Database = ReturnType<typeof getDb>;
export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Run a service mutation in the caller's transaction when one is supplied.
 *
 * Transport adapters such as MCP use this to keep their idempotency record,
 * domain mutation, and audit events on the same PostgreSQL connection and
 * transaction. Ordinary API callers omit `transaction` and retain the usual
 * service-owned atomic boundary.
 */
export function withTransaction<T>(
  transaction: DbTransaction | undefined,
  operation: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  // Timed only where a transaction is opened here. A caller that supplied one
  // is already being timed by whoever opened it, and counting both would report
  // one write as two and double the total time spent holding connections.
  if (transaction) return operation(transaction);
  const stop = databaseTransactionDuration.startTimer();
  return getDb()
    .transaction(operation)
    .finally(() => stop());
}
