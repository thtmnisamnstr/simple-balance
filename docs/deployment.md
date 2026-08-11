# Deployment

Simple Balance is one container and one PostgreSQL database. There is no Redis,
no sidecar, no object store, and nothing it needs to write to disk.

PostgreSQL 15 or newer. Every release is tested against 15 and 16, on Node 22
and 24. Nothing else is assumed about the server.

## Settings

Everything is an environment variable. `.env.example` has the lot; these are the
ones that matter.

### Required in production

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 15+ connection string. Encrypt it when the database is not on the same host; see TLS below for which `sslmode` to use. The database it names is created if the server does not have it yet. |
| `AUTH_SECRET` | At least 32 random characters. `openssl rand -base64 32`. Keep it: changing it signs everyone out. |
| `APP_BASE_URL` | Your canonical public origin, exactly as the browser sees it. HTTPS anywhere but localhost. |

`APP_BASE_URL` is load-bearing beyond cosmetics: secure cookies, the OAuth
issuer metadata, redirect validation, and the audience on MCP tokens are all
derived from it. Get it wrong and sign-in fails in ways that look unrelated.

So is `NODE_ENV`, which the images set to `production` for you and which you
have to set yourself if you run the built server directly with `npm start`.
Anything other than `production` means the first-run setup code is not demanded,
sign-in attempts are not rate limited, and cookies are not marked secure. The
server says so loudly at startup, because those three together are the
difference between a deployment and a development machine.

### Optional

| Variable | Default | What it does |
| --- | --- | --- |
| `AUTH_MODE` | `local` | Which sign-in methods are offered. See below. |
| `ALLOWED_EMAILS` | unset | Who may register. Unset admits nobody but the first account. See below. |
| `SETUP_TOKEN` | generated | The one-time code that claims a fresh instance. Left unset, one is generated and printed to the startup log. |
| `PORT` | `3000` | The port inside the container. Change it and your published port mapping has to follow. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `TRUST_PROXY` | `false` | Turn it on when a reverse proxy sits in front and replaces `X-Forwarded-For`. See the reverse proxy section; getting it wrong costs per-visitor rate limiting. |
| `DATABASE_POOL_SIZE` | `10` | Connections held open. Raise it only if you have measured contention. |
| `CSV_MAX_BYTES` | `10485760` | Largest CSV accepted for import, 10 MB by default. Ceiling 104857600. |
| `CSV_MAX_ROWS` | `10000` | Most rows accepted from one CSV. Ceiling 10000, which is also the most rows one mass edit, commit, or delete covers, so an import always fits in a single review-queue action. |
| `RECURRENCE_SCHEDULER` | `true` | Whether this process proposes recurring transactions. Turn it off on replicas that serve the API when a separate scheduler container owns the job. A value other than `true` or `false` refuses to start, because the wrong setting is otherwise silent. |
| `RECURRENCE_TICK_SECONDS` | `300` | How often it looks for a recurrence that has come due. Latency only: whatever a missed tick leaves behind, the next one catches up. Ceiling 3600. |
| `RECURRENCE_CATCH_UP_LIMIT` | `50` | Most occurrences one recurrence catches up in one tick. Nothing is dropped; a tick that hits the cap comes straight back rather than waiting out the interval. Ceiling 500. |
| `RECURRENCE_CLAIM_LIMIT` | `500` | Most recurrences examined in one tick. Ceiling 5000. |

Each of the five above is a whole number between 1 and the ceiling shown.
Anything else, whether a word, a zero, a negative or something past the ceiling,
falls back to the default rather than being clamped or refused, so a typo gets
you the default rather than a value you did not intend. `DATABASE_POOL_SIZE` is the
exception and refuses to start, because a wrong pool size is not something to
discover later.

### Limits you cannot change

These are compiled in rather than configured, because each one bounds something
a person or an agent could otherwise use to fill the database. They are here so
a refusal is explainable rather than surprising.

| Limit | Value | What hits it |
| --- | --- | --- |
| Rows in one mass edit or mass delete | 10,000 | A selection larger than this is refused rather than truncated. Split the work across calls; each one stands or falls on its own. |
| Category legs on one transaction | 50 | Far past a receipt anybody itemises by hand. A split is the whole counter-side of the entry rewritten, so the cost is paid on every read of it. |
| Recurring transactions per person | 200 | Each one is a standing instruction that proposes rows on every tick, so an uncapped list is a way to flood the review queue with nothing but `ledger:write`. |

### Only for Google sign-in

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Google modes refuse to start
without them, and without an `ALLOWED_EMAILS` that admits somebody, rather than
silently letting everyone in.

## Reaching the database over a network

A database on another host should be reached over TLS, or the password and every
row of the ledger cross the network in the clear. Which `sslmode` to put in
`DATABASE_URL` depends on who signed the server's certificate.

| `sslmode` | Encrypted | Certificate checked | Use it when |
| --- | --- | --- | --- |
| omitted | No | n/a | The database is on the same host, or reached over a private network you trust. |
| `no-verify` | Yes | No | The server presents a certificate it signed itself, which a self-hosted PostgreSQL usually does. |
| `verify-full` | Yes | Yes | The server has a certificate from a CA the container already trusts, such as a managed database. |

Do not reach for `require`. In libpq it means "encrypt and do not check the
certificate", and it is the setting most people try first, but node-postgres
does check the certificate, so against a self-signed server it fails with
`DEPTH_ZERO_SELF_SIGNED_CERT` and Node advises installing a root CA that does
not exist. The server refuses to start and says which setting to use instead.

`no-verify` is a real improvement on no TLS at all: the connection is encrypted,
so nothing on the network can read it. It cannot tell you that the host
answering is the host you meant, so on a network where somebody could stand in
the middle, put the server's CA where the container trusts it and use
`verify-full`.

## Who may register

`ALLOWED_EMAILS` decides who can create an account. It is a comma-separated
list, matched case-insensitively, and each entry is one of:

| Entry | Admits |
| --- | --- |
| `you@example.com` | That address, and only it. A plus tag is a different address. |
| `example.com` | Anybody at that domain. |
| `@example.com` | The same thing, written the way people often expect. |
| `*` | Anybody at all. |

A domain matches only itself. Allowing `example.com` does not allow
`someone@mail.example.com`, because a subdomain is a different domain and may be
under somebody else's control.

Leaving `ALLOWED_EMAILS` unset admits nobody. That is what makes an
unconfigured deployment a private one: the person who claims it with the setup
code gets an account, and nobody else can register. Set the variable when you
want to let other people in.

Every account is separate. Two people on one deployment cannot see each other's
accounts, transactions, categories, payees, or totals, and neither can name the
other's records by id.

### What the list does and does not do

The list decides who may *open* an account. It has no say after that. Somebody
you remove keeps the account they already have, along with everything in it,
because the alternative would mean an unset list locked every existing user out
of their own books. To remove somebody, delete their account, which takes their
data with it.

A domain entry is only as strong as the proof behind the address. In `google`
mode it is strong: Google has confirmed the address before it reaches us, and an
unconfirmed claim is refused. In local password mode it depends on whether this
deployment can send mail. With SMTP configured, a new account has to open a link
sent to the address before it can be signed in to, so `pinecone.io` means
somebody who can read mail at that domain. Without SMTP nothing is confirmed,
and the entry is a statement about who you expect to find the deployment rather
than proof of anything.

## Sign-in modes

`local` is the default and needs no Google configuration at all.

`google` allows Google accounts that `ALLOWED_EMAILS` admits.

`both` offers either. To use both for one account, create the local account
first, sign in with it, then use **Connect Google** in Settings. That link is
explicit on purpose: two accounts sharing an email address are not assumed to be
the same person.

For either Google mode, register this exact redirect URI on the Google OAuth web
application:

```text
https://simple-balance.example.com/api/auth/callback/google
```

Simple Balance asks Google for `openid`, `email`, and `profile`, and nothing
else. Keep the client secret out of the image.

## Passwords and the first account

The logs print a one-time setup code the first time a deployment starts with no
accounts in it. Whoever holds that code can create an account the registration
rule would otherwise turn away, which is what makes an unconfigured deployment
usable at all. It stops working the moment an account exists. Set `SETUP_TOKEN`
yourself if you would rather choose the code than read it from a log. When
`ALLOWED_EMAILS` already admits the first person, no code is asked for, because
it would guard a door anyone could walk around.

Passwords can be changed from Settings by whoever is signed in. What happens
when one is *lost* depends on whether this deployment can send mail; see below.

Sign-up and sign-in are rate limited to a few attempts per client address every
ten seconds. The count lives in the process's memory, so it resets on restart
and each replica counts separately. Which address they are counted against
depends on `TRUST_PROXY`; see the reverse proxy section.

## Sending mail

Set `SMTP_HOST` and `MAIL_FROM` and two things switch on together: people can
reset a forgotten password, and a new account has to confirm its address before
it works. Leave them unset and neither happens, which is the right answer for a
deployment of one where the password lives in a password manager.

| Variable | Default | What it is |
| --- | --- | --- |
| `SMTP_HOST` | unset | The submission server. Setting it turns mail on. |
| `MAIL_FROM` | unset | The address messages come from. `balance@example.com`, or `Simple Balance <balance@example.com>`. Required alongside `SMTP_HOST`. |
| `MAIL_REPLY_TO` | unset | Where a reply should go, if not to `MAIL_FROM`. Same two forms. |
| `SMTP_PORT` | `587`, or `465` when `SMTP_SSL` is true | |
| `SMTP_SSL` | `false` | True for a connection encrypted from the first byte, which is what 465 expects. False starts on 587 and upgrades with STARTTLS, which is what nearly every provider wants. |
| `SMTP_USERNAME` | unset | Set with `SMTP_PASSWORD` or not at all. |
| `SMTP_PASSWORD` | unset | Never sent unencrypted; see below. |

A password is never sent in the clear. With `SMTP_SSL` false and credentials
set, the STARTTLS upgrade is required rather than merely attempted, so a relay
that does not support it gets an error instead of your password. A connection
with no username and password has nothing to leak on the way, so it is allowed
to proceed unencrypted against a relay on a network you control, and still
upgrades whenever the relay offers to.

Use a **submission** service, not the MX host your domain publishes. An MX
record says where mail *to* your domain is delivered. It does not accept
authenticated submission, does not relay to other domains, and listens on a port
most hosts block outbound, so `aspmx.l.google.com` or `gmr-smtp-in.l.google.com`
will not work here however correct they look in your DNS.

For a domain on Google Workspace, either:

```sh
# One mailbox. Needs 2-Step Verification on that account and then an app
# password, which is not the account password.
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=balance@example.com
SMTP_PASSWORD=the-app-password
MAIL_FROM=Simple Balance <balance@example.com>
```

```sh
# The Workspace relay, which can send as any address in the domain. Turn it on
# first under Apps > Google Workspace > Gmail > Routing > SMTP relay service,
# and authenticate by IP allowlist, by SMTP credentials, or both.
SMTP_HOST=smtp-relay.gmail.com
SMTP_PORT=587
```

Google rewrites `From` to the mailbox that authenticated unless the address is a
verified alias on it, or the relay is set to allow any sender in the domain. If
that leaves messages coming from somewhere nobody reads, set `MAIL_REPLY_TO` to
an address somebody does.

Every link in these messages is built from `APP_BASE_URL`. If it is wrong the
links point somewhere the recipient cannot use, and there is nothing they can do
about it from their end.

The connection is opened once at startup so a wrong setting is reported in the
log rather than discovered by somebody locked out. A refusal is logged and the
server carries on, because the ledger works whether or not mail does. Reset and
verification links last an hour. A reset link is consumed the moment it is
used, so it works once. A verification link is a signed token rather than a
stored one, so it keeps working for the rest of its hour; opening it only
confirms the address, and signing in still takes the password.

### With no mail server

Nobody can reset a forgotten password, and recovering one means editing the
database. Accounts are usable the moment they are created because nothing is
waiting to be confirmed. On a deployment with more than one person, say that
before they sign up rather than after.

Accounts created while no mail server was configured keep working if one is
added later. They were admitted under the rules that applied at the time.

## Running it

```sh
docker run -d --name simple-balance --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  ghcr.io/thtmnisamnstr/simple-balance:latest
```

The container runs as a non-root user and the filesystem can stay read-only. Bind
to loopback and put a reverse proxy in front rather than publishing the port.

## Reverse proxy

Terminate TLS at the proxy and forward the original scheme and host.

```caddyfile
simple-balance.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # $remote_addr, not $proxy_add_x_forwarded_for. The latter appends to
    # whatever the client sent, which both lets a client put an address of its
    # choosing at the front of the list and produces a chain nothing downstream
    # can resolve to one caller.
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Then set `TRUST_PROXY=true`. Sign-in attempts are counted per client address,
and with this off that address is the far end of the connection, which behind a
proxy is the proxy itself for every visitor. Everybody would share one
allowance, and one stranger could spend it for the rest. The server says which
of the two it is doing when it starts.

Only leave `TRUST_PROXY` off when the application is reached directly, or when
the proxy in front passes through `X-Forwarded-For` rather than replacing it.
With it off, an address a caller made up is ignored in favour of the connection
they actually opened; with it on and a proxy that appends, a caller can put
whatever they like at the front of the chain.

## Starting from nothing

Point Simple Balance at a PostgreSQL server and it takes care of the rest. If
the database named in `DATABASE_URL` does not exist, it is created; if it exists
but is empty, the schema is built; if it is already up to date, nothing happens.
That is true however you run it, whether that is the container, `npm start`, or
`npm run dev`, because all of them go through the same startup step.

```sh
docker run -d --name simple-balance \
  -e DATABASE_URL='postgresql://postgres:secret@db.example:5432/simple_balance' \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e APP_BASE_URL='https://simple-balance.example.com' \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/thtmnisamnstr/simple-balance:latest
```

Creating the database needs the connecting role to have `CREATEDB`, which the
default `postgres` superuser has. Without it you get a message naming the
database and the statement to run, rather than a driver error. Nothing else
about the server is assumed or altered.

## Splitting it into separate containers

One container is the supported way to run this, and the rest of this document
assumes it. If you are running under Kubernetes and want to scale the web tier,
`deploy/docker/` holds three Dockerfiles that split it up. Build them from the
repository root:

```sh
docker build -f deploy/docker/server.Dockerfile -t simple-balance-server .
docker build -f deploy/docker/frontend.Dockerfile -t simple-balance-frontend .
docker build -f deploy/docker/scheduler.Dockerfile -t simple-balance-scheduler .
```

The server image is the API and the MCP endpoint with no browser bundle in it.
A request for a page gets a 404 rather than an application shell it is not the
authority on. It reads the same settings as the single container.

The frontend image is nginx serving the bundle and proxying `/api`, `/mcp`,
`/health` and `/.well-known` through to the server. It listens on **8080**, not
80, because the base image runs as a non-root user that cannot bind a privileged
port. Three settings, all with working defaults:

| Variable | Default | What it does |
| --- | --- | --- |
| `SB_API_ORIGIN` | `http://simple-balance-server:3000` | Where to proxy everything the API owns. Point it at your API Service. |
| `SB_FRONTEND_PORT` | `8080` | The port nginx listens on. Change it and the readiness probe and Service have to follow. |
| `SB_MAX_UPLOAD_SIZE` | `12m` | The largest request body nginx will pass. It has to stay above `CSV_MAX_BYTES` with room for the multipart wrapper, or a CSV the API would accept is refused before it gets there. |

The scheduler image proposes recurring transactions and serves nothing but its
own health checks, so a Service pointed at it by mistake cannot answer an API
request. It runs one entrypoint of its own and always ticks: the
`RECURRENCE_SCHEDULER` flag decides whether the API replicas tick too, and a pod
whose only job is this one would be pointless with it off.

Four things have to line up:

- **`APP_BASE_URL` on the server names the frontend's public origin**, not the
  server's own address. Cookies are set by the API and read by the browser, so
  both have to be reached on one origin, and that origin is nginx.
- **`TRUST_PROXY=true` on the server**, because nginx is now the address every
  connection comes from. Without it every visitor shares one sign-in allowance.
- **`RECURRENCE_SCHEDULER=false` on the server Deployment.** The scheduler
  entrypoint ignores the flag and always ticks, so the only thing left to decide
  is whether the API replicas tick too. Leaving them on is safe rather than
  wrong: one advisory lock lets a single replica tick at a time. It is still
  wasted wakeups on every replica.
- **One scheduler replica.** More is harmless for the same reason, and buys
  nothing.

Each of these processes now opens up to three pooled connections: the
application pool, the auth bootstrap lock, and the scheduler lock. Worth knowing
if you have set `DATABASE_POOL_SIZE=1`.

There is no published image for any of these and no CI that builds them. They
are here for you to build and push into your own registry.

## Health and shutdown

`/health/live` says the process is up. `/health/ready` says configuration, the
database, and the migrations have all succeeded, and stays closed until they
have. Point your orchestrator at readiness.

A process with the scheduler switched off is not an unhealthy one, so readiness
says nothing about it. What tells you the scheduler has stopped is the Recurring
page: a recurrence past its due date with nothing proposed means whatever runs
the schedule is not running.

On `SIGTERM` the process stops accepting connections, closes the HTTP server,
and drains the database pool before exiting.

## Backups

Everything is in PostgreSQL, so backing up the database backs up the product.

```sh
pg_dump --format=custom "$DATABASE_URL" > simple-balance-$(date +%F).dump
```

Restore into an empty database with `pg_restore`. Take a backup before upgrading;
[upgrades](upgrades.md) explains why.

## Upgrading

Pull the new image, stop and remove the container, start it again with the same
command. Migrations run at startup under an advisory lock, so concurrent starts
cannot race each other, and readiness stays closed until they finish.
`npm run db:migrate` is a development convenience, not an operator step. See
[upgrades](upgrades.md).

## Development

```sh
docker compose -f compose.dev.yml up -d
npm run dev
```

Then `npm run dev:client` in another terminal, and open
<http://localhost:5173>. Vite proxies the API, OAuth discovery, health, and MCP
routes to port 3000. No environment variables are needed: create a real account
on the first visit and use it for both the web app and MCP OAuth. Outside
production the API binds to `127.0.0.1`.

The compose file also creates `simple_balance_test` for the integration suite.
