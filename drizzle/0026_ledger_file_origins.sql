-- Where an entry came from, so a Simple Balance file can be imported twice and
-- write it once.
--
-- `import_origin` is the id an entry was first written under in the ledger it
-- came from. An import skips an entry whose origin is already here — as an
-- entry, deleted ones included, or as a row still waiting in the queue — so
-- the transfer in two accounts' files lands once, and a ledger moved away and
-- back brings nothing twice. The staged column carries it until the row is
-- committed, and the commit copies it onto the entry. `import_batch.kind`
-- says whether a batch was a CSV or a Simple Balance file, because the
-- delimiter and the mapping beside it only mean something for a CSV.
--
-- The three columns are metadata-only on any PostgreSQL: the two origins are
-- nullable with no default, and the kind's default is a constant, which
-- PostgreSQL 11 and later record once rather than writing into every row.
--
-- Metadata-only is not lock-free. Each ADD COLUMN takes ACCESS EXCLUSIVE, and
-- the migrator runs every pending file in one transaction, so all three
-- tables refuse reads as well as writes until it commits; and on a rolling
-- update the first ALTER on each table waits for every transaction already
-- open on it, with every later request queued behind the ALTER. The two
-- indexes are what makes the transaction last. `CREATE INDEX` scans its table,
-- and it cannot be `CONCURRENTLY` inside that one transaction. Both are
-- partial on the origin being set, so every row that exists when this runs is
-- read and none is indexed: one sequential scan and nothing to sort. Measured
-- on 2026-10-25 against the capacity seed at a thirtieth — 978,000 entries in
-- a 153 MB table, and 99,900 staged rows — on PostgreSQL 18.6: 44 ms warm and
-- 117 ms cold for the entries, under 20 ms for the queue, no table rewritten.
-- Linear in the table, that is one and a half to three and a half seconds on
-- the thirty-million-entry population `docs/capacity.md` measures, during
-- which the books can be neither read nor written.
--
-- Unique, because the skip is a read and a read can race; partial, so the
-- entries typed by hand cost nothing; led by `user_id`, so Citus can enforce
-- them, since a unique index there must hold the distribution column. Citus
-- propagates the type, the columns and the indexes to every shard, so this
-- needs no gate the way 0023 does: it was run on a single-node Citus 14.2 both
-- in the same transaction as 0023 on a new cluster and on its own over a
-- ledger 0023 had already distributed.
CREATE TYPE "public"."import_batch_kind" AS ENUM('csv', 'ledger_file');--> statement-breakpoint
ALTER TABLE "import_batch" ADD COLUMN "kind" "import_batch_kind" DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD COLUMN "import_origin" uuid;--> statement-breakpoint
ALTER TABLE "ledger_transaction" ADD COLUMN "import_origin" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "staged_user_import_origin_unique" ON "staged_transaction" USING btree ("user_id","import_origin") WHERE "staged_transaction"."import_origin" is not null and "staged_transaction"."status" = 'staged';--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_user_import_origin_unique" ON "ledger_transaction" USING btree ("user_id","import_origin") WHERE "ledger_transaction"."import_origin" is not null;