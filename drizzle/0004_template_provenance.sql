ALTER TABLE "ledger_transaction" ADD COLUMN "template_id" uuid;--> statement-breakpoint
CREATE INDEX "transaction_user_template_idx" ON "ledger_transaction" USING btree ("user_id","template_id");