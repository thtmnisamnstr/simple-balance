ALTER TYPE "public"."ledger_account_type" ADD VALUE 'crypto_wallet' BEFORE 'loan';--> statement-breakpoint
ALTER TABLE "ledger_account" DROP CONSTRAINT "ledger_account_currency_check";--> statement-breakpoint
ALTER TABLE "posting" DROP CONSTRAINT "posting_currency_check";--> statement-breakpoint
ALTER TABLE "ledger_transaction" DROP CONSTRAINT "ledger_transaction_shape_check";--> statement-breakpoint
ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_default_currency_check";--> statement-breakpoint
ALTER TABLE "ledger_account" ALTER COLUMN "opening_balance" SET DATA TYPE numeric(44, 18);--> statement-breakpoint
ALTER TABLE "ledger_account" ALTER COLUMN "opening_balance" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "posting" ALTER COLUMN "amount" SET DATA TYPE numeric(44, 18);--> statement-breakpoint
ALTER TABLE "ledger_transaction" ALTER COLUMN "source_amount" SET DATA TYPE numeric(44, 18);--> statement-breakpoint
ALTER TABLE "ledger_transaction" ALTER COLUMN "destination_amount" SET DATA TYPE numeric(44, 18);--> statement-breakpoint
ALTER TABLE "ledger_transaction" ALTER COLUMN "effective_rate" SET DATA TYPE numeric(44, 18);--> statement-breakpoint
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_currency_check" CHECK ("ledger_account"."currency" ~ '^[A-Z]{2,12}$');--> statement-breakpoint
ALTER TABLE "posting" ADD CONSTRAINT "posting_currency_check" CHECK ("posting"."currency" ~ '^[A-Z]{2,12}$');--> statement-breakpoint
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_shape_check" CHECK (
        (
          "ledger_transaction"."type" = 'deposit'
          and "ledger_transaction"."source_account_id" is null
          and "ledger_transaction"."source_amount" is null
          and "ledger_transaction"."source_currency" is null
          and "ledger_transaction"."destination_account_id" is not null
          and "ledger_transaction"."destination_amount" is not null
          and "ledger_transaction"."destination_amount" > 0
          and "ledger_transaction"."destination_currency" is not null
          and "ledger_transaction"."destination_currency" ~ '^[A-Z]{2,12}$'
          and "ledger_transaction"."effective_rate" is null
        )
        or
        (
          "ledger_transaction"."type" = 'withdrawal'
          and "ledger_transaction"."source_account_id" is not null
          and "ledger_transaction"."source_amount" is not null
          and "ledger_transaction"."source_amount" > 0
          and "ledger_transaction"."source_currency" is not null
          and "ledger_transaction"."source_currency" ~ '^[A-Z]{2,12}$'
          and "ledger_transaction"."destination_account_id" is null
          and "ledger_transaction"."destination_amount" is null
          and "ledger_transaction"."destination_currency" is null
          and "ledger_transaction"."effective_rate" is null
        )
        or
        (
          "ledger_transaction"."type" = 'transfer'
          and "ledger_transaction"."source_account_id" is not null
          and "ledger_transaction"."destination_account_id" is not null
          and "ledger_transaction"."source_account_id" <> "ledger_transaction"."destination_account_id"
          and "ledger_transaction"."source_amount" is not null
          and "ledger_transaction"."source_amount" > 0
          and "ledger_transaction"."destination_amount" is not null
          and "ledger_transaction"."destination_amount" > 0
          and "ledger_transaction"."source_currency" is not null
          and "ledger_transaction"."source_currency" ~ '^[A-Z]{2,12}$'
          and "ledger_transaction"."destination_currency" is not null
          and "ledger_transaction"."destination_currency" ~ '^[A-Z]{2,12}$'
          and "ledger_transaction"."effective_rate" is not null
          and "ledger_transaction"."effective_rate" > 0
          and (
            (
              "ledger_transaction"."source_currency" = "ledger_transaction"."destination_currency"
              and "ledger_transaction"."source_amount" = "ledger_transaction"."destination_amount"
              and "ledger_transaction"."effective_rate" = 1
            )
            or "ledger_transaction"."source_currency" <> "ledger_transaction"."destination_currency"
          )
        )
      );--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_default_currency_check" CHECK ("user_preferences"."default_currency" ~ '^[A-Z]{2,12}$');