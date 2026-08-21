CREATE TABLE "template_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"template_id" uuid NOT NULL,
	"frequency" "recurrence_frequency",
	"interval" smallint DEFAULT 1 NOT NULL,
	"anchor_date" date NOT NULL,
	"month_policy" "recurrence_month_policy" DEFAULT 'last_day' NOT NULL,
	"weekend_policy" "recurrence_weekend_policy" DEFAULT 'allow' NOT NULL,
	"position_ordinal" smallint,
	"position_weekday" smallint,
	"notify_at" text NOT NULL,
	"last_notified_date" date,
	"next_notification_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_notification_template_id_unique" UNIQUE("template_id"),
	CONSTRAINT "template_notification_interval_check" CHECK ("template_notification"."interval" between 1 and 366),
	CONSTRAINT "template_notification_notify_at_check" CHECK ("template_notification"."notify_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "template_notification_position_check" CHECK (("template_notification"."position_ordinal" is null) = ("template_notification"."position_weekday" is null)),
	CONSTRAINT "template_notification_position_frequency_check" CHECK ("template_notification"."position_ordinal" is null or "template_notification"."frequency" in ('monthly', 'yearly')),
	CONSTRAINT "template_notification_once_check" CHECK ("template_notification"."frequency" is not null or ("template_notification"."interval" = 1 and "template_notification"."position_ordinal" is null))
);
--> statement-breakpoint
ALTER TABLE "recurrence" ADD COLUMN "notify_on_create" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "template_notification" ADD CONSTRAINT "template_notification_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_notification" ADD CONSTRAINT "template_notification_template_id_transaction_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."transaction_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_notification_user_idx" ON "template_notification" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "template_notification_due_idx" ON "template_notification" USING btree ("next_notification_date","user_id","id");