CREATE TYPE "public"."budget_amount_rule" AS ENUM('fixed', 'sinking_fund');--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "rollover" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "rollover_cap" numeric(44, 18);--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "target_amount" numeric(44, 18);--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "target_date" date;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "amount_rule" "budget_amount_rule" DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_rollover_cap_check" CHECK ("budget_plan"."rollover_cap" is null or "budget_plan"."rollover_cap" >= 0);--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_target_amount_check" CHECK ("budget_plan"."target_amount" is null or "budget_plan"."target_amount" > 0);--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_rule_check" CHECK (("budget_plan"."amount_rule" = 'sinking_fund') = ("budget_plan"."target_amount" is not null and "budget_plan"."target_date" is not null));--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_sinking_rollover_check" CHECK ("budget_plan"."amount_rule" <> 'sinking_fund' or "budget_plan"."rollover");