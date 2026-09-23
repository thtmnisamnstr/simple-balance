# Upgrades

Everything persistent is in PostgreSQL. The container holds nothing you need to
keep, so upgrading is swapping it for a newer one.

## Before you upgrade to 0.1.7

**This heading is the next release's slot and its number is provisional.** The
release being built is 0.2.0, and this heading is spelled 0.1.7 only because
`tests/version.test.ts` asks for the next _patch_ of whatever `package.json`
currently says. It gets its real number in the cut commit, right after
`npm run set-version` — §Cutting a release, step 2, which also opens the note
for the release after it. Nothing renames it on its own. The content below is
what matters and is written as the work lands, because a note written while a
release is being cut says whatever the person cutting it can remember.

**Nothing about an existing configuration has to change, and the application
refuses nothing 0.1.6 accepted.** Everything added is optional and off unless an
operator sets it.

**One exception, and it is not the application.** If you run
`deploy/compose/compose.distributed.yml`, that recipe bundles its own PostgreSQL
and this release moves it from 16 to 18. A PostgreSQL container cannot read the
previous major version's data directory — it refuses to start and says so — so
this one needs a hand before you pull. The procedure is below.

### What runs automatically

**Three migrations, none of which rewrites a row on a single PostgreSQL, and on
almost every deployment one of them does nothing at all.**

`0022_plans_and_billing.sql` is additive only: five new tables —
`billing_customer`, `billing_subscription`, `billing_override`,
`billing_operation` and `billing_webhook_event` — two new enum types, four
foreign keys onto `auth_user` and one index. It alters no existing table, adds no
column to one, and rewrites no rows, so it completes in the time it takes to
create five empty tables however large your ledger is.

`0023_citus_distribution.sql` **does nothing at all unless your database has the
Citus extension installed**, which is the `ha` profile and nothing else. It is
gated on that extension at the top and returns immediately without it, so a
deployment on one PostgreSQL records it as run and keeps exactly the schema it
had. A second gate stops it on a ledger that is already distributed and says so,
which matters because the runbook invites you to run this file by hand. Verified
on PostgreSQL 15 and 18, from an empty database and from one 0.1.6 left:
twenty-five migrations recorded, and every primary and foreign key exactly as
`0022` left it.

On a Citus cluster it is the substantial one. It rewrites fourteen primary keys to
carry the owner, which rebuilds every index on them; drops five unique
constraints the new key makes redundant; and moves the ledger's seventeen tables
onto the workers while fourteen are replicated to every node. It runs as one
transaction — it either distributes everything or changes nothing — and it takes
a lock on `posting` for the duration. **Take a dump first**, and read
`docs/citus-runbook.md` §Moving an existing database onto a cluster before you
start, because a database that was already on this release when Citus arrived has
this migration recorded and will not run it again.

**And raise the startup budget before the first start**, which is the part that
bites without explaining itself. The chart's startup probe allows five minutes; a
migration that takes longer is killed mid-flight, rolls back, restarts and is
killed again, forever, with each event looking like a slow start rather than a
budget that is too small. `docs/citus-runbook.md` §Before the first start against
a cluster has the one values change that prevents it.

`0024_active_accounts.sql` adds one column, `ledger_account.active`, with a
constant default of true. A constant default rewrites no rows on any PostgreSQL
this release supports, so it is one catalog change however many accounts there
are, and on a cluster Citus carries it to the shards with no gate of its own.
Every account you already have arrives marked active, which is right: the column
records which accounts somebody chose to keep using on a limited plan, and
nobody has been asked yet. Nothing is frozen on a deployment that sells nothing,
whatever the column says.

### What you must do by hand

Nothing is required. A deployment that sets none of the new variables sells
nothing, limits nobody, shows no advertising, and opens no connection to Stripe
— which is what an untouched `.env` keeps doing.

**If you run `deploy/compose/compose.distributed.yml`, move its database to
PostgreSQL 18 before you pull.** This does not apply to the single container, to
the `single` profile, or to anyone pointing `DATABASE_URL` at a database they run
themselves — those connect to whatever you already have, and the floor is still
PostgreSQL 15. It applies to the one recipe that ships a `postgres` service.

Two things changed in it: the image is `postgres:18`, and the data volume is
mounted at `/var/lib/postgresql` rather than `/var/lib/postgresql/data`, because
PostgreSQL 18's image moved `PGDATA` into a versioned subdirectory. Starting 18
against the old mount point fails immediately with a message naming both facts,
which is the good failure — nothing starts empty and nothing is overwritten.

Dump, recreate, restore:

```sh
cd deploy/compose
# Every command below is about this one file, and the directory holds more
# than one, so it is named once here rather than on every line. Without it the
# first command fails with "no configuration file provided" — after the shell
# has already created an empty simple-balance-16.dump.
export COMPOSE_FILE=compose.distributed.yml
# 1. With the OLD compose file still checked out, take a dump. `-T` matters:
#    without it compose allocates a TTY and the dump arrives corrupted.
docker compose exec -T postgres \
  pg_dump -U simple_balance -Fc simple_balance > simple-balance-16.dump

# 2. Check the dump BEFORE destroying anything. A failed pg_dump still leaves a
#    file behind, and the next step is irreversible. This lists the objects in
#    the archive and exits non-zero if it cannot read it.
pg_restore --list simple-balance-16.dump > /dev/null && \
  echo "dump OK: $(wc -c < simple-balance-16.dump) bytes"
#    No pg_restore on the host? Ask the new image instead:
#    docker run --rm -i postgres:18 pg_restore --list < simple-balance-16.dump >/dev/null

# 3. Stop everything and discard the old data directory. `postgres-data` is the
#    only volume this file declares, so -v takes that and nothing else. Do not
#    run this until step 2 printed OK.
docker compose down -v

# 4. Pull this release, which brings up an empty PostgreSQL 18.
git pull && docker compose up -d postgres
#    `-h 127.0.0.1` matters here as much as `-T` did above: the entrypoint runs a
#    temporary server while it initializes, and that one answers on the unix
#    socket alone. Without it this loop finishes against a server about to be
#    replaced, and the restore below meets `the database system is shutting down`.
until docker compose exec -T postgres \
  pg_isready -h 127.0.0.1 -U simple_balance -d simple_balance
do sleep 1; done

# 5. Restore.
docker compose exec -T postgres \
  pg_restore -U simple_balance -d simple_balance --clean --if-exists \
  < simple-balance-16.dump

# 6. Build this release and bring the rest up. `--build` is what replaces the
#    images the previous release built here; without it they are reused, 0.1.6
#    starts against the restored data, and nothing says so. Migrations run at
#    startup as they always do. (If you swapped in the commented `image:`
#    lines instead, move their tags to this release.)
docker compose up -d --build
```

Keep the dump until you have signed in and seen your balances. `docs/upgrades.md`
§Rolling back applies unchanged: going back means restoring that dump into a
PostgreSQL 16 container, because 16 cannot read an 18 data directory either.

**`pg_dump` rather than `pg_upgrade --link`**, and the reason is collation. The
old image was `postgres:16-alpine`, which is musl, and the new one is Debian,
which is glibc; the two do not sort text the same way, and this product compares
normalized category and payee names with the database's collation.
`pg_upgrade` carries indexes across as bytes, so a `--link` upgrade would leave
every text index sorted under the old library and a uniqueness check quietly
reading the wrong page. A dump and restore rebuilds them under the collation the
new server actually has. If you would rather stay where you are, pin
`image: postgres:16-alpine` and the old mount path in your own copy of the file;
nothing in this release requires 18.

**One thing is worth doing, if you run the split containers behind anything
that terminates TLS**, which under Kubernetes is always. Set
`SB_TRUSTED_PROXY_CIDR` on the frontend — `frontend.trustedProxyCidr` in the
chart — to the range that terminator connects from.

Without it the frontend tells the API that every request came from the
terminator, so with `TRUST_PROXY` on, every sign-in attempt in the deployment
counts against one allowance and four wrong passwords from anywhere lock out
everybody else. That has been true since 0.1.0; what is new is that it can now
be fixed with a setting instead of by editing the nginx template and rebuilding
the image. The chart prints a warning while it is unset and `config.trustProxy`
is on.

Name the terminator's range and nothing wider. This decides whose word is taken
for a visitor's address, so a range that includes callers lets a caller choose
their own. `docs/deployment-profiles.md` has the reasoning and the measurement.

The `aws` and `gcp` Pulumi programs pass it through as
`simple-balance:trustedProxyCidr`, and on neither cloud is the setting the whole
answer as those programs build it: AWS's network load balancer does not hand the
visitor's address on to the ingress, and Google's appends its own after it.
`deploy/pulumi/README.md` §Things that will surprise you says what else each
needs.

**Two new deployment profiles exist, and neither is anything you have to do.**
`vps` is a machine per service with the database among them
(`deploy/compose/vps/`); `ha` is a Kubernetes cluster whose database is sharded
with Citus (`deploy/helm/`, with `database.enabled`). Both are new shapes rather
than changes to yours: the chart still expects a `DATABASE_URL` you supply unless
you ask it for a database, and it refuses to render if you set both.
`docs/deployment-profiles.md` compares the three and says plainly that `single`
is still the one to pick unless you have a reason. `single` is the shape one
container has always been; what is new there is a recipe for it —
`deploy/compose/single/`, `deploy/systemd/`, and the `aws-single` and
`oci-single` Pulumi programs — which you can adopt or ignore.

### What changed under you

The bundled PostgreSQL in `deploy/compose/compose.distributed.yml` moved from 16
to 18, which is the one change in this release that an operator cannot ignore;
everything else here is opt-in. `docs/deployment-profiles.md` has the reasoning,
and the short version is that where a deployment owns its database it runs the
newest version the `ha` cluster can also run.

Otherwise no setting changes meaning unless you opt in. `SB_TRUSTED_PROXY_CIDR`
defaults to `127.0.0.1`, which is the off position rather than a trusted range —
nothing reaches the container from loopback — so a deployment that sets nothing
behaves exactly as it did before the setting existed. Two new settings groups
exist and both default to absent: the five `STRIPE_*` settings with
`SB_BILLING_ENABLED`, and the `ADSENSE_*` settings. `docs/monetization.md` has
the table of what each combination turns on. Two names join the seven that
already take a `_FILE` form, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`,
taking that list to nine.

**Some sentences an agent reads changed, and nothing it sends or receives
did.** A handful of tool descriptions now say "every two weeks", "Monday through
Friday", "at once" and "one-time" where they used British wording, and
`set_active_accounts` is new and annotated destructive, so a client may ask the
person before it runs. No tool, argument, field or stored value was renamed or
removed. A prompt or a test of your own that quotes a description word for
word is the one thing that notices.

**If you run your own copy of a compose file, take this release's.** Every
compose shape now passes `DIRECT_DATABASE_URL` through to the application, which
the split recipe never did — so a pooled deployment that set it got no bypass
and no word about it — and passes the new `PRIVACY_POLICY_URL`, without which a
deployment that turns AdSense on refuses to start. An older copy drops both in
silence.

**The split deployment has four new frontend settings.** nginx serves the
application shell in that shape, so it — not the API — decides the headers each
page arrives with. Two of them are the ones easiest to miss, because no
`.env.example` carries them: `SB_BILLING_CONFIGURED` and `SB_ADS_CONFIGURED`
default to false, which is exactly today's behavior. Set Stripe on the server
without the first and the plan tab opens with no card fields; set AdSense
without the second and no ad renders. The compose recipe derives both from
settings you are already providing, and so does the Helm chart:
`SB_BILLING_CONFIGURED` is on when `config.extraEnv` carries a non-blank
`STRIPE_PUBLISHABLE_KEY` or `frontend.billingConfigured` is true, and
`SB_ADS_CONFIGURED` the same way from `ADSENSE_CLIENT_ID` and
`frontend.adsConfigured`. Set a switch by hand only where its key lives in an
`existingSecret`, which the render never sees. Only a hand-assembled deployment
has to set both itself. The other two are `SB_TRUSTED_PROXY_CIDR`, above, and
`SB_CSP_REPORT_ONLY`, the plan tab's rehearsal, which the frontend needs as well
as the server. `docs/deployment.md` lists all seven frontend settings.

**If you do turn advertising on**, know what the policy costs before you do.
AdSense publishes no list of the hosts it loads from, so every page but the plan
tab then allows scripts, frames, styles, fonts and connections to any HTTPS
origin, plus `unsafe-eval`. Those pages also send `Referrer-Policy:
strict-origin-when-cross-origin` rather than `same-origin`, because Google's
consent message does not serve under `same-origin`: another origin is told this
site's address and never a page's path. Ads are never shown to a paying account,
never on the plan and billing tab, never on sign-in and never on paper, and the
publisher id is the only identifier of yours that leaves — but the address of
the page an ad sits on goes to Google too, and this app's addresses name
records.

An ad is shown only where a plan is for sale, so AdSense without
`SB_BILLING_ENABLED=true` and Stripe widens the policy, serves `/ads.txt`, and
shows nobody an ad — the process says so at startup rather than refusing.
`PRIVACY_POLICY_URL` is required beside the AdSense ids. `docs/monetization.md`
has the checklist, in order, of what is yours to do at Google and here.

**If you do turn billing on**, `docs/billing-operations.md` is the page to read
first: setting up the Stripe account in order, going live from test mode,
granting a plan by hand, what a refund does and does not change, what
`SB_BILLING_ENABLED=false` stops and what it deliberately does not, and the
order to shut billing down in.

**Know what it does to anybody who already has more than three accounts,
because it happens the moment the process starts.** `SB_BILLING_ENABLED=true`
puts everybody without a subscription or an override on the free plan, and the
free plan keeps three accounts in use. Nobody at or under three notices
anything. Above it, nothing is archived, hidden or deleted: every account stays
listed, readable, and counted in every balance, report and export. But only three
stay usable — the three oldest, until the person makes their one-time choice on
the Accounts page, or an agent makes it with `set_active_accounts` — and the
rest are frozen. A frozen account refuses every write: a new entry, an edit, a
delete, a rename, and a payee or category merge that would touch it, which
refuses whole. A staged or imported row that names one gets an issue instead of
committing. Nothing is frozen while billing is off.

So before you set it, give everybody who should keep every account — yourself
included — an override. `docs/billing-operations.md` §Granting a plan by hand
has the statement, and `docs/monetization.md` has the whole rule, including why
the choice is made only once.

### What to check afterwards

`docs/capacity.md` is new and changes nothing about an upgrade, but it is the
answer to the question an operator asks before a big import or a second
household: one machine of the smallest size the `single` profile sells holds ten
thousand ledgers and thirty million transactions inside the stated times.
`scripts/capacity/README.md` reproduces it against your own hardware.

`/health/ready`, as with any upgrade. If you set the Stripe or AdSense
variables, the process refuses to start on a half-configured pair and names the
missing half, so a clean start is itself the check.

If you turned billing on, four more. **Read the log for the prices first.** Both
price ids are checked against Stripe when the API and the scheduler start, again
at most every ten minutes when they are read, before every subscription is
started, and on every reconciliation sweep — and the first check that succeeds
says `Stripe is configured, and both prices fit the plans they are sold as.` A
price that does not fit is an error line saying what is wrong with it, and until
it is fixed nothing is for sale: the plan tab offers no plan, and starting a
subscription answers `409` and charges nobody. Replacing a card, canceling,
paying a renewal's open invoice and letting go of a switch still waiting for the
renewal keep working, because none of them sells anything.
`docs/billing-operations.md` §Setting up Stripe says what the two prices have to
be.

`SB_CSP_REPORT_ONLY=true` is worth one pass before you rely on the plan tab: it
makes that page report what its content security policy would have blocked
instead of blocking it. The policy is Stripe's published Stripe.js and Link
sets plus four hosts this project added, and whether a live account contacts
those four has not been observed by anybody yet, so the pass is where the answer
shows up — in your log, rather than as a payment form that will not load. It
covers that page and no other: every page that can carry an ad goes on
enforcing, and what the ads policy refuses is read from the browser console
instead (`docs/monetization.md`). Turn it off again — the process warns at every
start while it is on.

Then two more. Open `/settings/plan` and confirm the two
prices show the figures you set in Stripe — they are read from Stripe rather than
from your settings, so a blank there means this deployment could not reach it.
And point a Stripe webhook endpoint at
`https://your-host/api/billing/webhook`, subscribed to the event types
`docs/deployment.md` lists — the selection is Stripe's and this deployment
cannot see what you chose, so an endpoint subscribed to the wrong set fails
silently. A test delivery answering `200` with `{"received": true}` means the
signature verified; it does not mean the subscription is right, because that is
also what an event with no opinion returns. A `404` there means the `STRIPE_*`
settings did not reach the container, because the route is registered only when
they did.

## Before you upgrade to 0.1.6

Nothing refuses to start that 0.1.5 accepted, and nothing about an existing
configuration has to change. Five things are worth knowing.

**It closes twenty-seven dependency advisories**, eleven of them rated high, in
`fast-uri`, `js-yaml`, `nodemailer`, `hono` and `qs`. Nothing about this needs
an action from you — they ship inside the image — but it is the strongest reason
to take this release rather than stay where you are. The Node base image moves
to the current `24-alpine` build for the same reason; the major stays at 24, so
nothing about the runtime changes under you.

**Nine migrations run at startup, and none rewrites a row.** They create the
budget tables, the category-group table and the types they use; they add
columns to `budget_plan`, `budget_entry`, `category` and `ledger_account` —
every one nullable or with a default, so nothing is backfilled; they add
indexes, including one on `idempotency_record.created_at` for the retention
sweep below; one swaps a check constraint on the new budget tables for a wider
one and another trades two unique constraints for partial unique indexes,
touching no data because the tables they sit on ship in this same release. The pause is the length of a handful of `create table`,
`alter table` and `create index` statements whatever the size of your ledger.
The one new column on an existing table anybody will notice is
`ledger_account.in_budget`, which defaults to true: every account you already
have is inside the budget's perimeter, which is what the budget page assumes
until you say otherwise.

**Settings that used to fail in silence now say so, and one that refused now
warns.** A bounded integer out of range — `CSV_MAX_ROWS=50000`,
`RECURRENCE_TICK_SECONDS=0`, and the three other bounded numbers beside them —
used to fall back to its default without a word. It still starts the container
and still runs on the default, but it now names itself in the log with the
value it was given and the number in force instead. So does a name set both
ways, such as `DATABASE_URL` beside `DATABASE_URL_FILE`, where the environment
variable wins as it always did. `DATABASE_POOL_SIZE` moved the other way:
0.1.5 refused to start over an out-of-range value, and this release starts,
warns, and runs on the default, so a container that would not boot yesterday
boots today. An empty value stays as quiet as ever on purpose, because
`.env.example` ships blanks and a blank means the default. If you have been
carrying one of these, this release tells you so for the first time; the
release that refuses it is a later one.

**Four `/api/v1` paths were renamed and the old spellings still answer.**
`POST /accounts/{id}/archive` is now `/archived`, `POST /categories/{id}/archive`
is now `/archived`, `POST /staged-transactions/delete` is now `/bulk-delete`, and
`GET /staged/{id}/duplicate` is now `/staged-transactions/{id}/duplicate`. The old
paths carry `Deprecation` and `Sunset` headers and stop answering after March 1, 2027. Nothing you run needs changing today; a browser tab left open across the
upgrade keeps working.

**An agent's arguments are checked more strictly.** Every MCP tool now declares a
closed argument object, so a tool call carrying a field the tool does not declare
comes back as an error naming it rather than having the field dropped in silence.
Nothing an agent could successfully do before is impossible now — the dropped
field never had any effect — but a call that returned success may now return a
failure, which is the point: an open object teaches a model that an argument it
invented works.

**New, and off unless you ask.** `METRICS_ENABLED=true` makes both the API and
the scheduler answer `GET /metrics` in Prometheus' format, and `METRICS_TOKEN`
puts a bearer token in front of it. A deployment that sets neither has no such
route and nothing changes. `LOG_LEVEL` now governs this application's own log
lines as well as the auth library's, so `warn` and `error` are quieter than they
were; the first-run setup code prints at every level.

**Used idempotency keys can be pruned now, and are not pruned unless you ask.**
`IDEMPOTENCY_RETENTION_HOURS` sets how long a used key keeps replaying, and it
defaults to zero, which means forever — exactly what every release before this
one did. Nothing about your data changes on upgrade. Set it if the table has
grown: every create, commit and bulk write stores a copy of its response there,
and on a busy deployment it outgrows the ledger it protects. It is safe to set
because the record makes a retry _quiet_ rather than safe — a repeated create
still meets the duplicate check, a repeated commit finds its rows already
committed, and a repeated bulk write still carries a count and fingerprint that
no longer match. The sweep rides the recurrence scheduler's tick, so it needs
`RECURRENCE_SCHEDULER` on somewhere, and it removes a bounded batch per pass so
a first sweep after a year drains rather than locking the table.

**Pagination cursors are signed now, and 0.1.5's are still accepted.** A
`nextCursor` this release hands out carries an HMAC keyed to your
`AUTH_SECRET`, so a cursor cannot be hand-built and a client cannot come to
depend on what is inside one. Nothing you do changes: a cursor a 0.1.5 client is
still holding when you swap the container keeps working, which is what makes
this safe to deploy while somebody is halfway down a list. **The unsigned form
stops being accepted on March 1, 2027**, which is the same date the four renamed
paths above stop answering — one date for everything this release deprecates —
and by then no build in the field will be issuing one. Two consequences worth knowing: replacing `AUTH_SECRET`
invalidates every outstanding cursor along with every session, so whoever is
mid-list starts again from page one — which is the same thing a sign-out already
does to them; and every replica needs the same `AUTH_SECRET`, which is already
true of everything else.

## Before you upgrade to 0.1.5

Nothing refuses to start that 0.1.4 accepted, and nothing about an existing
configuration has to change. Five things are worth knowing.

**Five migrations run at startup.** One adds the reminders table and one column
on `recurrence`, defaulting to off, so no recurrence you already have starts
emailing you. One adds a one-row table holding the first-run setup code, which
matters only on a deployment that has never been set up. One adds a `theme`
column defaulting to `system`, which is a constant default and therefore
metadata-only — no table rewrite, and every existing account lands on "follow the
machine", which is what it should be. One drops four indexes whose leading column
another unique constraint on the same table already leads with; no query loses a
plan, and the statements are `if exists`, so a database restored from a dump that
never had them upgrades cleanly. The fifth adds two indexes on the expression
payee names are compared by, which is what keeps every transaction write from
scanning your own rows to find the spelling already on file — on a large ledger
that one takes a moment to build while the container starts, before it opens
readiness.

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
grays carrying real text were below the contrast a person needs to read them —
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

| If your configuration has                                                            | 0.1.4 does                                                                                      | What to do                                                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET` still set to the placeholder `.env.example` shipped                    | Refuses to start, naming the variable                                                           | Generate one: `openssl rand -base64 32`                                                                               |
| `NODE_ENV` set to anything but `production`, `development` or `test`, empty included | Refuses to start                                                                                | Set `NODE_ENV=production`. The images already do.                                                                     |
| `NODE_ENV` unset                                                                     | Reads as `development`, so the setup code, sign-in rate limiting and secure cookies are all off | Set `NODE_ENV=production`. Unset is the one value that does not announce itself, which is what the row below catches. |
| `NODE_ENV` not `production` while `APP_BASE_URL` names anything but localhost        | Refuses to start                                                                                | Set `NODE_ENV=production`, and give `APP_BASE_URL` the HTTPS origin your proxy terminates                             |

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

### Rolling back from 0.2.0

Three of this release's changes decide how far back you can go, and they are
different for each profile. The short version: **on `single` and `vps` a
rollback is the ordinary restore above; on `ha` it is not a rollback at all.**

**`single` and `vps`.** `0022` is additive — five tables the older image does not
read — and `0024` adds one column the older image never names: its inserts leave
`ledger_account.active` to the default and nothing it reads mentions it. So
0.1.6 runs against a 0.2.0 schema unchanged. `0023` did nothing on these
profiles. You can put the older image back without restoring anything, and the
five billing tables and the new column sit unread until you upgrade again. The
one thing to undo separately is the compose recipe's PostgreSQL version if you
moved it: a 16-series container cannot read an 18-series data directory either,
so going back there is a dump and a restore in the other direction.

**`ha` cannot be rolled back to 0.1.6 by putting the old image back**, and this
is the one worth knowing before you distribute anything. `0023` widens fourteen
primary keys to carry the owner, and PostgreSQL then refuses a `GROUP BY` that
names only part of a key while the select list reads other columns — which is
what 0.1.6's balances, register, dashboard, category-group and import-batch
queries all do. They were corrected in this release precisely so the widened key
would be safe, and the older image does not have those corrections. It will
start, pass its health check, and fail those five reads.

So rolling back an `ha` deployment means restoring a dump taken before the
cluster into a single PostgreSQL and running 0.1.6 against that. **Take that dump
before you distribute**, not after: once the keys are widened, every dump you
take carries the widened schema.

**Stripe is outside all of this.** A subscription that exists at Stripe goes on
existing after a rollback, and 0.1.6 has no code that knows about it — nobody is
charged differently, and nothing is lost, but the deployment stops reflecting
what Stripe thinks. If the rollback is permanent, cancel the subscriptions at
Stripe rather than leaving them to renew against a product that no longer reads
them.

## Cutting a release

`docs/acceptance.md` is the list of what this release claims and what closes
each claim, with a second table of what is outstanding. Read that before the
steps below: three of its open rows are gates that no amount of work in this
repository closes.

1. `npm run set-version 0.2.0`, which sets the version in the twenty-two files
   where it has to agree: the three manifests and their three lockfiles, all
   four Dockerfiles' default build argument, the chart's `appVersion` and its
   own `version`, the constant the MCP server reports, the product backlog, the
   release the three product-kit files in `docs/product/` say they describe,
   and the pinned image tags in the split compose file, the `single` profile,
   the `vps` profile's `compose.app.yml` and `compose.frontend.yml`, the Pulumi
   README and the single-machine Pulumi programs. `tests/version.test.ts` checks every one of
   those against `package.json`, asserts the script names each, and runs the
   script over a scratch copy of the files to prove it rewrites them, so a
   location the script forgets fails the suite rather than shipping.
2. Give this release's upgrade note its number, and open the next one, in the
   same commit. `set-version` does not touch this file, and the moment it has
   run the suite asks for two headings the provisional one cannot supply.
   Rename the provisional `## Before you upgrade to 0.1.7` at the top of this
   file to `## Before you upgrade to 0.2.0` — a prerelease such as `0.2.0-rc.1`
   takes the release's number too, because it upgrades on to the same schema —
   and delete its paragraph saying the number is provisional. Then add
   `## Before you upgrade to 0.2.1` above it, with one paragraph saying nothing
   has landed for it yet: the shape the 0.1.6 cut gave 0.1.7 in `035da59`.

   Skip the renaming when the previous version was a prerelease of this one —
   0.2.0 after 0.2.0-rc.1. That cut already gave the note this release's number
   and opened the next patch's, so renaming the first heading here would turn
   the empty 0.2.1 placeholder into a second `## Before you upgrade to 0.2.0`,
   and `tests/version.test.ts`, which reads the first, would pass on the empty
   copy. Check only that what landed since the prerelease is written under this
   release's heading, then run that test.

   The note itself should already be written: what runs automatically, what an
   operator has to do by hand, what changed under them, and what to check
   afterward. Write it as the work lands rather than here — the suite asks for
   the _next_ version's note as well as this one's, so a release whose note was
   left to the last minute has already been failing. Write it even when the
   answer is that nothing changed, because a missing heading and an unwritten
   note look the same from the outside.
3. Confirm the product kit describes the tree being cut. `set-version` stamps
   the kit's `appVersion` rather than rebuilding it, which is honest only
   because `release-prep` phase 4a rebuilt the kit on this same tree, and a cut
   changes nothing a screen shows. The script cannot tell whether 4a ran, so
   compare the capture with the last change to the browser app, and run the
   `product-kit` skill first if a screen changed after it:

   ```sh
   grep -m1 capturedAt docs/product/screenshots.json
   git log -1 --format='%cs %h %s' -- src/client
   npx vitest run tests/product-kit.test.ts tests/product-facts.test.ts tests/version.test.ts
   ```

4. Date the `## Unreleased` heading in `CHANGELOG.md`, since nothing does that
   for you and the upgrade notes above send people there to read it.
5. Add that release's migrations to the frozen list in `AGENTS.md`. Once an
   image has run one against somebody's data it can never be edited again, and
   the list is what says so.
6. `npm run verify`, then commit and push on the default branch. The publish
   runs the same suite first, so a failure here is one the release would have
   met anyway.
7. Cut a release on GitHub against tag `v0.2.0`, from the UI or with
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
unless you check the box asking for it, because a run started by hand cannot see
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
  contents afterward.

Migrations run inside the application rather than as a separate step because
that is what makes an upgrade one action. Swap the image, start it, and the
database catches up on its own.
