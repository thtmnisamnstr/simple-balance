# Upgrades

Everything persistent is in PostgreSQL. The container holds nothing you need to
keep, so upgrading is swapping it for a newer one.

## Before you upgrade to 0.1.5

Nothing refuses to start that 0.1.4 accepted, and nothing about an existing
configuration has to change. Five things are worth knowing.

**Four migrations run at startup.** One adds the reminders table and one column
on `recurrence`, defaulting to off, so no recurrence you already have starts
emailing you. One adds a one-row table holding the first-run setup code, which
matters only on a deployment that has never been set up. One adds a `theme`
column defaulting to `system`, which is a constant default and therefore
metadata-only — no table rewrite, and every existing account lands on "follow the
machine", which is what it should be. The fourth drops four indexes whose leading
column another unique constraint on the same table already leads with; no query
loses a plan, and the statements are `if exists`, so a database restored from a
dump that never had them upgrades cleanly.

**Emailed reminders need a mail server and the scheduler.** Setting a recurrence
to write when it proposes, or giving a template a reminder, is saved either way,
and starts sending once `SMTP_HOST` and `MAIL_FROM` are configured. Nothing
queues in the meantime: a reminder whose moment passed while there was nowhere
to send it is not sent later. On a split deployment, give the scheduler
container those settings too — it is the process that sends them, and without
them it proposes rows and sends nothing, with no error to see.

**The first-run setup code now works on more than one replica.** It used to be
generated per process and held in memory, so on a web tier running two or more
pods — which the chart does by default — the code printed in the log was rejected
by every other pod, and first-run setup failed about half the time. It is stored
now, so every replica agrees on it. This affects only a deployment whose owner
account has not been created yet; an existing one has nothing to do. An
operator-chosen `SETUP_TOKEN` still never touches the database and still takes
precedence.

**Dark mode arrives set to follow the machine.** Nobody has to do anything: an
existing account keeps looking exactly as it did on a light machine, and starts
dark on a dark one. The setting lives on the account rather than in the browser,
so it follows somebody to another device, and there is a third state — Light and
Dark, which stay put, and Follow my system, which is the default and changes when
the machine does.

Three things change in the light theme as a consequence, all of them repairs. Six
greys carrying real text were below the contrast a person needs to read them —
the input placeholder was the worst at 2.65:1 — and they now sit on one three-step
ramp that clears it. The border on an input was 1.39:1 against the field it edges,
which is not a boundary — and an input here is white on a white card, so that
border is the only thing telling you where the field is; a field's edge now holds
the 3:1 that makes it visible, and a focused field is darker again rather than
only greener.
And the focus ring was semi-transparent, so how well it showed depended on
whatever happened to be behind it; it is opaque now and the same everywhere.
Inputs, captions and the focus ring therefore look more defined than they did.

**The duplicate check on Staged transactions got looser, and only as advice.** It
now anchors on the amount with three days of latitude on the date rather than
demanding the same day and the same payee, so an import will flag rows it would
have let past before. What refuses a commit is unchanged. Nothing already in the
queue is re-examined until it is listed again.

## Before you upgrade to 0.1.4

0.1.4 refuses to start on three configurations 0.1.3 accepted. Each refusal is
deliberate: all three were ways a deployment could look fine while running with
protections silently off. Check these before you swap the image, because the
container will not start and will not tell you until it has.

| If your configuration has | 0.1.4 does | What to do |
| --- | --- | --- |
| `AUTH_SECRET` still set to the placeholder `.env.example` shipped | Refuses to start, naming the variable | Generate one: `openssl rand -base64 32` |
| `NODE_ENV` set to anything but `production`, `development` or `test`, empty included | Refuses to start | Set `NODE_ENV=production`. The images already do. |
| `NODE_ENV` unset | Reads as `development`, so the setup code, sign-in rate limiting and secure cookies are all off | Set `NODE_ENV=production`. Unset is the one value that does not announce itself, which is what the row below catches. |
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
   agree: the three manifests and their three lockfiles, all four Dockerfiles'
   default build argument, the chart's `appVersion`, the constant the MCP server
   reports, the product backlog, and the example image tags in the
   split-deployment compose file and the Pulumi README. `tests/version.test.ts`
   checks every one of those against `package.json`, so a location the script
   forgets fails the suite rather than shipping.
2. Date the `## Unreleased` heading in `CHANGELOG.md`, since nothing does that
   for you and the upgrade notes above send people there to read it.
3. Add that release's migrations to the frozen list in `AGENTS.md`. Once an
   image has run one against somebody's data it can never be edited again, and
   the list is what says so.
4. Commit and push that on the default branch.
5. Cut a release on GitHub against tag `v0.2.0`, from the UI or with
   `gh release create v0.2.0`.

Publishing keys off the release itself, not off the tag push, so it runs once
whether the tag existed beforehand or GitHub creates it. The workflow runs the
full verification suite first, refuses to publish if the tag and the manifest
disagree, and then pushes a multi-architecture image to GHCR tagged with the
version. `latest` moves to it unless the release is marked as a prerelease or
the version carries a suffix, in which case only the version tag is published.

If a publish fails for a reason that has nothing to do with the code, run the
release workflow by hand from the Actions tab and give it the tag; it publishes
the same version tag without needing a new release. It leaves `latest` alone
unless you tick the box asking for it, because a run started by hand cannot see
whether the release was marked as a prerelease and should not guess.

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
