ALTER TABLE "posting" DROP CONSTRAINT "posting_origin_check";--> statement-breakpoint
ALTER TABLE "posting" ADD COLUMN "closing_account_id" uuid;--> statement-breakpoint
ALTER TABLE "posting" ADD CONSTRAINT "posting_closing_account_owner_fk" FOREIGN KEY ("user_id","closing_account_id") REFERENCES "public"."ledger_account"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posting_closing_account_idx" ON "posting" USING btree ("user_id","closing_account_id");--> statement-breakpoint
ALTER TABLE "posting" ADD CONSTRAINT "posting_origin_check" CHECK ((case when "posting"."transaction_id" is null then 0 else 1 end)
        + (case when "posting"."opening_account_id" is null then 0 else 1 end)
        + (case when "posting"."closing_account_id" is null then 0 else 1 end) = 1);