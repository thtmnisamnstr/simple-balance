CREATE TYPE "public"."ledger_account_type" AS ENUM('checking', 'savings', 'credit_card', 'cash', 'crypto_wallet', 'loan', 'investment', 'other_asset', 'other_liability', 'system');--> statement-breakpoint
CREATE TYPE "public"."actor_source" AS ENUM('web', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."category_kind" AS ENUM('income', 'expense', 'both');--> statement-breakpoint
CREATE TYPE "public"."staged_status" AS ENUM('staged', 'committed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."system_account_kind" AS ENUM('income', 'expense', 'exchange');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('deposit', 'withdrawal', 'transfer');--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_account_provider_account_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"actor_source" "actor_source" NOT NULL,
	"client_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"operation" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "category_kind" NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_user_name_unique" UNIQUE("user_id","name"),
	CONSTRAINT "category_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "category_version_check" CHECK ("category"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "idempotency_record" (
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_record_user_id_operation_key_pk" PRIMARY KEY("user_id","operation","key"),
	CONSTRAINT "idempotency_record_request_hash_check" CHECK ("idempotency_record"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"delimiter" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batch_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "import_batch_row_count_check" CHECK ("import_batch"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "ledger_account_type" NOT NULL,
	"system_kind" "system_account_kind",
	"currency" text NOT NULL,
	"institution" text,
	"notes" text,
	"opening_date" date NOT NULL,
	"opening_balance" numeric(44, 18) DEFAULT '0' NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_account_user_name_unique" UNIQUE("user_id","name"),
	CONSTRAINT "ledger_account_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "ledger_account_currency_check" CHECK ("ledger_account"."currency" ~ '^[A-Z]{2,12}$'),
	CONSTRAINT "ledger_account_version_check" CHECK ("ledger_account"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "auth_mcp_signing_key" (
	"id" text PRIMARY KEY NOT NULL,
	"algorithm" text DEFAULT 'RS256' NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_oauth_access_token_access_token_unique" UNIQUE("access_token"),
	CONSTRAINT "auth_oauth_access_token_refresh_token_unique" UNIQUE("refresh_token")
);
--> statement-breakpoint
CREATE TABLE "auth_oauth_application" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"metadata" text,
	"client_id" text NOT NULL,
	"client_secret" text,
	"redirect_urls" text NOT NULL,
	"type" text NOT NULL,
	"disabled" boolean DEFAULT false,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_oauth_application_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "auth_oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scopes" text NOT NULL,
	"consent_given" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(44, 18) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_amount_check" CHECK ("posting"."amount" <> 0),
	CONSTRAINT "posting_currency_check" CHECK ("posting"."currency" ~ '^[A-Z]{2,12}$')
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "staged_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"status" "staged_status" DEFAULT 'staged' NOT NULL,
	"draft" jsonb NOT NULL,
	"raw_data" jsonb,
	"validation_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duplicate_of_id" uuid,
	"import_batch_id" uuid,
	"committed_transaction_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staged_transaction_version_check" CHECK ("staged_transaction"."version" >= 1),
	CONSTRAINT "staged_transaction_status_check" CHECK (
        (
          "staged_transaction"."status" = 'staged'
          and "staged_transaction"."deleted_at" is null
          and "staged_transaction"."committed_transaction_id" is null
        )
        or
        (
          "staged_transaction"."status" = 'deleted'
          and "staged_transaction"."deleted_at" is not null
          and "staged_transaction"."committed_transaction_id" is null
        )
        or
        (
          "staged_transaction"."status" = 'committed'
          and "staged_transaction"."deleted_at" is null
          and "staged_transaction"."committed_transaction_id" is not null
        )
      )
);
--> statement-breakpoint
CREATE TABLE "ledger_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" "transaction_type" NOT NULL,
	"date" date NOT NULL,
	"description" text,
	"payee" text NOT NULL,
	"category_id" uuid,
	"notes" text,
	"external_id" text,
	"source_account_id" uuid,
	"destination_account_id" uuid,
	"source_amount" numeric(44, 18),
	"destination_amount" numeric(44, 18),
	"source_currency" text,
	"destination_currency" text,
	"effective_rate" numeric(44, 18),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transaction_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "ledger_transaction_version_check" CHECK ("ledger_transaction"."version" >= 1),
	CONSTRAINT "ledger_transaction_payee_check" CHECK (char_length(trim("ledger_transaction"."payee")) between 1 and 160),
	CONSTRAINT "ledger_transaction_description_check" CHECK ("ledger_transaction"."description" is null or char_length("ledger_transaction"."description") <= 240),
	CONSTRAINT "ledger_transaction_shape_check" CHECK (
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
      )
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_default_currency_check" CHECK ("user_preferences"."default_currency" ~ '^[A-Z]{2,12}$')
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_account" ADD CONSTRAINT "ledger_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_client_id_auth_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."auth_oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_application" ADD CONSTRAINT "auth_oauth_application_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_consent" ADD CONSTRAINT "auth_oauth_consent_client_id_auth_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."auth_oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_consent" ADD CONSTRAINT "auth_oauth_consent_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting" ADD CONSTRAINT "posting_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting" ADD CONSTRAINT "posting_transaction_owner_fk" FOREIGN KEY ("user_id","transaction_id") REFERENCES "public"."ledger_transaction"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting" ADD CONSTRAINT "posting_account_owner_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."ledger_account"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD CONSTRAINT "staged_transaction_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD CONSTRAINT "staged_transaction_duplicate_owner_fk" FOREIGN KEY ("user_id","duplicate_of_id") REFERENCES "public"."ledger_transaction"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD CONSTRAINT "staged_transaction_import_batch_owner_fk" FOREIGN KEY ("user_id","import_batch_id") REFERENCES "public"."import_batch"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_transaction" ADD CONSTRAINT "staged_transaction_committed_owner_fk" FOREIGN KEY ("user_id","committed_transaction_id") REFERENCES "public"."ledger_transaction"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_category_owner_fk" FOREIGN KEY ("user_id","category_id") REFERENCES "public"."category"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_source_account_owner_fk" FOREIGN KEY ("user_id","source_account_id") REFERENCES "public"."ledger_account"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_destination_account_owner_fk" FOREIGN KEY ("user_id","destination_account_id") REFERENCES "public"."ledger_account"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_user_created_idx" ON "audit_event" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_user_entity_idx" ON "audit_event" USING btree ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "category_user_idx" ON "category" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "import_batch_user_created_idx" ON "import_batch" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ledger_account_user_idx" ON "ledger_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_account_system_kind_unique" ON "ledger_account" USING btree ("user_id","system_kind","currency") WHERE "ledger_account"."system_kind" is not null;--> statement-breakpoint
CREATE INDEX "oauth_access_token_client_idx" ON "auth_oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_idx" ON "auth_oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_application_user_idx" ON "auth_oauth_application" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_client_idx" ON "auth_oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_idx" ON "auth_oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "posting_user_account_idx" ON "posting" USING btree ("user_id","account_id");--> statement-breakpoint
CREATE INDEX "posting_transaction_idx" ON "posting" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staged_user_status_created_idx" ON "staged_transaction" USING btree ("user_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "staged_user_import_batch_idx" ON "staged_transaction" USING btree ("user_id","import_batch_id");--> statement-breakpoint
CREATE INDEX "transaction_user_date_idx" ON "ledger_transaction" USING btree ("user_id","date","id");--> statement-breakpoint
CREATE INDEX "transaction_user_source_account_idx" ON "ledger_transaction" USING btree ("user_id","source_account_id");--> statement-breakpoint
CREATE INDEX "transaction_user_destination_account_idx" ON "ledger_transaction" USING btree ("user_id","destination_account_id");--> statement-breakpoint
CREATE INDEX "transaction_user_category_idx" ON "ledger_transaction" USING btree ("user_id","category_id");--> statement-breakpoint
CREATE INDEX "transaction_external_id_idx" ON "ledger_transaction" USING btree ("user_id","external_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");