CREATE TYPE "public"."budget_period_unit" AS ENUM('week', 'month', 'quarter', 'year');--> statement-breakpoint
CREATE TABLE "budget_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"category_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"period_unit" "budget_period_unit" NOT NULL,
	"period_start" date NOT NULL,
	"amount" numeric(44, 18) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_entry_period_unique" UNIQUE("user_id","category_id","period_unit","period_start","currency"),
	CONSTRAINT "budget_entry_amount_check" CHECK ("budget_entry"."amount" >= 0),
	CONSTRAINT "budget_entry_currency_check" CHECK ("budget_entry"."currency" ~ '^[A-Z]{2,12}$'),
	CONSTRAINT "budget_entry_version_check" CHECK ("budget_entry"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "budget_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"category_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"period_unit" "budget_period_unit" NOT NULL,
	"amount" numeric(44, 18) NOT NULL,
	"active_from" date NOT NULL,
	"active_to" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_plan_window_unique" UNIQUE("user_id","category_id","period_unit","currency","active_from"),
	CONSTRAINT "budget_plan_amount_check" CHECK ("budget_plan"."amount" >= 0),
	CONSTRAINT "budget_plan_currency_check" CHECK ("budget_plan"."currency" ~ '^[A-Z]{2,12}$'),
	CONSTRAINT "budget_plan_version_check" CHECK ("budget_plan"."version" >= 1),
	CONSTRAINT "budget_plan_window_check" CHECK ("budget_plan"."active_to" is null or "budget_plan"."active_to" >= "budget_plan"."active_from")
);
--> statement-breakpoint
ALTER TABLE "budget_entry" ADD CONSTRAINT "budget_entry_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entry" ADD CONSTRAINT "budget_entry_category_fk" FOREIGN KEY ("user_id","category_id") REFERENCES "public"."category"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_category_fk" FOREIGN KEY ("user_id","category_id") REFERENCES "public"."category"("user_id","id") ON DELETE cascade ON UPDATE no action;