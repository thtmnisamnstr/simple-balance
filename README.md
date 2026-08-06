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

MCP clients call the same code the browser does, and can do everything you can:
the whole ledger, imports, templates, mass edits, and your own settings. Two
things stay yours alone, deleting the account and setting a password, because
they are account management rather than bookkeeping. An agent cannot get around
your sign-in, the scopes you granted it, the duplicate checks, or the commit
step.

![The Simple Balance overview: balances, cash flow, and spending by category, shown per currency for a month of activity](docs/images/dashboard.png)

## What it does

Accounts hold anything you file as an asset or a liability, each in its own
currency. Crypto wallets track native quantities; nothing here quotes a market
price. Retiring an account archives it, which posts whatever it still holds out
to equity so the account closes at zero and stops counting toward your totals
without the books going out of balance; restoring it puts the balance back, and
its history stays readable throughout. Transactions are deposits, withdrawals,
and transfers, same-currency or converted. The payee is required. Everything
else is optional.

Imports go through a review queue. Simple Balance reads the CSV, works out the
format, maps the columns, parses whatever date and number conventions your bank
uses, and creates categories and payees as it goes. You look at the result
before any of it counts. Committing a batch is all or nothing.

One of its own exports needs no mapping at all: pick the account and stage it.
The account is that choice and nothing else, so a file exported from one ledger
imports into another, or into somebody else's, or into a fresh install. A
transfer names a second account, which is a choice the import screen cannot
make, so those rows arrive in the queue asking for it.

A transaction you enter often can be saved as a template from any row and picked
from a dropdown next time. It fills the form in and then gets out of the way:
what you change afterwards is yours alone, and the template is not touched. It
is a starting point, not a scheduled transaction, which stays out of scope.

Templates have a screen of their own, where you can make one, change one, or
change many at once. A mass edit there can also clear a field rather than set
it, which is how a template stops carrying an amount and starts asking for one
each time you use it.

Only the name is required. A template holds whatever subset of a transaction's
fields you give it, and applying one fills in those fields and leaves the rest
as they were, so you can apply a template to an entry that already exists as
well as to a new one. Each template also reports how many transactions have
come from it, and links to them.

You can change or delete up to 10,000 rows in one request that either wholly
succeeds or wholly does not, from any view, after seeing what it will touch.
That works on the queue as well as on committed rows, which is how you fix a
file whose account or category column meant nothing to the importer: one edit
over the whole batch, and the rows it repairs come back ready to commit.
Categories and payees match case-insensitively, flag their own near-duplicates,
and merge by rewriting every reference at once.

The dashboard covers balances, cash flow, and spending by category over any date
range, and the range is in the URL, so you can link to it. It stops at today
whatever range you pick, because money dated next month is not money you have.
Every list sorts by any column it shows and pages by number. Everything the
browser or an agent did is in the audit log.

Sign in with an email and password, with Google, or with both on the same
account. One deployment can hold any number of people, each with their own
separate books, and `ALLOWED_EMAILS` decides who may join. The MCP server runs
over OAuth with separate read, stage, and write scopes.

Leaving is yours to do. Settings deletes the account and everything in it,
after counting what that is and asking you to type your address. Nothing is
kept, and no agent can do it for you.

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
configuration. The first visit asks you to create an account; after that it is
the email and password you chose. Both servers stay on loopback.

Code reloads as you edit it. After changing dependencies, run `npm install` and
restart both commands. `docker compose -f compose.dev.yml stop` stops the
database and keeps its data; `docker compose -f compose.dev.yml down -v` removes
the containers and deletes it.

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

Pull a published image:

```sh
docker pull ghcr.io/thtmnisamnstr/simple-balance:latest
```

`latest` follows the newest final release. A prerelease tag publishes only its
own version. To build it yourself instead, `docker build -t simple-balance .`
from a clone.

Everything is configured through environment variables. Copy the example and
fill it in:

```sh
cp .env.example .env
```

`DATABASE_URL` and `AUTH_SECRET` are required, and `APP_BASE_URL` must be your
public HTTPS origin in production. Point `DATABASE_URL` at a PostgreSQL 15 or
newer server and Simple Balance sorts the rest out on startup: it creates the
database if the server does not have it, builds the schema if the database is
empty, and does nothing if it is already current. Generate the secret with
`openssl rand -base64 32` and keep it: changing it signs everyone out. Google
settings are only needed if you turn Google sign-in on.

```sh
docker run -d --name simple-balance --restart unless-stopped \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --env-file .env -p 127.0.0.1:3000:3000 \
  ghcr.io/thtmnisamnstr/simple-balance:latest
```

The container runs as a non-root user and never writes to its own filesystem.
Everything it keeps is in PostgreSQL. Leave it bound to loopback and put a
reverse proxy or a private network in front, rather than publishing the port.

Watch it come up with `docker logs -f simple-balance`, and check
`curl -f http://127.0.0.1:3000/health/ready`. Readiness stays closed until
configuration, the database connection, and the migrations have all succeeded.

The logs print a one-time setup code on first run. Enter it on the
account-creation screen to claim the instance. Set `SETUP_TOKEN` yourself if you
would rather choose it. Either way the code stops working once an account
exists, so nobody can claim an instance just because they found it.

Give it a mail server with `SMTP_HOST` and `MAIL_FROM` and people can reset a
forgotten password, and a new account has to confirm its address before it
works. Without one, neither happens and a lost password means editing the
database, so put it in a password manager.

After that, who else may register is up to `ALLOWED_EMAILS`. Leave it unset and
nobody can, which keeps the deployment yours alone. List addresses
(`you@example.com`), whole domains (`example.com`), or `*` for anybody, and
those people get accounts of their own. They cannot see yours and you cannot see
theirs.

To move to a newer image, pull it, stop and remove the container, and start it
again with the same command. Your database is untouched, and migrations run at
startup. See [upgrades](docs/upgrades.md).

### Sign-in modes

| `AUTH_MODE` | What it does | Also needs |
| --- | --- | --- |
| `local` (default) | Email and password | Nothing. Add `ALLOWED_EMAILS` to let others register |
| `google` | Google accounts `ALLOWED_EMAILS` admits | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS` |
| `both` | Either, and both on one account | The same three |

With Google enabled, register the callback as
`https://YOUR-DOMAIN/api/auth/callback/google`. Full settings and reverse-proxy
guidance are in [deployment](docs/deployment.md).

## Connect an agent

The MCP endpoint is `/mcp`, protected by OAuth. Point a client at your origin
and it discovers the rest. Grant `ledger:read` to let an agent look, add
`ledger:stage` to let it queue work for your review, and add `ledger:write` only
if you want it to commit. Settings lists what you have approved, and revoking an
agent there cuts it off on its next call rather than whenever its token happens
to expire. See [MCP](docs/mcp.md).

## More

- [Architecture](docs/architecture.md): how it fits together, and what the
  ledger guarantees
- [Deployment](docs/deployment.md): every setting, reverse proxies, backups
- [Upgrades](docs/upgrades.md): moving between versions
- [MCP](docs/mcp.md): scopes, tools, and what an agent can do
- [Roadmap](docs/roadmap.md): what is planned, in order, and the evidence for it
- [Changelog](CHANGELOG.md)
- [Contributing](AGENTS.md): the rules this codebase holds itself to
- [Ralph build loop](scripts/ralph/README.md)

## Built with

One TypeScript package: React and Vite in the browser, Hono on Node for the API,
auth, MCP, and static files, Better Auth for local and Google sign-in and for
MCP OAuth, Drizzle for PostgreSQL and its migrations, and Zod contracts shared
by both sides of every boundary.

## License

[GNU Lesser General Public License v3.0 only](LICENSE) (`LGPL-3.0-only`).

The LGPL is written as a set of additional permissions on top of the GPL, so
both texts apply: [LICENSE](LICENSE) is the LGPL supplement and
[COPYING](COPYING) is the GNU General Public License v3 it builds on.
