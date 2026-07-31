import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationDirectory = path.resolve(import.meta.dirname, "../drizzle");
const metadataDirectory = path.join(migrationDirectory, "meta");

describe("v0.1.0 migration baseline", () => {
  it("has one intentionally named initial migration and one matching snapshot", async () => {
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

    expect(migrationFiles).toEqual(["0000_v0_1_0_initial.sql"]);
    expect(snapshotFiles).toEqual(["0000_snapshot.json"]);
    expect(journal).toMatchObject({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          tag: "0000_v0_1_0_initial",
          breakpoints: true,
        },
      ],
    });
  });

  it("models the current schema directly without compatibility backfills", async () => {
    const sql = await readFile(
      path.join(migrationDirectory, "0000_v0_1_0_initial.sql"),
      "utf8",
    );
    const snapshot = JSON.parse(
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
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "posting_transaction_account_unique"',
    );
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
    expect(sql).not.toMatch(/\bALTER TABLE\b[\s\S]*?\bADD COLUMN\b/i);
    expect(sql).not.toMatch(/^UPDATE\s/imu);
    expect(sql).not.toMatch(/\blegacy\b|\bbackfill\b/i);

    expect(snapshot.prevId).toBe("00000000-0000-0000-0000-000000000000");
    expect(Object.keys(snapshot.tables)).toHaveLength(17);
    expect(
      snapshot.tables["public.idempotency_record"]?.columns.request_hash,
    ).toMatchObject({ notNull: true, type: "text" });
    expect(
      snapshot.tables["public.ledger_transaction"]?.indexes
        .transaction_external_id_idx,
    ).toBeDefined();
  });
});
