# Upgrades and schema evolution

All persistent state lives in PostgreSQL. The application container is
disposable and needs no writable volume.

Nothing has shipped yet, so there is no release to upgrade from. What follows is
the procedure and the contract that take effect once a version does ship.

## Upgrade procedure

1. Read the target release in the [changelog](../CHANGELOG.md) and confirm its
   PostgreSQL and configuration requirements.
2. Create and verify a PostgreSQL backup. For example:

   ```sh
   pg_dump --format=custom \
     --file=simple-balance-before-upgrade.dump \
     'postgresql://simple_balance@database.example:5432/simple_balance'
   ```

   Pass credentials through PostgreSQL's own secret mechanisms. Do not put a
   password in shell history.
3. Pull or build the target image using its immutable release tag.
4. Stop the application container. Keep PostgreSQL running.
5. Start the target image with the same `DATABASE_URL`, `APP_BASE_URL`,
   `AUTH_SECRET`, authentication settings, and container hardening flags.
6. Follow the startup log and wait for
   `curl -f http://127.0.0.1:3000/health/ready` to succeed.
7. Keep the backup until the application and representative ledger data have
   been checked.

The new process connects to PostgreSQL and applies every pending migration under
an advisory lock before it opens readiness. Data transformation and backfill
ride along inside the release migrations. You never run `npm run db:migrate`,
copy rows, or retype ledger data by hand.

Never run two application versions with different schema expectations at once.
A schema upgrade can leave the database unreadable by the older image, so
rollback means stopping the application and restoring the pre-upgrade backup,
unless the target release documents something safer.

## Schema contract

Until a version ships, the schema is one baseline migration that gets
regenerated in place. The first release freezes that baseline. From then on,
released migrations are immutable, and any later schema change must:

- add a new, forward-only, version-controlled SQL migration;
- preserve all ledger, authentication, provenance, idempotency, and audit data;
- deterministically populate every required column or derived record for
  existing rows;
- use a transaction wherever PostgreSQL permits it and explicitly design any
  operation that cannot be transactional;
- remain restart-safe after interruption and fail application readiness on any
  migration error;
- include a PostgreSQL integration test that begins with the preceding release
  schema plus representative data, runs the current startup migrations, and
  verifies both schema and data.

Migrations run inside the application because that is what makes an upgrade
automatic and non-destructive. Swap the image, restart the container, and the
database catches up on its own.
