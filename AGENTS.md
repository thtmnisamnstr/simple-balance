# Simple Balance agent guide

## Architecture boundaries

- Keep shared Zod contracts, CSV primitives and name normalization in
  `src/shared`. A rule the browser previews and the server enforces has to be
  one function, or the preview eventually shows something the server refuses.
- Keep ledger behavior in `src/server/services`; both Hono routes and MCP tools
  must call the same services.
- Treat `src/server/api.ts` and `src/server/mcp.ts` as transport adapters.
- Keep the browser UI in `src/client`; server calculations are authoritative.
- PostgreSQL is the only persistent dependency. Do not add Redis, SQLite, an
  object store, sidecar, or writable-volume requirement.

## Non-negotiable ledger invariants

- Never represent money with JavaScript/JSON floating-point numbers. Use validated
  decimal strings and PostgreSQL `numeric(44,18)`.
- Never accept a public `userId`. Derive it from the authenticated `Actor`, and
  scope every finance read/write by that ID.
- Keep `AUTH_MODE=local` as the default. Google credentials are required only for
  `google` or `both`.
- One deployment holds many people. `ALLOWED_EMAILS` decides who may create an
  account, on every sign-up path, local and Google alike. It decides nothing
  after that: never make it a condition of signing in, of keeping a session, or
  of linking a second method to an account that already exists. It is optional,
  so a deployment that never set one would otherwise lock everyone out.
- Keep the first-account claim transactional, serialized outside the application
  pool, and protected by the production setup code. Never expose a first-visitor
  claim race. The setup code only ever covers an address `ALLOWED_EMAILS` would
  turn away; addresses it admits register without one.
- Mail is optional and everything that needs it degrades rather than breaks. A
  deployment with no SMTP_HOST offers no password reset, asks nobody to confirm
  an address, and sends no scheduled reminder; one with SMTP_HOST does all
  three. Never make an account that was created without a mail server unusable
  once one is added, and never refuse to store a notification setting because
  there is nowhere to send it yet.
- Decisions made inside a Better Auth database hook must come from configuration
  and the request, never from a query. The hook runs inside the sign-up
  transaction, which on a one-connection pool is holding the only connection.
- The books are double-entry. Every transaction settles to zero in each currency
  it touches, checked before anything is written. A deposit credits the
  destination and debits income; a withdrawal debits the source and credits
  expense; a same-currency transfer moves between the two accounts; a conversion
  settles through the exchange account so each currency balances on its own. An
  opening balance posts against the equity account, so the ledger as a whole
  nets to zero rather than starting from a number kept outside it.
- Counter-accounts are server-owned, one per kind and currency, and never appear
  in account lists or pickers, and no transaction may name one as a side.
- A posting carries its own date and stands on its own. Balances, cash flow, and
  spending by category all read the posting table; only a label such as a
  category is looked up elsewhere. A posting names the leg it belongs to, and
  the leg holds the label, so recategorising is one update and writes no
  postings at all. The exception says what it is: a category whose kind runs
  against the entry's direction makes it a refund, which moves the other half
  between the income and expense counter-accounts, so that one appends a delta
  like any other correction. Never compute a monetary figure from
  `ledger_transaction` columns.
- A deposit credits income and a withdrawal debits expense only when no category
  contradicts it. Money coming back into a spending category is a refund, not
  income, and it debits expense so the spending it reverses goes down; the
  mirror holds for income coming back. The rule is `resolveEntrySide` in
  `src/shared/domain.ts`, because the browser previews it and the services
  enforce it. One entry never names both an income and an expense category, and
  a bulk edit never makes rows into refunds. Naming a category that does not
  exist yet is the case the direction alone gets wrong, so `categoryKind` says
  which kind to create; the form asks for it in the same words
  (`tests/new-category-kind-ui.test.tsx`), and it is ignored when the category
  already exists, because that one has an answer already.
- A split is the counter-account side of one entry cut into legs, not a second
  record of the money. Each leg has its own postings, so "the legs add up to the
  total" is the zero-sum check that was already there and needs no rule of its
  own. A transfer has no counter-account side and so is never split. A leg is
  zeroed, never deleted, because the postings that name it are append-only.
- Any write that changes a leg must bump the parent transaction's `version` in
  the same transaction. A mass edit describes the set it is about to change by
  `id:version`, so a leg relabelled underneath one would leave that description
  agreeing about a row that changed.
- Postings are append-only. To correct one, work out the difference per account,
  currency, and date, and append only that. Never update or delete a posting.
  An edit that changes nothing about the movement writes nothing at all.
- Deleting voids an entry by posting its reversal, and restoring posts it back.
  Nothing filters deleted rows out of a balance, because a voided entry already
  nets to zero. Editing a deleted entry leaves it void.
- Archiving an account posts whatever it still holds out to the same equity
  account, so it closes at zero and restoring posts the balance back. That is
  what lets a total leave archived accounts out and still be right; never make
  a figure correct by filtering alone while the figures beside it do not.
- A summary stops at today in the person's own timezone, whatever end date is
  asked for, and reports the day it used. Money dated in the future has not
  moved, so it counts toward neither a balance nor a cash flow.
- A table that holds somebody's data references `auth_user` with
  `on delete cascade`, because deleting an account is one delete of that row and
  nothing enumerates tables. Add the cascade with the table; without it the
  deletion fails rather than silently leaving data, which is the right failure
  but still a bug.
- The MCP surface has feature parity with the web app, and `tests/mcp-parity.test.ts`
  compares them route by route. A new `/api/v1` route needs a tool in the same
  change, or a named exception carrying its reason. It runs the other way too:
  the agent surface never gets ahead of the browser, so a route no page calls
  needs a named exception of its own. A capability a person cannot reach is not
  parity, it is a second product. Route by route is where the test can check,
  not where the rule stops: a request field only an agent ever sets is the same
  defect one level down, and it is invisible to a comparison of route lists.
  `categoryKind` was exactly that for a while — documented for the MCP, absent
  from the form, so the browser silently filed refunds as income.
- Two exceptions, both account management rather than bookkeeping: deleting an
  account and setting a sign-in password are reachable from a session and never
  from an MCP token.
- A tool whose result does not satisfy its declared output schema fails the
  call with an `Output validation error` naming the offending path, so a wrong
  schema breaks the tool rather than trimming its reply. Exercise new tools over
  a real connection rather than trusting the schema alone.
- Balances derive from postings alone. Never add an account column back into a
  balance query.
- Lists order by any column they display, in either direction. Order is
  presentation, so it stays out of the fingerprinted bulk selection filter. A
  cursor records the order it was issued for and is refused under another; an
  ordering a keyset cannot resume offers no cursor and pages by number instead.
- Only ask for `nulls last` on a key that can be null. On one that cannot, it
  stops matching the index and turns a page read into a sort of the whole table.
- Per-account FX stores distinct source/destination native amounts and an implied
  audit rate only. Do not add global rates or revaluation.
- Staged transactions never affect balances or reports.
- Updates/deletes require an expected version. Commits, and creates that write
  postings, require idempotency; a record somebody names is protected by its own
  name being unique, so a second submit fails rather than duplicating. Bulk
  commits are explicit-ID, validate-first, and atomic.
- Ten thousand rows is the cap, and it is the same number everywhere: a mass
  edit, a mass delete, a commit, and a CSV import. An import that stages more
  than one action can clear is a cap doing damage. A filtered selection is
  bounded in SQL, not after the rows have been read.
- `ledger:stage` proposes and never decides. Creating a category, bringing an
  archived one back, or widening what kind of entry it may carry are changes to
  the ledger's own records and need `ledger:write`, wherever they are reached
  from, including a CSV import.
- An audit entry records what changed, and for a split that includes the legs:
  relabelling one writes no posting and touches no column on the transaction.
- A guess never overwrites a decision. The browser's detected timezone and
  currency are offered only while `chosen` is false, and that condition travels
  with the write as `ifUnchosen` so it is checked in the transaction that would
  do the writing. A page decides it against the session it loaded with, which
  another tab may already have made stale. It is not part of the MCP contract:
  an agent has no browser locale and nothing to be tentative about.
- Transaction and staged mass edits are atomic and share one selection contract.
  Explicit rows carry expected versions; all-filtered selections carry a
  server-issued count and `id:version` fingerprint. Never silently move a
  transaction into a different currency, collapse a transfer into a
  single-account transaction, or flatten a split into one category in bulk. A staged mass edit revalidates every row
  it writes, and refuses rather than skips a row it cannot give one account to.
- A transaction's `templateId` is provenance and carries no foreign key, so a
  deleted template leaves the transactions made from it untouched. Ownership is
  checked on write, since nothing else constrains it.
- A template mass edit names explicit rows with expected versions and has no
  filtered selection, because the list is capped and the browser holds all of
  it. A patch key left out leaves the field alone, a value sets it, and `null`
  clears it back to blank; an empty string is refused rather than read as a
  clear.
- A recurrence proposes and never posts. On its due date it writes an ordinary
  staged row whose draft date is the occurrence as the weekend and month-length
  policies leave it, with no import batch and no external id, and
  a reference that no longer resolves becomes an issue on that row rather than a
  reason to write nothing. Its provenance columns carry no foreign key, so
  deleting a recurrence leaves every row it proposed alone.
- A notification watermark records only what was sent. So the reminder sweep
  does nothing at all when mail is off — advancing past occurrences nobody was
  told about would let a deployment eat its own backlog — and mail is sent after
  the transaction that earned it has committed, never inside it, because a
  message about rows that were then rolled back names a queue with nothing in
  it. A backlog collapses to one message. Nothing is ever queued for later.
  A recurrence's watermark is the opposite case and must advance either way: it
  records a proposal that really happened.
- Whether it is a given day, or a given time of day, where somebody lives is
  answered in one place. PostgreSQL reads a bare offset timezone with the POSIX
  sign convention and `Intl` reads it as ISO, so the two disagree by up to
  sixteen hours for anyone whose stored timezone is an offset. Ask
  `calendarDayIn`, `clockTimeIn` or `todayIn` from `src/shared/recurrence-dates.ts`;
  never ask the database.
- Preserve audit history, transaction provenance, and cross-currency CSV round
  trips.
- Every migration that has shipped is frozen: `0000_initial.sql`,
  `0001_verify_existing_accounts.sql`, and `0002_account_closing_postings.sql`
  in 0.1.0, `0003_transaction_templates.sql` and
  `0004_template_provenance.sql` in 0.1.3, `0005_split_transaction_legs.sql`
  `0006_recurring_transactions.sql` and `0007_shared_rate_limit.sql` in
  0.1.4, and `0008_owner_setup_token.sql`,
  `0009_scheduled_notifications.sql`, `0010_drop_covered_user_indexes.sql`,
  `0011_user_theme.sql` and `0012_payee_normalized_indexes.sql` in 0.1.5.
  `0013_budget_plans_and_entries.sql`,
  `0014_budget_rollover_and_targets.sql`, `0015_budget_amount_rules.sql` and
  `0016_category_groups.sql` and `0017_budget_perimeter.sql` are written and
  unreleased, so they are the ones
  here that may still be regenerated; they freeze when they ship. `0016` is the
  one exception to the composite-key habit and says why in the schema: a
  category's group is a single-column reference, because `on delete set null`
  nulls every column of the constraint it is on and the tenant is not nullable.
  `tests/migrations.test.ts` holds this list to what is on disk, because a list
  of what may never change is worth nothing if it can quietly fall behind.
  Never edit or regenerate one: someone's database has already run it, and
  changing it would leave their schema and its recorded history disagreeing.
  Every schema
  change from here is its own forward-only migration, generated with
  `npm run db:generate`, carrying whatever backfill it needs.
- A release upgrades cleanly from the one before it. A deployment running the
  previous release starts on this one with the configuration it already has, and
  every client that worked against it still works. A setting that was accepted
  stays accepted — warn and carry on rather than refusing. A precedence that
  existed is kept. A renamed route stays registered under its old spelling with
  `Deprecation` and `Sunset` headers. A capability a client had does not narrow.
  Removing any of those is a later release's job, after the deprecation has been
  in the field. `docs/standards/writing.md` has the reasoning.
- Startup must remain the only production migration path. Keep migrations safe
  under the advisory lock and fail readiness on migration failure.
- No metric label carries somebody's identity: not a user id, an email, an
  account name or an amount. A metric is read by whoever can reach the scrape
  endpoint, which is not the person whose ledger it counts, and the same rule
  keeps the cardinality bounded — a path with an id in it is counted under its
  route pattern, never under the path. `/metrics` is off unless asked for and
  registered rather than refusing, so a deployment that never set
  `METRICS_ENABLED` has no such route.

## Standards

This file holds the invariants: break one and the books are wrong. Two guide
sets sit below it and neither restates it.

- **[`docs/standards/`](docs/standards/index.md)** — the interfaces. What the
  browser app, the MCP surface, the HTTP API, the CSV format and the container
  do the same way everywhere. Read the one for the surface you are changing.
- **[`docs/standards/code/`](docs/standards/code/index.md)** — the source.
  Strictness, services, queries, React, errors, tests, metrics and logging,
  comments, and the linter and formatter settings the whole repository is
  checked with.

Where a guide and this file disagree, this file wins and the guide records the
disagreement rather than quietly losing it.

Two habits from those guides are worth knowing before the first edit, because
both look like mistakes:

- **Comments are dense on purpose** — 17.6% of non-blank lines in `src`. They
  carry why the obvious alternative is wrong. Do not tidy them away.
  (`docs/standards/code/comments.md`.)
- **Some loops must not be parallelised.** Legs resolve one at a time so two
  naming the same new category land on one category. `no-await-in-loop` is off
  for this reason. (`docs/standards/code/services.md`.)
- **Nothing outside the configuration layer names `console`.** Every line goes
  through `log` (`src/server/log.ts`) so `LOG_LEVEL` means something, and that
  includes handing `console` to something else as a default parameter, which is
  how two modules sat outside the gate for a release.
  (`docs/standards/code/observability.md`.)

## Commands

```sh
npm run typecheck
npm run lint
npm run format
npm test
npm run build
npm run verify
TEST_DATABASE_URL=postgresql://... npm run test:integration
BROWSER_DATABASE_URL=postgresql://... npm run test:browser
docker build -t simple-balance:test .
npm run ralph -- --dry-run
```

`npm run verify` is `typecheck → lint → format:check → test → build`. The
integration and browser suites are not in it because both need a PostgreSQL to
point at.

`npm run ralph -- --dry-run` is a local command and is deliberately not part of
CI. Its Git guard refuses a repository whose config pulls in another file,
because an included config can set an executable hook. `actions/checkout` does
exactly that to store its credentials, so the guard is right to object and CI is
the wrong place to ask it. The guard itself is covered by unit tests, which do
run in CI.

## Definition of done

- Add focused tests for changed domain behavior and run the story verification
  commands from `tasks/product.prd.json`.
- Run `npm run verify` before declaring a story complete.
- For database behavior, run the PostgreSQL integration suite when a test URL is
  available. For UI changes, verify keyboard use and responsive layouts.
- Keep changes story-scoped. Do not reset, discard, or overwrite existing work.
- Never use `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, or deprecated
  `--full-auto` in automation.
