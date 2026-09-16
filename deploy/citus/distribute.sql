-- Distributing Simple Balance across a Citus cluster.
--
-- NOT a migration yet, and the distinction matters: every file in `drizzle/`
-- runs on every deployment at startup, and nothing here should ever run on the
-- `single` profile or on a plain PostgreSQL. This is the procedure, proven
-- against Citus 14.2 on PostgreSQL 16, that migration 0023 will carry once it
-- is gated on the extension being present. `docs/citus.md` is the reasoning.
--
-- Order is forced and each step says why. Run it after the application's own
-- migrations, on a database where `create extension citus` has already run.

begin;

-- One connection per node, for the whole transaction.
--
-- Citus parallelises a multi-shard change across several connections per node
-- by default, and that is incompatible with holding a foreign key into a
-- reference table: the second statement in this transaction fails with
-- `cannot modify table ... because there was a parallel operation on a
-- distributed table in the transaction`. Sequential is slower and is the only
-- mode in which this whole procedure is one atomic step, which is what a
-- migration has to be.
set local citus.multi_shard_modify_mode to 'sequential';

-- 1. Every foreign key comes off first.
--
-- Not tidiness: Citus supports a foreign key between two distributed tables
-- and between a distributed table and a reference table, and refuses one
-- where either side is still a plain local table. Converting thirty-one
-- tables one at a time therefore passes through a state that is illegal for
-- whichever key spans the boundary, and there is no ordering that avoids it.
-- So they all come off and all go back.
alter table audit_event drop constraint "audit_event_user_id_auth_user_id_fk";
alter table auth_account drop constraint "auth_account_user_id_auth_user_id_fk";
alter table auth_oauth_access_token drop constraint "auth_oauth_access_token_client_id_auth_oauth_application_client";
alter table auth_oauth_access_token drop constraint "auth_oauth_access_token_user_id_auth_user_id_fk";
alter table auth_oauth_application drop constraint "auth_oauth_application_user_id_auth_user_id_fk";
alter table auth_oauth_consent drop constraint "auth_oauth_consent_client_id_auth_oauth_application_client_id_f";
alter table auth_oauth_consent drop constraint "auth_oauth_consent_user_id_auth_user_id_fk";
alter table auth_session drop constraint "auth_session_user_id_auth_user_id_fk";
alter table billing_customer drop constraint "billing_customer_user_id_auth_user_id_fk";
alter table billing_operation drop constraint "billing_operation_user_id_auth_user_id_fk";
alter table billing_override drop constraint "billing_override_user_id_auth_user_id_fk";
alter table billing_subscription drop constraint "billing_subscription_user_id_auth_user_id_fk";
alter table budget_entry drop constraint "budget_entry_category_fk";
alter table budget_entry drop constraint "budget_entry_group_fk";
alter table budget_entry drop constraint "budget_entry_user_id_auth_user_id_fk";
alter table budget_plan drop constraint "budget_plan_category_fk";
alter table budget_plan drop constraint "budget_plan_group_fk";
alter table budget_plan drop constraint "budget_plan_user_id_auth_user_id_fk";
alter table category drop constraint "category_group_id_category_group_id_fk";
alter table category drop constraint "category_user_id_auth_user_id_fk";
alter table category_group drop constraint "category_group_user_id_auth_user_id_fk";
alter table idempotency_record drop constraint "idempotency_record_user_id_auth_user_id_fk";
alter table import_batch drop constraint "import_batch_user_id_auth_user_id_fk";
alter table ledger_account drop constraint "ledger_account_user_id_auth_user_id_fk";
alter table ledger_transaction drop constraint "ledger_transaction_category_owner_fk";
alter table ledger_transaction drop constraint "ledger_transaction_destination_account_owner_fk";
alter table ledger_transaction drop constraint "ledger_transaction_source_account_owner_fk";
alter table ledger_transaction drop constraint "ledger_transaction_user_id_auth_user_id_fk";
alter table posting drop constraint "posting_account_currency_fk";
alter table posting drop constraint "posting_closing_account_owner_fk";
alter table posting drop constraint "posting_leg_owner_fk";
alter table posting drop constraint "posting_opening_account_owner_fk";
alter table posting drop constraint "posting_transaction_owner_fk";
alter table posting drop constraint "posting_user_id_auth_user_id_fk";
alter table recurrence drop constraint "recurrence_user_id_auth_user_id_fk";
alter table staged_transaction drop constraint "staged_transaction_committed_owner_fk";
alter table staged_transaction drop constraint "staged_transaction_duplicate_owner_fk";
alter table staged_transaction drop constraint "staged_transaction_import_batch_owner_fk";
alter table staged_transaction drop constraint "staged_transaction_user_id_auth_user_id_fk";
alter table template_notification drop constraint "template_notification_template_id_transaction_template_id_fk";
alter table template_notification drop constraint "template_notification_user_id_auth_user_id_fk";
alter table transaction_leg drop constraint "transaction_leg_category_owner_fk";
alter table transaction_leg drop constraint "transaction_leg_transaction_owner_fk";
alter table transaction_leg drop constraint "transaction_leg_user_id_auth_user_id_fk";
alter table transaction_template drop constraint "transaction_template_user_id_auth_user_id_fk";
alter table user_preferences drop constraint "user_preferences_user_id_auth_user_id_fk";

-- 2. The primary key has to contain the distribution column.
--
-- Citus refuses a primary key or unique constraint that does not include the
-- partition column, because it cannot enforce uniqueness across shards it
-- would have to search. `(user_id, id)` rather than `(id, user_id)`: the
-- tenant leads, so the index that backs it also serves every query that
-- filters by owner, which is all of them.
--
-- Each is two statements. Citus refuses `DROP CONSTRAINT` and `ADD CONSTRAINT`
-- in one `ALTER TABLE` with `cannot execute ADD CONSTRAINT command with other
-- subcommands`.
alter table audit_event drop constraint audit_event_pkey;
alter table audit_event add primary key (user_id, id);
alter table category_group drop constraint category_group_pkey;
alter table category_group add primary key (user_id, id);
alter table category drop constraint category_pkey;
alter table category add primary key (user_id, id);
alter table ledger_account drop constraint ledger_account_pkey;
alter table ledger_account add primary key (user_id, id);
alter table ledger_transaction drop constraint ledger_transaction_pkey;
alter table ledger_transaction add primary key (user_id, id);
alter table transaction_leg drop constraint transaction_leg_pkey;
alter table transaction_leg add primary key (user_id, id);
alter table posting drop constraint posting_pkey;
alter table posting add primary key (user_id, id);
alter table import_batch drop constraint import_batch_pkey;
alter table import_batch add primary key (user_id, id);
alter table staged_transaction drop constraint staged_transaction_pkey;
alter table staged_transaction add primary key (user_id, id);
alter table budget_plan drop constraint budget_plan_pkey;
alter table budget_plan add primary key (user_id, id);
alter table budget_entry drop constraint budget_entry_pkey;
alter table budget_entry add primary key (user_id, id);
alter table recurrence drop constraint recurrence_pkey;
alter table recurrence add primary key (user_id, id);
alter table transaction_template drop constraint transaction_template_pkey;
alter table transaction_template add primary key (user_id, id);
alter table template_notification drop constraint template_notification_pkey;
alter table template_notification add primary key (user_id, id);

-- 3. The one unique constraint that can be scoped to a tenant.
--
-- A template id is already unique across the whole table, so adding the owner
-- in front narrows nothing and costs nothing. The other five constraints that
-- exclude `user_id` cannot be treated this way and are the reason five tables
-- below are reference tables instead — see `docs/citus.md`.
alter table template_notification drop constraint template_notification_template_id_unique;
alter table template_notification
  add constraint template_notification_template_owner_unique unique (user_id, template_id);

-- 4. Reference tables: replicated whole to every node.
--
-- Three reasons appear here. `auth_user` and the tables with no `user_id` at
-- all have no tenant to distribute on. `auth_session` and `auth_account` carry
-- a unique that is global by nature — a session token, a provider's account
-- id — and distributing them would also turn the session lookup every
-- authenticated request performs into a scatter-gather. The three billing
-- tables carry Stripe's identifiers, which live in Stripe's namespace rather
-- than in ours. All of them are small: one row per person at most.
select create_reference_table('auth_user');
select create_reference_table('auth_verification');
select create_reference_table('auth_rate_limit');
select create_reference_table('auth_owner_setup_token');
select create_reference_table('auth_mcp_signing_key');
select create_reference_table('billing_webhook_event');
select create_reference_table('auth_oauth_application');
select create_reference_table('auth_oauth_access_token');
select create_reference_table('auth_oauth_consent');
select create_reference_table('auth_account');
select create_reference_table('auth_session');
select create_reference_table('billing_customer');
select create_reference_table('billing_operation');
select create_reference_table('billing_subscription');

-- 5. The ledger itself, distributed by owner and colocated.
--
-- Colocated is the whole point: shards for the same `user_id` land on the same
-- node, so a join between a person's transactions and their postings is local
-- to one worker rather than a network shuffle.
select create_distributed_table('user_preferences', 'user_id');
select create_distributed_table('audit_event', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('category_group', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('category', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('ledger_account', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('ledger_transaction', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('transaction_leg', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('posting', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('import_batch', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('staged_transaction', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('budget_plan', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('budget_entry', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('recurrence', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('transaction_template', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('template_notification', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('idempotency_record', 'user_id', colocate_with => 'user_preferences');
select create_distributed_table('billing_override', 'user_id', colocate_with => 'user_preferences');

-- 6. The foreign keys go back, two of them changed.
--
-- `category.group_id` loses `ON DELETE SET NULL`, and this is the one
-- behaviour the cluster costs. Citus refuses it with `SET NULL or SET DEFAULT
-- is not supported in ON DELETE operation when distribution key is included in
-- the foreign key constraint` — so it is not about which columns would be
-- nulled, and PostgreSQL 15's `SET NULL (group_id)` spelling is refused for
-- the same reason. The nulling moves into the delete, in the service.
alter table audit_event add constraint "audit_event_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table auth_account add constraint "auth_account_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table auth_oauth_access_token add constraint "auth_oauth_access_token_client_id_auth_oauth_application_client" FOREIGN KEY (client_id) REFERENCES auth_oauth_application(client_id) ON DELETE CASCADE;
alter table auth_oauth_access_token add constraint "auth_oauth_access_token_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table auth_oauth_application add constraint "auth_oauth_application_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table auth_oauth_consent add constraint "auth_oauth_consent_client_id_auth_oauth_application_client_id_f" FOREIGN KEY (client_id) REFERENCES auth_oauth_application(client_id) ON DELETE CASCADE;
alter table auth_oauth_consent add constraint "auth_oauth_consent_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table auth_session add constraint "auth_session_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table billing_customer add constraint "billing_customer_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table billing_operation add constraint "billing_operation_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table billing_override add constraint "billing_override_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table billing_subscription add constraint "billing_subscription_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table budget_entry add constraint "budget_entry_category_fk" FOREIGN KEY (user_id, category_id) REFERENCES category(user_id, id) ON DELETE CASCADE;
alter table budget_entry add constraint "budget_entry_group_fk" FOREIGN KEY (user_id, group_id) REFERENCES category_group(user_id, id) ON DELETE CASCADE;
alter table budget_entry add constraint "budget_entry_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table budget_plan add constraint "budget_plan_category_fk" FOREIGN KEY (user_id, category_id) REFERENCES category(user_id, id) ON DELETE CASCADE;
alter table budget_plan add constraint "budget_plan_group_fk" FOREIGN KEY (user_id, group_id) REFERENCES category_group(user_id, id) ON DELETE CASCADE;
alter table budget_plan add constraint "budget_plan_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table category add constraint "category_group_owner_fk" FOREIGN KEY (user_id, group_id) REFERENCES category_group(user_id, id);
alter table category add constraint "category_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table category_group add constraint "category_group_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table idempotency_record add constraint "idempotency_record_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table import_batch add constraint "import_batch_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table ledger_account add constraint "ledger_account_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table ledger_transaction add constraint "ledger_transaction_category_owner_fk" FOREIGN KEY (user_id, category_id) REFERENCES category(user_id, id);
alter table ledger_transaction add constraint "ledger_transaction_destination_account_owner_fk" FOREIGN KEY (user_id, destination_account_id) REFERENCES ledger_account(user_id, id);
alter table ledger_transaction add constraint "ledger_transaction_source_account_owner_fk" FOREIGN KEY (user_id, source_account_id) REFERENCES ledger_account(user_id, id);
alter table ledger_transaction add constraint "ledger_transaction_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table posting add constraint "posting_account_currency_fk" FOREIGN KEY (user_id, account_id, currency) REFERENCES ledger_account(user_id, id, currency);
alter table posting add constraint "posting_closing_account_owner_fk" FOREIGN KEY (user_id, closing_account_id) REFERENCES ledger_account(user_id, id);
alter table posting add constraint "posting_leg_owner_fk" FOREIGN KEY (user_id, transaction_id, leg_id) REFERENCES transaction_leg(user_id, transaction_id, id) ON DELETE CASCADE;
alter table posting add constraint "posting_opening_account_owner_fk" FOREIGN KEY (user_id, opening_account_id) REFERENCES ledger_account(user_id, id);
alter table posting add constraint "posting_transaction_owner_fk" FOREIGN KEY (user_id, transaction_id) REFERENCES ledger_transaction(user_id, id) ON DELETE CASCADE;
alter table posting add constraint "posting_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table recurrence add constraint "recurrence_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table staged_transaction add constraint "staged_transaction_committed_owner_fk" FOREIGN KEY (user_id, committed_transaction_id) REFERENCES ledger_transaction(user_id, id);
alter table staged_transaction add constraint "staged_transaction_duplicate_owner_fk" FOREIGN KEY (user_id, duplicate_of_id) REFERENCES ledger_transaction(user_id, id);
alter table staged_transaction add constraint "staged_transaction_import_batch_owner_fk" FOREIGN KEY (user_id, import_batch_id) REFERENCES import_batch(user_id, id);
alter table staged_transaction add constraint "staged_transaction_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table template_notification add constraint "template_notification_template_owner_fk" FOREIGN KEY (user_id, template_id) REFERENCES transaction_template(user_id, id) ON DELETE CASCADE;
alter table template_notification add constraint "template_notification_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table transaction_leg add constraint "transaction_leg_category_owner_fk" FOREIGN KEY (user_id, category_id) REFERENCES category(user_id, id);
alter table transaction_leg add constraint "transaction_leg_transaction_owner_fk" FOREIGN KEY (user_id, transaction_id) REFERENCES ledger_transaction(user_id, id) ON DELETE CASCADE;
alter table transaction_leg add constraint "transaction_leg_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table transaction_template add constraint "transaction_template_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;
alter table user_preferences add constraint "user_preferences_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE;

commit;
