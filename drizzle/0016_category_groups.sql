CREATE TYPE "public"."budget_group_policy" AS ENUM('standalone', 'sum_of_children');--> statement-breakpoint
CREATE TABLE "category_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"policy" "budget_group_policy" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_group_user_normalized_unique" UNIQUE("user_id","normalized_name"),
	CONSTRAINT "category_group_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "category_group_version_check" CHECK ("category_group"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "budget_entry" DROP CONSTRAINT "budget_entry_period_unique";--> statement-breakpoint
ALTER TABLE "budget_plan" DROP CONSTRAINT "budget_plan_window_unique";--> statement-breakpoint
ALTER TABLE "budget_entry" ALTER COLUMN "category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_plan" ALTER COLUMN "category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_entry" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "category_group" ADD CONSTRAINT "category_group_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entry" ADD CONSTRAINT "budget_entry_group_fk" FOREIGN KEY ("user_id","group_id") REFERENCES "public"."category_group"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_group_fk" FOREIGN KEY ("user_id","group_id") REFERENCES "public"."category_group"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_group_id_category_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."category_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_entry_category_period_unique" ON "budget_entry" USING btree ("user_id","category_id","period_unit","period_start","currency") WHERE "budget_entry"."category_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_entry_group_period_unique" ON "budget_entry" USING btree ("user_id","group_id","period_unit","period_start","currency") WHERE "budget_entry"."group_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_plan_category_window_unique" ON "budget_plan" USING btree ("user_id","category_id","period_unit","currency","active_from") WHERE "budget_plan"."category_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_plan_group_window_unique" ON "budget_plan" USING btree ("user_id","group_id","period_unit","currency","active_from") WHERE "budget_plan"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "category_group_idx" ON "category" USING btree ("user_id","group_id");--> statement-breakpoint
ALTER TABLE "budget_entry" ADD CONSTRAINT "budget_entry_target_check" CHECK (("budget_entry"."category_id" is null) <> ("budget_entry"."group_id" is null));--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_target_check" CHECK (("budget_plan"."category_id" is null) <> ("budget_plan"."group_id" is null));