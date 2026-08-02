# Upgrades

Everything persistent is in PostgreSQL. The container holds nothing you need to
keep, so upgrading is swapping it for a newer one.

## How to upgrade

1. Read the [changelog](../CHANGELOG.md) for the version you are moving to, and
   check whether it asks anything new of PostgreSQL or your configuration.
2. Back the database up, and confirm the backup is good:

   ```sh
   pg_dump --format=custom \
     --file=simple-balance-before-upgrade.dump \
     "$DATABASE_URL"
   ```

   Let PostgreSQL handle the password through `~/.pgpass` or the environment
   rather than typing it into a shell that remembers it.
3. Pull the image by its version tag, not `latest`, so you know what you are
   getting.
4. Stop and remove the application container. Leave PostgreSQL running.
5. Start the new image with the same settings you had before.
6. Watch the log, and wait for `curl -f http://127.0.0.1:3000/health/ready`.
7. Keep the backup until you have used the app enough to trust it.

The new process applies every pending migration before it opens readiness,
holding a PostgreSQL advisory lock so two containers starting at once cannot
race. Any data reshaping a release needs travels inside its migrations. You
never run a migration command, copy rows, or retype anything.

## Rolling back

Do not run two versions with different schema expectations against one database.
A migration can leave the schema unreadable to the older image, so rolling back
means stopping the app and restoring the backup you took in step 2, unless the
release you moved to says otherwise.

This is the reason step 2 is not optional.

## The schema contract

Before the first release, the schema is a single baseline migration that gets
regenerated in place as it changes. The first release freezes it.

After that, released migrations are immutable, and every schema change:

- is a new forward-only migration, checked into version control;
- preserves every ledger, authentication, provenance, idempotency, and audit
  row;
- fills in any new required column for existing rows deterministically;
- runs inside a transaction wherever PostgreSQL allows one, and states plainly
  what it does when it cannot;
- survives being interrupted and restarted, and fails readiness rather than
  leaving the schema half-changed;
- ships with an integration test that starts from the previous release's schema
  with real data in it, runs the migrations, and checks both the shape and the
  contents afterwards.

Migrations run inside the application rather than as a separate step because
that is what makes an upgrade one action. Swap the image, start it, and the
database catches up on its own.
