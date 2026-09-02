ALTER TABLE "budget_plan" DROP CONSTRAINT "budget_plan_percent_range_check";--> statement-breakpoint
ALTER TABLE "budget_plan" ADD CONSTRAINT "budget_plan_percent_range_check" CHECK ("budget_plan"."rule_percent" is null
        or ("budget_plan"."amount_rule"::text = 'incremental' and "budget_plan"."rule_percent" >= -100 and "budget_plan"."rule_percent" <= 1000)
        or ("budget_plan"."amount_rule"::text = 'percent_of_income' and "budget_plan"."rule_percent" >= 0 and "budget_plan"."rule_percent" <= 1000));