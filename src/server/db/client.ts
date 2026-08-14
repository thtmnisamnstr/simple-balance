import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { configuredDatabasePoolSize } from "../config-limits.js";
import * as schema from "./schema.js";

let pool: Pool | undefined;
let authBootstrapLockPool: Pool | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
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
export function getAuthBootstrapLockPool() {
  if (!authBootstrapLockPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    authBootstrapLockPool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
  }
  return authBootstrapLockPool;
}

export async function closeDb() {
  await Promise.all([
    pool?.end(),
    authBootstrapLockPool?.end(),
  ]);
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
  return transaction ? operation(transaction) : getDb().transaction(operation);
}
