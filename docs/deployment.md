# Deployment

## Authentication modes

`AUTH_MODE` accepts:

- `local` (default): embedded email/password authentication. No Google
  credentials or email allowlist are needed. The first browser visitor needs
  the one-time code printed in the container startup log to create the sole
  local owner account.
- `google`: Google login only. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a
  non-empty `ALLOWED_EMAILS` are required.
- `both`: local and Google login. The local owner email must appear in
  `ALLOWED_EMAILS`, and Google can be connected from Settings so both methods
  resolve to the same user and ledger.

Google modes require a Google OAuth web application with this exact authorized
redirect URI:

```text
https://simple-balance.example.com/api/auth/callback/google
```

`APP_BASE_URL` must be the canonical public origin, matching the browser origin
exactly. Production always requires it, including in local auth mode, because
secure cookies, OAuth issuer metadata, redirect validation, and MCP token
audience checks all read from it. Use HTTPS outside localhost. `AUTH_SECRET` is
also always required in production, and it has to stay stable across restarts. Google requests only
`openid`, `email`, and `profile`; keep its client secret outside the image.

Local authentication does not send verification or recovery email. Keep the
owner password in a password manager. An authenticated user can change it in
Settings.

## Docker

The application image requires an external PostgreSQL 15+ server. It does not
contain or require Redis, an auth sidecar, an object store, or a writable volume.

```sh
docker build -t simple-balance:0.1.0 .

docker run --name simple-balance \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -p 127.0.0.1:3000:3000 \
  -e DATABASE_URL='postgresql://simple_balance:secret@postgres.example:5432/simple_balance?sslmode=require' \
  -e APP_BASE_URL='https://simple-balance.example.com' \
  -e AUTH_SECRET='replace-with-at-least-32-random-characters' \
  -e AUTH_MODE='local' \
  simple-balance:0.1.0
```

Generate `AUTH_SECRET` once with `openssl rand -base64 32` and retain it across
restarts. While local setup is open, the application generates a one-time owner
code and prints it to the startup log. Enter that code on the owner form, or set
`SETUP_TOKEN` to a long value you chose. Invalid codes are rejected before
registration reaches the database. For `google` or `both`, add:

```sh
-e AUTH_MODE='both' \
-e GOOGLE_CLIENT_ID='client-id.apps.googleusercontent.com' \
-e GOOGLE_CLIENT_SECRET='client-secret' \
-e ALLOWED_EMAILS='owner@example.com,partner@example.com'
```

`ALLOWED_EMAILS` is case-normalized. Google modes fail closed at startup if any
Google setting or the allowlist is missing. Choose `both` when the owner should
be able to use either authentication method. Create the local owner first, sign
in locally, then use **Connect Google** in Settings. Explicit linking makes both
methods resolve to the same private ledger; implicit same-email account linking
is disabled.

`TRUST_PROXY` defaults to `false`. Set it to `true` only when every request
reaches the app through a trusted reverse proxy that replaces, rather than
passes through, `X-Forwarded-Host` and `X-Forwarded-Proto`. `APP_BASE_URL`
remains the canonical public origin. `LOG_LEVEL` accepts `debug`, `info`,
`warn`, or `error`.

## Reverse proxy

Terminate TLS at the reverse proxy and forward the original scheme and host. A
minimal Caddy configuration is:

```caddyfile
simple-balance.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

For nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Probe `/health/live` for process liveness and `/health/ready` for database and
migration readiness. The Node process handles `SIGTERM`, stops accepting requests,
closes the HTTP server, and drains its PostgreSQL pool.

For rebuilds and release upgrades, follow [upgrades and schema
evolution](upgrades.md). The application runs migrations automatically before
readiness; `npm run db:migrate` is a development command, not an operator step.

## Local development

```sh
docker compose -f compose.dev.yml up -d
npm run dev
```

Run Vite in another terminal with `npm run dev:client` and open
`http://localhost:5173`. Its development proxy routes API, OAuth discovery,
health, and MCP requests to port 3000. No environment variables are needed:
create a real local owner on the first visit, then use that login for both the
web app and MCP OAuth. The API binds to `127.0.0.1` outside production.
