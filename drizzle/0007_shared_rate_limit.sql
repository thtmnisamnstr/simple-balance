CREATE TABLE "auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_rate_limit_key_unique" ON "auth_rate_limit" USING btree ("key");--> statement-breakpoint
CREATE INDEX "auth_rate_limit_last_request_idx" ON "auth_rate_limit" USING btree ("last_request");