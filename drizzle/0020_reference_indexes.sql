CREATE INDEX "category_group_reference_idx" ON "category" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "staged_duplicate_of_reference_idx" ON "staged_transaction" USING btree ("user_id","duplicate_of_id");--> statement-breakpoint
CREATE INDEX "staged_committed_reference_idx" ON "staged_transaction" USING btree ("user_id","committed_transaction_id");