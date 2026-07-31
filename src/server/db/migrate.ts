import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { closeDb, getPool } from "./client.js";

const MIGRATION_LOCK = 724_202_607;

export async function runMigrations() {
  // Session advisory locks belong to one PostgreSQL connection. Holding a
  // dedicated pool client prevents the lock, migration, and unlock from being
  // dispatched through different pooled sessions.
  const client = await getPool().connect();
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => closeDb())
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exitCode = 1;
    });
}
