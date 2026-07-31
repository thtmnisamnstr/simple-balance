# Simple Balance

A modern, self-hosted personal accounting app built around ease of use and safe,
reviewable automation via AI.

Simple Balance tracks Checking, Savings, Debit Card, Credit Card, Cash, Crypto
Wallet, Loan, Investment, Asset, and Liability accounts. Wallets can use popular
crypto assets such as BTC, ETH, SOL, USDC, and USDT. It supports deposits,
withdrawals, same-asset transfers, and per-account conversion transfers with
distinct sent/received amounts. CSV imports are staged for review; direct
transactions and selected staged rows can be committed atomically.

AI and MCP clients use the same scoped, audited ledger services as the browser.
They can prepare work for review, but cannot bypass your authentication,
authorization, duplicate checks, or explicit commit controls.

## Version 0.1.0

This is Simple Balance's first release and database baseline. Its intentionally
focused feature set is:

- Embedded local authentication by default, with optional allowlisted Google
  login; both methods can open the same isolated private ledger
- Account and category CRUD with archive-safe history, duplicate-safe category
  and payee merging, and filtered transaction views for each account, category,
  and payee
- Committed transaction CRUD, soft delete/restore, optimistic concurrency,
  idempotent creation, and atomic mass editing from every transaction view
- Required payees, optional descriptions, and case-insensitive category/payee
  autocomplete while creating or editing transactions
- Dedicated staged queue with validation, duplicate warnings, batch deletion,
  dry-run, and all-or-nothing commit
- Bank CSV detection, mapping, localized date/number parsing, automatic matching
  and creation of categories/payees, preview, staging, duplicate detection, and
  app export/import round trips
- Linkable inclusive date ranges and native-currency dashboard groups
- Append-only web/MCP audit history
- OAuth-protected Streamable HTTP MCP server with read/stage/write scopes
- Audience-bound RS256 MCP access tokens with persistent PostgreSQL signing keys,
  public JWKS, expiry, and underlying token revocation checks
- One non-root, read-only-compatible Docker image; PostgreSQL is the only
  persistent dependency

Scheduled transactions, splits, budgets, tags, reconciliation, attachment
storage, bank sync, global FX/crypto prices, and shared households are outside
the 0.1.0 scope. Crypto wallets track native asset quantities only; they do not
provide market prices, valuation, staking, or blockchain synchronization.

## Run for development

Requirements: Node 22.22.2+, npm 11+, and PostgreSQL 15+.

```sh
npm install
docker compose -f compose.dev.yml up -d
npm run dev
```

In a second terminal, run `npm run dev:client` and open
`http://localhost:5173`. Local development requires no environment variables.
On the first visit, create your local owner account; subsequent visits use that
email and password. Both development servers bind or proxy through loopback.

## Rebuild and run whenever you want

Edits to application code reload automatically. After changing dependencies,
run `npm install` and restart those two development commands. To stop the
development servers, press `Ctrl-C`; to stop only the development database, run
`docker compose -f compose.dev.yml stop`. Do not add `-v` unless you intend to
delete the local development database.

### Self-hosted Docker image

Create a production `.env` from `.env.example`, enter your external PostgreSQL
and public HTTPS values, and generate a persistent secret with
`openssl rand -base64 32`. Google configuration is unnecessary in the default
`AUTH_MODE=local` mode.

```sh
cp .env.example .env
# Edit .env. APP_BASE_URL must be your public HTTPS origin.
docker build -t simple-balance:0.1.0 .
docker run -d --name simple-balance --restart unless-stopped \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --env-file .env -p 127.0.0.1:3000:3000 simple-balance:0.1.0
```

Read the generated one-time owner setup code with
`docker logs simple-balance`, then enter it on the first account-creation screen.
You may instead set `SETUP_TOKEN` yourself. The code is ignored after the owner
exists, so an unclaimed instance cannot be taken over merely because its web
route became reachable.

To rebuild the same source at any time, stop and remove the application
container, rebuild the image, and run the same command. The external PostgreSQL
database is not removed:

```sh
docker build -t simple-balance:0.1.0 .
docker stop simple-balance
docker rm simple-balance
docker run -d --name simple-balance --restart unless-stopped \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --env-file .env -p 127.0.0.1:3000:3000 simple-balance:0.1.0
```

Check startup with `docker logs -f simple-balance` and
`curl -f http://127.0.0.1:3000/health/ready`. On the first visit in local mode,
the app asks you for the startup-log code and creates the sole local owner
account. There is no email-based password recovery, so save its password in a
password manager. Keep the loopback binding and put the documented HTTPS reverse
proxy or a private VPN in front of it; do not publish the container port
directly.

Authentication modes:

- `AUTH_MODE=local` (default) uses only the embedded local account and needs no
  Google settings.
- `AUTH_MODE=google` uses only allowlisted Google login and requires
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ALLOWED_EMAILS`.
- `AUTH_MODE=both` offers both. The local owner email must be in
  `ALLOWED_EMAILS`; connect Google from Settings so either method opens the same
  ledger.

When Google is enabled, configure its callback as
`https://YOUR-DOMAIN/api/auth/callback/google`. See
[deployment details](docs/deployment.md) for authentication, reverse proxy, and
HTTPS guidance.

### Upgrade

Back up PostgreSQL, replace the application container with the image for the
new release, and wait for `/health/ready`. At startup, Simple Balance applies
its versioned database migrations under a PostgreSQL advisory lock before it
becomes ready. Release migrations populate data required by the new schema, so
operators do not run a separate migration command or re-enter ledger data.

Safe automatic upgrades still require internal database migrations whenever a
release changes the schema. They are the mechanism that preserves and
transforms existing data; avoiding them would make upgrades less safe. See the
[upgrade procedure and schema policy](docs/upgrades.md).

Quality gates:

```sh
npm run verify
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test' \
  npm run test:integration
```

## Operations and internals

- [Release history](CHANGELOG.md)
- [Architecture](docs/architecture.md)
- [Deployment and authentication](docs/deployment.md)
- [Upgrades and schema evolution](docs/upgrades.md)
- [MCP scopes and discovery](docs/mcp.md)
- [Ralph build loop](scripts/ralph/README.md)
- [Product stories](tasks/product.prd.json)

## License

Simple Balance is licensed under the
[GNU Lesser General Public License v3.0 only](LICENSE) (`LGPL-3.0-only`).

The project uses a single npm/TypeScript package: React/Vite in the browser,
Hono on Node for JSON/auth/MCP/static routes, Better Auth for embedded local
login, optional Google login, and MCP OAuth, Drizzle for versioned PostgreSQL
migrations, and shared Zod contracts at every external boundary.
