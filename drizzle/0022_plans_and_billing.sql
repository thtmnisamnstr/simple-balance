CREATE TYPE "public"."billing_operation_state" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."billing_plan" AS ENUM('free', 'plus');--> statement-breakpoint
CREATE TABLE "billing_customer" (
	"user_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customer_stripe_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "billing_operation" (
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"stripe_idempotency_key" text NOT NULL,
	"state" "billing_operation_state" NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_operation_user_id_operation_key_pk" PRIMARY KEY("user_id","operation","key"),
	CONSTRAINT "billing_operation_stripe_key_unique" UNIQUE("stripe_idempotency_key"),
	CONSTRAINT "billing_operation_request_hash_check" CHECK ("billing_operation"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "billing_override" (
	"user_id" text PRIMARY KEY NOT NULL,
	"plan" "billing_plan" NOT NULL,
	"expires_at" timestamp with time zone,
	"reason" text NOT NULL,
	"operator" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_subscription" (
	"user_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"price_id" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"past_due_since" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"scheduled_price_id" text,
	"scheduled_at" timestamp with time zone,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscription_user_id_stripe_subscription_id_pk" PRIMARY KEY("user_id","stripe_subscription_id"),
	CONSTRAINT "billing_subscription_stripe_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_customer" ADD CONSTRAINT "billing_customer_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operation" ADD CONSTRAINT "billing_operation_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_override" ADD CONSTRAINT "billing_override_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscription" ADD CONSTRAINT "billing_subscription_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_subscription_synced_at_idx" ON "billing_subscription" USING btree ("synced_at");