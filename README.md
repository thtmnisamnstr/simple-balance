# Simple Balance

Personal accounting you host yourself, built so an AI agent can do the tedious
parts without being able to do the dangerous ones.

Track checking, savings, credit cards, cash, loans, investments, and crypto
wallets. Record deposits, withdrawals, and transfers, including conversions that
keep the sent and received amounts apart. Bank CSVs land in a review queue
first, so nothing reaches your books until you say so.

The books are double-entry and append-only. Every entry balances to zero in each
currency it touches, corrections are posted rather than typed over, and deleting
something reverses it instead of erasing it. What you did to your ledger, and
when, stays readable.

MCP clients call the same code the browser does. An agent can prepare work and
queue it for review. It cannot get around your sign-in, the scopes you granted
it, the duplicate checks, or the commit step.

## What it does

- **Accounts** for anything you file as an asset or a liability, each in its own
  currency. Crypto wallets hold native quantities; there are no market prices.
- **Transactions**: deposits, withdrawals, and transfers, same-currency or
  converted, with the payee required and everything else optional.
- **Editing in bulk**: change or delete up to 10,000 rows in one atomic request,
  from any transaction view, with a preview of what will be touched.
- **A review queue** for imports, with validation, duplicate warnings, and an
  all-or-nothing commit.
- **CSV import** that detects the format, maps the columns, parses localised
  dates and numbers, and creates categories and payees as it goes. Exports round
  trip back in without loss.
- **Categories and payees** with case-insensitive matching, duplicate detection,
  and merging that rewrites every reference at once.
- **A dashboard** of balances, cash flow, and spending by category, over any date
  range you can link to.
- **Sorting and pagination** on every list, by any column it shows.
- **An audit log** of everything the browser or an agent did.
- **Sign-in** with an embedded local account, optional allowlisted Google, or
  both against the same ledger.
- **An MCP server** over OAuth, with separate read, stage, and write scopes.

Out of scope for now: scheduled transactions, splits, budgets, tags,
reconciliation, attachments, bank sync, market prices, and shared households.

## Run it locally

You need Node 22.22.2 or newer, npm 11 or newer, Docker, and nothing else.

```sh
npm install
docker compose -f compose.dev.yml up -d
npm run dev
```

In a second terminal:

```sh
npm run dev:client
```

Open <http://localhost:5173>. Development needs no environment variables and no
configuration. The first visit asks you to create the owner account; after that
it is the email and password you chose. Both servers stay on loopback.

Code reloads as you edit it. After changing dependencies, run `npm install` and
restart both commands. `docker compose -f compose.dev.yml stop` stops the
database and keeps its data; adding `-v` deletes it.

## Run the tests

```sh
npm run verify
```

That is typecheck, unit tests, and both builds. The integration suite needs
PostgreSQL, which `compose.dev.yml` already gave you along with a separate
database for it:

```sh
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test' \
  npm run test:integration
```

## Host it

Build the image, or pull a published one:

```sh
docker pull ghcr.io/thtmnisamnstr/simple-balance:latest
```

`latest` follows the newest final release. A prerelease tag publishes only its
own version.

Configuration is environment variables. Copy the example and fill it in:

```sh
cp .env.example .env
```

`DATABASE_URL` and `AUTH_SECRET` are required, and `APP_BASE_URL` must be your
public HTTPS origin in production. Generate the secret with
`openssl rand -base64 32` and keep it: changing it signs everyone out. Google
settings are only needed if you turn Google sign-in on.

```sh
docker run -d --name simple-balance --restart unless-stopped \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --env-file .env -p 127.0.0.1:3000:3000 \
  ghcr.io/thtmnisamnstr/simple-balance:latest
```

The container runs as a non-root user and needs no writable volume. PostgreSQL
is the only thing it stores anything in. Keep the loopback binding and put a
reverse proxy or a private network in front of it rather than publishing the
port.

Watch it come up with `docker logs -f simple-balance`, and check
`curl -f http://127.0.0.1:3000/health/ready`. Readiness stays closed until
configuration, the database connection, and the migrations have all succeeded.

The logs print a one-time setup code on first run. Enter it on the
account-creation screen to claim the instance. Set `SETUP_TOKEN` yourself if you
would rather choose it. Either way the code stops working once an owner exists,
so nobody can claim an instance just because they found it. There is no password
reset, so put the owner password in a password manager.

To move to a newer image, pull it, stop and remove the container, and start it
again with the same command. Your database is untouched, and migrations run at
startup. See [upgrades](docs/upgrades.md).

### Sign-in modes

| `AUTH_MODE` | What it does | Also needs |
| --- | --- | --- |
| `local` (default) | The embedded account only | Nothing |
| `google` | Allowlisted Google only | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS` |
| `both` | Either, into the same ledger | The same three, with the owner's email in `ALLOWED_EMAILS` |

With Google enabled, register the callback as
`https://YOUR-DOMAIN/api/auth/callback/google`. Full settings and reverse-proxy
guidance are in [deployment](docs/deployment.md).

## Connect an agent

The MCP endpoint is `/mcp`, protected by OAuth. Point a client at your origin
and it discovers the rest. Grant `ledger:read` to let an agent look, add
`ledger:stage` to let it queue work for your review, and add `ledger:write` only
if you want it to commit. See [MCP](docs/mcp.md).

## More

- [Architecture](docs/architecture.md) — how it fits together and what the ledger
  guarantees
- [Deployment](docs/deployment.md) — every setting, reverse proxy, backups
- [Upgrades](docs/upgrades.md) — moving between versions
- [MCP](docs/mcp.md) — scopes, tools, and what an agent can do
- [Changelog](CHANGELOG.md)
- [Contributing](AGENTS.md) — the rules this codebase holds itself to
- [Ralph build loop](scripts/ralph/README.md)

## Built with

One TypeScript package: React and Vite in the browser, Hono on Node for the API,
auth, MCP, and static files, Better Auth for local and Google sign-in and for
MCP OAuth, Drizzle for PostgreSQL and its migrations, and Zod contracts shared
by both sides of every boundary.

## License

[GNU Lesser General Public License v3.0 only](LICENSE) (`LGPL-3.0-only`).
