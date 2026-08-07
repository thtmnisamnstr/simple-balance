import { Client as PgClient } from "pg";
import { closeDb } from "../../../src/server/db/client.js";
import { runMigrations } from "../../../src/server/db/migrate.js";

/**
 * A database of this suite file's own, migrated and then dropped.
 *
 * Sharing one database means sharing the rows in it, and these files seed fixed
 * user ids and delete them again. Two runs at once, from two worktrees or a
 * developer alongside CI, then delete each other's fixtures and fail in ways
 * that look like real defects. The name carries the process id and a timestamp
 * so two runs cannot land on the same database either.
 */
export function scratchDatabase(label: string) {
  const connection = process.env.TEST_DATABASE_URL;
  const name = `simple_balance_${label}_${process.pid}_${Date.now()}`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let admin: PgClient | undefined;

  return {
    async create() {
      admin = new PgClient({ connectionString: connection });
      await admin.connect();
      await admin.query(`create database "${name}"`);
      const url = new URL(connection!);
      url.pathname = `/${name}`;
      process.env.DATABASE_URL = url.toString();
      await runMigrations();
    },
    // Every step runs even when an earlier one throws, because a failure here
    // would otherwise strand the database and the connection both, and the
    // second failure is the one that gets reported.
    async drop() {
      try {
        await closeDb();
      } finally {
        try {
          await admin?.query(`drop database if exists "${name}"`);
        } finally {
          try {
            await admin?.end();
          } finally {
            if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = previousDatabaseUrl;
          }
        }
      }
    },
  };
}
