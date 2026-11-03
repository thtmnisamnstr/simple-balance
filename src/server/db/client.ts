import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { readSecret } from "../config-files.js";
import { configuredDatabasePoolSize } from "../config-limits.js";
import {
  databasePoolAcquireDuration,
  databasePoolErrors,
  databaseTransactionDuration,
  databaseTransactions,
  trackDatabasePool,
} from "../metrics.js";
import * as schema from "./schema.js";
import { log } from "../log.js";

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
    // time this runs; there is nothing to do but say so, and count it: the line
    // is the one an operator reads afterward, and a run of them is a database
    // restarting, which only a rate can show while it is happening.
    pool.on("error", (error) => {
      databasePoolErrors.inc();
      log.failure("Idle database client error", error);
    });
    measureAcquire(pool);
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
    database = measureTransactions(drizzle(getPool(), { schema }));
  }
  return database;
}

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

/**
 * Keep the cross-process owner-bootstrap lock off the application pool.
 *
 * The lock holder calls Better Auth, which needs the main pool. A dedicated
 * single-connection pool prevents a small application pool from deadlocking
 * while also bounding this process to one PostgreSQL lock connection.
 */
export function getAuthBootstrapLockPool() {
  if (!authBootstrapLockPool) {
    authBootstrapLockPool = new Pool({
      connectionString: directConnectionString(),
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    // Same handler the main pool has, for the same reason: an idle client's
    // connection dropping emits 'error' on the pool, and unhandled that is an
    // uncaught exception that takes the process down for a blip the next
    // query would simply have retried through.
    authBootstrapLockPool.on("error", (error) => {
      log.failure("Idle auth bootstrap client error", error);
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
  // Timed nowhere in here, in either branch. `getDb()` times every transaction
  // it opens (`measureTransactions`, below), so the one opened here is timed
  // there, and so is one a caller supplied: nothing else hands out a
  // transaction, so whoever opened it went through the same door. Timing here
  // as well would report one write as two and double the time spent holding
  // connections. The comment that stood here said a supplied transaction was
  // "already being timed by whoever opened it", and it was false for every MCP
  // write, whose transaction the transport opened directly and nobody timed.
  if (transaction) return operation(transaction);
  return getDb().transaction(operation);
}

/**
 * Every transaction this process opens, timed and counted at the one door they
 * all pass.
 *
 * `withTransaction` was the only thing timed, and it was one way in among
 * thirteen: twelve sites opened `getDb().transaction` directly — every MCP
 * write, the scheduler's recurrence proposals, and the billing writes that hold
 * the subscription lock among them — so the histogram reported an unknown
 * fraction of the time connections were held. Routing the twelve through
 * `withTransaction` was the other fix, and it holds until the next direct call,
 * which is untimed again with nothing to say so. `getDb()` is the door all of
 * them already use, Better Auth's adapter included, since it is handed this
 * same instance. Wrapping `transaction` on the instance is what instruments a
 * site added tomorrow by existing rather than by somebody remembering. A
 * savepoint is `transaction` on the transaction object rather than on this
 * one, so it stays part of the transaction it nests in.
 *
 * The clock starts inside the callback, which drizzle calls once it holds a
 * connection and `begin` has returned, and stops when the `commit` or
 * `rollback` has returned and the connection is back in the pool. That is the
 * figure the histogram's help text names — how long a transaction held its
 * connection. `withTransaction` started its clock before asking for one, so a
 * full pool read as slow transactions, which is the opposite diagnosis; the
 * wait is `db_pool_acquire_duration_seconds` now and is counted there alone.
 * The sum of this histogram over a window, divided by the window, is how many
 * connections transactions kept busy on average.
 *
 * The outcome is counted once drizzle's promise has settled, which is after the
 * `commit` or `rollback` came back, because a transaction counted as committed
 * before its commit returned is a count of attempts. A `commit` that fails is a
 * rollback: PostgreSQL has ended the transaction either way. A transaction that
 * never began — no connection to be had, or `begin` itself refused — is
 * neither, and is not timed; the acquire that failed is in
 * `db_pool_errors_total`.
 */
function measureTransactions(db: ReturnType<typeof drizzle<typeof schema>>) {
  const open = db.transaction.bind(db);
  db.transaction = (operation, config) => {
    let stop: (() => number) | undefined;
    return open((tx) => {
      stop = databaseTransactionDuration.startTimer();
      return operation(tx);
    }, config).then(
      (result) => {
        stop?.();
        databaseTransactions.inc({ outcome: "committed" });
        return result;
      },
      (error: unknown) => {
        if (stop) {
          stop();
          databaseTransactions.inc({ outcome: "rolled_back" });
        }
        throw error;
      },
    );
  };
  return db;
}

type AcquireCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (release?: unknown) => void,
) => void;

/**
 * Every wait for a connection from the application pool, timed where it is
 * made.
 *
 * `connect` is the one door, and it is reached two ways. A transaction calls it
 * and awaits the promise. A statement outside one — most reads, Better Auth's
 * included — goes through `pool.query`, which calls `this.connect` with a
 * callback and never touches anything this file hands out. So the wrapper sits
 * on the pool instance, where both find it, and takes both shapes. Wrapping the
 * transactions alone would miss the plain reads, and those are most of what
 * queues behind a full pool.
 *
 * Each shape goes through in its own form rather than one being built from the
 * other, so a caller gets back exactly what it got before — pg's own promise,
 * or its callback with the release function — and the only difference is a
 * clock read on either side. Nothing else happens here: no read and no
 * connection of its own, so there is nothing a Better Auth hook holding the
 * only connection of a one-connection pool could end up waiting on.
 *
 * A failed acquire — refused, or out of time after `connectionTimeoutMillis` —
 * is observed as the wait it was and counted as a pool error, because it fails
 * the request that asked while that request's own series can only say that it
 * failed. The bootstrap lock pool is left out on purpose. It serves the
 * first-account claim and nothing else, and a second claim in the same process
 * is refused before it asks, so it never queues: what it would contribute is
 * a connection being opened, read as a wait in a histogram about queueing.
 */
function measureAcquire(application: Pool) {
  const acquire = application.connect.bind(application) as Pool["connect"];
  application.connect = function measuredConnect(callback?: AcquireCallback) {
    const stop = databasePoolAcquireDuration.startTimer();
    if (callback) {
      acquire((error, client, release) => {
        stop();
        if (error) databasePoolErrors.inc();
        callback(error, client, release);
      });
      return;
    }
    return acquire().then(
      (client) => {
        stop();
        return client;
      },
      (error: unknown) => {
        stop();
        databasePoolErrors.inc();
        throw error;
      },
    );
  } as Pool["connect"];
}
