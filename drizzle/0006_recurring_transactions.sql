CREATE TYPE "public"."recurrence_frequency" AS ENUM('daily', 'weekly', 'monthly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."recurrence_month_policy" AS ENUM('last_day', 'skip');--> statement-breakpoint
CREATE TYPE "public"."recurrence_weekend_policy" AS ENUM('allow', 'skip', 'previous_business_day', 'next_business_day');--> statement-breakpoint
ALTER TYPE "public"."actor_source" ADD VALUE 'schedule';--> statement-breakpoint
CREATE TABLE "recurrence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"shape" jsonb NOT NULL,
	"frequency" "recurrence_frequency" NOT NULL,
	"interval" smallint DEFAULT 1 NOT NULL,
	"anchor_date" date NOT NULL,
	"month_policy" "recurrence_month_policy" DEFAULT 'last_day' NOT NULL,
	"weekend_policy" "recurrence_weekend_policy" DEFAULT 'allow' NOT NULL,
	"position_ordinal" smallint,
	"position_weekday" smallint,
	"proposes_from" date NOT NULL,
	"last_occurrence_date" date,
	"next_occurrence_date" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurrence_user_name_unique" UNIQUE("user_id","name"),
	CONSTRAINT "recurrence_name_check" CHECK (char_length(btrim("recurrence"."name")) between 1 and 120),
	CONSTRAINT "recurrence_interval_check" CHECK ("recurrence"."interval" between 1 and 366),
	CONSTRAINT "recurrence_version_check" CHECK ("recurrence"."version" >= 1),
	CONSTRAINT "recurrence_position_check" CHECK (("recurrence"."position_ordinal" is null) = ("recurrence"."position_weekday" is null)
          and ("recurrence"."position_ordinal" is null
               or ("recurrence"."position_ordinal" in (1, 2, 3, 4, -1)
                   and "recurrence"."position_weekday" between 0 and 6))),
	CONSTRAINT "recurrence_cursor_floor_check" CHECK ("recurrence"."next_occurrence_date" >= "recurrence"."proposes_from"),
	CONSTRAINT "recurrence_cursor_watermark_check" CHECK ("recurrence"."last_occurrence_date" is null
          or "recurrence"."next_occurrence_date" > "recurrence"."last_occurrence_date")
);
--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD COLUMN "recurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD COLUMN "occurrence_date" date;--> statement-breakpoint
ALTER TABLE "recurrence" ADD CONSTRAINT "recurrence_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurrence_user_idx" ON "recurrence" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recurrence_due_idx" ON "recurrence" USING btree ("next_occurrence_date","user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "staged_recurrence_occurrence_unique" ON "staged_transaction" USING btree ("user_id","recurrence_id","occurrence_date") WHERE "staged_transaction"."recurrence_id" is not null;--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD CONSTRAINT "staged_transaction_recurrence_check" CHECK (("staged_transaction"."recurrence_id" is null) = ("staged_transaction"."occurrence_date" is null));--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD CONSTRAINT "staged_transaction_recurrence_import_check" CHECK ("staged_transaction"."recurrence_id" is null or "staged_transaction"."import_batch_id" is null);