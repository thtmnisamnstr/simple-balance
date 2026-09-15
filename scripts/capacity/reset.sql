-- Empties a capacity database so it can be seeded again.
--
--   psql "$CAPACITY_DATABASE_URL" -f scripts/capacity/reset.sql
--
-- `seed.mjs` refuses a database that already holds capacity users, because
-- every id it writes is derived from a counter rather than generated: a second
-- run would collide with the first on the primary key rather than adding to it.
-- This is the way back without dropping and re-migrating the database.
--
-- Everything a capacity user owns hangs off `auth_user` with `on delete
-- cascade`, which is the rule `AGENTS.md` sets for any table holding somebody's
-- data — so deleting the users is deleting the ledger, and nothing here has to
-- enumerate tables. That is also why this is one statement rather than a list
-- that would go stale the next time a table is added.
delete from auth_user where id like 'cap-%' or email = 'capacity-key@capacity.invalid';

-- The one thing that does not cascade, because it belongs to nobody: the
-- record of which webhook deliveries have been answered. A capacity run never
-- writes one, and this is here so the file is complete rather than nearly.
-- Nothing else in the schema is outside the cascade.
select
  (select count(*) from auth_user where id like 'cap-%') as users_left,
  (select count(*) from ledger_transaction) as transactions_left,
  (select count(*) from posting) as postings_left;
