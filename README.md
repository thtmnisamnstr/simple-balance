# Simple Balance

Know where your money is, and where it went. Every account in one place, bank
statements that import and file themselves, the bills and paychecks you only set
up once, and reports that go back as far as your books do — on a server you run
yourself.

- **Every account, one page.** Checking, savings, credit cards, cash, loans,
  investments and crypto wallets, each in its own currency, with balances as of
  any date you ask for.
- **Statements that file themselves.** Point it at a bank CSV and it works out
  the format, maps the columns, and sorts the categories and payees. It flags
  anything that looks like a transaction you already have, and nothing counts
  until you say so.
- **Nothing to remember.** Rent, a salary, a subscription: set it up once and it
  proposes itself on the day, with an email if you want one.
- **Reports that add up.** Net worth, income against expense, spending by
  category, cash flow, a balance sheet and a trial balance — over any range, and
  never added across currencies, because there are no exchange rates here to add
  them with.

Underneath it is real double-entry bookkeeping, which is what lets every figure
on every page trace back to the entries that made it. And it ships a full MCP
server, so an AI agent can do the filing and the tidying for you without being
able to do anything dangerous, or get around the step where you check its work.

![The Simple Balance overview: balance, deposits, withdrawals and net cash flow for a month, then accounts and spending by category, reported separately for each currency the ledger holds](docs/images/dashboard.png)

## Everything else it does

- Deposits, withdrawals, and transfers, including conversions between currencies
  that keep the sent and received amounts apart
- One receipt split across several categories, each attributed on its own
- A duplicate opened beside the entry it resembles, so you can fix either side
  and drop the spare
- Templates for the transactions you enter over and over, with a reminder on any
  of them
- Change or delete up to 10,000 rows in one go, from any view, after seeing what
  it will touch
- A register for any account: every posting with the balance before and after it,
  for when a figure is wrong and you need the row it went wrong on
- Categories and payees that match case-insensitively, flag near-duplicates, and
  merge
- An audit log of everything you or an agent did
- Email and password, Google, or both, and any number of people on one
  deployment, each with their own separate books

There is a walkthrough of all of it in [the guide](docs/guide.md).

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

```sh
docker pull ghcr.io/thtmnisamnstr/simple-balance:latest
```

`latest` follows the newest final release. A prerelease tag publishes only its own
version. To build it yourself instead, `docker build -t simple-balance .` from a
clone.

Everything is configured through environment variables. Copy the example and fill
it in:

```sh
cp .env.example .env
```

`DATABASE_URL` and `AUTH_SECRET` are required, and `APP_BASE_URL` must be your
public HTTPS origin in production. Point `DATABASE_URL` at a PostgreSQL 15 or
newer server and Simple Balance sorts the rest out on startup: it creates the
database if the server does not have it, builds the schema if the database is
empty, and does nothing if it is already current. Generate the secret with
`openssl rand -base64 32` and keep it — changing it signs everyone out.

```sh
docker run -d --name simple-balance --restart unless-stopped \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --stop-timeout 30 \
  --env-file .env -p 127.0.0.1:3000:3000 \
  ghcr.io/thtmnisamnstr/simple-balance:latest
```

The container runs as a non-root user, never writes to its own filesystem, drops
every Linux capability and cannot gain a privilege it did not start with. A Node
server binding port 3000 as a non-root user needs none of them, so those two
flags cost nothing and close the two routes a container escape usually takes.
Everything it keeps is in PostgreSQL. Leave it bound to loopback and put a reverse
proxy or a private network in front, rather than publishing the port.

Watch it come up with `docker logs -f simple-balance`, and check
`curl -f http://127.0.0.1:3000/health/ready`. Readiness answers once the
database is reachable. Nothing is listening until the migrations have finished,
so a container answering at all is one that got through them.

**Claim the instance.** The logs print a one-time setup code on first run. Enter
it on the account-creation screen. Set `SETUP_TOKEN` yourself if you would rather
choose it. Either way the code stops working once an account exists, so nobody can
claim an instance just because they found it.

**Give it a mail server.** With `SMTP_HOST` and `MAIL_FROM`, people can reset a
forgotten password, a new account has to confirm its address, and the scheduled
reminders can be delivered. Without one, none of that happens and a lost password
means editing the database, so put it in a password manager. Whether those
messages arrive also depends on SPF, DKIM, DMARC and a PTR record in your DNS;
"Getting mail delivered" in [deployment](docs/deployment.md) says what each one
is and who sets it.

**Decide who else may register**, with `ALLOWED_EMAILS`. Leave it unset and nobody
can, which keeps the deployment yours alone. List addresses (`you@example.com`),
whole domains (`example.com`), or `*` for anybody, and those people get accounts of
their own. They cannot see yours and you cannot see theirs.

To move to a newer image, pull it, stop and remove the container, and start it
again with the same command. Your database is untouched, and migrations run at
startup. See [upgrades](docs/upgrades.md).

Every setting, reverse proxies, TLS to the database, mail providers, backups, and
running the pieces as separate containers are all in
[deployment](docs/deployment.md).

### Sign-in modes

| `AUTH_MODE` | What it does | Also needs |
| --- | --- | --- |
| `local` (default) | Email and password | Nothing. Add `ALLOWED_EMAILS` to let others register |
| `google` | Google accounts `ALLOWED_EMAILS` admits | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS` |
| `both` | Either, and both on one account | The same three |

With Google enabled, register the callback as
`https://YOUR-DOMAIN/api/auth/callback/google`.

## Connect an agent

The MCP endpoint is `/mcp`, protected by OAuth. Point a client at your origin and
it discovers the rest. Grant `ledger:read` to let an agent look, add
`ledger:stage` to let it queue work for your review, and add `ledger:write` only
if you want it to commit. Settings lists what you have approved, and revoking an
agent there cuts it off on its next call rather than whenever its token happens to
expire.

An agent can do everything you can: the whole ledger, imports, templates,
recurrences, mass edits, and your own settings. Two things stay yours alone,
deleting the account and setting a password, because they are account management
rather than bookkeeping. An agent cannot get around your sign-in, the scopes you
granted it, the duplicate checks, or the commit step. See [MCP](docs/mcp.md).

## Security

One deployment holds many people and none of them can see another's books: every
read and write is scoped to whoever is signed in, and a record that is not yours
comes back as not found rather than as forbidden. Put TLS in front of it;
[deployment](docs/deployment.md) says how.

If you find a hole, [SECURITY.md](SECURITY.md) says how to report it privately,
and asks you not to open a public issue for it.

## Contributing

Whether a change is taken is the owner's call, and there is no promise here that
one will be. What this section can tell you is what a change has to look like
before that question is worth asking.

[`AGENTS.md`](AGENTS.md) holds the invariants — what the books guarantee, and
what breaking one costs. [`docs/standards/`](docs/standards/index.md) holds how
the interfaces behave and [`docs/standards/code/`](docs/standards/code/index.md)
how the source is written; read the one for the surface you are touching. Every
rule in both says how it is checked, so a rule you have not broken is one you
can prove you have not.

`npm run verify` is typecheck, lint, format, tests and build, and it has to pass.
Add a test for the behaviour you changed: this repository tests heavily and a
change with no test is a change nobody can keep. If you touched anything with a
database behind it, run `npm run test:integration` against a throwaway
PostgreSQL, and if you touched the browser app, `npm run test:browser`.

Do not cut a version. Releases are the owner's.

## Not built yet

Budgets, bank sync, account sharing, attachments, and reconciliation. What is
planned, in what order, and the evidence behind each is in the
[roadmap](docs/roadmap.md), which also says what is deliberately not planned and
why, market prices among it. Tags are neither built nor planned.

## More

- [Guide](docs/guide.md): every feature, and the decisions behind the ones that
  are not obvious
- [Architecture](docs/architecture.md): how it fits together, and what the ledger
  guarantees
- [Deployment](docs/deployment.md): every setting, reverse proxies, backups
- [Upgrades](docs/upgrades.md): moving between versions
- [MCP](docs/mcp.md): scopes, tools, and what an agent can do
- [Roadmap](docs/roadmap.md): what is planned, in order, and the evidence for it
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md): reporting a vulnerability
- [Agent and contributor guide](AGENTS.md): the rules this codebase holds itself
  to
- [Ralph build loop](scripts/ralph/README.md)

## Built with

One TypeScript package: React and Vite in the browser, Hono on Node for the API,
auth, MCP, and static files, Better Auth for local and Google sign-in and for MCP
OAuth, Drizzle for PostgreSQL and its migrations, and Zod contracts shared by both
sides of every boundary.

## License

[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

Run it, change it, and share it freely. What the Affero clause adds to the GPL is
section 13: offer a modified version to people over a network, and those people
are entitled to that version's source. Self-hosting it for yourself, your
household, or your company changes nothing about how you use it.

Every version up to and including 0.1.3 was published under the LGPL and stays
available under it. This applies from 0.1.4 onward.
