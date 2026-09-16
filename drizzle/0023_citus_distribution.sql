-- Distribute the ledger across a Citus cluster, where there is one.
--
-- This migration does nothing at all on a plain PostgreSQL, which is what the
-- `single` and `vps` profiles run, and it has to: everything below is either
-- meaningless or destructive without Citus. The gate is the extension being
-- installed, checked once at the top, and a deployment that never installs it
-- records this migration as run and keeps the schema it already had.
--
-- The whole thing is one `DO` block because that is the only way a plain SQL
-- migration can be conditional. Every DDL statement therefore goes through
-- `execute`, and the Citus functions through `perform`; neither changes what
-- runs, only how it is spelled. `docs/citus.md` carries the reasoning for each
-- step and `docs/citus-runbook.md` the operational half.
--
-- It is also the procedure to run by hand. A deployment that was already on
-- this release before Citus was installed has this migration recorded and will
-- not run it again, so moving an existing database onto a cluster means feeding
-- this same file to psql once the extension is there. The gate makes that safe
-- either way round.
--
-- Note that drizzle runs every pending migration inside one transaction, so on
-- a new cluster the tables are created and distributed in the same transaction.
-- That is supported and it is tested — `tests/integration/citus-*` — but it is
-- the reason the modify mode below is set rather than left alone.
DO $citus$
BEGIN
  -- No Citus, nothing to do. Not an error: the two single-database profiles are
  -- supported deployments and this is how they stay unchanged.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citus') THEN
    RETURN;
  END IF;

  -- One connection per node, for the whole transaction.
  --
  -- Citus parallelises a multi-shard change across several connections per node
  -- by default, and that is incompatible with holding a foreign key into a
  -- reference table: the second statement in this transaction fails with
  -- `cannot modify table ... because there was a parallel operation on a
  -- distributed table in the transaction`. Sequential is slower and is the only
  -- mode in which this whole procedure is one atomic step, which is what a
  -- migration has to be.
  perform set_config('citus.multi_shard_modify_mode', 'sequential', true);

  -- 1. Every foreign key comes off first.
  --
  -- Not tidiness: Citus supports a foreign key between two distributed tables
  -- and between a distributed table and a reference table, and refuses one
  -- where either side is still a plain local table. Converting thirty-one
  -- tables one at a time therefore passes through a state that is illegal for
  -- whichever key spans the boundary, and there is no ordering that avoids it.
  -- So they all come off and all go back.
  execute 'alter table audit_event drop constraint "audit_event_user_id_auth_user_id_fk"';
  execute 'alter table auth_account drop constraint "auth_account_user_id_auth_user_id_fk"';
  execute 'alter table auth_oauth_access_token drop constraint "auth_oauth_access_token_client_id_auth_oauth_application_client"';
  execute 'alter table auth_oauth_access_token drop constraint "auth_oauth_access_token_user_id_auth_user_id_fk"';
  execute 'alter table auth_oauth_application drop constraint "auth_oauth_application_user_id_auth_user_id_fk"';
  execute 'alter table auth_oauth_consent drop constraint "auth_oauth_consent_client_id_auth_oauth_application_client_id_f"';
  execute 'alter table auth_oauth_consent drop constraint "auth_oauth_consent_user_id_auth_user_id_fk"';
  execute 'alter table auth_session drop constraint "auth_session_user_id_auth_user_id_fk"';
  execute 'alter table billing_customer drop constraint "billing_customer_user_id_auth_user_id_fk"';
  execute 'alter table billing_operation drop constraint "billing_operation_user_id_auth_user_id_fk"';
  execute 'alter table billing_override drop constraint "billing_override_user_id_auth_user_id_fk"';
  execute 'alter table billing_subscription drop constraint "billing_subscription_user_id_auth_user_id_fk"';
  execute 'alter table budget_entry drop constraint "budget_entry_category_fk"';
  execute 'alter table budget_entry drop constraint "budget_entry_group_fk"';
  execute 'alter table budget_entry drop constraint "budget_entry_user_id_auth_user_id_fk"';
  execute 'alter table budget_plan drop constraint "budget_plan_category_fk"';
  execute 'alter table budget_plan drop constraint "budget_plan_group_fk"';
  execute 'alter table budget_plan drop constraint "budget_plan_user_id_auth_user_id_fk"';
  execute 'alter table category drop constraint "category_group_id_category_group_id_fk"';
  execute 'alter table category drop constraint "category_user_id_auth_user_id_fk"';
  execute 'alter table category_group drop constraint "category_group_user_id_auth_user_id_fk"';
  execute 'alter table idempotency_record drop constraint "idempotency_record_user_id_auth_user_id_fk"';
  execute 'alter table import_batch drop constraint "import_batch_user_id_auth_user_id_fk"';
  execute 'alter table ledger_account drop constraint "ledger_account_user_id_auth_user_id_fk"';
  execute 'alter table ledger_transaction drop constraint "ledger_transaction_category_owner_fk"';
  execute 'alter table ledger_transaction drop constraint "ledger_transaction_destination_account_owner_fk"';
  execute 'alter table ledger_transaction drop constraint "ledger_transaction_source_account_owner_fk"';
  execute 'alter table ledger_transaction drop constraint "ledger_transaction_user_id_auth_user_id_fk"';
  execute 'alter table posting drop constraint "posting_account_currency_fk"';
  execute 'alter table posting drop constraint "posting_closing_account_owner_fk"';
  execute 'alter table posting drop constraint "posting_leg_owner_fk"';
  execute 'alter table posting drop constraint "posting_opening_account_owner_fk"';
  execute 'alter table posting drop constraint "posting_transaction_owner_fk"';
  execute 'alter table posting drop constraint "posting_user_id_auth_user_id_fk"';
  execute 'alter table recurrence drop constraint "recurrence_user_id_auth_user_id_fk"';
  execute 'alter table staged_transaction drop constraint "staged_transaction_committed_owner_fk"';
  execute 'alter table staged_transaction drop constraint "staged_transaction_duplicate_owner_fk"';
  execute 'alter table staged_transaction drop constraint "staged_transaction_import_batch_owner_fk"';
  execute 'alter table staged_transaction drop constraint "staged_transaction_user_id_auth_user_id_fk"';
  execute 'alter table template_notification drop constraint "template_notification_template_id_transaction_template_id_fk"';
  execute 'alter table template_notification drop constraint "template_notification_user_id_auth_user_id_fk"';
  execute 'alter table transaction_leg drop constraint "transaction_leg_category_owner_fk"';
  execute 'alter table transaction_leg drop constraint "transaction_leg_transaction_owner_fk"';
  execute 'alter table transaction_leg drop constraint "transaction_leg_user_id_auth_user_id_fk"';
  execute 'alter table transaction_template drop constraint "transaction_template_user_id_auth_user_id_fk"';
  execute 'alter table user_preferences drop constraint "user_preferences_user_id_auth_user_id_fk"';

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
  execute 'alter table audit_event drop constraint audit_event_pkey';
  execute 'alter table audit_event add primary key (user_id, id)';
  execute 'alter table category_group drop constraint category_group_pkey';
  execute 'alter table category_group add primary key (user_id, id)';
  execute 'alter table category drop constraint category_pkey';
  execute 'alter table category add primary key (user_id, id)';
  execute 'alter table ledger_account drop constraint ledger_account_pkey';
  execute 'alter table ledger_account add primary key (user_id, id)';
  execute 'alter table ledger_transaction drop constraint ledger_transaction_pkey';
  execute 'alter table ledger_transaction add primary key (user_id, id)';
  execute 'alter table transaction_leg drop constraint transaction_leg_pkey';
  execute 'alter table transaction_leg add primary key (user_id, id)';
  execute 'alter table posting drop constraint posting_pkey';
  execute 'alter table posting add primary key (user_id, id)';
  execute 'alter table import_batch drop constraint import_batch_pkey';
  execute 'alter table import_batch add primary key (user_id, id)';
  execute 'alter table staged_transaction drop constraint staged_transaction_pkey';
  execute 'alter table staged_transaction add primary key (user_id, id)';
  execute 'alter table budget_plan drop constraint budget_plan_pkey';
  execute 'alter table budget_plan add primary key (user_id, id)';
  execute 'alter table budget_entry drop constraint budget_entry_pkey';
  execute 'alter table budget_entry add primary key (user_id, id)';
  execute 'alter table recurrence drop constraint recurrence_pkey';
  execute 'alter table recurrence add primary key (user_id, id)';
  execute 'alter table transaction_template drop constraint transaction_template_pkey';
  execute 'alter table transaction_template add primary key (user_id, id)';
  execute 'alter table template_notification drop constraint template_notification_pkey';
  execute 'alter table template_notification add primary key (user_id, id)';

  -- 2a. Five unique constraints the new primary key has just made redundant.
  --
  -- Each is `unique (user_id, id)` on a table whose primary key is now exactly
  -- those columns in that order, so the constraint indexes nothing the key does
  -- not. They existed to let the composite foreign keys elsewhere in this schema
  -- point at `(user_id, id)` while the primary key was `(id)` alone; the key now
  -- serves that purpose and the foreign keys go back against it in step 6.
  --
  -- Dropping them is not tidying. `create_distributed_table` copies every index
  -- to every shard, so each of these would otherwise be replicated thirty-two
  -- times over — including one on `ledger_transaction`, which is the largest
  -- table here and the one taking the most writes.
  execute 'alter table category_group drop constraint category_group_user_id_id_unique';
  execute 'alter table category drop constraint category_user_id_id_unique';
  execute 'alter table import_batch drop constraint import_batch_user_id_id_unique';
  execute 'alter table ledger_account drop constraint ledger_account_user_id_id_unique';
  execute 'alter table ledger_transaction drop constraint ledger_transaction_user_id_id_unique';
  --
  -- `ledger_account_user_id_currency_unique` is deliberately NOT in that list.
  -- It is `(user_id, id, currency)`, which the primary key does not cover, and
  -- `posting_account_currency_fk` is the reason it exists: a posting names an
  -- account and a currency together, so the pair has to be a real combination.
  -- 3. The one unique constraint that can be scoped to a tenant.
  --
  -- A template id is already unique across the whole table, so adding the owner
  -- in front narrows nothing and costs nothing. The other five constraints that
  -- exclude `user_id` cannot be treated this way and are the reason five tables
  -- below are reference tables instead — see `docs/citus.md`.
  execute 'alter table template_notification drop constraint template_notification_template_id_unique';
  execute 'alter table template_notification add constraint template_notification_template_owner_unique unique (user_id, template_id)';

  -- 4. Reference tables: replicated whole to every node.
  --
  -- Three reasons appear here. `auth_user` and the tables with no `user_id` at
  -- all have no tenant to distribute on. `auth_session` and `auth_account` carry
  -- a unique that is global by nature — a session token, a provider's account
  -- id — and distributing them would also turn the session lookup every
  -- authenticated request performs into a scatter-gather. The three billing
  -- tables carry Stripe's identifiers, which live in Stripe's namespace rather
  -- than in ours. All of them are small: one row per person at most.
  perform create_reference_table('auth_user');
  perform create_reference_table('auth_verification');
  perform create_reference_table('auth_rate_limit');
  perform create_reference_table('auth_owner_setup_token');
  perform create_reference_table('auth_mcp_signing_key');
  perform create_reference_table('billing_webhook_event');
  perform create_reference_table('auth_oauth_application');
  perform create_reference_table('auth_oauth_access_token');
  perform create_reference_table('auth_oauth_consent');
  perform create_reference_table('auth_account');
  perform create_reference_table('auth_session');
  perform create_reference_table('billing_customer');
  perform create_reference_table('billing_operation');
  perform create_reference_table('billing_subscription');

  -- 5. The ledger itself, distributed by owner and colocated.
  --
  -- Colocated is the whole point: shards for the same `user_id` land on the same
  -- node, so a join between a person's transactions and their postings is local
  -- to one worker rather than a network shuffle.
  perform create_distributed_table('user_preferences', 'user_id');
  perform create_distributed_table('audit_event', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('category_group', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('category', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('ledger_account', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('ledger_transaction', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('transaction_leg', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('posting', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('import_batch', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('staged_transaction', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('budget_plan', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('budget_entry', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('recurrence', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('transaction_template', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('template_notification', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('idempotency_record', 'user_id', colocate_with => 'user_preferences');
  perform create_distributed_table('billing_override', 'user_id', colocate_with => 'user_preferences');

  -- 6. The foreign keys go back, two of them changed.
  --
  -- `category.group_id` loses `ON DELETE SET NULL`, and this is the one
  -- behaviour the cluster costs. Citus refuses it with `SET NULL or SET DEFAULT
  -- is not supported in ON DELETE operation when distribution key is included in
  -- the foreign key constraint` — so it is not about which columns would be
  -- nulled, and PostgreSQL 15's `SET NULL (group_id)` spelling is refused for
  -- the same reason. The nulling moves into the delete, in the service.
  execute 'alter table audit_event add constraint "audit_event_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table auth_account add constraint "auth_account_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table auth_oauth_access_token add constraint "auth_oauth_access_token_client_id_auth_oauth_application_client" FOREIGN KEY (client_id) REFERENCES auth_oauth_application(client_id) ON DELETE CASCADE';
  execute 'alter table auth_oauth_access_token add constraint "auth_oauth_access_token_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table auth_oauth_application add constraint "auth_oauth_application_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table auth_oauth_consent add constraint "auth_oauth_consent_client_id_auth_oauth_application_client_id_f" FOREIGN KEY (client_id) REFERENCES auth_oauth_application(client_id) ON DELETE CASCADE';
  execute 'alter table auth_oauth_consent add constraint "auth_oauth_consent_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table auth_session add constraint "auth_session_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table billing_customer add constraint "billing_customer_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table billing_operation add constraint "billing_operation_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table billing_override add constraint "billing_override_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table billing_subscription add constraint "billing_subscription_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table budget_entry add constraint "budget_entry_category_fk" FOREIGN KEY (user_id, category_id) REFERENCES category(user_id, id) ON DELETE CASCADE';
  execute 'alter table budget_entry add constraint "budget_entry_group_fk" FOREIGN KEY (user_id, group_id) REFERENCES category_group(user_id, id) ON DELETE CASCADE';
  execute 'alter table budget_entry add constraint "budget_entry_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table budget_plan add constraint "budget_plan_category_fk" FOREIGN KEY (user_id, category_id) REFERENCES category(user_id, id) ON DELETE CASCADE';
  execute 'alter table budget_plan add constraint "budget_plan_group_fk" FOREIGN KEY (user_id, group_id) REFERENCES category_group(user_id, id) ON DELETE CASCADE';
  execute 'alter table budget_plan add constraint "budget_plan_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table category add constraint "category_group_owner_fk" FOREIGN KEY (user_id, group_id) REFERENCES category_group(user_id, id)';
  execute 'alter table category add constraint "category_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table category_group add constraint "category_group_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table idempotency_record add constraint "idempotency_record_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table import_batch add constraint "import_batch_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table ledger_account add constraint "ledger_account_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table ledger_transaction add constraint "ledger_transaction_category_owner_fk" FOREIGN KEY (user_id, category_id) REFERENCES category(user_id, id)';
  execute 'alter table ledger_transaction add constraint "ledger_transaction_destination_account_owner_fk" FOREIGN KEY (user_id, destination_account_id) REFERENCES ledger_account(user_id, id)';
  execute 'alter table ledger_transaction add constraint "ledger_transaction_source_account_owner_fk" FOREIGN KEY (user_id, source_account_id) REFERENCES ledger_account(user_id, id)';
  execute 'alter table ledger_transaction add constraint "ledger_transaction_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table posting add constraint "posting_account_currency_fk" FOREIGN KEY (user_id, account_id, currency) REFERENCES ledger_account(user_id, id, currency)';
  execute 'alter table posting add constraint "posting_closing_account_owner_fk" FOREIGN KEY (user_id, closing_account_id) REFERENCES ledger_account(user_id, id)';
  execute 'alter table posting add constraint "posting_leg_owner_fk" FOREIGN KEY (user_id, transaction_id, leg_id) REFERENCES transaction_leg(user_id, transaction_id, id) ON DELETE CASCADE';
  execute 'alter table posting add constraint "posting_opening_account_owner_fk" FOREIGN KEY (user_id, opening_account_id) REFERENCES ledger_account(user_id, id)';
  execute 'alter table posting add constraint "posting_transaction_owner_fk" FOREIGN KEY (user_id, transaction_id) REFERENCES ledger_transaction(user_id, id) ON DELETE CASCADE';
  execute 'alter table posting add constraint "posting_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table recurrence add constraint "recurrence_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table staged_transaction add constraint "staged_transaction_committed_owner_fk" FOREIGN KEY (user_id, committed_transaction_id) REFERENCES ledger_transaction(user_id, id)';
  execute 'alter table staged_transaction add constraint "staged_transaction_duplicate_owner_fk" FOREIGN KEY (user_id, duplicate_of_id) REFERENCES ledger_transaction(user_id, id)';
  execute 'alter table staged_transaction add constraint "staged_transaction_import_batch_owner_fk" FOREIGN KEY (user_id, import_batch_id) REFERENCES import_batch(user_id, id)';
  execute 'alter table staged_transaction add constraint "staged_transaction_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table template_notification add constraint "template_notification_template_owner_fk" FOREIGN KEY (user_id, template_id) REFERENCES transaction_template(user_id, id) ON DELETE CASCADE';
  execute 'alter table template_notification add constraint "template_notification_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table transaction_leg add constraint "transaction_leg_category_owner_fk" FOREIGN KEY (user_id, category_id) REFERENCES category(user_id, id)';
  execute 'alter table transaction_leg add constraint "transaction_leg_transaction_owner_fk" FOREIGN KEY (user_id, transaction_id) REFERENCES ledger_transaction(user_id, id) ON DELETE CASCADE';
  execute 'alter table transaction_leg add constraint "transaction_leg_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table transaction_template add constraint "transaction_template_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
  execute 'alter table user_preferences add constraint "user_preferences_user_id_auth_user_id_fk" FOREIGN KEY (user_id) REFERENCES auth_user(id) ON DELETE CASCADE';
END
$citus$;
