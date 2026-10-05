# HTTP

`/api/v1` is a public contract. It was a browser API that happened to be
reachable with `fetch`, and the decision to publish it changes what a change to
it costs: a field renamed is somebody else's client broken, not a compile error
in the same repository.

This guide covers `/api/v1`. It also covers the unversioned surfaces the same
process answers on, `/health`, `/api/auth` and `/.well-known`, because a rule
that stops at a prefix boundary is a rule somebody will step over. Money, dates,
naming, the error vocabulary and the glossary are in [`common.md`](common.md)
and are not repeated here. What the ledger guarantees is in
[`AGENTS.md`](../../AGENTS.md) and is quoted, never paraphrased.

## The standing test

**House.** Every rule here is checked against MCP before it is adopted. If a
rule can only be expressed with an HTTP header, it cannot be a rule of this API,
because half the transports have no headers.

That one test explains most of what follows: `expectedVersion` in the body
rather than `If-Match`, `idempotencyKey` in the body rather than
`Idempotency-Key`, an error code in the body rather than only a status line, and
the absence of conditional requests entirely. It is also why the two transports
can share one service layer and one set of Zod contracts.

*Not checked mechanically*, and no test could check it: nothing can look at a
rule and see that it needs a header. What is checked is the consequence.
`tests/mcp-parity.test.ts` compares every `/api/v1` route against the tool
registry in both directions and makes each exception carry a written reason, so
a route whose contract only HTTP can express cannot ship without somebody
writing down why it has no tool.

## Two things to say plainly

### Nothing outside a browser can reach this API today

Three facts, all currently true, combine into that:

1. Every `/api/v1` request resolves its user with `getWebIdentity`, which reads
   a session cookie and nothing else (`src/server/api.ts:1480-1501`). There is no
   bearer path.
2. Every state-changing `/api/v1` request must present an `Origin` (or failing
   that a `Referer`) equal to the configured base URL
   (`src/server/http-security.ts:482-516`, mounted at `src/server/api.ts:1472-1479`).
3. Every state-changing `/api/v1` request must declare
   `Content-Type: application/json`, including the ones with no body at all
   (`requireContentType: true`, `src/server/api.ts:1477`).

So `curl` can read nothing and write nothing, and the answer for programmatic
access has been MCP. Story SB-030 in [`docs/roadmap.md`](../roadmap.md) removes
the first two for token-authenticated callers by accepting the OAuth bearer
tokens the MCP server already issues, on the same three scopes, leaving the
same-origin requirement where it belongs: on requests that carry an ambient
credential another site could forge.

**This guide is written for the contract SB-030 completes.** Every rule below is
a rule now; the bearer-token precondition is the one part that is unimplemented,
and it is named here rather than left for a reader to discover by getting a 401
they cannot fix.

### A row belonging to somebody else is not found, not forbidden

**Binding.** `AGENTS.md`: "Never accept a public `userId`. Derive it from the
authenticated `Actor`, and scope every finance read/write by that ID."
`docs/architecture.md:208-209`: "An id belonging to someone else comes back as
not found, not as forbidden."

[`common.md`](common.md#errors) settles the rule. What HTTP adds is the
transport argument: 403 would confirm the row exists, so
`GET /api/v1/accounts/{id}` for a stranger's account is a 404 with the same body
as an id that was never issued (`src/server/services/accounts.ts:592`). This is
deliberate, it is not a missing feature, and it applies to every resource.

*Checked by:* `tests/integration/tenant-isolation.integration.test.ts:169-207`
("refuses reads of another tenant's records by id", "refuses writes to another
tenant's records by id") and `:383-399`, which asserts `status: 404` under the
comment "Reading somebody else's by id is a 404, never a 403". Not checked
mechanically: that no service leaks existence through a distinguishable
message.

## The route list

Eighty-four routes under `/api/v1`, generated from `src/server/api.ts`, not
counting the four old spellings kept answering under `Deprecation` and `Sunset`.
The count is the table's, and only the table is pinned:
`tests/http-route-table.test.ts` holds the rows to the registrations both
ways, and this sentence just reports them. The scope column is the scope the
equivalent MCP tool needs today, and therefore the scope a bearer token will
need once SB-030 lands; `ledger:read` is implied by both of the others
(`src/server/mcp.ts:507-518`).

The register at `tests/mcp-parity.test.ts:21-40` does two jobs rather than one,
and reading it as one job is how the second gets lost. Most of its entries are
routes with **no tool at all**, and those are the ones marked session only
below. One entry is a route whose tool is **spelled differently**:
`GET /api/v1/csv/export` is reachable as `export_transactions_csv` and is
`ledger:read` in the table, listed there only because the route differs from the
tool in returning a file download with a dated filename. An agent can export; it
just does not get the `Content-Disposition`.

**House.** This table is the published list. Adding a route means adding a row
in the same commit.

*Checked by:* `tests/http-route-table.test.ts`, which extracts the routes from
`src/server/api.ts` the way `tests/mcp-parity.test.ts` already does and compares
the two sets both ways. A published route list that is wrong is worse than none
now that this contract is public, so neither a route without a row nor a row
without a route survives the suite.

### Session and account

| Route | Scope |
| --- | --- |
| `GET /api/v1/session` | session only |
| `POST /api/v1/auth/local-password` | session only |
| `DELETE /api/v1/me` | session only |
| `GET /api/v1/me/data` | `ledger:read` |
| `PUT /api/v1/preferences` | `ledger:write` |

### Plan and billing

Registered only where Stripe is configured. On every other deployment — which is
the default — these five paths do not exist, and `/api/billing/*` answers `404`
rather than the single-page shell. That is [A route a deployment did not ask for
is absent, not refusing](#a-route-a-deployment-did-not-ask-for-is-absent-not-refusing),
and the rule states what listing them here costs.

| Route | Scope |
| --- | --- |
| `GET /api/v1/billing` | session only |
| `PUT /api/v1/billing/subscription` | session only |
| `PUT /api/v1/billing/subscription/cancellation` | session only |
| `POST /api/v1/billing/payment-setups` | session only |
| `POST /api/v1/billing/payment-setups/confirmations` | session only |

Each of the four mutations takes an `idempotencyKey`. The two `PUT`s are state
sub-resources rather than verbs: `PUT` the subscription you want, `PUT` whether
it cancels at the end of the period. Setting either to what it already is
succeeds and sends nothing to Stripe, which is what makes a double-pressed
button harmless before the key is even consulted.

`PUT /api/v1/billing/subscription` is one route for two directions because it is
one decision from the person's side. Monthly to annual takes effect immediately
and charges the difference; annual to monthly takes effect at the renewal, via a
Stripe subscription schedule, because ending a year somebody has paid for early
is not what they asked for. A monthly subscription with a renewal still owed
moves at the renewal too, rather than charging a failing card a second time.
Asking for the interval you are already on, while a change is scheduled,
abandons the scheduled change. Which of these a request means is
`subscriptionAction` in `src/shared/domain.ts`, the same function the plan tab
previews it with.

While a cancellation is pending, a change of interval is refused with
`409 CONFLICT`, `details.planEnding: true` and the sentence the plan tab
disables its buttons with, and nothing is sent to Stripe. Either move did
something nobody was shown: the schedule to monthly replaced the cancellation,
so the plan renewed after all, and the upgrade charged the difference for a
year set to end. Turning renewal back on is consent the renewal terms are
displayed for, so it belongs to `PUT …/cancellation` alone. Paying what is owed,
asking for the plan already held, and letting a scheduled switch go still
succeed.

While an operator's grant is in force the same route refuses every request that
would sell something, with `409 CONFLICT` and `details.planGranted: true`. A
grant already outranks Stripe in `resolveEntitlement`, so a sale under one
charges for a plan the person has; the refusal is what stops the charge rather
than merely hiding the button. It is read twice and the second read is the one
that decides -- once before a Stripe customer is made, so a doomed request
leaves nothing behind, and again inside the transaction that does the writing,
which `code/services.md` 2.8 requires because an override expires at a moment
no code observes. Which requests it covers is `sellsSomething`, the same
predicate the wound-down refusal uses, so letting a scheduled switch go and
asking for the plan already held still succeed -- and so does paying a renewal
whose retries ran out, because that settles a debt rather than buying a plan.
A first payment that was never finished is a sale and is refused, on this route
and on `POST …/payment-setups/confirmations`, which is the one that collects it:
refusing the button and leaving that open would have let a granted person buy
the plan they had been given by replacing their card.

A plan set to end is answered before a grant is looked at, so a request that is
both gets `details.planEnding` rather than `details.planGranted`. The order is
the early check's and the locked check follows it, because the two answering one
state differently would put the tab's preview at odds with whichever the request
reached. The plan tab blames the grant only for the presses the grant is
blocking, which is the same line.

`POST /api/v1/billing/payment-setups` answers `200` with no `Location`, alone
among the creates here: what it makes lives at Stripe and has no address in this
deployment. Its `/confirmations` sub-resource is the other half and is not
optional — confirming a card in the browser attaches it to the Stripe customer
and changes nothing about what is billed, so without this call the replacement
card is never the one charged. It names a SetupIntent id, which is an unowned
string, so the server reads the intent back from Stripe and refuses one whose
customer is not the caller's. It refuses a saved method this deployment does not
offer, or one the subscription refuses to bill, with `409` and
`details.paymentMethodType`, before anything is written.

Its answer says what became of anything owed, because a new card is asked to pay
it: `invoice` is `none`, `paid`, `declined` or `needs_authentication`, with
Stripe's own sentence in `declineMessage` where a card was declined and Stripe
gave one. `paidInvoice` stays beside it, and is `invoice === "paid"`. A boolean
alone said `false` both for nothing owed and for a declined card, so the page
reading it closed the form over a payment that had failed. A replay of a key
stored before `invoice` existed answers with the first two fields only, and a
client reads a missing `invoice` as unknown rather than as nothing owed.

### Connected agents

| Route | Scope |
| --- | --- |
| `GET /api/v1/connected-apps` | `ledger:read` |
| `DELETE /api/v1/connected-apps/{clientId}` | `ledger:write` |

A read-only token can list grants and cannot revoke them, so a stolen
`ledger:read` token cannot spend its last minutes locking out the agents it was
stolen from (`src/server/api.ts:1686-1694`).

### Accounts

| Route | Scope |
| --- | --- |
| `GET /api/v1/accounts` | `ledger:read` |
| `GET /api/v1/accounts/{id}` | `ledger:read` |
| `GET /api/v1/accounts/{id}/balances` | `ledger:read` |
| `GET /api/v1/accounts/{id}/register` | `ledger:read` |
| `POST /api/v1/accounts` | `ledger:write` |
| `PUT /api/v1/accounts/{id}` | `ledger:write` |
| `POST /api/v1/accounts/{id}/archived` | `ledger:write` |
| `PUT /api/v1/accounts/active` | `ledger:write` |
| `DELETE /api/v1/accounts/{id}` | `ledger:write` |

### Categories

| Route | Scope |
| --- | --- |
| `GET /api/v1/categories` | `ledger:read` |
| `GET /api/v1/categories/summaries` | `ledger:read` |
| `GET /api/v1/categories/duplicates` | `ledger:read` |
| `GET /api/v1/categories/{id}` | `ledger:read` |
| `POST /api/v1/categories` | `ledger:write` |
| `PUT /api/v1/categories/{id}` | `ledger:write` |
| `POST /api/v1/categories/{id}/archived` | `ledger:write` |
| `DELETE /api/v1/categories/{id}` | `ledger:write` |
| `POST /api/v1/categories/merge` | `ledger:write` |

### Payees

| Route | Scope |
| --- | --- |
| `GET /api/v1/payees` | `ledger:read` |
| `GET /api/v1/payees/suggestions` | `ledger:read` |
| `GET /api/v1/payees/duplicates` | `ledger:read` |
| `POST /api/v1/payees/merge` | `ledger:write` |

### Transactions

| Route | Scope |
| --- | --- |
| `GET /api/v1/transactions` | `ledger:read` |
| `GET /api/v1/transactions/{id}` | `ledger:read` |
| `POST /api/v1/transactions/bulk-selection` | `ledger:read` |
| `POST /api/v1/transactions` | `ledger:write` |
| `PUT /api/v1/transactions/{id}` | `ledger:write` |
| `POST /api/v1/transactions/{id}/deleted` | `ledger:write` |
| `POST /api/v1/transactions/bulk-edit` | `ledger:write` |
| `POST /api/v1/transactions/bulk-delete` | `ledger:write` |

### Staged transactions

| Route | Scope |
| --- | --- |
| `GET /api/v1/staged-transactions` | `ledger:read` |
| `GET /api/v1/staged-transactions/{id}` | `ledger:read` |
| `GET /api/v1/staged-transactions/{id}/duplicate` | `ledger:read` |
| `POST /api/v1/staged-transactions/bulk-selection` | `ledger:read` |
| `POST /api/v1/staged-transactions` | `ledger:stage` |
| `PUT /api/v1/staged-transactions/{id}` | `ledger:stage` |
| `POST /api/v1/staged-transactions/bulk-edit` | `ledger:stage` |
| `POST /api/v1/staged-transactions/bulk-delete` | `ledger:stage` |
| `POST /api/v1/staged-transactions/commit` | `ledger:write` |

Committing is the scope boundary, and it is the point of the queue.
`AGENTS.md`: "`ledger:stage` proposes and never decides."

### Transaction templates

| Route | Scope |
| --- | --- |
| `GET /api/v1/transaction-templates` | `ledger:read` |
| `GET /api/v1/transaction-templates/{id}` | `ledger:read` |
| `POST /api/v1/transaction-templates` | `ledger:write` |
| `PUT /api/v1/transaction-templates/{id}` | `ledger:write` |
| `DELETE /api/v1/transaction-templates/{id}` | `ledger:write` |
| `POST /api/v1/transaction-templates/bulk-edit` | `ledger:write` |
| `POST /api/v1/transaction-templates/bulk-delete` | `ledger:write` |

### Recurrences

| Route | Scope |
| --- | --- |
| `GET /api/v1/recurrences` | `ledger:read` |
| `GET /api/v1/recurrences/{id}` | `ledger:read` |
| `POST /api/v1/recurrences` | `ledger:write` |
| `PUT /api/v1/recurrences/{id}` | `ledger:write` |
| `DELETE /api/v1/recurrences/{id}` | `ledger:write` |

### Budgeting

| Route | Scope |
| --- | --- |
| `GET /api/v1/category-groups` | `ledger:read` |
| `POST /api/v1/category-groups` | `ledger:write` |
| `PUT /api/v1/category-groups/{id}` | `ledger:write` |
| `DELETE /api/v1/category-groups/{id}` | `ledger:write` |
| `GET /api/v1/budget-plans` | `ledger:read` |
| `GET /api/v1/budget-plans/{id}` | `ledger:read` |
| `GET /api/v1/budget-entries` | `ledger:read` |
| `GET /api/v1/budget-report` | `ledger:read` |
| `GET /api/v1/forecast` | `ledger:read` |
| `POST /api/v1/budget-plans` | `ledger:write` |
| `PUT /api/v1/budget-plans/{id}` | `ledger:write` |
| `DELETE /api/v1/budget-plans/{id}` | `ledger:write` |
| `PUT /api/v1/budget-entries` | `ledger:write` |
| `DELETE /api/v1/budget-entries/{id}` | `ledger:write` |

### CSV and import

| Route | Scope |
| --- | --- |
| `POST /api/v1/csv/preview` | `ledger:read` |
| `GET /api/v1/csv/export` | `ledger:read` |
| `GET /api/v1/import-batches` | `ledger:read` |
| `POST /api/v1/csv/stage` | `ledger:stage` |

### Reporting

| Route | Scope |
| --- | --- |
| `GET /api/v1/summary` | `ledger:read` |
| `GET /api/v1/reports/{report}` | `ledger:read` |
| `GET /api/v1/audit-events` | `ledger:read` |

### Outside `/api/v1`

Unversioned, and each for a reason.

| Route | What it is |
| --- | --- |
| `GET /health/live`, `GET /health/ready` | Liveness, and a `select 1` against the database. `503` when the database is unreachable (`src/server/api.ts:432-447`). |
| `/api/auth/*` | Better Auth, plus this product's own sign-up, consent and MCP token routes. No JSON body under it carries the session token: the `HttpOnly` cookie does, and a script that could read the token from a body could do everything the cookie keeps from it (`withholdSessionTokens`, `src/server/http-security.ts:822`). |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | RFC 9728 and OAuth discovery, each also served under `/mcp` and `/mcp/` because RFC 9728 puts the resource path after the well-known segment (`src/server/api.ts:1024-1031`). |
| `/mcp`, `/mcp/` | The MCP transport. Governed by [`mcp.md`](mcp.md). |
| `GET /metrics` | Prometheus text format, and registered only when `METRICS_ENABLED=true`, so a deployment that did not ask for it has no such route rather than a route that refuses. A `METRICS_TOKEN` makes it demand a bearer token. Not proxied by the bundled frontend. |
| `POST /api/billing/webhook` | Where Stripe reports what happened, and registered only when Stripe is configured, so a deployment that sells nothing has no such route. Outside `/api/v1` because everything under that prefix is guarded by `protectBrowserMutation`, which refuses a mutation carrying no matching `Origin` — and a webhook carries none. Authenticated by Stripe's signature over the raw body rather than by a session. Every deliberate no-op answers 2xx, because a non-2xx makes Stripe retry and delays finalization of every auto-collection invoice on the account for up to 72 hours. |
| `GET /robots.txt` | A static file in the client bundle (`public/robots.txt`), so it is served wherever the client is, including by the decomposed profile's nginx. It lets AdSense's crawler read the pages it places ads on and asks every other crawler to stay out, because nothing behind a sign-in belongs in a search index. Unconditional, unlike `/ads.txt`: turning crawlers away costs a deployment that sells nothing nothing. |
| `GET /ads.txt` | The authorized-sellers file, registered only when AdSense is configured. Derived from the publisher id rather than stored, because there is one correct answer for a deployment whose only ad partner is AdSense and it cannot ship in the image — one image serves every operator. `text/plain`, cached an hour. Unversioned because the format is the IAB's. |
| `POST /api/csp-report` | Where a browser posts what the content security policy would have blocked, registered only while `SB_CSP_REPORT_ONLY` is set. Outside `/api/v1` and above its guards because a violation report carries no `Origin` this app would recognize and a content type of its own — under `protectBrowserMutation` every report would be refused before it was read, and the rehearsal would produce a silence indistinguishable from a clean run. Always `204`; it is a one-way message with nobody to tell about a failure. |

**House.** These stay unversioned. `/api/v1` versions this product's own
contract; an OAuth discovery document is versioned by the RFC that defines it,
and putting `v1` in front of a well-known path would make it undiscoverable.
`/metrics` is the name every scraper already looks for, and a versioned one
would have to be configured everywhere to say the same thing.

*Checked by:* `tests/mcp-parity.test.ts:121-136` extracts the registered
`/api/v1` routes from source, so a route added without a tool or a written
exception fails, and `tests/http-route-table.test.ts` now holds the `/api/v1`
tables above to that same extraction in both directions. Four of the rows in
this table have a test of their own, for the half that matters most about them —
that they are absent where unconfigured — and those are named under [A route a
deployment did not ask for is absent, not
refusing](#a-route-a-deployment-did-not-ask-for-is-absent-not-refusing).
*Not checked:* the table itself, which is the surfaces that are not `/api/v1`
and so fall outside both extractions. A row here is still only as published as
somebody remembering to add it.

## Paths and resources

- **House.** A collection is a plural kebab-case noun: `budget-plans`,
  `staged-transactions`, `transaction-templates`, `import-batches`,
  `connected-apps`. camelCase and snake_case both appear in other people's
  guidelines; the path segment is the one place this codebase uses kebab-case,
  and it is consistent.
- **House.** Two levels of nesting, no more. `/accounts/{id}/balances` and
  `/accounts/{id}/register` are the deepest paths here. Zalando's guideline is
  three; two is enough for a ledger with eleven resources.
- **House.** Every path id is a UUID and is parsed at the boundary before it
  reaches a query, through `pathId` (`src/server/api.ts:1527-1528`). Nothing in a
  specification or in `AGENTS.md` requires it; the failure it prevents does. Two
  names are exempt and both are checked another way: `clientId`, which is an
  OAuth client id and not a UUID, and `report`, which is parsed against a closed
  set. Without
  this an id that is not a UUID travels to PostgreSQL, fails a cast, and comes
  back as an unexplained 500 with a stack trace in the log for what was only a
  mistyped URL.
  *Checked by:* `tests/path-id-validation.test.ts`.
- **House.** A state change that a person would name as a state gets a state
  sub-resource, not a verb: `POST /transactions/{id}/deleted` with
  `{"deleted": true}`. The MCP tool is `set_transaction_deleted` for the same
  reason.
- **House.** A verb endpoint is legitimate in exactly three cases, and it is
  the only three the API uses:
  1. **An operation over a set that is not a resource.** `bulk-edit`,
     `bulk-delete`, `bulk-selection`, `commit`. There is no "the selection"
     resource to PUT.
  2. **An operation that destroys the identity of its inputs.**
     `categories/merge`, `payees/merge`. After a merge the source rows do not
     exist, so no method on them describes it.
  3. **A read whose input is too large for a query string.**
     `POST /csv/preview` parses a CSV body and touches no row; it is a POST
     because a spreadsheet does not fit in a URL. The bulk selection previews
     are the same shape: a POST that reads.
- **House.** New custom methods use the colon convention, `:merge`,
  `:bulkEdit`, following Google AIP-136 and the Azure guidelines. Ids here are
  UUIDs, so the colon cannot collide with one. The existing verb paths above
  stay as they are: two conventions cost a reader less than churn costs
  everybody. Renaming a path is a breaking change under every published
  guideline, which is why the bullet below had to argue its four renames rather
  than simply make them.
- **House, and the three inconsistencies that were here are gone.** The paths
  read the way the rules above say now:
  `GET /api/v1/staged-transactions/{id}/duplicate` (`src/server/api.ts:2031`)
  rather than a `staged` collection that existed nowhere else;
  `POST /api/v1/staged-transactions/bulk-delete` (`src/server/api.ts:1947`)
  rather than a `delete` that spelled the same operation as
  `POST /api/v1/transactions/bulk-delete` (`src/server/api.ts:1886`)
  differently; and `POST /api/v1/accounts/{id}/archived` and
  `POST /api/v1/categories/{id}/archived` (`src/server/api.ts:1730`, `:1863`),
  which take `{"archived": boolean}` and are therefore the state sub-resource
  pattern, matching `POST /api/v1/transactions/{id}/deleted`.

  The two `bulk-delete` routes stayed two routes. They are the same word for two
  different operations: one voids committed entries by posting their reversal
  under `ledger:write`, the other removes staged rows that never posted under
  `ledger:stage`. Only the spelling was duplicated.

  Each old spelling still answers, on the same handler, marked with
  `Deprecation` and `Sunset`. The first version of this renamed them outright,
  on the argument in [Nothing outside a browser can reach this API
  today](#nothing-outside-a-browser-can-reach-this-api-today): a cookie, a
  same-origin check and a required content type mean the only client that could
  be calling them ships in the same image as the server that answers. That is
  true of the image being deployed and false of the one already running — a
  browser tab left open across the upgrade is serving the previous build, and
  would have met a 404 on the first archive somebody attempted, with nothing to
  tell it apart from a bug. Paying for `/api/v2` to fix a hyphen would still
  have been an expensive way to keep a promise nobody had been made; keeping the
  old paths for a release is the cheap way to keep the one that matters.

  The MCP tools keep their names. `archive_account` and `archive_category` are
  `verb_noun` and correct, and [`mcp.md`](mcp.md) has already settled that
  renaming a tool breaks configured clients for less than it returns. A path and
  a tool name are different namespaces; `tests/mcp-parity.test.ts` maps one to
  the other by table, which is where the two are allowed to differ.
  *Checked by:* `tests/http-route-table.test.ts`, which holds the tables above
  to the routes `src/server/api.ts` registers and refuses a `staged` segment, a
  path ending in `/archive` or a path ending in a bare `/delete`, so this
  particular drift cannot come back.

### A literal path segment is registered before the parameter route it sits under

**Binding.** Hono answers from the first registration that matches, so a
collection-level literal registered after `:id` is never reached: the parameter
route takes it, `active` or `duplicates` is parsed as an id, and the request
fails UUID validation before any service runs. The caller gets a 422 about an id
they never sent, for a path the published table says exists.

The three that exist today are all registered the right way round —
`PUT /api/v1/accounts/active` at `src/server/api.ts:1718` ahead of
`PUT /api/v1/accounts/:id` at `:1721`, and `GET /api/v1/categories/duplicates`
and `/summaries` at `:1740` and `:1743` ahead of `GET /api/v1/categories/:id`
at `:1746`. The state-sub-resource bullet above is what keeps producing this
shape: a state that belongs to the collection rather than to one row is a
literal segment under a path that already has a parameter route, so every
future collection-level sub-resource adds another.

**The obvious alternative is what this guide already relies on, and it cannot
work.** The published route table and the MCP parity comparison both read
`src/server/api.ts` as text. Neither can see *order* — both would show
`PUT /api/v1/accounts/active` registered, named in the table, and paired with
`set_active_accounts`, with every assertion green, while the route answered
nothing. That is not hypothetical: it is what shipped in the feature's first
draft with all three tiers passing, because the integration test called the
service directly and everything else was reading source. The only check that
can see it is one that asks the router.

*Checked by:* `tests/route-shadowing.test.ts`, which asks `app.router.match`
which registration would answer each of the three and compares it with the path
itself. Its second case is the one that keeps it honest: a real UUID under
`/api/v1/accounts/` must reach `:id`, or the first assertion would pass whatever
the registration order were.

### A route a deployment did not ask for is absent, not refusing

**House.** Five surfaces in this process exist only where their configuration
does: `GET /metrics` under `METRICS_ENABLED`, `GET /ads.txt` under AdSense,
`POST /api/billing/webhook` and the five `/api/v1/billing` routes under Stripe,
and `POST /api/csp-report` under `SB_CSP_REPORT_ONLY`. None of them is
registered-and-refusing. `AGENTS.md` fixes this for one of the five — "`/metrics`
is off unless asked for and registered rather than refusing, so a deployment
that never set `METRICS_ENABLED` has no such route" — and the rule here is that
sentence generalized to the other four, which were each argued separately in
prose and had no rule behind them.

Absence is one less thing to misconfigure, and it is an honest answer to
whoever is asking. A registered route that refuses advertises a capability the
deployment does not have, to a caller who is in no position to do anything with
that information: a scraper, a crawler reading `/ads.txt`, or a payment
processor. The `/api/billing/*` catch-all is what makes the absence read as
absence rather than as the single-page shell.

**The obvious alternative — register it and answer 403 — is right somewhere
else, which is why it is tempting.** `POST /api/auth/sign-up/email` answers
`403 LOCAL_AUTH_DISABLED` on a deployment with local sign-in off
(`src/server/api.ts:513`), and that is correct, because the caller is this
product's own browser, it will render the refusal, and a person will read it.
The test is who is calling. Where the caller is a program that will never show
anybody the body, a refusal is a disclosure with no reader.

**The cost is real and the published tables pay it.** The route list above names
five billing routes most deployments do not have, because the extraction reads
registrations without regard to the `if` they sit inside. A reader working from
the table has to read the "registered only where Stripe is configured" sentence
above it; a reader working from the deployment gets a 404 the table did not
predict. That is the price of the table being generated rather than curated, and
it is cheaper than a table somebody keeps by hand.

*Checked by:* nothing, and no test can check the rule itself — "a capability
nobody configured has no route" is a statement about every route that does not
exist. What is checked is each instance:
`tests/billing-routes-absent.test.ts` for all five plan routes and the webhook,
`tests/ads-txt.test.ts:50` for `/ads.txt`, `tests/csp-report-only.test.ts:98`
for the report endpoint, and `tests/metrics.test.ts:224` for `/metrics`. A seventh
surface added without one of these is the gap this rule leaves open, and it is
left open honestly rather than closed by a test that would pass forever.

## Requests

- **House.** JSON in, JSON out. `Content-Type: application/json` is required
  on every state-changing request, with no body-present exception, and a request
  that omits it is refused with 415 before anything reads the body
  (`src/server/http-security.ts:500-512`). The consequence is real and the
  browser client lives with it: revoking an agent is a `DELETE` that sends `{}`
  purely so it can declare a content type
  (`src/client/pages/SettingsPage.tsx:630-639`).
  *Checked by:* `tests/api-security.test.ts:64-88`, both halves, the refusal and
  the bodyless request that gets through the gate.
- **House.** A malformed or absent JSON body is a 400 with a message saying so,
  not a 500. Every mutation reads its body through one helper for this reason
  (`src/server/api.ts:1507-1517`); before it existed a truncated body arrived as a
  500 with a stack trace in the log.
- **House.** Request bodies are bounded, and the bound is derived from a
  documented cap rather than chosen. The figures come from this repository
  rather than from anything published, which is why the derivation matters more
  than the numbers. **Five limits**, and the order they are tried in is the
  order they are written: 64 KiB for `/api/auth`, **128 KiB for
  `/api/csp-report`**, then a CSV-derived limit for `/csv/preview`,
  `/csv/stage` and `/mcp`, a selection-derived limit for any route whose last
  segment is `bulk-edit`, `bulk-delete`, `bulk-selection`, `commit` or
  `delete`, and 256 KiB for everything else under `/api/v1`
  (`src/server/http-security.ts:380-398`, `:985-1001`, `:1069-1077`). A limit is
  derived, not guessed: the template mass edit and mass delete were once sized
  as ordinary requests, so a selection their own schemas accepted came back 413.
  Recognizing a bulk route by shape rather than by a hand-kept list is what
  stops that recurring.

  The report limit is the one whose derivation is a measurement, and its
  docblock carries it (`:1055-1068`): Chromium batches pending violations into
  one delivery rather than posting one report each — about 17 KiB for seventeen
  and 100 KiB for a hundred — so a limit sized for a single report answers that
  batch 413 and logs nothing, and the rehearsal records the first violation and
  drops the one naming the host it exists to find. It is checked before the
  `/api/v1` limit and sits far under it, because this is the one route nothing
  authenticates.

  *Checked by:* `tests/http-security.test.ts:338-440` for the arithmetic, and
  `tests/http-security.test.ts:744-756`, which walks the registered routes so no
  bulk-shaped route can be added without its limit.
- **House.** Field names are camelCase in bodies and in query strings, matching
  the Azure guidelines, the adidas guidelines and protobuf JSON, and disagreeing
  with Zalando, which requires snake_case on the grounds that no industry
  standard exists. Settled here because the same Zod schemas are the browser's
  types and the MCP tool arguments, and translating at one of three boundaries
  would be a third spelling of every name. See
  [`common.md`](common.md#naming).
- **House, and a live gap.** Unknown query parameters and unknown body fields
  are an error. Newer schemas are `.strict()`; the older core ones are not.
  `listQuerySchema` (`src/shared/domain.ts:2028-2095`) accepts anything, so
  `?sortt=date` returns page one in the default order with a 200, which is the
  wrong answer delivered confidently. The bulk filter schema derived from it
  **is** strict (`src/shared/domain.ts:2103-2105`), so the two disagree about
  the same parameter set. Make `listQuerySchema` strict. The two staged
  selection schemas were the same disagreement between callers rather than
  between schemas, and are strict now; see [the bulk selection
  contract](#the-bulk-selection-contract).
  *Checked by:* `tests/list-bulk-filter-keys.test.ts` for the names — the two
  schemas' key sets agree once presentation is taken out, in both directions and
  for the staged pair too, and every key a filter accepts is applied by the
  resolver that turns it into SQL. The strictness half stays open deliberately:
  making `listQuerySchema` strict would refuse a request a deployment on the
  previous release has been sending and getting a 200 for, so it is a later
  release's job. The comparison needs none of it and catches the next
  divergence.
- **House, settled.** A boolean query parameter is read one way.
  `queryBoolean` refuses anything that is not `"true"` or `"false"`. Five routes
  used to compare `c.req.query("includeArchived") === "true"` by hand, so
  `?includeArchived=yes` silently meant false: the caller asked for something,
  was not refused, and got the opposite. All five go through
  `includeArchivedFlag` (`src/server/api.ts:1560-1561`), which parses with the shared
  schema.

  The budget report was the sixth, and it was found after the other five: it
  kept its own `=== "true"` in the transport for two flags that default to
  **on**, so `?includeArchived=1` turned them off without saying so, and on that
  report off means every penny spent through a closed account leaves the
  figures. The only thing that differed was the default, so `queryBoolean` takes
  one (`src/shared/domain.ts:1542-1550`) and the route hands the schema the raw
  query. `tests/domain.test.ts` holds both halves: the two spellings that work,
  and that `1`, `yes`, `TRUE`, `on` and an empty value are refused rather than
  read as off.
- **House.** A repeated query parameter is not supported. Hono's `c.req.query()`
  keeps the first occurrence, so `?accountId=a&accountId=b` silently drops `b`.
  State it, and if a filter ever needs multiple values it takes a
  comma-separated list with a documented separator rather than repetition.
- **Binding.** No request ever names a user. `AGENTS.md`: "Never accept a public
  `userId`."

### A body limit is derived three times, and the application's is the innermost

**House.** The limits above are the application's, and they are the last of
three an import passes. Whatever terminates TLS sees the body first and whatever
proxies it sees it second, so **both outer ones have to be at least the inner
one**. Either set below it turns an import this product advertises into a 413
the application never gets to explain: the request never reaches the code that
knows what the limit is or how to say so, and nothing lands on screen but a
refusal from a server the person has never heard of.

Both outer figures are in this repository, which is what makes this a rule here
rather than a note to an operator: `SB_MAX_UPLOAD_SIZE` in the frontend image
and `MAX_BODY_SIZE` in the `single` profile's Caddy. What each of those
configures, and which deployment shapes have which, is
[`operations.md`](operations.md#a-deployment-profile-is-a-shape-not-a-setting)
and [`operations.md`](operations.md#documenting-a-variable); describing them
here would be the second copy that goes stale.

**The obvious alternative is that the proxy is the operator's problem, and it is
wrong twice over.** This repository ships the proxies, so there is no operator
to hand it to for the shapes it builds. And the defect it already produced was a
unit rather than a number: nginx reads `61m` as binary and Caddy reads `61MB` as
decimal, so two spellings that look identical were 63,963,136 and 61,000,000 —
with the application accepting 62,980,096, which falls between them. A 61.5 MB
CSV was accepted by the API, refused by the terminator, and correct according to
both files. Nobody reading the two numbers side by side would have seen it;
Caddy's side says `61MiB` now because a test worked it out in bytes.

*Checked by:* `tests/upload-limit-agreement.test.ts`, which parses each
spelling in its own units and asserts three things: that each terminator will
carry at least `apiRequestBodyLimit("/api/v1/csv/stage")`, that the application's
own limit is the CSV-derived one rather than the generic one, and that the two
terminators describe **the same** ceiling rather than merely two sufficient
ones. The last is the assertion that catches a unit mistake, since a decimal
spelling large enough to pass the first would still be a different number from
the binary one beside it.

### Absent, null and empty are three different things

**Binding.** `AGENTS.md`, on the template mass edit: "A patch key left out
leaves the field alone, a value sets it, and `null` clears it back to blank; an
empty string is refused rather than read as a clear."

**House.** That distinction is the rule for every patch body on this API, not
only for template mass edits.

- **Absent** means do not touch this field.
- **`null`** means clear it. It is only accepted where the field is nullable.
- **`""`** is refused. An empty string is what an unfilled form control sends,
  and reading it as "clear this" turns a mis-click into a data loss.

The budgeting schemas already follow it: `activeTo` present and null ends a
plan, absent leaves it alone (`src/shared/domain.ts:1786-1815`). So does the
template mass edit, whose schema comment says why blank and absent have to stay
different: "blank and absent being different is the whole of what a stored draft
records" (`src/shared/domain.ts:891-897`).

**Where the code disagrees.** Three patch schemas answer this question and two
of them read `""` as a clear rather than refusing it. The transaction bulk patch
carries `.transform((value) => (value === "" ? null : value))` on `description`
and `notes` (`src/shared/domain.ts:2250-2263`), pinned by
`tests/domain.test.ts:144-185`, and the staged bulk patch carries the identical
transform on the same two fields (`src/shared/domain.ts:2544-2557`). The
template mass edit (`:963-974`) is the only one of the three that refuses the
empty string. So fixing only the transaction path leaves the same defect on the
staged one. There is an argument for the
transform, that a transaction description has no "unset" state distinct from
blank the way a template field does, but it is nowhere written down and the
template schema's comment argues the opposite case at length. Either document
the distinction beside the transform or remove it.

This three-way rule is also why the API takes `PUT` with a partial body and a
discriminated patch object on a bulk edit, rather than `PATCH` with JSON Merge
Patch (RFC 7396). The `PUT` is not RFC 9110's whole-representation replace, and
an earlier version of this sentence said it was: `accountUpdateSchema`,
`categoryUpdateSchema` and `transactionTemplateUpdateSchema` are all
`.partial()`, so a key left out is left alone, which is the absent half of the
rule above. The method stays, because changing it would break every client
that has sent one. Merge patch gives `null` the meaning "remove" and has no way
to express "refuse the empty string", and RFC 7396 itself says merge patch "is
not appropriate for all JSON syntaxes". A ledger is one of the documents it is
not appropriate for.

*Checked by:* `tests/domain.test.ts` for the two patch schemas as they stand,
and `tests/http-envelope-and-patch.test.ts` for the two agreeing with each
other — by asking them, field by field, with a battery that straddles absent,
`null`, `""` and a value, because a `.transform` is invisible to a reading of
`.shape` and the transform is the whole subject. It also holds that a key left
out never comes back as the same thing an explicit `null` does. Still not
checked mechanically: that a *new* nullable field follows the three-way rule,
which is a judgement about a field that does not exist yet.

**And the two `patch` field descriptions contradict the code**, which is worth
recording here rather than leaving to be re-found. Both parent schemas describe
`patch` as "An empty string is refused rather than read as a clear" while
`description` and `notes` transform `""` to `null` — and their own field
descriptions say so, two lines below. The sentence is true of the three uuid
fields and false of the two free-text ones. Resolving it is the same decision
this section already names: document the distinction or remove the transform.
Removing it changes what a client that sends `""` today gets, so it is a
deprecation rather than a fix.

## Responses

- **House, and eleven listings predate it.** A single resource is returned as
  the object itself, with no envelope. A collection is returned as one of two
  envelopes and no third.

  **The rule stands and the code does not follow it yet, and that is a decision
  rather than an oversight.** Eleven listings return a bare array —
  `list_accounts`, `list_categories`, `list_payees`,
  `list_payee_suggestions`, `list_transaction_templates`,
  `list_category_groups`, `list_budget_plans`, `list_budget_entries`,
  `list_duplicate_categories`, `list_duplicate_payees` and
  `list_connected_agents` — which is the third shape, arrived at by there being
  no rule when they were written. `list_recurrences` is a twelfth case of its
  own: `{today, items}`, because a schedule read on Tuesday means something
  different from one read on Wednesday and `AGENTS.md` requires a summary to
  report the day it used. That datum is real; the shape around it is still not
  one of the two.

  Turning `[…]` into `{items: […]}` is not additive. It removes no field and
  changes no field's type — it changes the type of the *whole response*, so
  every client reading `response[0]` breaks, which the breaking-change list
  below names and `AGENTS.md` forbids a release from doing. Closing it needs
  `/api/v2` or a deprecation cycle, and it is a later release's job.

  *Checked by:* `tests/mcp-output.test.ts`, which reads the success arm of every
  listing's published output schema and requires `items` and `nextCursor` — with
  the twelve named in a register carrying this reason. The value of the check is
  the **thirteenth**: a listing added now has to use an envelope, because adding
  a name to that register is a decision somebody makes in a diff rather than a
  shape that arrives by nobody thinking about it. A register entry naming a tool
  that no longer exists fails too, so the register cannot drift the way the
  shapes did.
- **House.** Two list envelopes:
  - `Page<T>`: `{items, nextCursor}` (`src/shared/domain.ts:2696-2700`), where
    callers only stream forward.
  - `PaginatedPage<T>`: `Page<T>` plus `{page, pageSize, totalCount,
    totalPages, cursorAvailable}` (`src/shared/domain.ts:2702-2716`), where
    `cursorAvailable` says whether this ordering can be resumed with a cursor.
- **House.** `201 Created` on a create that mints a row, `200 OK` on everything
  else that succeeds. **No `/api/v1` route returns `204`**; every response there
  has a body, because an MCP tool result cannot be empty and the two transports
  return the same thing. The client's dead `204` branch is gone with it.

  **One route outside `/api/v1` does, and the exception is the rule's own
  argument running out.** `POST /api/csp-report` answers `204` always
  (`src/server/api.ts:1311`). It has no tool and can never have one — a browser
  posts to it, nothing reads the answer, and there is nobody to tell about a
  failure — so "the two transports return the same thing" is a constraint with
  one transport in it. Scope the rule to `/api/v1` rather than quietly allowing
  a second empty body: a route here that wanted `204` would have to make the
  same argument, and no `/api/v1` route can.
- **House.** A `201` carries a `Location` header naming the created resource,
  per RFC 9110 section 10.2.2. All eight creates go through one helper
  (`src/server/api.ts:1532-1552`) rather than each remembering it, because a
  route that forgot would be indistinguishable from a route that meant not to
  send one. Purely additive, so no client that worked against the previous
  release stops working. `POST /api/v1/category-groups` is the one whose
  `Location` has no `GET` behind it: `PUT` and `DELETE` answer there, and the
  URI identifies the resource either way.
- **Binding.** Money is a decimal string, everywhere, with the currency as a
  separate sibling ISO 4217 field. No response has anywhere to put a figure that
  spans currencies. See [`common.md`](common.md#money).
- **Binding.** Dates and instants are settled in
  [`common.md`](common.md#dates-and-times), and this API adds nothing to them.
- **House.** Do not adopt RFC 9557 bracketed time zone suffixes on the wire. The
  person's timezone is already a preference, and a bracketed suffix would create
  a second place that answers "which day is it where they live", against
  `AGENTS.md`: "Whether it is a given day, or a given time of day, where
  somebody lives is answered in one place."
- **House.** Enumerations in responses are extensible: a client must tolerate a
  value it has not seen. Over MCP this is not advice but enforcement, since
  `AGENTS.md` fixes that "a tool whose result does not satisfy its declared
  output schema fails the call …".
- **House.** `GET /api/v1/csv/export` is the only route whose *default*
  representation is not JSON: `text/csv; charset=utf-8; header=present` with a
  `Content-Disposition` filename (`src/server/api.ts:2012-2024`). Its format is
  governed by [`csv.md`](csv.md). Two routes offer a second representation
  beside their JSON one, chosen by `Accept`; see
  [Streaming a response](#streaming-a-response).

*Checked by:* `tests/http-security.test.ts` for headers, body limits and that
every 429 names an interval, `tests/mcp-output.test.ts` for the envelope rule
over every listing's published output schema, and `tests/cursor.test.ts` for the
cursor's ordering binding. That a single resource carries no envelope is
`tests/http-envelope-and-patch.test.ts`, a walk over the registered routes of
the kind `tests/http-security.test.ts` already does for body limits — scoped to
the routes whose last path segment is a parameter, which is the half of the
rule with no exceptions in it. The eleven listings above are outside it, and
deliberately: a check written against the whole sentence would report them as
failures on code this section has already argued about.

### Status codes

**Binding**, RFC 9110 semantics. One code per situation, and one situation per
code.

| Status | When |
| --- | --- |
| 200 | A read, a write that changed something that already existed, or a write answered with a report rather than a resource |
| 201 | A create that minted a row |
| 400 | The body is not JSON, or its framing headers contradict it (`INVALID_CONTENT_LENGTH`, `REQUEST_BODY_NOT_ALLOWED`) |
| 401 | No session, and once SB-030 lands, no acceptable bearer token |
| 403 | Cross-origin state change, or an operation the deployment has disabled, or re-authentication required |
| 404 | No such route, no such row, or a row belonging to somebody else |
| 409 | `STALE_VERSION`, `DUPLICATE`, `CONFLICT`, and an idempotency key reused with a different request |
| 413 | Body over the derived limit for that path |
| 415 | Missing or unacceptable `Content-Type` on a state change |
| 422 | The body is valid JSON and valid against no rule the ledger will accept, and — a gap, below — a path id that is not a UUID |
| 429 | Rate limited: the setup-code limiter (`src/server/api.ts:552-566`), and Better Auth's production limiter on `/api/auth` (`src/server/auth.ts:127-131`) |
| 500 | Anything unhandled, with no detail |
| 503 | `GET /health/ready` when the database is unreachable |

- **Contested: 400 versus 422 for a semantic failure.** RFC 9110 defines 422 as
  the content type and syntax being understood but the instructions not
  processable. Zalando marks 422 `do-not-use` and sends everything to 400,
  because "400 already covers most use-cases and there does not seem to be a
  clear benefit to differentiating between them". **This product uses 422**, and
  the benefit Zalando could not see is specific here: 400 means the request was
  never a request, and 422 means it was a well-formed request the ledger
  refused. Those two need different handling from an agent, which can retry
  neither but can explain only the second.
- **House.** One code maps to one status. `VALIDATION_ERROR` was 422 from a
  service and 400 from the malformed-body guard, so on that code the status
  carried information the code did not, which is backwards. The malformed body
  now has its own code: `MALFORMED_BODY` at 400 (`src/server/api.ts:1515`),
  raised as a `TransportError` rather than an `AppError`
  (`src/server/services/errors.ts:13-23`), which is also what keeps it out of
  the service vocabulary an MCP tool can raise. Adding a code is not a breaking
  change; changing `VALIDATION_ERROR`'s 400 site to 422 would have been.
- **House, and recorded rather than changed.** Three writes mint rows and
  answer 200. `PUT /api/v1/budget-entries` inserts a row the first time a
  period's amount is set and updates it after: it is a set addressed by its key
  — a budget and a period — so the caller already knows where the row lives and
  a `Location` would tell it nothing. `POST /api/v1/csv/stage` and
  `POST /api/v1/staged-transactions/commit` mint many rows each and answer with
  a report of what happened to the batch, which is not one resource with one
  address. All three have answered 200 since they shipped, and a client
  checking for exactly 200 is a client a 201 would break.
- **House, and recorded.** The two disabled sign-in methods answer differently,
  and the difference is the one §A route a deployment did not ask for is
  absent, not refusing draws. `POST /api/auth/sign-up/email` is this product's
  own form, so `403 LOCAL_AUTH_DISABLED` is a refusal a person reads.
  `/api/auth/callback/google` is reached by a redirect from Google, so it
  answers `404 GOOGLE_AUTH_DISABLED`: absent, with a code for the one person
  who arrives from a redirect started before the method was turned off.
- **House, and a gap.** A missing `expectedVersion` should be `428 Precondition
  Required` (RFC 6585), which says exactly what happened and which Zalando rates
  `use`. Today it is a Zod failure and a 422
  (`src/shared/domain.ts:1233-1248`, `src/server/api.ts:388-411`).
- **House, and a mismatch.** A path id that is not a UUID can never name a row,
  so the answer is 404, for the same reason a stranger's id is 404: what the
  caller asked for is not there. Today `pathId` raises a Zod failure
  (`src/server/api.ts:1527-1528`) which the global handler renders as a 422
  (`src/server/api.ts:388-411`), so a mistyped URL and a rejected body look the
  same to a client. The 404 catch-all already answers a mistyped *path* this
  way; a mistyped *id* should match it.
- **House, and a gap.** A wrong method on an existing path should be 405 with
  `Allow`. Today it falls to the catch-all and is a 404
  (`src/server/api.ts:2060-2062`). OWASP's REST guidance is to allowlist methods
  and reject the rest with 405.
- **House.** A 429 carries `Retry-After`. Neither of the two the process emits
  did. The setup-code limiter now sends the window it counts by, taken from the
  limiter rather than written beside it (`src/server/http-security.ts:680-687`)
  — the whole window rather than what is left of it, because the remaining time
  is known only to whichever replica counted the first attempt and a local
  reading can be shorter than the truth. Over-reporting only makes the caller
  wait longer than they had to; under-reporting sends them back for a second
  429. Better Auth's own limiter sends the non-standard `X-Retry-After` its
  library chose, and the `/api/auth/*` middleware mirrors it into the standard
  header on the way out (`src/server/api.ts:463-472`) rather than renaming it,
  so a client already reading the non-standard one keeps working. `Retry-After`
  is standard in RFC 9110; the `RateLimit-*` draft headers are not, their syntax
  has changed between revisions, and pinning to them buys nothing yet.

*Checked by:* `tests/http-security.test.ts` for the security and cache headers,
for the body limits, and for `Retry-After` on every 429; `tests/cursor.test.ts`
for the cursor's ordering binding. *Not checked:* that a single resource is
returned without an envelope, which is a walk over the registered routes of the
kind `tests/http-security.test.ts` already does for body limits. The three gaps
named in this section are gaps still: 428 for a missing `expectedVersion`, 404
rather than 422 for a path id that is not a UUID, and 405 with `Allow` for a
wrong method.

## Errors

### The envelope, and where it is going

**Binding for the shape.** [`common.md`](common.md#errors) fixes it:
`{ error: { code, message, details? } }`, one enumeration, published. Over MCP
it is the `result` member; over HTTP it is the body today
(`src/server/api.ts:369-422`).

**Contested, and this is the live decision.** The conformance target in
[`index.md`](index.md#conformance-targets) is RFC 9457 problem details, and this
API does not emit them. RFC 9457 is Standards Track, obsoletes RFC 7807, defines
`type`, `title`, `status`, `detail` and `instance`, and uses the media type
`application/problem+json`. The argument against adopting it was that an MCP
tool result has no HTTP status line, so a machine-readable `code` inside the
body is not a convenience but the only channel, and problem details would add
three members beside a `code` that still has to exist.

Publishing the API settles it, because a stranger's HTTP client knows RFC 9457
and does not know this product's envelope. **The rule:**

- On HTTP, an error is `application/problem+json` carrying `type`, `title`,
  `status` and `detail`, plus two extension members: `code`, which is the
  `ApiErrorCode`, and whatever named members the situation needs. RFC 9457
  permits extensions and requires consumers to ignore ones they do not
  recognize.
- `type` is a stable URI under this deployment's base URL, one per code. It is
  an identifier, not a page that has to exist, though it should resolve.
- `title` does not change from occurrence to occurrence. `detail` is the
  sentence a person reads, and it is the message [`common.md`](common.md#errors)
  specifies.
- Over MCP the same `AppError` renders as `{ error: { code, message, details } }`
  exactly as `common.md` says, because MCP has no media type and no status line.
  One error object, two renderings, one enumeration.
- **The migration keeps `error` as an extension member** for one deprecation
  window, because the browser client reads `payload.error.code`,
  `payload.error.message` and `payload.error.details`
  (`src/client/api.ts:125-173`), and so may anybody who built against the API
  before this guide existed. Then it goes at the sunset date.

Until that lands, the honest statement is: **this API does not conform to its own
error target.** It is recorded here rather than quietly dropped.

**And it obliges an edit to a spine document.** `common.md` fixes the envelope
as Binding, "One envelope, everywhere. `{ error: { code, message, details? } }`.
Over HTTP it is the body". Adopting problem details makes that false of HTTP, so
`common.md`'s error section is amended in the same commit that adopts them, as
[`index.md`](index.md#changing-a-rule) requires: "Change it here, in one place,
and change every file it governs in the same commit." This guide cannot make
that edit, so recording that it is owed is the whole of what it can do. Until
the commit lands, the two documents disagree about the same bytes and
`common.md` is the one describing what ships.

*Checked by:* `tests/api-security.test.ts` for the shape on the paths it covers,
and for the code each of those refusals names being a member of `apiErrorCodes`;
`tests/service-errors.test.ts` for one code mapping to one status, which it
derives by reading the `(code, status)` pair off every `AppError` and
`errorResponse` construction and grouping by code.

### Rules that hold either way

- **House.** The published enumeration is frozen contract, and it is complete.
  `apiErrorCodes` (`src/shared/domain.ts:2668`) is the sum of two lists
  held apart on purpose: `serviceErrorCodes`, the nine an `AppError` can carry,
  and `transportErrorCodes`, the six the transport refuses with before a service
  runs — `CROSS_ORIGIN_REQUEST` (`src/server/http-security.ts:495`, `:564`),
  `UNSUPPORTED_MEDIA_TYPE` (`:509`, `:548`), `PAYLOAD_TOO_LARGE` (`:969`,
  `:1015`), `INVALID_CONTENT_LENGTH` (`:958`), `REQUEST_BODY_NOT_ALLOWED`
  (`:985`) and `MALFORMED_BODY` (`src/server/api.ts:1515`), which the
  [status codes](#status-codes) section above argues for by name and which is
  therefore the sixth rather than an addition this list has not caught up with.
  All fifteen reach a caller from `/api/v1` in this guide's own
  envelope, so all fifteen are published; the split is what stops a service
  raising a transport code, because `AppError`
  (`src/server/services/errors.ts:31-61`) takes `ServiceErrorCode`, and a code
  naming something that happened before there was an actor is not one a service
  can have seen. Adding a code is additive; removing one, repurposing one, or
  changing the status it maps to is breaking, on the Azure guidelines' reasoning
  that error code strings "cannot change in the future" because customer code
  compares against them.

  Five of these were on the wire and in no enumeration at all for a while, and
  the lesson is the typed parameter rather than the list: an enumeration that
  anything can bypass is not a contract, it is what somebody remembered.
  **Settled.** `errorResponse` takes `TransportErrorCode` rather than `string`,
  which is what made the gap possible in the first place, so the compiler now
  holds the transport half the way it already holds the service half.
- **House, and settled by addition rather than by replacement.** One envelope on
  every route this process serves. `/api/v1` used the envelope and the auth,
  consent and setup routes answered with a flat `{code, message}` that the
  browser's own reader cannot see, because it looks inside `error`. All
  fifteen now send both, through `transportError`
  (`src/server/api.ts:513`, `:538`, `:561`, `:570`, `:582`, `:598`, `:609`,
  `:646`, `:801`, `:880`, `:886`, `:895`, `:929`, `:936` and `:1194`): the flat
  pair a 0.1.5 client reads, and the envelope everything else in the product
  uses. The fifteenth is the Stripe webhook's signature refusal, which is
  neither auth nor consent nor setup but reaches a caller the same way.
  Dropping the flat half is a later release's job, once the envelope has been in
  the field — the same rule the renamed routes follow, and the reason this was
  not simply swapped.
  **One named exception:** the `/.well-known` catch-all returns
  `{error, error_description}` (`src/server/api.ts:1048-1050`). That is the OAuth
  error shape, its reader is an OAuth client, and it is correct there.
- **House, and settled the same way.** Field errors are `{field, message}` with
  `field` a dotted path. `zodIssues()` produces exactly that
  (`src/server/services/errors.ts:180-185`) and MCP uses it
  (`src/server/mcp.ts:300`); the global HTTP handler shipped `error.issues`
  straight from Zod, putting the validator's own discriminators on the wire as
  public contract. Each issue now carries `field` beside what it already had
  (`src/server/api.ts:404-407`), because 0.1.5 shipped the raw issue and a client
  reading `path` still works. Under problem details this array becomes
  `errors`, and dropping the Zod half belongs with that change.
- **House, following AIP-193 and the Azure guidelines.** Any number in a message
  also appears in the details as a field: the ten thousand row cap, a byte
  limit, the count in a stale bulk selection. A client should never have to
  parse a sentence to learn a number. Eight refusals broke it until the sweep
  that found them: both CSV caps, the export cap, the 413, both report bounds,
  the budget report's, and the frozen-account refusal. They carry `limit` now,
  and the register gets `postingCount` and the frozen refusal `accountId`
  beside it. `tests/refusal-numbers.test.ts` holds the rule from the other
  direction, since which interpolation is a number cannot be read without a
  type checker: every value a refusal sentence interpolates is in its details,
  or is named in `NOT_A_NUMBER` with the reason it is not one, and a sentence
  composed by a helper is named in `COMPOSED` with the details key its number
  arrives in.
  **The frozen refusal differs in one more way and keeps it.** It is
  `422 VALIDATION_ERROR` where every other plan limit is `409 CONFLICT`. A
  client that branches on the code would see a change of status as a different
  refusal, so the difference is recorded rather than fixed.
- **House.** No stack traces, no SQL, no bound parameters, ever. The docblock on
  `log.failure` at `src/server/log.ts:75-90` says why, and it is not
  boilerplate: "Drizzle builds an error's message out of the failing SQL *and
  its bound parameters*, and one of those parameters is the OAuth access token
  the MCP token endpoint looks a grant up by. Logging such an error whole
  writes a live credential into the log on any database hiccup." The 500 body
  is a fixed sentence with no detail (`src/server/api.ts:418-421`), and the
  comment above it at `src/server/api.ts:413-416` says why the narrowing is
  not done there.
  The narrowing is not this route's: it lives in `log.failure`
  (`src/server/log.ts:91-101`), so all five paths in this process that can log a
  database error get it — `src/server/index.ts:118`,
  `src/server/scheduler.ts:138`, `src/server/db/migrate.ts:197` and
  `src/server/db/client.ts:33` and `:92`. It was a route-level guard for a
  release, which meant the agent transport logged whole what this one redacted.
- **House.** What an error sentence says is settled in
  [`common.md`](common.md#errors), including the worked sentences for both
  readers.

*Checked by:* `tests/api-security.test.ts` for the transport refusals,
`tests/refusal-numbers.test.ts` for a number in a message,
`tests/mcp-output.test.ts` for the MCP rendering, and `tests/service-errors.test.ts`
for the two rules that used to be greppable and ungrepped: one code maps to one
status, and no route builds an error body by hand. *Also checked by:*
`tests/transport-code-status.test.ts` for the two shapes that one cannot reach,
described in the paragraph below it; it holds the guide's own count of
twenty-three refusals, because a parser that stopped reading the multi-line
`c.json` wrapper would find no ambiguity and look like a pass. The second carries two named
exceptions rather than a blanket skip — the OAuth `{error, error_description}`
shape RFC 6749 specifies, and the JSON-RPC `-32000` on the `/mcp` mount, which
is a different protocol's envelope on a route this guide does not govern.

**What the check for the first of those cannot see, and it is the half that
matters.** It reads `new AppError(` and `new TransportError(` constructions
(`tests/service-errors.test.ts:150-168`), which is where a *service* names a
status. It sees neither of the two places a *transport* does: the
`errorResponse(context, status, code, …)` call sites in
`src/server/http-security.ts`, where the status is the second argument, and
`transportError(code, message)` in `src/server/api.ts`, where the status is a
literal on the `c.json(…, 4xx)` beside it. Those two carry twenty-three
refusals between them, and the sentence above is why nobody looked at them.

**House, and the gap is closed.** One code meant two statuses: `UNAUTHORIZED`
was 401 on the two OAuth consent routes and 400 on the Stripe webhook's
signature refusal. Both were defensible on their own — a browser with no session
is told to sign in, and Stripe documents 400 for a delivery whose signature does
not verify — which is exactly the shape the rule exists to refuse: a client
cannot branch on a code that does not decide. The `errorResponse` sites were
clean; this was the only split.

The webhook's refusal now answers `INVALID_SIGNATURE`
(`src/server/api.ts:1194`), which is the move `MALFORMED_BODY` made when it
split off from `VALIDATION_ERROR` for the same reason. Adding a code is
additive, so nothing a client handled narrows; the status is unchanged, which is
all Stripe reads. It is deliberately **not** in `apiErrorCodes`, because that
enumeration scopes itself to what a caller reads off `/api/v1` and
`/api/billing/webhook` is not one — the same argument that keeps the eight
`/api/auth` codes outside it.

The reasoning is here rather than in a comment at the call site, which is the
exception to this repository's habit and has a reason: `src/server/api.ts` is
cited by line from four guides, and a comment block at line 1184 moves
twenty-five of those citations for a decision that is one token wide. The line
itself is one `grep INVALID_SIGNATURE` from this paragraph.

Building the test was the first half of making that decision rather than a
reason to defer it, and it was: written against the two shapes, it named the
split on its first run.

*Not checked:* that every code an interface can emit is in the published
enumeration, which needs a running server rather than a grep.

## Pagination

**Binding.** `AGENTS.md`: "Lists order by any column they display, in either
direction. Order is presentation, so it stays out of the fingerprinted bulk
selection filter. A cursor records the order it was issued for and is refused
under another; an ordering a keyset cannot resume offers no cursor and pages by
number instead."

That invariant is why this API has both mechanisms, and it is not indecision.

- **House.** A cursor is for walking a collection: stable under insertion,
  cheap, and the only correct way to export or to page through a ledger that is
  being written to. A page number is for jumping: it is what a browser draws
  when somebody wants page seven, and it is the only thing available for an
  ordering a keyset cannot resume, such as one that sorts by a name reached from
  another table (`src/server/services/sorting.ts:4-11`).
- **House.** When both `cursor` and `page` are sent, the cursor wins and `page`
  is reported as 1 (`src/server/services/transactions.ts:1463-1465`).
- **House, following AIP-158.** `nextCursor: null` is the end signal, and the
  only one. The Azure guidelines forbid exactly that spelling; AIP-158 permits
  it. Keep the null, because the field's presence is contractual: Zod output
  schemas and MCP output validation make an absent field a failure, not an
  inference.
- **House, an overload since fixed.** `nextCursor: null` used to mean two
  things: the collection has ended, and this ordering issues no cursors at all.
  A client could not tell them apart, so the envelope now says which:
  `cursorAvailable` rides on every paginated page from both listings
  (`src/shared/domain.ts:2702-2716`), and a null beside `cursorAvailable: true`
  is an ended collection rather than a guess. [`mcp.md`](mcp.md) records the
  same field on the tool side.
- **Binding.** A cursor binds the ordering it was issued for and is refused
  under another, with a message telling the caller to start again from the first
  page (`src/server/services/cursor.ts:128-194`).
  *Checked by:* `tests/cursor.test.ts`.
- **House, and it used to bind only the ordering.** A cursor must bind
  everything that defines the collection. It carried `key`, `direction`, `sort`
  and `id`, so changing the sort between pages was caught and changing a
  **filter** was not: `accountId`, `categoryId`, `templateId`, `payee`, `type`,
  `currency`, `search`, `start`, `end` and `includeDeleted` could all move and
  the keyset resumed silently into a different collection — handing back rows
  from a query nobody asked for, with the row count still reporting the truth of
  the *new* collection, which is what made it silent.

  It now carries `filters`, a fingerprint of the query with the presentation
  keys taken out (`src/server/services/cursor.ts:25-72`). **State the
  symmetry:** a cursor binds the collection it walks, a bulk selection binds the
  rows it changes, and both refuse rather than quietly covering something else.
  Four things about how it is built, each of which was a way to get it wrong:

  - **The scope is derived by exclusion, not enumerated.** Everything except
    `sort`, `direction`, `cursor`, `page` and `limit` is part of the
    collection, so a filter added to a list schema is bound without anybody
    remembering — which is the failure the member exists to prevent, one level
    up. The five excluded are the ones `AGENTS.md` calls presentation.
  - **The canonicalizer is the one this product already has.**
    `idempotencyRequestHash` sorts keys, drops `undefined` and renders dates as
    ISO strings, so two spellings of one query hash alike. Two canonical forms
    is a way for one of them to drift.
  - **Sixteen hex characters.** The payload is signed, so no caller can build a
    cursor whose fingerprint matches a collection it did not come from; what is
    left is accidental collision between two of one person's own filter
    combinations, and 64 bits is far past enough. The rest would be 48
    characters on every cursor for nothing.
  - **Absent means unbound, and is accepted.** A cursor issued before this
    existed carries no fingerprint, and refusing it would narrow a working
    client. It goes with the unsigned encoding, on the same date.

  Two of the four cursor-taking listings pass one, because the other two have no
  filters to bind: the audit log and the import-batch list take `cursor` and
  `limit` and nothing that narrows what they walk. Both say so at the call site,
  so a filter added there is a decision rather than an omission.

  A refusal names which of the two moved. A message about the sort when the sort
  is unchanged sends somebody looking in the wrong place, so the two are two
  sentences.

  *Checked by:* `tests/cursor.test.ts` for the fingerprint and the refusal, and
  — separately and necessarily — `tests/integration/sorting.integration.test.ts`
  and `tests/integration/staged-cursor.integration.test.ts` for the two call
  sites. The unit test can only reach `decodeCursor`, and the defect was that
  the call sites passed it nothing to compare: dropping `filters:` from either
  listing leaves every unit test green.
- **Contested: is a cursor opaque? Settled by signing it.** AIP-158 says page
  tokens "must be opaque (but URL-safe) strings, and must not be user-parseable",
  and names base64-encoding an otherwise-transparent token as insufficient
  obfuscation. This cursor was base64url of plain JSON, which is precisely that
  case, and no invariant protected the encoding — so a reader of the base64 would
  have built against it. **The published guidance won.** A cursor is now
  `<payload>.<mac>`, where the MAC is HMAC-SHA256 over the payload under a key
  derived from `AUTH_SECRET` (`src/server/services/cursor.ts:78-126`).

  Signed rather than encrypted, and the difference is the whole argument. The
  contents are a boundary value and a row id the caller already holds, so there
  is nothing here to keep from them; what mattered is that they could *build*
  one. A signed cursor is refusable rather than merely validated, and a scheme a
  reader can check beats one they have to trust.

  Three things worth knowing about it. The key is **derived** from `AUTH_SECRET`
  rather than being it — the standard subkey construction, so a weakness in
  either purpose does not reach the other while an operator still sets one
  secret. It is keyed to the **deployment** and not to the process, which is what
  lets a cursor issued by one replica be read by another; rotating `AUTH_SECRET`
  invalidates every cursor along with every session, which is the right pairing
  because a rotation already sends everybody to a sign-in screen. And it costs
  about **seven microseconds** to sign and seven to verify, against a page read
  that costs milliseconds, and adds 44 characters to a cursor whose declared
  ceiling is 500.

  **The previous encoding is still read, for this release only.** A cursor is
  held rather than stored — a browser tab keeps one in component state, an agent
  may send one back minutes later — so a rolling deploy has a window in which a
  caller legitimately holds one the previous build issued, and refusing it would
  narrow a working client's pagination to "start from page 1". That is what the
  breaking-change list below means by "changing the cursor encoding *without
  still accepting the old one*". The cost of the window, stated rather than
  implied: an unsigned cursor can be hand-built, and what that buys is a
  different starting boundary inside a query already scoped to the caller's own
  `userId`. No cursor has ever been an authorization boundary, so the window
  costs opacity for one release and nothing else. `docs/upgrades.md` schedules
  the removal.

  This does not close the filter-binding gap two bullets up. A cursor still
  binds its ordering and not the filters it was issued under; signing it first
  makes that fix additive — a `filters` member inside a payload that is already
  signed — rather than a second change to the encoding.
- **Contested: total counts.** Zalando rule 254 and the Azure guidelines both
  say not to return a count of all matching objects, because counting a complex
  query is a full index scan and because clients integrate against a number that
  then cannot be removed. **This product returns `totalCount` and `totalPages`,
  and is bounded in doing so**: `AGENTS.md` makes numbered pages structural
  rather than optional, the data set is one person's ledger, and the browser
  draws page numbers. The bound is that **the cursor path returns no count**.
  The count is what makes the numbered path expensive, and the cursor path
  exists to be cheap.
  **The code disagrees with that bound today**, on both cursor lists.
  `listTransactions` runs its `count()` unconditionally, before it looks at
  whether a cursor was sent (`src/server/services/transactions.ts:1456-1461`),
  and `listStages` does the same (`src/server/services/staging.ts:806-811`),
  so a cursor page pays for a full count it does not use. The fix is not simply
  to skip it: `totalCount` is a field every client of those two lists reads,
  and a cursor page that stopped carrying it, or carried a null, is a narrowing
  a release may not make. It takes a deprecation — announced, a window, then
  the count dropped from cursor pages — and this guide records the bound so
  that change has something to point at.
- **House, four keyset pitfalls,** written here because they currently live only
  in code comments, where nobody looks before adding the seventh sortable
  column:
  1. **The sort value is computed once in SQL and carried in the cursor.**
     Recomputing it in JavaScript looks equivalent and is not. PostgreSQL's
     `lower()` and JavaScript's `toLowerCase()` are different functions, and
     `src/server/services/sorting.ts:15-26` records the consequence: a cursor
     built from the wrong one either skips every row sharing the boundary's
     lowered value or returns the boundary row forever, silently, with the row
     count still reporting the truth. *That divergence is stated in the code and
     is not cited to a source here; the deployment's own collation is what would
     settle it.*
  2. **`nulls last` only on a key that can be null.** `AGENTS.md`: "Only ask for
     `nulls last` on a key that can be null. On one that cannot, it stops
     matching the index and turns a page read into a sort of the whole table."
     PostgreSQL's documentation is the source: a B-tree scanned backward
     produces `DESC NULLS FIRST`, so `desc nulls last` stops matching the index
     (`src/server/services/sorting.ts:42-50`).
  3. **The tiebreaker is mandatory.** Every ordering ends in the row id, and the
     comparison is a row-value comparison, which survives the anchor row being
     deleted where a positional formulation does not.
  4. **A cursor is caller-supplied input.** Parse it, bound it, and turn a bad
     one into "start from the first page" rather than a 500. The value inside
     one becomes a bound parameter compared against a date or a numeric column,
     and PostgreSQL answers a value it cannot read with an error
     (`src/server/services/sorting.ts:29-39`, `src/server/services/cursor.ts:197-210`).
- **House.** `limit` is optional, defaults to 50 and is capped at 200
  (`src/shared/domain.ts:2061`). A server may return fewer rows than asked for.
  **One list differs and keeps it:** `GET /api/v1/import-batches` defaults to
  25 and caps at 100 (`importBatchListQuerySchema`, `src/shared/csv.ts:618-636`),
  because each row on it is a count over that batch's staged rows, worked out
  when the page is read, so a page costs a grouped join where another list's
  costs an index read. Raising its cap would be additive;
  changing its default would hand every client that relied on it a page twice
  the size, so it stays.
- **House.** Every list contract on this surface is a published Zod schema, and
  `GET /api/v1/audit-events` was the one that was not. It read `cursor` and
  `limit` out of the query string by hand and handed `Number(...)` to the
  service, so `?limit=x` arrived as `NaN` and the service grew a guard against
  it — the right defense in the wrong place, and one the MCP tool's own inline
  shape said nothing about. Both transports now parse `auditListQuerySchema`
  (`src/shared/domain.ts:2008-2026`), which lives with the others, is coerced so
  that a query string's `"50"` and a tool call's `50` are one contract, and is
  *not* `.strict()`: both transports have always ignored an unknown query
  parameter and refusing one now is a narrowing a release may not make. The
  agent surface applies `.strict()` at the tool, as it does to `listQuerySchema`.

## Filtering and sorting

- **House, against AIP-160 and the Azure guidelines, with the cost named.**
  Filters are discrete typed query parameters, not a filter DSL. AIP-160
  recommends a single structured `filter` string on the grounds that filtering
  requirements evolve. Four reasons this product does not:
  1. A DSL is a parser to maintain and an injection surface, and its payoff is
     clients composing filters nobody anticipated.
  2. The fingerprinted bulk selection needs a canonical filter **object** to
     hash, so a filter string would have to be parsed into one first.
  3. Zod validates a discrete parameter and cannot validate a DSL without
     becoming one.
  4. An agent reading a tool schema learns `accountId: uuid` immediately and
     learns a grammar badly.

  **The cost, stated:** every new filter is a schema change in three places, the
  list query, the bulk filter selection and the MCP tool, and adding one changes
  what a fingerprint covers.
- **House.** Sorting is `sort` plus `direction`, with `direction` one of `asc`
  or `desc` (`src/shared/domain.ts:2034-2043`). If multi-key sorting ever
  arrives it becomes `sort=-date,payee`, following JSON:API and Zalando rule
  137, rather than a second parameter, because a second parameter cannot express
  precedence.
- **Binding.** Order is presentation and never scopes a write. `sort`,
  `direction`, `cursor`, `page` and `limit` are omitted from every bulk filter
  schema (`src/shared/domain.ts:2103-2105`), so two requests selecting the same
  rows in different orders are the same selection.

*Checked by:* the bulk filter schemas being `.strict()` in `src/shared/domain.ts`,
which refuses an ordering key at the boundary. *Not checked:* that
`listQuerySchema` and the bulk filter schemas accept the same parameter names, so
a misspelled `sort` key still answers 200 with page one in the default order.

## Concurrency

**Binding.** `AGENTS.md`: "Updates/deletes require an expected version."

- **House, and the reason is the standing test.** The version travels in the
  body as `expectedVersion`, never as `If-Match`
  (`src/shared/domain.ts:1233-1248`). A mismatch is `409 STALE_VERSION` with
  `{currentVersion}` in the details. Google AIP-154 sanctions a body-carried
  token with an abort on mismatch, and Zalando's appendix rates a payload
  version number as "perfect optimistic locking", so this is a published pattern
  and not a workaround. Zalando's objection to it, that functionality belonging
  in a header becomes part of the business object, is not a cost when half the
  transports have no headers.
- **House.** The version is an integer that increases, not an opaque token, and
  it is never exposed as an `ETag`. If it were, a client would reasonably send
  `If-None-Match` and expect a 304, and this API has no conditional GET.
- **House, and the two halves are one rule.** The Azure guidelines raise the
  real objection to version-number tokens: "If a client sends a conditional
  update request, the service acts on the request, but the client never receives
  a response, a subsequent identical update will be seen as a conflict even
  though the retried request is attempting to make the same update." The answer
  is idempotency: a retry replays the stored response instead of colliding with
  the version its predecessor bumped. **Neither half works alone.** A versioned
  update without idempotency cannot be retried safely; an idempotent update
  without versioning cannot detect a concurrent edit. Do not relax either on the
  grounds that the other exists.
- **House, and the objection is open on HTTP today.** Over MCP every mutation is
  wrapped in an idempotency record by the transport itself
  (`runIdempotentMcpMutation`, `src/server/mcp.ts:310-343`, used on twenty-nine
  tools at last count — nothing pins the number, so recount before leaning on
  it), so the Azure objection does not bite there. Over HTTP only the writes
  whose schema declares an `idempotencyKey` are protected, and **no ledger
  update or delete does**: `transactionUpdateSchema` and
  `versionedMutationSchema` carry a version and nothing else
  (`src/shared/domain.ts:1233-1248`). So an HTTP update to the books whose
  response is lost genuinely cannot be retried, and the browser hides it by
  refetching. That is the gap, and it is the same gap as the missing keys on
  five creates below.

  **Two updates outside the ledger already take one**, which is why the claim is
  scoped rather than general. `PUT /api/v1/billing/subscription` and
  `PUT …/subscription/cancellation` each carry an `idempotencyKey`
  (`src/shared/domain.ts:3939-3951`), as the billing section above states. They
  are the proof the shape works on an update and not an exception to the rule:
  each spends money at a third party, where a lost response and a retry is a
  second charge rather than a second refetch. What the ledger updates are
  waiting on is a release that can add a required field, not an argument.
- **House, one named exception.** `PUT /api/v1/budget-entries` is an upsert and
  its `expectedVersion` is optional: absent on the first set for a period,
  required to change one that is already there
  (`src/shared/domain.ts:1818-1825`).
- **Binding.** `AGENTS.md`: "Any write that changes a leg must bump the parent
  transaction's `version` in the same transaction." A version that does not move when a leg moves would
  let a bulk selection fingerprint describe a row that has changed underneath
  it.

*Checked by:* `tests/integration/ledger.integration.test.ts:239` ("rolls back an
entire staged selection on a stale version") for the refusal, and
`tests/integration/splits-audit.integration.test.ts:218` for the leg invariant,
which asserts that an update changing a transaction's legs leaves
`updated.version` one higher than the version it was read at.
`tests/transaction-legs.test.ts` covers how legs parse and says nothing about
versions. That every mutating route requires one is
`tests/http-version-and-idempotency.test.ts`, which walks the mutating `/api/v1`
routes, resolves each one's request schema through the services, converts it
with `z.toJSONSchema` and reads it with a matcher that recurses into `anyOf`
arms and per-row arrays — so a version asked for inside one branch of a union
still counts. The routes that ask for none are a register, each argued from
`AGENTS.md`: the active-account choice states the whole set that stays active
and is serialized by `lockAccountNamespace` rather than by a version, which that
invariant spells out; `PUT /api/v1/preferences` has a prior row and takes no
version anyway, because it writes only the fields it names and each is a whole
value the person just chose, so the last write is the one somebody meant;
`DELETE /api/v1/me` and revoking an agent are argued in §Idempotency; and the
rest are creates with no prior row to replace. It also resolves the three
`const x: Handler<AppEnv> =` handlers a declaration walk cannot split on, which
is where three of the version-carrying routes live.

## Idempotency

**Binding.** `AGENTS.md`: "Commits, and creates that write postings, require
idempotency; a record somebody names is protected by its own name being unique,
so a second submit fails rather than duplicating."

- **House.** The key travels in the body as `idempotencyKey`, following Google
  AIP-155, for the same reason as `expectedVersion`. There is no standard being
  ignored: `draft-ietf-httpapi-idempotency-key-header` reached version 07 in
  October 2025 and is expired and archived, with no intended RFC status. Stripe
  is the de facto reference and it uses a header, which this API cannot.
- **House.** A key is 8 to 200 characters, trimmed, and a UUID is the suggested
  form (`src/shared/domain.ts:316-323`).
- **House, matching Zalando rule 230 point for point.** The key is scoped to
  `(user, operation, key)`, stored with a hash of the canonical request and the
  response, replayed on repeat, and refused with a 409 when the same key arrives
  with a different request (`src/server/services/helpers.ts:146-178`). The
  request is canonicalized before hashing, with object keys sorted and `Date`
  instances stringified, so key order cannot change the fingerprint
  (`src/server/services/helpers.ts:223-262`). Concurrent uses of one key are
  serialized by a transaction-scoped advisory lock
  (`src/server/services/helpers.ts:265-277`), which is stronger than Stripe,
  which errors on a concurrent conflict rather than waiting.
- **House, a deliberate divergence worth writing down.** Stripe replays
  failures, including 500s. Simple Balance writes the idempotency record inside
  the same PostgreSQL transaction as the effect, so a failure rolls the record
  back and the retry executes rather than replays. For a ledger that is the
  safer direction, and it matches Stripe's own carve-out that results are saved
  only once execution begins. Said out loud, because the alternative reading is
  that nobody thought about it.
- **House, and it is a setting rather than a number.** Nothing pruned
  `idempotency_record`, and every create, commit and bulk write stores a full
  JSONB copy of its response in it. Zalando is blunt about the consequence: the
  key cache "is not intended as request log, and therefore should have a limited
  lifetime, else it could easily exceed the data resource in size".
  `IDEMPOTENCY_RETENTION_HOURS` sets a window and the existing scheduler tick
  enforces it.

  **Zero is the default and means forever**, which is the whole of what makes
  this safe to add in a release rather than a decision imposed by one. A
  deployment that sets nothing keeps every record exactly as it did — the same
  rule `METRICS_ENABLED` follows, and the same rule the upgrade invariant
  demands: "A capability a client had does not narrow." The number the sources
  do not settle stays unsettled, because it is now an operator's to pick: 24
  hours is Stripe's figure for a payments API, and an agent retrying a commit a
  week later is plausible here.

  **What a pruned key costs, said rather than implied**, because it is the
  reason a window can be offered at all. A retry whose record has gone does the
  work again — and for every operation that stores one, the second attempt is
  refused by something other than the record: a repeated `transaction.create`
  meets the duplicate guard, `stage.commit` finds its rows already committed
  rather than staged, a bulk edit or delete carries a count and fingerprint that
  no longer describe the set, and a merge finds its sources gone. The record
  makes a retry *quiet*; it was never the only thing making it safe.

  Two details are load-bearing. The sweep is **bounded per pass**
  (`IDEMPOTENCY_SWEEP_BATCH`), because a deployment turning this on after a year
  has a year of records to remove and one unbounded `delete` would hold a lock
  over the whole table; the scheduler returns in minutes, so a full batch is
  drained rather than rushed. And it reads by `created_at`, which the primary
  key of (user, operation, key) cannot serve — so `0021_idempotency_retention.sql`
  adds the index, without which the sweep is a full scan of the table it runs to
  keep small.

  *Checked by:* `tests/config-limits.test.ts` for the reader — unset, empty and
  an explicit zero all mean forever, and an unreadable value falls back to
  forever with a warning, which is the safe direction because the alternative
  prunes on a typo. `tests/recurrence-scheduler.test.ts` for its place on the
  tick: last of the three, with its own `try`, so a database refusing the prune
  costs the proposals nothing. And
  `tests/integration/idempotency-retention.integration.test.ts` for the SQL,
  including that a deployment which asked for nothing keeps everything, that the
  batch bound reports itself, and that an index can serve the read.
- **House, MAY.** Accept `Idempotency-Key` as a header alias for the body field,
  with documented precedence, so a client written against Stripe habits works.
  One line of middleware and no change to the MCP contract. It is also the only
  way a bodyless mutation could carry one.
- **House, and settled for the one route that had nothing.** `AGENTS.md` says
  creates that write postings require idempotency, and this guide extends that
  to every create, because a public client retrying a `POST` after a timeout
  should not get two rows. `POST /transactions` and `POST /staged-transactions`
  take a key (`src/shared/domain.ts:1220` and `:1264`) and `POST /accounts`,
  `POST /categories`, `POST /recurrences` and `POST /transaction-templates` do
  not (`src/shared/domain.ts:1058`, `:1098`, `:3299`, `:3226`) — those four are
  protected by a unique name, which is the `AGENTS.md` carve-out, and the reason
  the gap is narrower than it looks.
  `POST /categories/merge` was protected by nothing while the sister route
  `POST /payees/merge` demanded a key (`src/shared/domain.ts:1191-1205`), so two
  merges disagreed about the same question. It takes one now
  (`src/shared/domain.ts:1151-1155`), and the browser sends it. **Optional, not
  required**, which is the only way to add it in a release a 0.1.5 client has to
  survive: that client merges without sending anything, and a required field
  would refuse a request that worked yesterday. Narrowing it belongs in a later
  release. The versions are not a substitute — a retry arrives with the versions
  read before the first attempt, so without a key a merge that succeeded answers
  its own retry with `STALE_VERSION`, which reads as "it did not happen".
- **House.** No `GET` or `DELETE` accepts a key. A safe method needs none, and a
  delete on this API is a versioned mutation, which is idempotent by
  construction, with two exceptions among the nine deletes.
  `DELETE /api/v1/connected-apps/{clientId}` reads no body and takes no
  `expectedVersion`: revoking a grant is idempotent anyway, since the second
  call finds nothing to revoke. `DELETE /api/v1/me` takes none either, because
  deleting the person leaves no later state for a stale version to protect, and
  refusing it because something changed would refuse the one request that makes
  everything else moot. The other seven — accounts, categories, category
  groups, budget plans, budget entries, templates and recurrences — parse
  `versionedMutationSchema`. Both carve-outs are named here and in the register
  `tests/http-version-and-idempotency.test.ts` keeps, rather than left to be
  discovered; an earlier version of this said there was one.

*Checked by:* `tests/idempotency-key.test.ts` for the browser's key generator,
and `tests/integration/ledger.integration.test.ts:199` ("commits deposits
idempotently and produces native balances") plus
`tests/integration/bulk-transactions.integration.test.ts:106` ("soft-deletes a
selection atomically and idempotently") for replay, and
`tests/integration/categories.integration.test.ts:657` ("returns the first
answer when the same merge is asked for twice") for the merge key this section
argued for, including the reused-key refusal. That every create and commit route
declares a key, and that `idempotencyKeySchema`'s own bounds hold, is
`tests/http-version-and-idempotency.test.ts` — the key test never reaches the
server schema, so those are the first direct assertions on its trim and its 8
and 200 bounds.

**That check is worth reading before the next one like it is written.** Its
first version could not fail the mutation it was built for. A full transitive
schema closure let the commit route inherit `directTransactionCreateSchema`'s
key through `createTransaction`, so deleting the key from `commitStageSchema`
left it green. A schema search that keeps descending eventually finds every
field somewhere; the fix is to stop at the shallowest depth that parses
anything. It was found by mutating and by nothing else.

## The bulk selection contract

**Binding.** `AGENTS.md`: "Transaction and staged mass edits are atomic and
share one selection contract. Explicit rows carry expected versions;
all-filtered selections carry a server-issued count and `id:version`
fingerprint." And: "Bulk commits are explicit-ID, validate-first, and atomic."
And: "Ten thousand rows is the cap, and it is the same number everywhere: a mass
edit, a mass delete, a commit, and a CSV import."

- **House, scoped to what the invariant above covers: transaction and staged
  mass edits.** Two selection shapes and no third for those
  (`src/shared/domain.ts:2186-2189`):
  - `{"mode": "ids", "items": [{"id", "expectedVersion"}]}` for rows the caller
    can see.
  - `{"mode": "filter", "filter", "excludedIds", "expectedCount",
    "expectedFingerprint"}` for "everything matching this", where the count and
    the fingerprint were issued by a preview call.
- **House, and three routes outside that scope encode a selection their own
  way. Each records why, and that is the answer rather than a deferral.**
  `transactionTemplateBulkSelectionSchema` (`src/shared/domain.ts:860-889`) is
  `{items: [{id, expectedVersion}]}` with no `mode` discriminator, and stays
  that way because `AGENTS.md` already settled it: a template mass edit "has no
  filtered selection, because the list is capped and the browser holds all of
  it". A discriminated union with one member is ceremony, and `mode` would be a
  required new request field bought for nothing. The schema's own comment
  (`src/shared/domain.ts:852-859`) argued this before this guide asked.

  `commitStageSchema` (`src/shared/domain.ts:1315-1341`) and `bulkDeleteStageSchema` (`src/shared/domain.ts:1354-1376`) are
  `{stagedIds: uuid[], expectedVersions: Record<string, number>}`, a parallel
  map rather than a list of pairs. That is the older spelling and it stays.
  Moving it changes the wire on the one route that puts money in the books, and
  the request shape is what the recorded idempotency payload is hashed from
  (`src/server/services/staging.ts:1189-1194`), so a commit retried across the
  deploy would come back `CONFLICT` instead of replaying — a self-inflicted
  failure on the write that can least afford one, in exchange for no behavior a
  caller can observe. A missing map entry already refused rather than wrote.

  What the parallel map could get wrong is fixed instead. Two structures
  describing one set can disagree, and an id with no entry compared `undefined`
  against the row's version and threw `STALE_VERSION` — safe, but the wrong
  fault named: nothing went stale, the request arrived incomplete, and an agent
  told to read the row again and retry sends the same payload back. Both
  services now refuse it by name with the offending id in the details
  (`src/server/services/staging.ts:1071-1089`), the way `mergeCategories`
  (`src/server/services/categories.ts:916-922`) already did with the identical
  encoding, and a repeated id is refused as a duplicate rather than reported as
  a missing row. A superset map is still accepted: naming a version the caller
  did not select harms nothing, and refusing it would break a working request to
  no end. `mergeCategories` does not refuse it either.

  Neither schema is `.strict()`, and that is a decision rather than a gap. MCP
  applies `.strict()` at the tool boundary, so `expectedVersion` typed singular
  is refused for an agent with the field named; HTTP still drops the unknown
  key and reads the request as one that named no versions — worse, and
  deliberately left that way for now, because making the shared schema strict
  narrows what an existing caller may send, and a release does not take
  something away from a client that had it. `tests/domain.test.ts` pins the split so it stays chosen
  rather than drifting back by accident.

  Three encodings, one question, and the answer is written beside each of them
  rather than made uniform. If a version boundary ever arrives for another
  reason, bringing the staged pair onto the shared shape is the change to make
  in it.
  *Checked by:* `tests/integration/staged-bulk-edit.integration.test.ts` and
  `tests/integration/ledger.integration.test.ts` for the refusals,
  `tests/domain.test.ts` for the open-here-strict-there split, and the
  real-connection `delete_staged_transactions` call in
  `tests/integration/duplicates.integration.test.ts`, which is the only thing
  that catches the tool handing a strict schema the key it added.
- **House.** A filter selection is resolved first by the matching
  `bulk-selection` route, which returns the count and the fingerprint the write
  must send back (`src/server/api.ts:1873-1880`, `:1937-1939`). The fingerprint
  is a SHA-256 over the sorted `id:version` pairs, computed by one function so
  the transaction and staged paths cannot drift into accepting different sets
  (`src/server/services/helpers.ts:329-344`).
- **House.** If the set has moved, the write is refused with the current count
  and fingerprint in the details, and the caller previews again. It is never
  silently applied to whatever matches now. The message is in
  [`common.md`](common.md#errors).
- **House, and it declines a published MUST.** **This API never returns 207.**
  Zalando rule 152 says a batch request "*always* responds with HTTP status code
  207", explicitly including the case where every item fails. Bulk operations
  here validate first and apply atomically in one PostgreSQL transaction, so
  partial success cannot occur, a 207 would be a lie, and it would tell a client
  to inspect per-row outcomes that do not exist. Google AIP-233 supports the
  atomicity: "Synchronous batch create must be atomic." A partial commit into a
  double-entry ledger leaves the operator holding a set of postings they did not
  choose, described only by an error list. **If a bulk endpoint ever needs 207,
  that is a change to the transaction boundary, not a change of status code.**
- **House, and all seven bulk routes carry it.** `dryRun` is the substitute for
  per-row reporting. A caller that wants to know what will happen asks first,
  rather than being told afterwards which rows failed. Six of the seven had it;
  `bulkDeleteStageSchema`, behind `POST /api/v1/staged-transactions/bulk-delete`
  (`src/shared/domain.ts:1354-1376`), did not, which made the one bulk write that
  removes rows the one nobody could ask about first. It validates the whole
  request — every row present, every row still staged, every version current —
  and returns the ids it would have deleted with `dryRun: true`, stopping before
  the write.
- **House, and it declines AIP-151.** No long-running operations and no job
  queue. AIP-151 puts the threshold at ten seconds and requires an `Operation`
  resource polled through an Operations service, which needs a durable job table
  and a poller. `AGENTS.md`: "PostgreSQL is the only persistent dependency. Do
  not add Redis, SQLite, an object store, sidecar, or writable-volume
  requirement." **`AGENTS.md` wins**, and the alternative it chose is to bound
  the work so it finishes inside a request: ten thousand rows everywhere, with
  the body limit derived from that cap rather than guessed.
  **The one operation that outgrows this is CSV export**, which buffers up to
  100,000 transactions in memory (`src/server/services/import-export.ts:997`)
  against very carefully specified request limits. The bound it needed is now
  stated and enforced: `CSV_EXPORT_MAX_ROWS` (`src/server/config-limits.ts:30`)
  refuses a larger export with the remedy named — narrow the date range and
  export one range at a time (`src/server/services/transactions.ts:1414-1420`).
  [`csv.md`](csv.md) records the decision as settled, and
  `tests/bulk-row-cap.test.ts` holds both refusals to their message.
  **Reporting progress does not reopen this.** Two of these bounded writes now
  say how far along they are while they run, and it is worth being exact about
  what that is not: no `Operation` resource, no job table, no poller, no second
  request, and nothing outliving the one that started it. The work still
  finishes inside the request that asked for it, still capped at ten thousand
  rows. See [Streaming a response](#streaming-a-response).

*Checked by:* `tests/bulk-row-cap.test.ts`, `tests/http-security.test.ts:352-433`
for the derived limits, and
`tests/integration/bulk-transactions.integration.test.ts` for atomicity, which
covers the stale selection writing nothing
(`tests/integration/bulk-transactions.integration.test.ts:170`), the cross-tenant
explicit selection refused without partial updates (`:825`), and the exact filter
fingerprint (`:611`).

## Streaming a response

**House, and it is the standing test's first exception.** Two routes will answer
in frames instead of one body, if the caller asks:
`POST /api/v1/staged-transactions/commit` and `POST /api/v1/csv/stage`. Both do
all their work in one transaction over up to ten thousand rows, which is a
minute or more with nothing to show for it, and there is nowhere else the
progress could come from: a row written inside an uncommitted transaction is
invisible to every other connection, `NOTIFY` is queued until commit, and a
count held in one process cannot be polled when a deployment runs several. The
socket already open is the only channel that exists.

- **The opt-in is `Accept: text/event-stream`.** Absent, or anything else, and
  the response is exactly what it was: `application/json`, same status, same
  body, same headers. "Anything else" includes the type weighed at `q=0`, which
  RFC 9110 §12.5.1 makes "not acceptable" and which a substring test used to
  answer with frames; `acceptsFrames` reads the weight
  (`src/server/stream.ts`), and a wildcard does not ask for frames either.
- **This is the exception, and the rule it is an exception to is quoted rather
  than paraphrased:** *"If a rule can only be expressed with an HTTP header, it
  cannot be a rule of this API, because half the transports have no headers."*
  It holds because nothing about the *contract* is expressed here. The three
  examples that rule gives — `expectedVersion`, `idempotencyKey`, an error code
  in the body — are all data the server acts on or the caller needs. This is
  none of those. The request is identical, the work is identical, and the final
  payload is identical; only the transcript differs, which is what `Accept` is
  for. A body field would have put the switch in the contract and published it
  on a tool whose transport answers in a single JSON object
  (`enableJsonResponse: true`, `src/server/mcp.ts:2198`) and could never honor
  it — advertising a capability an agent cannot reach, which is the
  `categoryKind` defect pointing the other way.
- **Three frame types, and exactly one terminal frame, last:** `progress` while
  the work runs, then either `result` carrying byte for byte what the JSON
  branch would have returned, or `error`. The format is one module both ends
  share, `src/shared/progress.ts`.
- **A refusal is a frame, because the status line was already spent.** A
  streamed response is 200 before its outcome is known and nothing can change it
  afterwards, so the refusal carries the same `{ error: { code, message,
  details? } }` object the JSON branch would have — from the same function,
  `errorEnvelope` (`src/server/api.ts:369`), so the two renderings cannot drift.
  That is a third rendering of one error object beside the two
  [Errors](#errors) allows, and it exists only because of the status line.
- **An intermediate frame carries no committed fact.** It says which row a loop
  is on. This is the 207 rule one level down: a shape implying per-row outcomes
  is a lie when the write is atomic, and a client must not read a `progress`
  frame as rows that are safe.
- **A streamed route keeps `Cache-Control: no-store`** and adds
  `X-Accel-Buffering: no`. The first is the rule below, kept without exception;
  the second is for a reverse proxy that buffers by default. **This repository
  ships three proxies now, and each answers it differently.** The frontend
  image's nginx says `proxy_buffering off` on the API location
  (`deploy/docker/nginx.conf.template:242`). The `single` profile's Caddy needs
  no directive and says so where somebody would look for one: Caddy streams and
  does not time a slow response out, which is exactly what nginx has to be told
  (`deploy/compose/single/Caddyfile:48-54`). The chart's ingress declares nothing
  either way (`deploy/helm/simple-balance/templates/ingress.yaml`), and it does
  not need to: it fronts the same frontend image, which has already said
  `proxy_buffering off`, and an nginx-based ingress controller honors the
  `X-Accel-Buffering: no` the application sends. That header is what makes the
  rule hold through a proxy nobody here configured, which is why it is on the
  response rather than only in a config file.
- **A client that disconnects does not cancel the work.** The commit finishes
  and the idempotency record answers the retry. Somebody closed a tab; they did
  not ask for a rollback. The consequence for a client is the important half: a
  stream that ends without a terminal frame carries **no** information about the
  outcome, and reporting it as a failure would be wrong more often than right.
  Retry with the same idempotency key, or read the rows back.

*Checked by:* `tests/integration/streamed-commit.integration.test.ts` — that a
request without the header gets the same status, content type and body it got
before; that a streamed reply carries `text/event-stream`, `no-store` and
`X-Accel-Buffering: no`; that the terminal `result` frame equals what the plain
branch returns for the same input; and that a commit refused mid-stream writes
no transaction, leaves every row staged, and ends in an `error` frame carrying
the code the plain branch would have used. `tests/progress-frames.test.ts` holds
the format the two ends share, and that a frame really is written while the work
is still running. *Not checked:* that any of the three proxies above forwards
the frames unbuffered, nor that a proxy somebody else put in front of a
deployment does. The deferral to an operator is still right for the last of
those and is not an answer for the first two, which this repository owns: the
honest statement is that the directives are read by a person rather than by a
test, and a streamed commit has not been watched through the chart's ingress.

## Security, cache and CORS

- **House.** Everything under `/api/v1` is `Cache-Control: no-store`, without
  exception, set once in the first middleware on the prefix rather than once per
  route. First matters: it used to be set inside the session check, so a
  cross-origin `403` and a `415` — both refused by guards mounted before it —
  went out without it (`src/server/api.ts:1453-1458`). RFC 9111's shared-cache protection keys off
  the `Authorization` header, and `/api/v1` authenticates with a cookie, so that
  protection does not apply and `no-store` is doing the whole job. When SB-030
  adds bearer tokens, `no-store` stays: two mechanisms for one guarantee is
  cheaper than reasoning about which one applied.
- **House.** `Vary` is unnecessary today precisely because nothing authenticated
  is cacheable. The invariant to preserve: no cacheable response depends on a
  request header without naming it in `Vary`.
- **House.** The security headers are one exported function
  (`securityHeaderOptions`, `src/server/http-security.ts:207-326`), and no route
  overrides one of the headers in the table below. It takes `isProduction` and a
  context — `surface`, `ads` and `reportOnly`
  (`SecurityHeaderContext`, `:60-73`) — so which policy a response carries is
  decided per request path rather than once for the process: one middleware
  picks between two prebuilt header sets by asking `isStripeSurfacePath`
  (`src/server/api.ts:243-263`). Two other headers are set by hand outside
  `/api/v1` and are documented under CORS: `Access-Control-Allow-Origin` on the
  JWKS route (`src/server/api.ts:782`) and on discovery (`:999`), and
  `Cache-Control` on those two (`:783`, `:1002`) and on `/api/v1` itself
  (`:1458`). The split deployment's nginx repeats them for the files it serves,
  and the two are compared value for value by a test rather than by a reader.

  **The content policy is the only header that is wholly per surface.** Two more
  carry one alternative value each, and the rest are the same on every response:

  | Header | Value |
  | --- | --- |
  | `X-Frame-Options` | `DENY`, agreeing with `frame-ancestors 'none'` rather than Hono's `SAMEORIGIN` default |
  | `Referrer-Policy` | `same-origin`, or `strict-origin-when-cross-origin` on the pages that carry ads, where Google's consent message will not serve under `same-origin`; never on the plan tab |
  | `X-Content-Type-Options` | `nosniff` |
  | `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, in production only |
  | `Cross-Origin-Opener-Policy` | `same-origin`, or `same-origin-allow-popups` on the plan tab alone, where a wallet payment can finish in a popup |
  | Hono's remaining defaults | `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies`, `X-XSS-Protection: 0` |

  **There is no longer one content policy.** `default-src 'self'`, `base-uri
  'self'`, `form-action 'self'`, `frame-ancestors 'none'` and `object-src
  'none'` hold on all of them, and `img-src 'self' data: https:` does too. What
  varies is what each vendor needs, and the rule for widening is [A vendor
  widens the policy at the narrowest surface that needs
  it](#a-vendor-widens-the-policy-at-the-narrowest-surface-that-needs-it-never-globally)
  below.
  Three surfaces exist, plus a report-only form of one of them:

  | Surface | Policy |
  | --- | --- |
  | The application, with no ads configured — the default, and what this container shipped before billing existed | `style-src`, `script-src` and `connect-src` are each `'self'`; no `frame-src` and no `font-src`, so `default-src 'self'` governs both |
  | The application where AdSense is configured | the same, plus `https:` on `script-src`, `connect-src`, `style-src` and `frame-src`, `'unsafe-eval'` on `script-src`, `'unsafe-inline'` on `style-src`, and a `font-src` of `'self' https: data:` (`src/server/http-security.ts:175-179`) |
  | `/settings/plan`, where Stripe is configured | Stripe's, Link's and hCaptcha's named hosts — `'self'` beside them on `script-src`, `connect-src` and `style-src`, and `frame-src` carrying the hosts alone, because nothing on this origin is framed (`:78-138`). Never widened for ads |
  | `/settings/plan` while `SB_CSP_REPORT_ONLY` is set | the same policy as above, sent as `Content-Security-Policy-Report-Only` with `report-uri` and `report-to`, and a `Reporting-Endpoints` header naming `/api/csp-report` beside it. Exactly one of the enforcing and report-only headers is ever sent (`:276-286`) |

  **`'unsafe-inline'` is absent from `style-src` on the two surfaces this
  product controls, and present on the one it does not.** The reasoning survives
  for this app's own styles and is worth not undoing: the inline styles here are
  React `style` props, applied through the CSSOM rather than written as a style
  attribute, which CSP does not govern, and Vite emits the stylesheet as a file.
  What changed is that it is no longer a guarantee the product can make. Google's
  consent message injects `<style>` blocks into this document and a stylesheet
  from `fonts.googleapis.com`, and under `style-src 'self'` it renders unstyled,
  far down the page, where nobody answers it — which in the EEA and the UK means
  no ad request completes at all. So an operator who turns ads on buys
  `'unsafe-inline'` for styles and `'unsafe-eval'` for scripts across every page
  that renders somebody's balances, which is why ads are off unless asked for and
  why `docs/monetization.md` states the cost in the operator's own words first.
  `'unsafe-inline'` for *scripts* is given up nowhere.

  The nginx copies are `deploy/docker/nginx-security-headers.conf` for the
  application shell and `deploy/docker/nginx-security-headers-plan.conf` for the
  plan tab. **Neither holds a constant policy any more**: each names a `map`
  variable built in `deploy/docker/nginx.conf.template` from
  `SB_ADS_CONFIGURED`, `SB_BILLING_CONFIGURED` and `SB_CSP_REPORT_ONLY`, because
  a file that froze one arm would serve a deployment the policy a different
  deployment needed. The plan file is a whole second copy of the header list
  rather than an override, because nginx `add_header` does not merge: a location
  declaring one directive drops every inherited one, so a partial file would
  serve that page a policy and none of the other nine headers. "Compared
  character for character" was true of one file and one constant; what the test
  compares now is each map arm against what `securityHeaderOptions` produces for
  the same settings.

  *Checked by:* `tests/security-header-parity.test.ts`, which parses both
  snippets and the template's maps and compares every arm against the function
  for every combination of the three settings, in both the enforcing and the
  report-only form; `tests/csp-report-only.test.ts` for the rehearsal and for
  which paths the plan policy matches; and `tests/http-security.test.ts` for the
  behavior.
- **House, one subtlety already handled and worth not undoing.**
  `referrerPolicy` is `same-origin`, not Hono's `no-referrer` default, because
  under `no-referrer` a browser sends `Origin: null` on a native form
  submission, including the sign-in form posting to this very server, and the
  origin check rightly refuses an origin it cannot recognize. The pages that
  carry ads widen it to `strict-origin-when-cross-origin`, which still sends
  another origin this site's address and never the path, so a record id in a
  URL stays off every Referer (`src/server/http-security.ts:287-308`).
- **House, and the two halves are one rule.** Same-origin and JSON content type
  are presented together and neither is relaxed on the grounds that the other
  exists. OWASP files origin checking under defense in depth rather than as a
  primary defense, and separately notes that disallowing simple content types is
  itself a mitigation. Together they are enough; separately neither is.
- **Contested, and now decided: CORS.** The rule used to be that `/api/v1`
  emits no CORS headers ever, and cross-origin access is MCP's job. Publishing
  the API changes that, but only for the half that is safe to widen:
  - **`/api/v1` still emits no `Access-Control-Allow-Origin`, and no
    deployment-configurable allowlist is added.** A browser on another origin
    cannot be given cookie-authenticated access to somebody's ledger without
    inviting exactly the forgery the origin check exists to prevent.
  - **Bearer-authenticated requests are the cross-origin path**, once SB-030
    lands. A bearer request carries no ambient credential, so it is not
    forgeable by a third-party page, and CORS for it can be opened without the
    same risk. Whether it should be is a deployment decision and belongs in
    configuration, not in code.
  - **Two exceptions exist today and are correct**, both outside `/api/v1`:
    `GET /api/auth/mcp/jwks` (`src/server/api.ts:781`) and the OAuth discovery
    endpoints (`discoveryHeaders`, `src/server/api.ts:997-1003`) both send
    `Access-Control-Allow-Origin: *`. They are deliberately public and read by
    clients that are not browsers and have no origin to speak of. A rule saying
    "this process never emits ACAO" would be contradicted by grep on the day it
    shipped.
  - **No `OPTIONS` handling.** A preflight to `/api/v1` gets a 401 with no
    CORS headers. Not the 404 an earlier version of this said: a preflight
    carries no cookie, so the session check answers before the catch-all is
    reached. Either is the correct answer to a preflight for something that is
    not allowed, because what makes it correct is the missing
    `Access-Control-Allow-Origin`, not the status.
- **House.** The single-page app never answers an API path. Three JSON 404
  catch-alls sit below every route their prefix owns and above the shell:
  `/api/v1/*` (`src/server/api.ts:2060-2062`), `/.well-known/*` (`:1048-1050`)
  and `/api/billing/*` (`:2069-2071`). Without them a mistyped path came back as
  200 `text/html`, which an API client parses as a syntax error and a person
  debugging reads as a working page.

  The third one carries a cost the other two do not. A Stripe delivery aimed at
  a misspelled path — or at a deployment with no Stripe configured, where the
  webhook route genuinely does not exist — would otherwise get the shell and a
  200, and Stripe records a 200 as delivered. A missed delivery the sender
  believes arrived is the one shape nothing ever retries, which is the opposite
  failure from the one the webhook's own "every no-op answers 2xx" rule is
  guarding against.

### A vendor widens the policy at the narrowest surface that needs it, never globally

**Binding.** Two vendors now need hosts `default-src 'self'` refuses, and the
answer was two surfaces rather than one union. The plan tab alone carries
Stripe's and hCaptcha's hosts; the ad sources go only where ads are served; and
a directive neither surface needs is **absent rather than empty**, so
`default-src 'self'` governs it. `frame-src` is the case worth naming: with no
`frame-src` of its own and no widened `default-src` to fall back to, the
`default-src 'self'` above governs and no third-party frame loads at all —
which is stronger than listing nothing (`src/server/http-security.ts:250-261`).
`base-uri`, `form-action`, `frame-ancestors`, `object-src` and
`'unsafe-inline'` for scripts are given up on no surface, by either vendor.

**The two never combine, and the reason is a product promise rather than a
technical one.** Ads live in the application shell; the plan tab is the one page
this product promises not to put them on, and it is the page that takes a card.
So `surface === "stripe"` short-circuits the ad arms (`:243-261`), and a
deployment that sells *and* advertises serves two policies rather than one.

**The obvious alternative was one policy carrying the union**, and it is wrong
in both directions at once. It would give `'unsafe-eval'` and `script-src
https:` to every page, including the sign-in form, so that a deployment which
shows one ad unit weakens the page where somebody types a password. And it would
give the payment page third-party ad frames — on the page taking a card, which
is the one place this product has told people it will not. A union is the
cheapest thing to write and the only one that cannot be argued for.

**Two consequences, both paid rather than avoided.** The split deployment's
nginx grows a snippet and a `map` arm per surface, because `add_header` does not
merge and a partial file would serve a page one directive and none of the other
nine. And the report-only rehearsal applies to the new surface alone: `reportOnly`
is forced false on every surface but `stripe` (`:213`), so an operator
rehearsing is rehearsing the policy that changed and leaving the one that has
been in the field enforcing. A third vendor is a third surface and a third map
arm, which is the cost this rule is choosing to pay each time.

*Checked by:* `tests/security-header-parity.test.ts`, whose last two blocks are
this rule. Three of its assertions are the three halves above — "never widens
the plan tab, which carries no ads", "keeps what the widening does not buy" and
"leaves the ordinary policy untouched when no ads are configured" — and the
block after them walks every header in every configuration on both transports.
`tests/csp-report-only.test.ts:59` holds the rehearsal to the plan tab alone.

### As an OAuth resource server

Written for what SB-030 completes; today none of `/api/v1` is reachable this
way.

- **Binding**, RFC 6750. A bearer token travels in the `Authorization` header
  and never in a query string. RFC 6750 says the URI query parameter method
  "SHOULD NOT be used" and "its use is not recommended, due to its security
  deficiencies", and a token in a URL is a token in an access log.
- **House.** A 401 on a bearer-capable route carries a `WWW-Authenticate`
  challenge with `resource_metadata` and `scope`. A 403 for an under-scoped
  token carries `error="insufficient_scope"` and names the scope required.
- **House, a deliberate absence.** A 401 on a cookie-authenticated `/api/v1`
  request carries no `WWW-Authenticate`
  (`src/server/api.ts:1480-1501`). A Bearer challenge there would invite an agent
  to present a token that will never be accepted. When SB-030 lands, the
  challenge appears on the routes that can actually accept one.
- **Binding**, RFC 9728. Protected resource metadata is served at the root and
  at every `/mcp` path spelling, because a client told the resource is
  `<origin>/mcp` looks under the well-known suffix with the resource path
  appended (`src/server/api.ts:1024-1031`). Answering only at the root left the
  single-page app returning HTML with a 200, which a client cannot parse and
  will not retry.
- **Binding.** The scopes are `ledger:read`, `ledger:stage` and `ledger:write`,
  published in the discovery documents (`src/server/api.ts:987-996`, `:1021`), and the
  route table above says which each route needs. `AGENTS.md`: "`ledger:stage`
  proposes and never decides."
- **Binding.** Seven routes stay session-only whatever the token. `AGENTS.md`:
  "Three exceptions, all account management rather than bookkeeping: deleting an
  account, setting a sign-in password, and the billing routes are reachable from
  a session and never from an MCP token." Those are `DELETE /api/v1/me`,
  `POST /api/v1/auth/local-password`, and the five under `/api/v1/billing`.
- **House.** `GET /api/v1/session` is session-only for a different reason and
  should not be read as a third invariant: it is split rather than withheld.
  Identity, the plan's ceiling and how much of it is used are `whoami`, and the
  regional settings are `get_preferences`. What is left is which sign-in methods
  the deployment offers, which is no business of an agent's
  (`tests/mcp-parity.test.ts:26-27`).
- **House.** Signed out, `GET /api/v1/session` is a `401` like every other
  route here, and `GET /api/v1/session?optional=true` is `200 null`. The
  browser asks that way because "is anybody signed in?" is the first thing it
  asks on every load, and a `401` answering "no" was logged by every browser as
  a failed request on every signed-out visit. Opt-in, and on this route alone:
  a client that reads the `401` keeps getting it, and on any other route being
  signed out really is the request failing. Checked by
  `tests/integration/auth.integration.test.ts`.

  **It is the one boolean query parameter that does not refuse.**
  `?optional=1`, `yes` or `TRUE` is read as false and gets the `401`, where
  §Requests says a boolean refuses anything but `"true"` and `"false"`. The
  parameter shipped first, and refusing now would turn a `401` a client already
  handles into a `400` it may not. Recorded rather than fixed, and the
  difference costs little: the wrong spelling gets the answer it always got.

*Checked by:* `tests/api-security.test.ts` and `tests/http-security.test.ts` for
the discovery routes and their caching, and `tests/security-header-parity.test.ts`
for the headers. *Not checked:* the token lifetime and revocation behavior, which
is Better Auth's and is covered by its own tests rather than these.

## Versioning and deprecation

- **Contested, and settled the unfashionable way.** The version is in the path:
  `/api/v1`. Zalando rule 115 says "MUST not use URL versioning", the adidas
  guidelines say a resource identifier must not contain a semantic version, and
  the Azure guidelines require a query parameter instead. Google AIP-185
  requires exactly what this product does: a major version as the first segment
  of the URI path. **Keep the path version.** `docs/architecture.md:26-27` gives
  the reason: "`/api/v1` versions the HTTP contract, not the product. It changes
  when the contract breaks, which is not the same as when the app does." And
  media-type versioning is wrong here specifically: content negotiation exists
  so two clients on different schedules can share a server, and the browser
  client ships in the same image as the server that answers it.
- **House, and a hole the version number does not cover.** The contract is
  defined by shared Zod schemas that MCP consumes unversioned. A breaking change
  shipped under a new `/api/v2` would still break every MCP tool. So a breaking
  change to a shared schema is a breaking change to both transports, and the
  path version does not contain it. Until MCP has its own versioning story,
  treat the schemas as one contract with two spellings.
- **House.** A version is reported. `APP_VERSION` was announced to every MCP
  client and to nobody over HTTP — not on health, not in a header — so the one
  surface an operator actually polls was the one that could not answer "which
  build is this" during a rolling deploy. Both health routes now carry it
  (`src/server/api.ts:432-447`), and so do the scheduler's
  (`src/server/scheduler.ts:29-38`), because that process is deployed
  separately and reading the version off the API's answer would answer about
  the wrong one. Not a header: a header on every response is a cost paid by
  every request for a question asked during a deploy.

*Not checked mechanically.* Whether a change breaks a caller is a judgement about
what callers rely on, and the honest enforcement is the route list above plus
review.

### What counts as a breaking change

**House**, translated from Google AIP-180, plus three specific to this API.

Breaking:

- Removing a field, a route, an enum value used in a response, or an error code.
  Renaming one is remove-and-add.
- Changing a field's type, even to a wire-compatible one. A number that becomes
  a string breaks a client that compared it.
- Adding a required field to an existing request.
- Changing a default value, or changing the format or algorithm behind an
  existing field's value.
- Making a validation rule stricter, or lowering a documented limit.
- Changing the HTTP status an existing `ApiErrorCode` maps to, or repurposing a
  code.
- **Changing the cursor encoding without still accepting the old one.**
- **Changing what the bulk selection fingerprint is computed over.**

The last two break silently in flight rather than failing loudly, which is why
they are called out: a client mid-walk gets wrong rows, not an error.

Not breaking:

- Adding a route, an optional request field, or a response field.
- Adding an enum value to an enumeration that only appears in requests.
- Adding an error code, provided nothing existing changes status.
- Loosening a validation rule, or raising a limit.

*Not checked mechanically.* Review.

### Deprecation

**House**, and in use as of this release: the four renamed paths below are the
first thing to go through it.

- A deprecated route or field is announced in `CHANGELOG.md` in the commit that
  deprecates it, with the replacement named.
- The response carries `Deprecation` (RFC 9745, Standards Track, March 2025),
  whose value "MUST be a Date as per Section 3.3.7 of [RFC9651]", for example
  `Deprecation: @1688169599`, plus a `deprecation` link relation pointing at the
  changelog entry — the release heading's anchor, which is the nearest one
  GitHub generates — and a `successor-version` relation naming the replacement
  with the id the request was sent with. A `{id}` template is not a URI
  reference (RFC 3986 allows no brace in one), and the first version linked
  exactly that.
- The response carries `Sunset` (RFC 8594) with the date the route stops
  answering. RFC 8594 requires that the sunset timestamp "MUST NOT be earlier
  than" the deprecation timestamp.
- The window is at least one minor release and at least ninety days, whichever
  is longer. That number is this product's choice; nothing cited sets one.
- One Hono middleware sets both headers, and it is the first on the prefix. Do
  not set them per route: a refusal that comes before the route — the `401` an
  old tab meets once its session lapses, a `403`, a `415`, a `413` — is a
  response to the old path too, and a header set by the route never reaches it.

The four renamed paths are the first use, and they are why this policy stopped
being hypothetical. The first version of the rename argued that `/api/v1` is
cookie-only and same-origin, so the only client that could call the old paths
ships in this image — which is true of *this* image and not of the one already
running. A browser tab left open across the upgrade is serving the previous
build, and it would have met a 404 on the first archive somebody attempted.

One middleware sets both headers, reading the old spellings from one table,
`RENAMED_PATHS` in `src/server/api.ts`. It was a middleware per route until the
sweep that found the `401` going out unmarked. The value of
`Deprecation` is the date form RFC 9745 requires rather than the superseded
draft's `true`, and the sunset is 188 days later, which clears both the ninety
days and the one minor release. It was a date in the past for a while, which is
worse than no header at all: a client reading it is told the path is already
gone while it is still answering.

**The unsigned cursor encoding is the second use, and it does not get the
headers.** A deprecated *encoding* is not a route or a field: the old form
arrives inside a request rather than being addressed by one, so there is nothing
for a middleware to annotate and a per-request header would break the "one
middleware, not per route" rule above for no reader's benefit. What it does get
is the rest of the policy — announced in `CHANGELOG.md` with the replacement
named, recorded in `docs/upgrades.md`, and **sunset on the same March 1, 2027**,
so this release deprecates two things on one date rather than asking an operator
to hold two.

*Checked by:* `tests/http-route-table.test.ts` reads both values as dates: that
`Deprecation` is `@<seconds>`, that the sunset parses, that the window is at
least ninety days, and that it has not passed. `tests/api-security.test.ts`
("headers set before anything can refuse") holds the headers on a `401`, the
successor link's real id, and that only the old spellings are marked. The last of those fails on the
day it expires, which is the day somebody has to decide between removing the
aliases and moving the date. `tests/browser/budgets.spec.ts` proves two of the
four still answer over a real connection.

### The OpenAPI document

**House, and it does not exist yet.** There is no OpenAPI or JSON Schema
artefact in this repository, and the only route list before this guide lived
inside `tests/mcp-parity.test.ts`, which exists to test parity rather than to
document anything.

Generate it from the Zod contracts with `z.toJSONSchema`, check it in, and let
CI fail when it changes without a `CHANGELOG.md` entry. Ranked honestly, what it
is for:

1. A machine-readable definition of "breaking change", which turns the section
   above from prose people read once into a diff people cannot avoid.
2. A third thing for the parity test to compare, since the document and the MCP
   tool schemas come from the same Zod source.
3. Documentation, since `docs/mcp.md` is a detailed guide to MCP and there is no
   equivalent for `/api/v1`.
4. Client generation, which is worth close to nothing while the only client
   imports the Zod types directly.

Two caveats that will bite whoever writes the build script. `listQuerySchema`
uses `z.coerce.number()`, so the input and output types differ and only
`io: "input"` describes the wire. And set `unrepresentable` to a function that
maps a date to `{type: "string", format: "date"}` rather than to `"any"`, so an
unexpected type still throws rather than silently widening. *Which OpenAPI
version to target was not established;* 3.2.0 is current as of September 2025
and 3.1 may have better tooling. Choose on evidence.

*Not checked mechanically.* There is no document yet; this records what it would
owe if one is generated.

## Where this disagrees with published guidance

One line of reason each, so the next reviewer argues with the decision rather
than rediscovering the disagreement.

| Decision | Against | Why |
| --- | --- | --- |
| Version in the URL path | Zalando 115, adidas, Azure | AIP-185 agrees; there are not two clients on different schedules to negotiate between |
| 422 for a semantic failure | Zalando (`do-not-use`) | 400 means it was never a request; 422 means the ledger refused a well-formed one, and an agent handles those differently |
| `totalCount` on the numbered path | Zalando 254, Azure | `AGENTS.md` makes numbered pages structural; bounded to the numbered path only |
| camelCase field names | Zalando 118 | Azure, adidas and protobuf JSON agree, and one schema serves three surfaces |
| Never 207 for bulk | Zalando 152 | Bulk writes are atomic, so partial success cannot occur and 207 would be a lie. AIP-233 agrees on atomicity |
| Idempotency required rather than optional | AIP-155 (`should be optional`) | A ledger that records a payment twice is worse than one that refuses a retry |
| Discrete filter parameters, not a filter string | AIP-160, Azure | The bulk fingerprint needs a canonical filter object, and Zod cannot validate a DSL |
| `expectedVersion` in the body, no `If-Match` | Zalando's stated con | Half the transports have no headers. AIP-154 sanctions the pattern |
| No long-running operations | AIP-151 | `AGENTS.md`: "PostgreSQL is the only persistent dependency" |
| Cursor opacity | AIP-158 | **The guidance wins.** Sign the cursor or declare it unstable in writing |

## What is checked, and what is not

**Enforced by a test today:**

| Rule | Test |
| --- | --- |
| Cross-origin and content-type refusals fire before the session lookup | `tests/api-security.test.ts` |
| Body limits, their derivation, and that every bulk-shaped route gets one | `tests/http-security.test.ts`, `tests/http-security-node.test.ts` |
| Every path id is parsed at the boundary | `tests/path-id-validation.test.ts` |
| A cursor round-trips and is refused under a different ordering | `tests/cursor.test.ts` |
| The browser's idempotency key is a v4 UUID, long enough for the server's minimum | `tests/idempotency-key.test.ts` |
| A commit replays rather than duplicating, and a bulk write is atomic | `tests/integration/ledger.integration.test.ts`, `tests/integration/bulk-transactions.integration.test.ts` |
| A leg write bumps the parent transaction's version | `tests/integration/splits-audit.integration.test.ts:175` |
| A stranger's id is a 404 and never a 403 | `tests/integration/tenant-isolation.integration.test.ts` |
| The Hono security headers and the nginx ones agree, on every surface and in every combination of the three settings | `tests/security-header-parity.test.ts` |
| A vendor's hosts reach only the surface that needs them, and the rehearsal only the plan tab | `tests/security-header-parity.test.ts`, `tests/csp-report-only.test.ts` |
| A literal collection path is reached by its own handler rather than by the parameter route above it | `tests/route-shadowing.test.ts` |
| Both terminators will carry what the application's CSV limit accepts, and describe the same ceiling | `tests/upload-limit-agreement.test.ts` |
| The plan routes, the webhook, `/ads.txt`, the report endpoint and `/metrics` are each absent where unconfigured | `tests/billing-routes-absent.test.ts`, `tests/ads-txt.test.ts:50`, `tests/csp-report-only.test.ts:98`, `tests/metrics.test.ts:224` |
| The collection envelope on every listing's published output schema, with the twelve bare arrays in a register carrying their reason | `tests/mcp-output.test.ts` |
| Every `/api/v1` route has a tool or a written exception, and every tool has a route | `tests/mcp-parity.test.ts`, both directions |
| The ten thousand row cap | `tests/bulk-row-cap.test.ts` |
| The route tables in this guide name every registered route and nothing else | `tests/http-route-table.test.ts` |
| A streamed reply is optional, keeps `no-store`, ends in the plain branch's payload, and writes nothing when it ends in a refusal | `tests/integration/streamed-commit.integration.test.ts`, `tests/progress-frames.test.ts` |
| One error code maps to one status, and no route builds an error body by hand outside two named exceptions | `tests/service-errors.test.ts` |
| A cursor is signed, refuses a forged or truncated MAC, and still reads the previous encoding | `tests/cursor.test.ts` |
| A cursor binds the filters it was issued under, at both call sites that have filters | `tests/integration/sorting.integration.test.ts`, `tests/integration/staged-cursor.integration.test.ts` |
| Every 429 names an interval, and the limiter derives it from the window it counts by | `tests/http-security.test.ts` |
| No `/api/v1` handler converts a query parameter itself, and the four it still reads one at a time are named | `tests/http-route-table.test.ts` |
| Every health response says which build is answering, in both entrypoints | `tests/version.test.ts` |
| `listQuerySchema` and the bulk filter schema accept the same parameter names, in both directions and for the staged pair; and every filter key a selection carries is applied by the resolver that turns it into SQL | `tests/list-bulk-filter-keys.test.ts` |
| Every mutating route asks for an expected version, or is registered with the argument from `AGENTS.md` for why a lost update cannot happen on it; every create that writes postings and every commit asks for an idempotency key; and `idempotencyKeySchema` trims and refuses one too short or too long | `tests/http-version-and-idempotency.test.ts` |
| A single resource carries no envelope, over the routes whose last path segment is a parameter; the transaction and staged bulk patch schemas carry the same fields and answer a nine-value battery identically on every one | `tests/http-envelope-and-patch.test.ts` |
| One code, one status at the two sites `tests/service-errors.test.ts` cannot read: `errorResponse(context, status, code, …)` and a `transportError` beside a `c.json(…, 4xx)`, the latter read past the call's own closing paren rather than through a fixed window | `tests/transport-code-status.test.ts` |

**Worth building, cheapest first:**

1. **Landed, both halves, in two files.** `listQuerySchema` and the bulk filter
   schema accept the same parameter names:
   `tests/list-bulk-filter-keys.test.ts`, which also holds the half this item
   did not ask for — that every filter key a selection *declares* is really
   applied by the resolver, since a declared-but-unapplied key passes `.strict()`
   and silently returns unfiltered rows, making the preview's count and the
   write's fingerprint agree about the wrong set.
   `idempotencyKeySchema`'s own bounds and its trim are
   `tests/http-version-and-idempotency.test.ts`. The **enforcement** half of the
   first is deliberately not shipped: making `listQuerySchema` `.strict()` would
   refuse a query string a deployment on the previous release has been sending
   and getting a 200 for, which is the upgrade guarantee in `AGENTS.md`. The
   names are checked; the strictness is a later release's job, after a
   deprecation has been in the field. Kept here with its number because the
   items below it are cited by position.
2. ~~One code, one status at the two sites `tests/service-errors.test.ts`
   cannot reach.~~ Landed as `tests/transport-code-status.test.ts`, and it did
   fail on the `UNAUTHORIZED` 400/401 split named under
   [Errors](#rules-that-hold-either-way) — which is now closed by
   `INVALID_SIGNATURE`. Kept here, struck through, because the entry argued
   that writing the test was half of making the decision and the record of that
   working is worth more than the empty line.
3. **Landed.** A single resource is returned without an envelope:
   `tests/http-envelope-and-patch.test.ts`, over the routes whose last path
   segment is a parameter. Scoped that way on purpose — the eleven listings are
   collections and the §Responses entry argues them out. Kept here with its
   number because the items around it are cited by position.
4. The generated OpenAPI document is checked in and CI fails when it changes
   without a changelog entry.

**Review only, and honestly so:**

- Whether a new endpoint needed to exist, or whether an existing resource
  answered the question.
- Whether an error message names the right next action for each of its two
  readers.
- Whether a new filter is worth what it costs the fingerprint.
- Whether a change is breaking. The OpenAPI diff makes it visible; deciding what
  the diff means is still a person's job.

A rule that appears in none of these three lists is a rule nobody is responsible
for, and that is a defect in this guide rather than in the code.
