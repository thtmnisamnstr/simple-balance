-- When an OAuth client was first authorized, so the sweep of abandoned dynamic
-- registrations stops deleting clients somebody used.
--
-- `pruneAbandonedClients` deletes an anonymous client older than a day that
-- holds no consent and no token. Revoking an agent deletes exactly those rows,
-- so a client that was connected, used and then disconnected looked the same as
-- one nobody finished registering, and was deleted. ChatGPT registers a client
-- once per connection and reuses it, so its next sign-in failed with
-- `invalid_client`. The column is set the first time a consent is approved or a
-- token is issued and never cleared, and the sweep keeps every client it is set
-- on.
--
-- Nullable with no default, so the ADD COLUMN is metadata-only on any
-- PostgreSQL. The UPDATE is the backfill: every client holding a consent or a
-- token today has been authorized, at the earliest of their creation times. It
-- reads and writes only the three OAuth tables, which hold one row per client
-- and per grant rather than anybody's ledger, and on a Citus cluster all three
-- are reference tables (0023), where an UPDATE reading other reference tables
-- runs as it does on one node. A client revoked before this ran has no rows
-- left to say it was used; it stays eligible for the sweep, as it was.
ALTER TABLE "auth_oauth_application" ADD COLUMN "first_authorized_at" timestamp with time zone;--> statement-breakpoint
UPDATE "auth_oauth_application" AS client SET "first_authorized_at" = least(
  (select min(consent."created_at") from "auth_oauth_consent" AS consent where consent."client_id" = client."client_id"),
  (select min(token."created_at") from "auth_oauth_access_token" AS token where token."client_id" = client."client_id")
) WHERE exists (select 1 from "auth_oauth_consent" AS consent where consent."client_id" = client."client_id")
   OR exists (select 1 from "auth_oauth_access_token" AS token where token."client_id" = client."client_id");
