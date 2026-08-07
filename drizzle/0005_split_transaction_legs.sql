CREATE TABLE "transaction_leg" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"category_id" uuid,
	"ordinal" smallint DEFAULT 0 NOT NULL,
	"amount" numeric(44, 18) NOT NULL,
	"currency" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_leg_posting_target_unique" UNIQUE("user_id","transaction_id","id","currency"),
	CONSTRAINT "transaction_leg_ordinal_check" CHECK ("transaction_leg"."ordinal" >= 0),
	CONSTRAINT "transaction_leg_amount_check" CHECK ("transaction_leg"."amount" >= 0),
	CONSTRAINT "transaction_leg_currency_check" CHECK ("transaction_leg"."currency" ~ '^[A-Z]{2,12}$'),
	CONSTRAINT "transaction_leg_note_check" CHECK ("transaction_leg"."note" is null or char_length("transaction_leg"."note") <= 240)
);
--> statement-breakpoint
ALTER TABLE "posting" ADD COLUMN "leg_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_transaction" ADD COLUMN "leg_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_leg" ADD CONSTRAINT "transaction_leg_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_leg" ADD CONSTRAINT "transaction_leg_transaction_owner_fk" FOREIGN KEY ("user_id","transaction_id") REFERENCES "public"."ledger_transaction"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_leg" ADD CONSTRAINT "transaction_leg_category_owner_fk" FOREIGN KEY ("user_id","category_id") REFERENCES "public"."category"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_leg_transaction_idx" ON "transaction_leg" USING btree ("user_id","transaction_id","ordinal");--> statement-breakpoint
CREATE INDEX "transaction_leg_user_category_idx" ON "transaction_leg" USING btree ("user_id","category_id","transaction_id");--> statement-breakpoint
ALTER TABLE "posting" ADD CONSTRAINT "posting_leg_owner_fk" FOREIGN KEY ("user_id","transaction_id","leg_id","currency") REFERENCES "public"."transaction_leg"("user_id","transaction_id","id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posting_user_leg_idx" ON "posting" USING btree ("user_id","leg_id");--> statement-breakpoint
ALTER TABLE "posting" ADD CONSTRAINT "posting_leg_origin_check" CHECK ("posting"."leg_id" is null or "posting"."transaction_id" is not null);--> statement-breakpoint
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_split_check" CHECK (
        "ledger_transaction"."leg_count" = 0
        or (
          "ledger_transaction"."leg_count" between 2 and 50
          and "ledger_transaction"."category_id" is null
          and "ledger_transaction"."type" <> 'transfer'
        )
      );