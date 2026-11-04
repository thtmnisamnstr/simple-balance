# The demo ledger

`demo-ledger.json` is the one synthetic ledger this repository uses. The
product kit's screenshots are taken of it, a design review or a smoke test
loads it, and anyone who wants to see the app with something in it loads it
too. **Don't write a new generator, and don't seed an account through the forms
or the API by hand.** When something needs data the file doesn't have, add it
to the file (see [Changing it](#changing-it)) so every later use gets it too.

It's a Simple Balance file (`docs/standards/ledger-file.md`), exported from this
application rather than written by hand. A move holds it to every rule it holds
any file to, and checks every account's balance after writing.

## What's in it

Alex Rivera's books, three months of them:

- **Accounts:** four, in two currencies. There's everyday checking, savings and
  a credit card in USD, and a euro checking account.
- **Categories:** nine, with an *Essentials* group over rent, groceries and
  utilities.
- **Transactions:** sixty in all. Each month has a salary, rent, bills,
  groceries, dining out, transit and a transfer into savings. Beyond that
  pattern there are three special cases:
  - a split between groceries and health
  - a euro-to-dollar conversion
  - one entry that was deleted after being charged twice
- **Budgets:** nine monthly budgets across both currencies.
- **Other records:**
  - four templates
  - five monthly recurring transactions
  - four rows waiting in Staged, one of which is a refund into a spending
    category

`tests/demo-ledger.test.ts` fails if a screen the product kit photographs
would come out empty.

The person isn't in the file, because a file carries no users. Their details
are `DEMO_PERSON` in `rebase.mjs`: `alex@example.com` /
`correct-horse-battery-staple-9`.

## Loading it

Use a fresh database every time. Start the application against it, with mail
off and `ALLOWED_EMAILS` admitting the address. The product-kit skill's
runbook has the full command. Then run:

```sh
npx tsx scripts/demo-ledger/load.mjs --url http://localhost:3000
```

The script signs the demo person up, then moves the file into their books. The
move goes through `POST /api/v1/ledger-file:move`, the route a person moving
their own file uses. Pass `--url` the application itself, not Vite. If the
server's `APP_BASE_URL` is somewhere else, such as Vite's `:5173`, set
`APP_BASE_URL` to match so the request comes from the origin the server
expects.

The product kit's `build.mjs` does the same move itself, from the browser it
signs up in. A browser spec can call `demoLedgerMove({ today })` and post the
result the same way.

**The dates move.** The file was exported on one day and is read on another.
Every page opens on this month, so a three-month-old ledger would look empty.
To prevent that, `rebaseLedgerFile` moves every date by the same whole number
of months, so the month of the last entry becomes the current month.

Any entry that lands after today is dated today instead. That's because the
app doesn't count money dated in the future, so leaving those entries ahead
would make the current month come out short. Schedules and budgets aren't
clamped, so every recurring transaction is anchored next month and none shows
as past due. `rebase.mjs` has the reasoning.

**Reloading:**

- **Same day:** loading again replays the first load under the same
  idempotency key.
- **Later day:** loading again skips every entry that's already there (by its
  origin) and leaves those entries on their old dates. Start from a fresh
  database instead.

**On a deployment that sells plans,** the free plan keeps three accounts in
use and this ledger has four. The move will be refused until the account has a
subscription. The product-kit skill shows how to give it one.

## Changing it

Make the change in the app, then save the result over the file:

```sh
# a fresh database, the application running against it
npx tsx scripts/demo-ledger/load.mjs --months-back 1
# … change what needs changing, in the browser or through the API …
npx tsx scripts/demo-ledger/save.mjs
git diff scripts/demo-ledger/demo-ledger.json
```

**Load with `--months-back 1`.** This puts the last month wholly in the past,
so no entry gets clamped to today. If you save a copy loaded at the current
month, every entry after today ends up dated today, permanently. `save.mjs`
refuses to save such a copy.

**Keep new entries in the past.** `rebaseLedgerFile` refuses a file holding an
entry dated after its own balance checks. `save.mjs` also refuses a file whose
last month isn't wholly past.

`save.mjs` makes the diff show only what changed in two ways:

- **It moves the dates back.** It finds an entry that's in both files and
  shifts every date by however many months that entry moved.
- **It keeps the committed order.** Records already in the file stay where they
  were. Without this, a move creates each kind of record in a single
  transaction, so the export would list them in a different order.

After an unchanged round trip, the diff is just `exportedAt`. Read the diff
before committing.

**When to change it:**

- **A feature lands with a screen or record the file doesn't reach.** Add it
  here in the same change, rather than seeding it somewhere else.
- **A test fails over the file.** If the format or a move's rules change and
  the file no longer meets them, `tests/integration/demo-ledger.integration.test.ts`
  fails. `tests/demo-ledger.test.ts` fails when the file isn't exactly what this
  release's writer produces. In either case, load and save it again.

Whatever you add should still be shaped for a screenshot:

- Use plausible names and amounts.
- Keep both currencies populated, since the overview shows one block per
  currency.
- Keep the person's settings unset. A timezone in the file would become the
  server's "today" for them, while the product kit works its dates out in the
  machine's zone.
