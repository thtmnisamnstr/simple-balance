# Upgrades and schema evolution

Simple Balance stores all persistent state in PostgreSQL. The application
container is replaceable and needs no writable volume.

## Upgrade procedure

1. Read the target release in the [changelog](../CHANGELOG.md) and confirm its
   PostgreSQL and configuration requirements.
2. Create and verify a PostgreSQL backup. For example:

   ```sh
   pg_dump --format=custom \
     --file=simple-balance-before-upgrade.dump \
     'postgresql://simple_balance@database.example:5432/simple_balance'
   ```

   Supply credentials through PostgreSQL's supported secret mechanisms rather
   than placing a password in shell history.
3. Pull or build the target image using its immutable release tag.
4. Stop the application container. Keep PostgreSQL running.
5. Start the target image with the same `DATABASE_URL`, `APP_BASE_URL`,
   `AUTH_SECRET`, authentication settings, and container hardening flags.
6. Follow the startup log and wait for
   `curl -f http://127.0.0.1:3000/health/ready` to succeed.
7. Keep the backup until the application and representative ledger data have
   been checked.

The new process connects to PostgreSQL and applies every pending migration under
an advisory lock before opening readiness. Data transformations and required
value population ship inside the release migrations. Operators do not run
`pnpm db:migrate`, copy rows, or repopulate the ledger manually.

Do not run application versions with different schema expectations
simultaneously during an upgrade. A schema upgrade can make the database
incompatible with an earlier image, so rollback means stopping the application
and restoring the pre-upgrade backup unless the target release explicitly
documents another safe procedure.

## Schema contract

Version 0.1.0 is the database baseline and contains one initial migration.
Released migrations are immutable. A later release that changes the schema
must:

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

Internal migrations are necessary for automatic, data-preserving upgrades.
They let an operator upgrade the image and restart the container without
manually changing the database or re-entering data.
