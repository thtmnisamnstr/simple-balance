# Deployment

Simple Balance is one container and one PostgreSQL database. There is no Redis,
no sidecar, no object store, and nothing it needs to write to disk.

## Settings

Everything is an environment variable. `.env.example` has the lot; these are the
ones that matter.

### Required in production

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Append `?sslmode=require` when the database is not on the same host. |
| `AUTH_SECRET` | At least 32 random characters. `openssl rand -base64 32`. Keep it: changing it signs everyone out. |
| `APP_BASE_URL` | Your canonical public origin, exactly as the browser sees it. HTTPS anywhere but localhost. |

`APP_BASE_URL` is load-bearing beyond cosmetics: secure cookies, the OAuth
issuer metadata, redirect validation, and the audience on MCP tokens are all
derived from it. Get it wrong and sign-in fails in ways that look unrelated.

### Optional

| Variable | Default | What it does |
| --- | --- | --- |
| `AUTH_MODE` | `local` | Which sign-in methods are offered. See below. |
| `SETUP_TOKEN` | generated | The one-time code that claims a fresh instance. Left unset, one is generated and printed to the startup log. |
| `PORT` | `3000` | The port inside the container. Change it and your published port mapping has to follow. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `TRUST_PROXY` | `false` | See the reverse proxy section. Leave it off unless the condition there holds. |
| `DATABASE_POOL_SIZE` | `10` | Connections held open. Raise it only if you have measured contention. |
| `CSV_MAX_BYTES` | `10485760` | Largest CSV accepted for import, 10 MB by default. |
| `CSV_MAX_ROWS` | `25000` | Most rows accepted from one CSV. |

### Only for Google sign-in

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ALLOWED_EMAILS`. Google modes
refuse to start if any of the three is missing, rather than silently letting
everyone in.

## Sign-in modes

`local` is the default and needs no Google configuration at all. The first
person to visit claims the instance with the one-time code from the startup log,
and becomes the sole owner.

`google` allows only allowlisted Google accounts. `ALLOWED_EMAILS` is a
comma-separated list, matched case-insensitively.

`both` offers either, into the same ledger. Create the local owner first, sign in
with it, then use **Connect Google** in Settings. That link is explicit on
purpose: two accounts sharing an email address are not assumed to be the same
person.

For either Google mode, register this exact redirect URI on the Google OAuth web
application:

```text
https://simple-balance.example.com/api/auth/callback/google
```

Simple Balance asks Google for `openid`, `email`, and `profile`, and nothing
else. Keep the client secret out of the image.

Local sign-in sends no email, which means there is no password reset. Put the
owner password in a password manager. It can be changed from Settings by
whoever is already signed in.

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
*replaces* `X-Forwarded-Host` and `X-Forwarded-Proto` rather than passing through
whatever a client sent. If a client can set those headers itself, leave it off.

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
routes to port 3000. No environment variables are needed: create a real owner on
the first visit and use it for both the web app and MCP OAuth. Outside
production the API binds to `127.0.0.1`.

The compose file also creates `simple_balance_test` for the integration suite.
