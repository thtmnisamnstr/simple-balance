# Deployment

Simple Balance is one container and one PostgreSQL database. There is no Redis,
no sidecar, no object store, and nothing it needs to write to disk.

## Settings

Everything is an environment variable. `.env.example` has the lot; these are the
ones that matter.

### Required in production

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Append `?sslmode=require` when the database is not on the same host. The database it names is created if the server does not have it yet. |
| `AUTH_SECRET` | At least 32 random characters. `openssl rand -base64 32`. Keep it: changing it signs everyone out. |
| `APP_BASE_URL` | Your canonical public origin, exactly as the browser sees it. HTTPS anywhere but localhost. |

`APP_BASE_URL` is load-bearing beyond cosmetics: secure cookies, the OAuth
issuer metadata, redirect validation, and the audience on MCP tokens are all
derived from it. Get it wrong and sign-in fails in ways that look unrelated.

### Optional

| Variable | Default | What it does |
| --- | --- | --- |
| `AUTH_MODE` | `local` | Which sign-in methods are offered. See below. |
| `ALLOWED_EMAILS` | unset | Who may register. Unset admits nobody but the first account. See below. |
| `SETUP_TOKEN` | generated | The one-time code that claims a fresh instance. Left unset, one is generated and printed to the startup log. |
| `PORT` | `3000` | The port inside the container. Change it and your published port mapping has to follow. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `TRUST_PROXY` | `false` | See the reverse proxy section. Leave it off unless the condition there holds. |
| `DATABASE_POOL_SIZE` | `10` | Connections held open. Raise it only if you have measured contention. |
| `CSV_MAX_BYTES` | `10485760` | Largest CSV accepted for import, 10 MB by default. |
| `CSV_MAX_ROWS` | `25000` | Most rows accepted from one CSV. |

### Only for Google sign-in

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Google modes refuse to start
without them, and without an `ALLOWED_EMAILS` that admits somebody, rather than
silently letting everyone in.

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
and each replica counts separately. Set `TRUST_PROXY=true` when a reverse proxy
sets `X-Forwarded-For`; otherwise the address is taken from the connection
itself, which a caller cannot choose.

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
verification links last an hour and work once.

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
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Set `TRUST_PROXY=true` only when every request arrives through a proxy that
*replaces* `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` rather
than passing through whatever a client sent. If a client can set those headers
itself, leave it off: with it off the sign-in rate limit counts against the
connection's own address, which is worth more than a header anyone can type.

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

## Health and shutdown

`/health/live` says the process is up. `/health/ready` says configuration, the
database, and the migrations have all succeeded, and stays closed until they
have. Point your orchestrator at readiness.

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
