ALTER TYPE "public"."budget_amount_rule" ADD VALUE 'trailing_average';--> statement-breakpoint
ALTER TYPE "public"."budget_amount_rule" ADD VALUE 'incremental';--> statement-breakpoint
ALTER TYPE "public"."budget_amount_rule" ADD VALUE 'percent_of_income';--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "rule_lookback" integer;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "rule_percent" numeric(9, 4);--> statement-breakpoint
ALTER TABLE "budget_plan" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_lookback_check" CHECK (("budget_plan"."amount_rule"::text = 'trailing_average') = ("budget_plan"."rule_lookback" is not null));--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_percent_check" CHECK (("budget_plan"."amount_rule"::text in ('incremental', 'percent_of_income')) = ("budget_plan"."rule_percent" is not null));--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_lookback_range_check" CHECK ("budget_plan"."rule_lookback" is null or ("budget_plan"."rule_lookback" >= 1 and "budget_plan"."rule_lookback" <= 24));--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_percent_range_check" CHECK ("budget_plan"."rule_percent" is null or ("budget_plan"."rule_percent" >= 0 and "budget_plan"."rule_percent" <= 1000));