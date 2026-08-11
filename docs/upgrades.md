# Upgrades

Everything persistent is in PostgreSQL. The container holds nothing you need to
keep, so upgrading is swapping it for a newer one.

## Before you upgrade to 0.1.4

0.1.4 refuses to start on three configurations 0.1.3 accepted. Each refusal is
deliberate: all three were ways a deployment could look fine while running with
protections silently off. Check these before you swap the image, because the
container will not start and will not tell you until it has.

| If your configuration has | 0.1.4 does | What to do |
| --- | --- | --- |
| `AUTH_SECRET` still set to the placeholder `.env.example` shipped | Refuses to start, naming the variable | Generate one: `openssl rand -base64 32` |
| `NODE_ENV` set to anything but `production`, `development` or `test`, including unset or empty | Refuses to start | Set `NODE_ENV=production`. The images already do. |
| `NODE_ENV` not `production` while `APP_BASE_URL` names anything but localhost | Refuses to start | Set `NODE_ENV=production`, and give `APP_BASE_URL` the HTTPS origin your proxy terminates |

**Replacing `AUTH_SECRET` signs everybody out** and disconnects every MCP
client, because sessions are signed with it. Everyone signs in again with the
password they already have, and each connected agent has to be authorized once
more from Settings. Plan the upgrade for a moment when that is acceptable.

Two other things change without stopping the server:

- `CSV_MAX_ROWS` above 10,000 is silently reduced to 10,000, which is now also
  the most rows one mass edit, commit or delete covers. If you had it higher,
  large imports now arrive in more than one file.
- MCP access tokens issued by 0.1.3 stop working. Clients holding a refresh
  token get a new one on their next call without anybody doing anything; a
  client that cannot refresh has to be authorized again.

The first start after the upgrade re-closes any account you archived while it
held a transaction dated in the future, and says so in the log. It writes
nothing for an account that is already correct, and running it again writes
nothing at all.

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
5. Start the new image with the same settings you had before, after checking
   the section above for anything that release refuses.
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

## Cutting a release

1. `npm run set-version 0.2.0`, which sets the version everywhere it has to
   agree: both manifests, both lockfiles, all four Dockerfiles, the constant the
   MCP server reports, and the backlog.
2. Date the `## Unreleased` heading in `CHANGELOG.md`, since nothing does that
   for you and the upgrade notes above send people there to read it.
3. Commit and push that on the default branch.
4. Cut a release on GitHub against tag `v0.2.0`, from the UI or with
   `gh release create v0.2.0`.

Publishing keys off the release itself, not off the tag push, so it runs once
whether the tag existed beforehand or GitHub creates it. The workflow runs the
full verification suite first, refuses to publish if the tag and the manifest
disagree, and then pushes a multi-architecture image to GHCR tagged with the
version. `latest` moves to it unless the release is marked as a prerelease or
the version carries a suffix, in which case only the version tag is published.

If a publish fails for a reason that has nothing to do with the code, run the
release workflow by hand from the Actions tab and give it the tag; it publishes
the same tags without needing a new release.

## The schema contract

Once a migration ships in a release it is frozen, starting with the ones in
0.1.0. A released migration has run against somebody's data by then, and editing
it would leave their schema and its recorded history disagreeing.

Every schema change is therefore a new migration, and each one:

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
