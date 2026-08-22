import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationDirectory = path.resolve(import.meta.dirname, "../drizzle");
const metadataDirectory = path.join(migrationDirectory, "meta");

describe("migration baseline", () => {
  // The 0.1.0 baseline has shipped, so it is frozen. A change here would mean a
  // database that already ran it now disagrees with its own recorded history.
  // New schema work adds a migration beside it rather than editing it.
  it("keeps the released baseline exactly as it shipped", async () => {
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const snapshotFiles = (await readdir(metadataDirectory))
      .filter((name) => name.endsWith("_snapshot.json"))
      .sort();
    const journal = JSON.parse(
      await readFile(path.join(metadataDirectory, "_journal.json"), "utf8"),
    ) as {
      version: string;
      dialect: string;
      entries: Array<{
        idx: number;
        version: string;
        tag: string;
        breakpoints: boolean;
      }>;
    };

    // Frozen means unchanged and still first, not alone. Later work is expected
    // to sit beside it; what must never happen is the baseline itself moving.
    //
    // 0001 through 0004 shipped in released versions and are frozen for the
    // same reason: a database that has already recorded running them cannot be
    // told they say something else now.
    expect(journal.entries.slice(0, 5).map((entry) => entry.tag)).toEqual([
      "0000_initial",
      "0001_verify_existing_accounts",
      "0002_account_closing_postings",
      "0003_transaction_templates",
      "0004_template_provenance",
    ]);
    expect(migrationFiles[0]).toBe("0000_initial.sql");
    expect(snapshotFiles[0]).toBe("0000_snapshot.json");
    expect(journal).toMatchObject({ version: "7", dialect: "postgresql" });
    expect(journal.entries[0]).toMatchObject({
      idx: 0,
      version: "7",
      tag: "0000_initial",
      breakpoints: true,
    });

    // Every migration is numbered in order, appears once, and carries the
    // snapshot drizzle-kit needs to work out the next one.
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
    expect(migrationFiles).toHaveLength(journal.entries.length);
    expect(snapshotFiles).toHaveLength(journal.entries.length);
    journal.entries.forEach((entry, index) => {
      expect(migrationFiles[index]).toBe(`${entry.tag}.sql`);
      expect(snapshotFiles[index]).toBe(
        `${String(index).padStart(4, "0")}_snapshot.json`,
      );
    });
  });

  it("models the current schema directly", async () => {
    const sql = await readFile(
      path.join(migrationDirectory, "0000_initial.sql"),
      "utf8",
    );
    const baselineSnapshot = JSON.parse(
      await readFile(path.join(metadataDirectory, "0000_snapshot.json"), "utf8"),
    ) as {
      prevId: string;
      tables: Record<
        string,
        {
          columns: Record<string, { notNull: boolean; type: string }>;
          indexes: Record<string, unknown>;
        }
      >;
    };

    expect(sql).toContain('CREATE TABLE "idempotency_record"');
    expect(sql).toContain('"request_hash" text NOT NULL');
    expect(sql).toContain('CREATE TABLE "auth_mcp_signing_key"');
    expect(sql).toContain(
      'CONSTRAINT "auth_account_provider_account_unique" UNIQUE("provider_id","account_id")',
    );
    expect(sql).toContain(
      'CREATE INDEX "transaction_external_id_idx" ON "ledger_transaction" USING btree ("user_id","external_id")',
    );
    expect(sql).toContain(
      'CONSTRAINT "ledger_transaction_shape_check" CHECK',
    );
    // Postings are append-only, so one account can carry several generations
    // for the same transaction and a conversion touches the exchange account in
    // two currencies. A uniqueness rule there would block both.
    expect(sql).not.toContain('CREATE UNIQUE INDEX "posting_transaction_account_unique"');
    expect(sql).toContain('CREATE INDEX "posting_transaction_idx"');
    expect(sql).toContain("CREATE TYPE \"public\".\"system_account_kind\"");
    expect(sql).toContain('"system_kind" "system_account_kind"');
    expect(sql).toContain(
      'CONSTRAINT "idempotency_record_request_hash_check" CHECK',
    );
    expect(sql).toContain(
      'CONSTRAINT "ledger_transaction_destination_account_owner_fk" FOREIGN KEY ("user_id","destination_account_id")',
    );
    expect(sql).toContain(
      'CONSTRAINT "posting_transaction_owner_fk" FOREIGN KEY ("user_id","transaction_id")',
    );
    expect(sql).toContain(
      'CONSTRAINT "staged_transaction_import_batch_owner_fk" FOREIGN KEY ("user_id","import_batch_id")',
    );
    expect(sql).toContain("'crypto_wallet'");
    expect(sql).not.toContain("'debit_card'");
    expect(sql).toContain('"payee" text NOT NULL');
    expect(sql).toContain('"description" text');
    expect(sql).toContain("numeric(44, 18)");
    expect(sql).not.toMatch(/\bALTER TABLE\b[\s\S]*?\bADD COLUMN\b/i);
    expect(sql).not.toMatch(/^UPDATE\s/imu);
    expect(baselineSnapshot.prevId).toBe("00000000-0000-0000-0000-000000000000");
    expect(Object.keys(baselineSnapshot.tables)).toHaveLength(17);
    expect(
      baselineSnapshot.tables["public.idempotency_record"]?.columns.request_hash,
    ).toMatchObject({ notNull: true, type: "text" });
    expect(
      baselineSnapshot.tables["public.ledger_transaction"]?.indexes
        .transaction_external_id_idx,
    ).toBeDefined();
  });

  /**
   * Splits are added by giving the counter-account side more rows, never by
   * rewriting the rows already there. That is what makes upgrading a ledger
   * that has years of entries in it a schema change and not a data migration,
   * so it is asserted rather than described: every existing posting keeps a
   * null leg, every existing transaction keeps a zero leg count, and every
   * report reads the same numbers the moment the upgrade finishes.
   */
  it("adds split legs without touching a single existing row", async () => {
    const sql = await readFile(
      path.join(migrationDirectory, "0005_split_transaction_legs.sql"),
      "utf8",
    );

    expect(sql).toContain('CREATE TABLE "transaction_leg"');
    expect(sql).toContain('ALTER TABLE "posting" ADD COLUMN "leg_id" uuid;');
    expect(sql).toContain(
      'ALTER TABLE "ledger_transaction" ADD COLUMN "leg_count" smallint DEFAULT 0 NOT NULL;',
    );
    expect(sql).toContain(
      'ADD CONSTRAINT "posting_leg_owner_fk" FOREIGN KEY ("user_id","transaction_id","leg_id")',
    );

    // No backfill, no rewrite, nothing removed. A DROP or a DML statement here
    // would mean the upgrade changes what a ledger says about the past.
    for (const forbidden of [/\bDROP\b/i, /^\s*UPDATE\s/im, /^\s*DELETE\s/im, /^\s*INSERT\s/im]) {
      expect(sql, forbidden.source).not.toMatch(forbidden);
    }
    // A NOT NULL column with no default would rewrite the whole table.
    expect(sql).not.toMatch(/ADD COLUMN(?!.*DEFAULT).*NOT NULL/i);
  });

  /**
   * 0007 and 0008 add tables nothing else reads yet, which is exactly when a
   * migration slips through unasserted. Both are pure additions; neither may
   * grow a backfill later.
   */
  it("adds the shared rate limit and the setup token as pure additions", async () => {
    for (const name of ["0007_shared_rate_limit", "0008_owner_setup_token"]) {
      const sql = await readFile(
        path.join(migrationDirectory, `${name}.sql`),
        "utf8",
      );
      for (const forbidden of [
        /\bDROP\b/i,
        /^\s*UPDATE\s/im,
        /^\s*DELETE\s/im,
        /^\s*INSERT\s/im,
        /\bALTER COLUMN\b/i,
      ]) {
        expect(sql, `${name}: ${forbidden.source}`).not.toMatch(forbidden);
      }
    }

    const rateLimit = await readFile(
      path.join(migrationDirectory, "0007_shared_rate_limit.sql"),
      "utf8",
    );
    // The whole point of the table: one row per key across every replica, so
    // the counter is shared rather than per-process.
    expect(rateLimit).toContain('CREATE TABLE "auth_rate_limit"');
    expect(rateLimit).toContain(
      'CREATE UNIQUE INDEX "auth_rate_limit_key_unique" ON "auth_rate_limit" USING btree ("key")',
    );
    // Sweeping expired counters needs the timestamp indexed, or the sweep is a
    // full scan on the one table every request writes to.
    expect(rateLimit).toContain(
      'CREATE INDEX "auth_rate_limit_last_request_idx" ON "auth_rate_limit" USING btree ("last_request")',
    );

    const setupToken = await readFile(
      path.join(migrationDirectory, "0008_owner_setup_token.sql"),
      "utf8",
    );
    expect(setupToken).toContain('CREATE TABLE "auth_owner_setup_token"');
    expect(setupToken).toContain('"token" text NOT NULL');
  });

  /**
   * Reminders arrive as a new table plus one column on recurrences. The column
   * is the part that can go wrong: a NOT NULL added to a table with rows in it
   * needs a default, and every existing recurrence has to keep meaning "do not
   * email me" rather than suddenly opting in.
   */
  it("adds notifications without opting an existing recurrence in", async () => {
    const sql = await readFile(
      path.join(migrationDirectory, "0009_scheduled_notifications.sql"),
      "utf8",
    );

    expect(sql).toContain('CREATE TABLE "template_notification"');
    expect(sql).toContain(
      'ALTER TABLE "recurrence" ADD COLUMN "notify_on_create" boolean DEFAULT false NOT NULL;',
    );
    // A default of true would start emailing about every rule already in the
    // ledger the moment the upgrade finished.
    expect(sql).not.toMatch(/notify_on_create.*DEFAULT true/i);
    // At most one reminder per template, enforced by the database rather than
    // by the code that writes it.
    expect(sql).toContain(
      'CONSTRAINT "template_notification_template_id_unique" UNIQUE("template_id")',
    );
    // The scheduler's due query leads with the date, because it has to find
    // work across every ledger before it can know whose it is.
    expect(sql).toContain(
      'CREATE INDEX "template_notification_due_idx" ON "template_notification" USING btree ("next_notification_date","user_id","id")',
    );
    // A reminder goes when its template goes; an orphan would be a mail about
    // a template that no longer exists.
    expect(sql).toMatch(
      /template_notification_template_id_transaction_template_id_fk[\s\S]*?ON DELETE cascade/,
    );
    // The time of day is a wall clock, so it is checked as one.
    expect(sql).toContain(
      `CHECK ("template_notification"."notify_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')`,
    );

    for (const forbidden of [
      /\bDROP\b/i,
      /^\s*UPDATE\s/im,
      /^\s*DELETE\s/im,
      /^\s*INSERT\s/im,
    ]) {
      expect(sql, forbidden.source).not.toMatch(forbidden);
    }
    // Every added column carries a default, so no existing row is rewritten.
    expect(sql).not.toMatch(/ADD COLUMN(?!.*DEFAULT).*NOT NULL/i);
  });

  /**
   * The theme column, and the promise the upgrade notes make about it to
   * operators: that it is metadata-only, so no table is rewritten and nobody
   * waits. That holds only while the default is a constant and the column is
   * added rather than backfilled — a NOT NULL add with a constant default is
   * filled by PostgreSQL without touching a row, and an UPDATE afterwards would
   * quietly take that away on a large table.
   */
  it("adds the theme without rewriting a row", async () => {
    const sql = await readFile(
      path.join(migrationDirectory, "0011_user_theme.sql"),
      "utf8",
    );

    expect(sql).toMatch(
      /CREATE TYPE "public"\."user_theme" AS ENUM\('system', 'light', 'dark'\)/,
    );
    // `system` first is not cosmetic: it is the default, and it means "follow
    // the machine", which is the only honest thing to fill an existing row with.
    expect(sql).toMatch(
      /ADD COLUMN "theme" "user_theme" DEFAULT 'system' NOT NULL/,
    );
    // A constant default, so the add is metadata-only. A volatile one would
    // rewrite the table.
    expect(sql).not.toMatch(/DEFAULT\s+[a-z_]+\s*\(/i);
    for (const forbidden of [/^\s*UPDATE\s/im, /^\s*DELETE\s/im, /\bDROP\b/i]) {
      expect(sql, forbidden.source).not.toMatch(forbidden);
    }
  });

  /**
   * The one migration here that removes something. It drops four indexes whose
   * leading column is already the leading column of a unique constraint on the
   * same table, so nothing loses a plan. Dropping anything else — a column, a
   * constraint, a table — would be data or a rule going away.
   */
  it("drops only indexes another index already covers", async () => {
    const sql = await readFile(
      path.join(migrationDirectory, "0010_drop_covered_user_indexes.sql"),
      "utf8",
    );

    const dropped = [...sql.matchAll(/DROP INDEX IF EXISTS "([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(dropped).toEqual([
      "category_user_idx",
      "ledger_account_user_idx",
      "recurrence_user_idx",
      "transaction_template_user_idx",
    ]);
    // IF EXISTS, so a database restored from a dump that never had them still
    // runs the migration rather than stopping the upgrade.
    expect([...sql.matchAll(/DROP INDEX/g)]).toHaveLength(dropped.length);
    for (const forbidden of [
      /DROP\s+(TABLE|COLUMN|CONSTRAINT|TYPE|VIEW)/i,
      /^\s*UPDATE\s/im,
      /^\s*DELETE\s/im,
      /\bALTER COLUMN\b/i,
    ]) {
      expect(sql, forbidden.source).not.toMatch(forbidden);
    }
  });

  /**
   * The same promise for recurrences, and one more besides. Adding a value to
   * an existing enum is the only statement in either migration that touches a
   * type the running application already reads, and PostgreSQL will not let it
   * share a transaction with anything that then uses the new value. Nothing
   * here does, but nothing declared that either, so it is asserted.
   */
  it("adds recurrences without touching a single existing row", async () => {
    const sql = await readFile(
      path.join(migrationDirectory, "0006_recurring_transactions.sql"),
      "utf8",
    );

    expect(sql).toContain('CREATE TABLE "recurrence"');
    expect(sql).toContain(
      `ALTER TYPE "public"."actor_source" ADD VALUE 'schedule';`,
    );
    expect(sql).toContain(
      'ALTER TABLE "staged_transaction" ADD COLUMN "recurrence_id" uuid;',
    );
    expect(sql).toContain(
      'ALTER TABLE "staged_transaction" ADD COLUMN "occurrence_date" date;',
    );

    // The index that makes proposing an occurrence twice impossible. Partial on
    // recurrence_id and deliberately NOT qualified by status, so a row somebody
    // discarded still holds its place.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "staged_recurrence_occurrence_unique" ON "staged_transaction" USING btree ("user_id","recurrence_id","occurrence_date") WHERE "staged_transaction"."recurrence_id" is not null',
    );
    expect(sql).not.toMatch(
      /staged_recurrence_occurrence_unique[\s\S]*?WHERE[^;]*status/i,
    );

    for (const forbidden of [/\bDROP\b/i, /^\s*UPDATE\s/im, /^\s*DELETE\s/im, /^\s*INSERT\s/im]) {
      expect(sql, forbidden.source).not.toMatch(forbidden);
    }
    // Both new columns are nullable, so every staged row that already exists
    // keeps meaning what it meant.
    expect(sql).not.toMatch(/ADD COLUMN(?!.*DEFAULT).*NOT NULL/i);
    // The new enum value must not be used in the same migration that adds it.
    const afterEnum = sql.slice(sql.indexOf("ADD VALUE 'schedule'"));
    expect(afterEnum).not.toMatch(/'schedule'::/);
  });
});
