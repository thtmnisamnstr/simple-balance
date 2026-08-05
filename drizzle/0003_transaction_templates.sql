CREATE TABLE "transaction_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"draft" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_template_user_name_unique" UNIQUE("user_id","name"),
	CONSTRAINT "transaction_template_name_check" CHECK (char_length(btrim("transaction_template"."name")) between 1 and 120),
	CONSTRAINT "transaction_template_version_check" CHECK ("transaction_template"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "transaction_template" ADD CONSTRAINT "transaction_template_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_template_user_idx" ON "transaction_template" USING btree ("user_id");