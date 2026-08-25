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
   a session cookie and nothing else (`src/server/api.ts:892-907`). There is no
   bearer path.
2. Every state-changing `/api/v1` request must present an `Origin` (or failing
   that a `Referer`) equal to the configured base URL
   (`src/server/http-security.ts:157-191`, mounted at `src/server/api.ts:900-903`).
3. Every state-changing `/api/v1` request must declare
   `Content-Type: application/json`, including the ones with no body at all
   (`requireContentType: true`, `src/server/api.ts:892`).

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
`docs/architecture.md:197-198`: "An id belonging to someone else comes back as
not found, not as forbidden."

[`common.md`](common.md#errors) settles the rule. What HTTP adds is the
transport argument: 403 would confirm the row exists, so
`GET /api/v1/accounts/{id}` for a stranger's account is a 404 with the same body
as an id that was never issued (`src/server/services/accounts.ts:532`). This is
deliberate, it is not a missing feature, and it applies to every resource.

*Checked by:* `tests/integration/tenant-isolation.integration.test.ts:165-202`
("refuses reads of another tenant's records by id", "refuses writes to another
tenant's records by id") and `:335-345`, which asserts `status: 404` under the
comment "Reading somebody else's by id is a 404, never a 403". Not checked
mechanically: that no service leaks existence through a distinguishable
message.

## The route list

Seventy-three routes under `/api/v1`, generated from `src/server/api.ts`. The
scope column is the scope the equivalent MCP tool needs today, and therefore the
scope a bearer token will need once SB-030 lands; `ledger:read` is implied by
both of the others (`src/server/mcp.ts:272-277`). Routes marked session only are
named exceptions in `tests/mcp-parity.test.ts:17-26`, each carrying its reason.

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

### Connected agents

| Route | Scope |
| --- | --- |
| `GET /api/v1/connected-apps` | `ledger:read` |
| `DELETE /api/v1/connected-apps/{clientId}` | `ledger:write` |

A read-only token can list grants and cannot revoke them, so a stolen
`ledger:read` token cannot spend its last minutes locking out the agents it was
stolen from (`src/server/api.ts:1011-1014`).

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
| `GET /api/v1/budget-plans` | `ledger:read` |
| `GET /api/v1/budget-plans/{id}` | `ledger:read` |
| `GET /api/v1/budget-entries` | `ledger:read` |
| `GET /api/v1/budget-report` | `ledger:read` |
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
| `GET /health/live`, `GET /health/ready` | Liveness, and a `select 1` against the database. `503` when the database is unreachable (`src/server/api.ts:228-243`). |
| `/api/auth/*` | Better Auth, plus this product's own sign-up, consent and MCP token routes. |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | RFC 9728 and OAuth discovery, each also served under `/mcp` and `/mcp/` because RFC 9728 puts the resource path after the well-known segment (`src/server/api.ts:789-797`). |
| `/mcp`, `/mcp/` | The MCP transport. Governed by [`mcp.md`](mcp.md). |

**House.** These stay unversioned. `/api/v1` versions this product's own
contract; an OAuth discovery document is versioned by the RFC that defines it,
and putting `v1` in front of a well-known path would make it undiscoverable.

*Checked by:* `tests/mcp-parity.test.ts:101-108` extracts the registered
`/api/v1` routes from source, so a route added without a tool or a written
exception fails, and `tests/http-route-table.test.ts` now holds the `/api/v1`
tables above to that same extraction in both directions. *Not checked:* this
table, which is the surfaces that are not `/api/v1` and so fall outside both
extractions. A row here is still only as published as somebody remembering to
add it.

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
  reaches a query, through `pathId` (`src/server/api.ts:932-934`). Nothing in a
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
  `GET /api/v1/staged-transactions/{id}/duplicate` (`src/server/api.ts:1335`)
  rather than a `staged` collection that existed nowhere else;
  `POST /api/v1/staged-transactions/bulk-delete` (`src/server/api.ts:1298`)
  rather than a `delete` that spelled the same operation as
  `POST /api/v1/transactions/bulk-delete` (`src/server/api.ts:1238`)
  differently; and `POST /api/v1/accounts/{id}/archived` and
  `POST /api/v1/categories/{id}/archived` (`src/server/api.ts:1095`, `:1211`),
  which take `{"archived": boolean}` and are therefore the state sub-resource
  pattern, matching `POST /api/v1/transactions/{id}/deleted`.

  The two `bulk-delete` routes stayed two routes. They are the same word for two
  different operations: one voids committed entries by posting their reversal
  under `ledger:write`, the other removes staged rows that never posted under
  `ledger:stage`. Only the spelling was duplicated.

  They were renamed outright rather than deprecated, and the reason is the one
  in [Nothing outside a browser can reach this API
  today](#nothing-outside-a-browser-can-reach-this-api-today): a cookie, a
  same-origin check and a required content type mean the only client that could
  have been broken ships in the same image as the server that answers it. The
  deprecation policy below starts applying the day SB-030 makes a third-party
  client possible. Paying for `/api/v2` to fix a hyphen would have been an
  expensive way to keep a promise nobody had been made — and the window to do it
  for nothing closes when SB-030 lands, which is why it was not deferred again.
  The one cost is real and small: a browser tab left open across the upgrade
  gets a 404 on the old paths until it is reloaded.

  The MCP tools keep their names. `archive_account` and `archive_category` are
  `verb_noun` and correct, and [`mcp.md`](mcp.md) has already settled that
  renaming a tool breaks configured clients for less than it returns. A path and
  a tool name are different namespaces; `tests/mcp-parity.test.ts` maps one to
  the other by table, which is where the two are allowed to differ.
  *Checked by:* `tests/http-route-table.test.ts`, which holds the tables above
  to the routes `src/server/api.ts` registers and refuses a `staged` segment, a
  path ending in `/archive` or a path ending in a bare `/delete`, so this
  particular drift cannot come back.

## Requests

- **House.** JSON in, JSON out. `Content-Type: application/json` is required
  on every state-changing request, with no body-present exception, and a request
  that omits it is refused with 415 before anything reads the body
  (`src/server/http-security.ts:177-186`). The consequence is real and the
  browser client lives with it: revoking an agent is a `DELETE` that sends `{}`
  purely so it can declare a content type
  (`src/client/pages/SettingsPage.tsx:538-546`).
  *Checked by:* `tests/api-security.test.ts:64-88`, both halves, the refusal and
  the bodyless request that gets through the gate.
- **House.** A malformed or absent JSON body is a 400 with a message saying so,
  not a 500. Every mutation reads its body through one helper for this reason
  (`src/server/api.ts:904-942`); before it existed a truncated body arrived as a
  500 with a stack trace in the log.
- **House.** Request bodies are bounded, and the bound is derived from a
  documented cap rather than chosen. The two figures come from this repository
  rather than from anything published, which is why the derivation matters more
  than the numbers. 64 KiB for `/api/auth`, 256 KiB for
  ordinary `/api/v1`, a CSV-derived limit for `/csv/preview`, `/csv/stage` and
  `/mcp`, and a selection-derived limit for any route whose last segment is
  `bulk-edit`, `bulk-delete`, `bulk-selection`, `commit` or `delete`
  (`src/server/http-security.ts:59-97`, `:638-661`). A limit is derived, not
  guessed: the template mass edit and mass delete were once sized as ordinary
  requests, so a selection their own schemas accepted came back 413. Recognising
  a bulk route by shape rather than by a hand-kept list is what stops that
  recurring.
  *Checked by:* `tests/http-security.test.ts:259-398` for the arithmetic, and
  `tests/http-security.test.ts:615-626`, which walks the registered routes so no
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
  `listQuerySchema` (`src/shared/domain.ts:1218-1283`) accepts anything, so
  `?sortt=date` returns page one in the default order with a 200, which is the
  wrong answer delivered confidently. The bulk filter schema derived from it
  **is** strict (`src/shared/domain.ts:1288-1290`), so the two disagree about
  the same parameter set. Make `listQuerySchema` strict. The two staged
  selection schemas were the same disagreement between callers rather than
  between schemas, and are strict now; see [the bulk selection
  contract](#the-bulk-selection-contract).
  *Not checked mechanically.* A test asserting the list schema and the bulk
  filter schema accept the same names would catch both this and any future
  divergence.
- **House, settled.** A boolean query parameter is read one way.
  `queryBooleanSchema` refuses anything that is not `"true"` or `"false"`. Five
  routes used to compare `c.req.query("includeArchived") === "true"` by hand, so
  `?includeArchived=yes` silently meant false: the caller asked for something,
  was not refused, and got the opposite. All five now go through
  `includeArchivedFlag` (`src/server/api.ts:956`), which parses with the shared
  schema, so a value that is neither is refused rather than quietly inverted. `queryWithFlags` (`src/server/api.ts:951-960`) is the
  bridge for routes that pass a whole query object to a Zod schema.
- **House.** A repeated query parameter is not supported. Hono's `c.req.query()`
  keeps the first occurrence, so `?accountId=a&accountId=b` silently drops `b`.
  State it, and if a filter ever needs multiple values it takes a
  comma-separated list with a documented separator rather than repetition.
- **Binding.** No request ever names a user. `AGENTS.md`: "Never accept a public
  `userId`."

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
plan, absent leaves it alone (`src/shared/domain.ts:1093-1107`). So does the
template mass edit, whose schema comment says why blank and absent have to stay
different: "blank and absent being different is the whole of what a stored draft
records" (`src/shared/domain.ts:634-641`).

**Where the code disagrees.** Three patch schemas answer this question and two
of them read `""` as a clear rather than refusing it. The transaction bulk patch
carries `.transform((value) => (value === "" ? null : value))` on `description`
and `notes` (`src/shared/domain.ts:1396-1407`), pinned by
`tests/domain.test.ts:142-149`, and the staged bulk patch carries the identical
transform on the same two fields (`src/shared/domain.ts:1643-1654`). The
template mass edit (`:593-617`) is the only one of the three that refuses the
empty string. So fixing only the transaction path leaves the same defect on the
staged one. There is an argument for the
transform, that a transaction description has no "unset" state distinct from
blank the way a template field does, but it is nowhere written down and the
template schema's comment argues the opposite case at length. Either document
the distinction beside the transform or remove it.

This three-way rule is also why the API takes `PUT` on a whole resource and a
discriminated patch object on a bulk edit, rather than `PATCH` with JSON Merge
Patch (RFC 7396). Merge patch gives `null` the meaning "remove" and has no way
to express "refuse the empty string", and RFC 7396 itself says merge patch "is
not appropriate for all JSON syntaxes". A ledger is one of the documents it is
not appropriate for.

*Checked by:* `tests/domain.test.ts` for the two patch schemas as they stand.
Not checked mechanically: that a new nullable field follows the three-way rule,
or that the two patch schemas agree with each other.

## Responses

- **House.** A single resource is returned as the object itself, with no
  envelope. A collection is returned as one of two envelopes and no third.
- **House.** Two list envelopes:
  - `Page<T>`: `{items, nextCursor}` (`src/shared/domain.ts:1765-1769`), where
    callers only stream forward.
  - `PaginatedPage<T>`: `Page<T>` plus `{page, pageSize, totalCount,
    totalPages}` (`src/shared/domain.ts:1771-1776`).
- **House.** `201 Created` on a create that mints a row, `200 OK` on everything
  else that succeeds. No route returns `204`; every response has a body,
  because an MCP tool result cannot be empty and the two transports return the
  same thing. `src/client/api.ts:92` still has a `204` branch, which is dead and
  should go.
- **House, and a gap.** A `201` carries no `Location` header. It should, since
  the created object always has an id and a canonical path, and a public API is
  where that stops being ceremony. This is additive, so it is not a breaking
  change.
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
  output schema fails the call".
- **House.** `GET /api/v1/csv/export` is the only route that answers with
  something other than JSON: `text/csv; charset=utf-8; header=present` with a
  `Content-Disposition` filename (`src/server/api.ts:1316-1330`). Its format is
  governed by [`csv.md`](csv.md).

*Checked by:* `tests/http-security.test.ts` for headers and body limits,
`tests/cursor.test.ts` for the cursor's ordering binding. *Not checked:* that a
collection uses one of the two envelopes and not a third, that a single resource
carries no envelope, and that every 429 sends `Retry-After`. All three are a walk
over the registered routes, which that file already does for body limits.

### Status codes

**Binding**, RFC 9110 semantics. One code per situation, and one situation per
code.

| Status | When |
| --- | --- |
| 200 | A read, or a write that changed something that already existed |
| 201 | A create that minted a row |
| 400 | The body is not JSON, or its framing headers contradict it (`INVALID_CONTENT_LENGTH`, `REQUEST_BODY_NOT_ALLOWED`) |
| 401 | No session, and once SB-030 lands, no acceptable bearer token |
| 403 | Cross-origin state change, or an operation the deployment has disabled, or re-authentication required |
| 404 | No such route, no such row, a row belonging to somebody else, or a path id that is not the shape the path declares |
| 409 | `STALE_VERSION`, `DUPLICATE`, `CONFLICT`, and an idempotency key reused with a different request |
| 413 | Body over the derived limit for that path |
| 415 | Missing or unacceptable `Content-Type` on a state change |
| 422 | The body is valid JSON and valid against no rule the ledger will accept |
| 429 | Rate limited. Today only the setup-code limiter (`src/server/api.ts:319-348`) |
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
- **House, and a live inconsistency.** One code must map to one status.
  `VALIDATION_ERROR` is 422 from a service (`src/server/services/errors.ts:73-74`)
  and 400 from the malformed-body guard (`src/server/api.ts:923`), so on that
  code the status carries information the code does not, which is backwards.
  Give the malformed body its own code.
- **House, and a gap.** A missing `expectedVersion` should be `428 Precondition
  Required` (RFC 6585), which says exactly what happened and which Zalando rates
  `use`. Today it is a Zod failure and a 422
  (`src/shared/domain.ts:226-236`, `src/server/api.ts:202-209`).
- **House, and a mismatch.** A path id that is not a UUID can never name a row,
  so the answer is 404, for the same reason a stranger's id is 404: what the
  caller asked for is not there. Today `pathId` raises a Zod failure
  (`src/server/api.ts:932-933`) which the global handler renders as a 422
  (`src/server/api.ts:199-208`), so a mistyped URL and a rejected body look the
  same to a client. The 404 catch-all already answers a mistyped *path* this
  way; a mistyped *id* should match it.
- **House, and a gap.** A wrong method on an existing path should be 405 with
  `Allow`. Today it falls to the catch-all and is a 404
  (`src/server/api.ts:1373-1377`). OWASP's REST guidance is to allowlist methods
  and reject the rest with 405.
- **House.** A 429 carries `Retry-After`. Today the one 429 the process emits
  carries nothing. `Retry-After` is standard in RFC 9110; the `RateLimit-*`
  draft headers are not, their syntax has changed between revisions, and pinning
  to them buys nothing yet.

*Checked by:* `tests/http-security.test.ts` for the security and cache headers
and for the body limits, and `tests/cursor.test.ts` for the cursor's ordering
binding. *Not checked:* that a collection uses one of the two envelopes and not
a third, that every 429 carries `Retry-After`, and that a single resource is
returned without an envelope. All three are a walk over the registered routes,
which `tests/http-security.test.ts` already does for body limits.

## Errors

### The envelope, and where it is going

**Binding for the shape.** [`common.md`](common.md#errors) fixes it:
`{ error: { code, message, details? } }`, one enumeration, published. Over MCP
it is the `result` member; over HTTP it is the body today
(`src/server/api.ts:186-209`).

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
  recognise.
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
  (`src/client/api.ts:38-56`), and so may anybody who built against the API
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
and for the code each of those refusals names being a member of `apiErrorCodes`.
*Not checked:* that one code maps to one status, which is already false for
`VALIDATION_ERROR`.

### Rules that hold either way

- **House.** The published enumeration is frozen contract, and it is complete.
  `apiErrorCodes` (`src/shared/domain.ts:1720-1755`) is the sum of two lists
  held apart on purpose: `serviceErrorCodes`, the nine an `AppError` can carry,
  and `transportErrorCodes`, the five the middleware refuses with before a route
  runs — `CROSS_ORIGIN_REQUEST` (`src/server/http-security.ts:170`, `:234`),
  `UNSUPPORTED_MEDIA_TYPE` (`:179`, `:218`), `PAYLOAD_TOO_LARGE` (`:572`,
  `:617`), `INVALID_CONTENT_LENGTH` (`:561`) and `REQUEST_BODY_NOT_ALLOWED`
  (`:587`). All fourteen reach a caller from `/api/v1` in this guide's own
  envelope, so all fourteen are published; the split is what stops a service
  raising a transport code, because `AppError`
  (`src/server/services/errors.ts:10-40`) takes `ServiceErrorCode`, and a code
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
- **House, and violated in fourteen places.** One envelope on every route this
  process serves. `/api/v1` uses the envelope; the auth, consent and setup
  routes return a flat `{code, message}` at `src/server/api.ts:281`, `:309`,
  `:326`, `:335`, `:347`, `:366`, `:377`, `:414`, `:571`, `:650`, `:657`,
  `:666`, `:699` and `:707`. The browser can only read one of the two shapes.
  Fix those fourteen.
  **One named exception:** the `/.well-known` catch-all returns
  `{error, error_description}` (`src/server/api.ts:812-820`). That is the OAuth
  error shape, its reader is an OAuth client, and it is correct there.
- **House.** Field errors are `{field, message}` with `field` a dotted path.
  `zodIssues()` already produces exactly that
  (`src/server/services/errors.ts:76-81`) and MCP uses it
  (`src/server/mcp.ts:211`), but the global HTTP handler does not: it ships
  `error.issues` straight from Zod (`src/server/api.ts:205`), putting the
  validator's own discriminators on the wire as public contract. Route it
  through `zodIssues()`. Under problem details this array becomes `errors`.
- **House, following AIP-193 and the Azure guidelines.** Any number in a message
  also appears in the details as a field: the ten thousand row cap, a byte
  limit, the count in a stale bulk selection. A client should never have to
  parse a sentence to learn a number.
- **House.** No stack traces, no SQL, no bound parameters, ever. The comment at
  `src/server/api.ts:211-217` says why, and it is not boilerplate: "Drizzle
  builds its message out of the failing SQL and its bound parameters, and one of
  those parameters is the OAuth access token the MCP token endpoint looks a
  grant up by, so logging it whole would write a live credential into the log on
  any database hiccup." The 500 body is a fixed sentence with no detail
  (`src/server/api.ts:218-221`).
  **The gap:** that redaction is applied on one of the five paths in this
  process that can log a database error. The other four are
  `src/server/index.ts`, `src/server/scheduler.ts`, `src/server/db/migrate.ts`
  and `src/server/db/client.ts`.
- **House.** What an error sentence says is settled in
  [`common.md`](common.md#errors), including the worked sentences for both
  readers.

*Checked by:* `tests/api-security.test.ts` for the transport refusals,
`tests/mcp-output.test.ts` for the MCP rendering. Not checked mechanically: that
every code an interface can emit is in the published enumeration, that one code
maps to one status, and that no route builds an error body by hand. All three
are greppable and all three are worth a test.

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
  is reported as 1 (`src/server/services/transactions.ts:1359-1361`).
- **House, following AIP-158.** `nextCursor: null` is the end signal, and the
  only one. The Azure guidelines forbid exactly that spelling; AIP-158 permits
  it. Keep the null, because the field's presence is contractual: Zod output
  schemas and MCP output validation make an absent field a failure, not an
  inference.
- **House, and an overload to fix.** `nextCursor: null` currently means two
  things: the collection has ended, and this ordering issues no cursors at all
  (`src/server/services/transactions.ts:1388-1405`). A client cannot tell them
  apart. The list response should say whether the ordering is cursor-resumable,
  as a separate boolean, rather than making a null carry two meanings.
- **Binding.** A cursor binds the ordering it was issued for and is refused
  under another, with a message telling the caller to start again from the first
  page (`src/server/services/cursor.ts:30-46`).
  *Checked by:* `tests/cursor.test.ts`.
- **House, and a real gap.** A cursor must bind everything that defines the
  collection, and today it binds only the ordering. It carries `key`,
  `direction`, `sort` and `id` (`src/server/services/cursor.ts:10-22`), so
  changing the sort between pages is caught, and changing a **filter** is not:
  `accountId`, `categoryId`, `templateId`, `payee`, `type`, `currency`,
  `search`, `start`, `end` and `includeDeleted` can all change and the keyset
  resumes silently into a different collection. The fix is a hash of the
  canonical filter object, and the machinery exists, because the fingerprinted
  bulk selection solves the same problem for a different contract. **State the
  symmetry:** a cursor binds the collection it walks, a bulk selection binds the
  rows it changes, and both refuse rather than quietly covering something else.
- **Contested: is a cursor opaque?** AIP-158 says page tokens "must be opaque
  (but URL-safe) strings, and must not be user-parseable", and names
  base64-encoding an otherwise-transparent token as insufficient obfuscation.
  This cursor is base64url of plain JSON (`src/server/services/cursor.ts:26-28`),
  which is precisely that case. **The published guidance wins**, because no
  invariant protects the current encoding and a reader of the base64 will
  otherwise build against it. Two acceptable resolutions and one unacceptable
  one: sign it with an HMAC keyed to the deployment, which also makes a
  hand-built cursor refusable rather than merely validated; or declare it
  inspectable and unstable in writing and say its contents may change in any
  release. Leaving it undeclared is the unacceptable one.
- **Contested: total counts.** Zalando rule 254 and the Azure guidelines both
  say not to return a count of all matching objects, because counting a complex
  query is a full index scan and because clients integrate against a number that
  then cannot be removed. **This product returns `totalCount` and `totalPages`,
  and is bounded in doing so**: `AGENTS.md` makes numbered pages structural
  rather than optional, the data set is one person's ledger, and the browser
  draws page numbers. The bound is that **the cursor path returns no count**.
  The count is what makes the numbered path expensive, and the cursor path
  exists to be cheap.
  **The code disagrees with that bound today.** `listTransactions` runs its
  `count()` unconditionally, before it looks at whether a cursor was sent
  (`src/server/services/transactions.ts:1355-1360`), so a cursor page pays for a
  full count it does not use. Skip the count when a cursor is present.
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
     (`src/server/services/sorting.ts:29-39`, `src/server/services/cursor.ts:49-62`).
- **House.** `limit` is optional, defaults to 50 and is capped at 200
  (`src/shared/domain.ts:1045`). A server may return fewer rows than asked for.
- **House, and an outlier.** `GET /api/v1/audit-events` parses its own query by
  hand rather than through a published schema
  (`src/server/api.ts:1358-1365`), so its parameters are the one list contract
  not expressed in Zod. The service defends itself against the resulting `NaN`
  (`src/server/services/audit.ts:11-15`), which is the right defence in the
  wrong place. Give it a schema.

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
  or `desc` (`src/shared/domain.ts:1221-1232`). If multi-key sorting ever
  arrives it becomes `sort=-date,payee`, following JSON:API and Zalando rule
  137, rather than a second parameter, because a second parameter cannot express
  precedence.
- **Binding.** Order is presentation and never scopes a write. `sort`,
  `direction`, `cursor`, `page` and `limit` are omitted from every bulk filter
  schema (`src/shared/domain.ts:1288-1290`), so two requests selecting the same
  rows in different orders are the same selection.

*Checked by:* the bulk filter schemas being `.strict()` in `src/shared/domain.ts`,
which refuses an ordering key at the boundary. *Not checked:* that
`listQuerySchema` and the bulk filter schemas accept the same parameter names, so
a misspelled `sort` key still answers 200 with page one in the default order.

## Concurrency

**Binding.** `AGENTS.md`: "Updates/deletes require an expected version."

- **House, and the reason is the standing test.** The version travels in the
  body as `expectedVersion`, never as `If-Match`
  (`src/shared/domain.ts:859-874`). A mismatch is `409 STALE_VERSION` with
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
  (`runIdempotentMcpMutation`, `src/server/mcp.ts:282-305`, used on twenty-six
  tools), so the Azure objection does not bite there. Over HTTP only the writes
  whose schema declares an `idempotencyKey` are protected, and no update or
  delete does: `transactionUpdateSchema` and `versionedMutationSchema` carry a
  version and nothing else (`src/shared/domain.ts:859-874`). So an HTTP update
  whose response is lost genuinely cannot be retried, and the browser hides it
  by refetching. That is the gap, and it is the same gap as the missing keys on
  five creates below.
- **House, one named exception.** `PUT /api/v1/budget-entries` is an upsert and
  its `expectedVersion` is optional: absent on the first set for a period,
  required to change one that is already there
  (`src/shared/domain.ts:1110-1118`).
- **Binding.** `AGENTS.md`: "Any write that changes a leg must bump the parent
  transaction's `version` in the same transaction." A version that does not move when a leg moves would
  let a bulk selection fingerprint describe a row that has changed underneath
  it.

*Checked by:* `tests/integration/ledger.integration.test.ts:214` ("rolls back an
entire staged selection on a stale version") for the refusal, and
`tests/integration/splits-audit.integration.test.ts:218` for the leg invariant,
which asserts that an update changing a transaction's legs leaves
`updated.version` one higher than the version it was read at.
`tests/transaction-legs.test.ts` covers how legs parse and says nothing about
versions. Not checked mechanically: that every mutating route requires a
version.

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
  form (`src/shared/domain.ts:218-242`).
- **House, matching Zalando rule 230 point for point.** The key is scoped to
  `(user, operation, key)`, stored with a hash of the canonical request and the
  response, replayed on repeat, and refused with a 409 when the same key arrives
  with a different request (`src/server/services/helpers.ts:89-120`). The
  request is canonicalised before hashing, with object keys sorted and `Date`
  instances stringified, so key order cannot change the fingerprint
  (`src/server/services/helpers.ts:116-155`). Concurrent uses of one key are
  serialised by a transaction-scoped advisory lock
  (`src/server/services/helpers.ts:158-170`), which is stronger than Stripe,
  which errors on a concurrent conflict rather than waiting.
- **House, a deliberate divergence worth writing down.** Stripe replays
  failures, including 500s. Simple Balance writes the idempotency record inside
  the same PostgreSQL transaction as the effect, so a failure rolls the record
  back and the retry executes rather than replays. For a ledger that is the
  safer direction, and it matches Stripe's own carve-out that results are saved
  only once execution begins. Said out loud, because the alternative reading is
  that nobody thought about it.
- **House, and the one real gap.** Nothing prunes `idempotency_record`. Every
  create, commit and bulk write stores a full JSONB copy of its response,
  forever. Zalando is blunt about the consequence: the key cache "is not
  intended as request log, and therefore should have a limited lifetime, else it
  could easily exceed the data resource in size". Set a retention window and let
  the existing scheduler enforce it. **The number is a product decision the
  sources do not settle:** 24 hours is Stripe's figure for a payments API, and
  an agent retrying a commit a week later is plausible here.
- **House, MAY.** Accept `Idempotency-Key` as a header alias for the body field,
  with documented precedence, so a client written against Stripe habits works.
  One line of middleware and no change to the MCP contract. It is also the only
  way a bodyless mutation could carry one.
- **House, and violated on five creates.** `AGENTS.md` says creates that write
  postings require idempotency, and this guide extends that to every create,
  because a public client retrying a `POST` after a timeout should not get two
  rows. Today `POST /transactions` and `POST /staged-transactions` take a key
  (`src/shared/domain.ts:846-850` and `:890-895`) and `POST /accounts`,
  `POST /categories`, `POST /recurrences`, `POST /transaction-templates` and
  `POST /categories/merge` do not (`src/shared/domain.ts:718`, `:752`, `:2173`,
  `:2135`, `:767`). The MCP tools for the same operations all require one.
  The four creates are protected by a unique name, which is the `AGENTS.md`
  carve-out. `POST /categories/merge` is protected by nothing, and the sister
  route `POST /payees/merge` does take a key
  (`src/shared/domain.ts:817-829`), so the two merges disagree about the same
  question. Add the field.
- **House.** No `GET` or `DELETE` accepts a key. A safe method needs none, and a
  delete on this API is a versioned mutation, which is idempotent by
  construction, with one exception:
  `DELETE /api/v1/connected-apps/{clientId}` (`src/server/api.ts:1038-1042`)
  reads no body and takes no `expectedVersion`, where the other six versioned
  deletes parse `versionedMutationSchema` (`src/server/api.ts:1102`, `:1090`,
  `:1102`, `:1112`, `:1142`, `:1181`). Revoking a grant is idempotent anyway,
  since the second call finds nothing to revoke, but the premise does not hold
  for it and the carve-out is named here rather than left to be discovered.

*Checked by:* `tests/idempotency-key.test.ts` for the browser's key generator,
and `tests/integration/ledger.integration.test.ts:174` ("commits deposits
idempotently and produces native balances") plus
`tests/integration/bulk-transactions.integration.test.ts:106` ("soft-deletes a
selection atomically and idempotently") for replay. Not checked mechanically:
that every create and commit route declares a key, and that
`idempotencyKeySchema`'s own bounds hold, since the key test never reaches the
server schema.

## The bulk selection contract

**Binding.** `AGENTS.md`: "Transaction and staged mass edits are atomic and
share one selection contract. Explicit rows carry expected versions;
all-filtered selections carry a server-issued count and `id:version`
fingerprint." And: "Bulk commits are explicit-ID, validate-first, and atomic."
And: "Ten thousand rows is the cap, and it is the same number everywhere: a mass
edit, a mass delete, a commit, and a CSV import."

- **House, scoped to what the invariant above covers: transaction and staged
  mass edits.** Two selection shapes and no third for those
  (`src/shared/domain.ts:1346-1349`):
  - `{"mode": "ids", "items": [{"id", "expectedVersion"}]}` for rows the caller
    can see.
  - `{"mode": "filter", "filter", "excludedIds", "expectedCount",
    "expectedFingerprint"}` for "everything matching this", where the count and
    the fingerprint were issued by a preview call.
- **House, and three routes outside that scope encode a selection their own
  way. Each records why, and that is the answer rather than a deferral.**
  `transactionTemplateBulkSelectionSchema` (`src/shared/domain.ts:608-632`) is
  `{items: [{id, expectedVersion}]}` with no `mode` discriminator, and stays
  that way because `AGENTS.md` already settled it: a template mass edit "has no
  filtered selection, because the list is capped and the browser holds all of
  it". A discriminated union with one member is ceremony, and `mode` would be a
  required new request field bought for nothing. The schema's own comment
  (`:600-607`) argued this before this guide asked.

  `commitStageSchema` (`:926-954`) and `bulkDeleteStageSchema` (`:966-990`) are
  `{stagedIds: uuid[], expectedVersions: Record<string, number>}`, a parallel
  map rather than a list of pairs. That is the older spelling and it stays.
  Moving it changes the wire on the one route that puts money in the books, and
  the request shape is what the recorded idempotency payload is hashed from
  (`src/server/services/staging.ts:1088-1093`), so a commit retried across the
  deploy would come back `CONFLICT` instead of replaying — a self-inflicted
  failure on the write that can least afford one, in exchange for no behaviour a
  caller can observe. A missing map entry already refused rather than wrote.

  What the parallel map could get wrong is fixed instead. Two structures
  describing one set can disagree, and an id with no entry compared `undefined`
  against the row's version and threw `STALE_VERSION` — safe, but the wrong
  fault named: nothing went stale, the request arrived incomplete, and an agent
  told to read the row again and retry sends the same payload back. Both
  services now refuse it by name with the offending id in the details
  (`src/server/services/staging.ts:981-999`), the way `mergeCategories`
  (`src/server/services/categories.ts:905-911`) already did with the identical
  encoding, and a repeated id is refused as a duplicate rather than reported as
  a missing row. A superset map is still accepted: naming a version the caller
  did not select harms nothing, and refusing it would break a working request to
  no end. `mergeCategories` does not refuse it either.

  Both schemas are `.strict()` now, which is the unknown-fields rule above
  applied here rather than anything this bullet decides: MCP applied `.strict()`
  at the tool boundary while HTTP silently dropped an unknown key, so
  `expectedVersion` typed singular was refused for an agent and ignored for the
  browser.

  Three encodings, one question, and the answer is written beside each of them
  rather than made uniform. If a version boundary ever arrives for another
  reason, bringing the staged pair onto the shared shape is the change to make
  in it.
  *Checked by:* `tests/integration/staged-bulk-edit.integration.test.ts` and
  `tests/integration/ledger.integration.test.ts` for the refusals,
  `tests/domain.test.ts` for the strictness, and the real-connection
  `delete_staged_transactions` call in
  `tests/integration/duplicates.integration.test.ts`, which is the only thing
  that catches the tool handing a strict schema the key it added.
- **House.** A filter selection is resolved first by the matching
  `bulk-selection` route, which returns the count and the fingerprint the write
  must send back (`src/server/api.ts:1225-1228`, `:1288-1291`). The fingerprint
  is a SHA-256 over the sorted `id:version` pairs, computed by one function so
  the transaction and staged paths cannot drift into accepting different sets
  (`src/server/services/helpers.ts:222-237`).
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
  (`src/shared/domain.ts:966-990`), did not, which made the one bulk write that
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
  against very carefully specified request limits. It needs a stated bound on
  the response or streaming.

*Checked by:* `tests/bulk-row-cap.test.ts`, `tests/http-security.test.ts:273-398`
for the derived limits, and
`tests/integration/bulk-transactions.integration.test.ts` for atomicity, which
covers the stale selection writing nothing
(`tests/integration/bulk-transactions.integration.test.ts:170`), the cross-tenant
explicit selection refused without partial updates (`:758`), and the exact filter
fingerprint (`:544`).

## Security, cache and CORS

- **House.** Everything under `/api/v1` is `Cache-Control: no-store`, without
  exception, set once in middleware rather than on seventy-three routes
  (`src/server/api.ts:892-898`). RFC 9111's shared-cache protection keys off the
  `Authorization` header, and `/api/v1` authenticates with a cookie, so that
  protection does not apply and `no-store` is doing the whole job. When SB-030
  adds bearer tokens, `no-store` stays: two mechanisms for one guarantee is
  cheaper than reasoning about which one applied.
- **House.** `Vary` is unnecessary today precisely because nothing authenticated
  is cacheable. The invariant to preserve: no cacheable response depends on a
  request header without naming it in `Vary`.
- **House.** The security headers are one exported function of `isProduction`
  (`src/server/http-security.ts:19-57`) and no route overrides one of the
  headers in the table below. Two other headers are set by hand outside
  `/api/v1` and are documented under CORS: `Access-Control-Allow-Origin` on the
  JWKS route (`src/server/api.ts:552`) and on discovery (`:771`), and
  `Cache-Control` on those two (`:553`, `:772`) and on `/api/v1` itself
  (`:849`). The
  split deployment's nginx repeats them for the files it serves, and the two are
  compared character for character. Every response from this process carries:

  | Header | Value |
  | --- | --- |
  | `Content-Security-Policy` | `default-src 'self'`, with `img-src 'self' data: https:`, `style-src 'self'`, `script-src 'self'`, `connect-src 'self'`, and explicit `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` and `object-src 'none'`, none of which fall back to `default-src` |
  | `X-Frame-Options` | `DENY`, agreeing with `frame-ancestors 'none'` rather than Hono's `SAMEORIGIN` default |
  | `Referrer-Policy` | `same-origin` |
  | `X-Content-Type-Options` | `nosniff` |
  | `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, in production only |
  | Hono's remaining defaults | `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies`, `X-XSS-Protection: 0` |

  There is no `'unsafe-inline'` in `style-src`. The inline styles here are React
  `style` props, applied through the CSSOM rather than written as a style
  attribute, which CSP does not govern. The nginx copy is
  `deploy/docker/nginx-security-headers.conf`.

  *Checked by:* `tests/security-header-parity.test.ts`, and
  `tests/http-security.test.ts` for the behaviour.
- **House, one subtlety already handled and worth not undoing.**
  `referrerPolicy` is `same-origin`, not Hono's `no-referrer` default, because
  under `no-referrer` a browser sends `Origin: null` on a native form
  submission, including the sign-in form posting to this very server, and the
  origin check rightly refuses an origin it cannot recognise
  (`src/server/http-security.ts:43-49`).
- **House, and the two halves are one rule.** Same-origin and JSON content type
  are presented together and neither is relaxed on the grounds that the other
  exists. OWASP files origin checking under defence in depth rather than as a
  primary defence, and separately notes that disallowing simple content types is
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
    `GET /api/auth/mcp/jwks` (`src/server/api.ts:551`) and the OAuth discovery
    endpoints (`discoveryHeaders`, `src/server/api.ts:767-775`) both send
    `Access-Control-Allow-Origin: *`. They are deliberately public and read by
    clients that are not browsers and have no origin to speak of. A rule saying
    "this process never emits ACAO" would be contradicted by grep on the day it
    shipped.
  - **No `OPTIONS` handling.** A preflight to `/api/v1` reaches the catch-all
    and gets a 404 with no CORS headers, which is the correct answer to a
    preflight for something that is not allowed.
- **House.** The single-page app never answers an API path. JSON 404 catch-alls
  sit under `/api/v1/*` (`src/server/api.ts:1373-1377`) and `/.well-known/*`
  (`src/server/api.ts:812-816`), below every route those prefixes own and above
  the shell. Without them a mistyped path came back as 200 `text/html`, which an
  API client parses as a syntax error and a person debugging reads as a working
  page.

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
  (`src/server/api.ts:891-913`). A Bearer challenge there would invite an agent
  to present a token that will never be accepted. When SB-030 lands, the
  challenge appears on the routes that can actually accept one.
- **Binding**, RFC 9728. Protected resource metadata is served at the root and
  at every `/mcp` path spelling, because a client told the resource is
  `<origin>/mcp` looks under the well-known suffix with the resource path
  appended (`src/server/api.ts:789-797`). Answering only at the root left the
  single-page app returning HTML with a 200, which a client cannot parse and
  will not retry.
- **Binding.** The scopes are `ledger:read`, `ledger:stage` and `ledger:write`,
  published in the discovery documents (`src/server/api.ts:749-758`), and the
  route table above says which each route needs. `AGENTS.md`: "`ledger:stage`
  proposes and never decides."
- **Binding.** Two routes stay session-only whatever the token. `AGENTS.md`:
  "Two exceptions, both account management rather than bookkeeping: deleting an
  account and setting a sign-in password are reachable from a session and never
  from an MCP token." Those are `DELETE /api/v1/me` and
  `POST /api/v1/auth/local-password`.
- **House.** `GET /api/v1/session` is session-only for a different reason and
  should not be read as a third invariant: it is split rather than withheld.
  Identity is `whoami` and the regional settings are `get_preferences`; the rest
  of it is which sign-in methods the deployment offers, which is no business of
  an agent's (`tests/mcp-parity.test.ts:22-23`).

*Checked by:* `tests/api-security.test.ts` and `tests/http-security.test.ts` for
the discovery routes and their caching, and `tests/security-header-parity.test.ts`
for the headers. *Not checked:* the token lifetime and revocation behaviour, which
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
- **House.** A version is reported. `APP_VERSION` is announced to every MCP
  client and to nobody over HTTP: not on health, not in a header. Put it in the
  health response.

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

**House**, and nothing is deprecated today, so this is the policy for the first
time it happens.

- A deprecated route or field is announced in `CHANGELOG.md` in the commit that
  deprecates it, with the replacement named.
- The response carries `Deprecation` (RFC 9745, Standards Track, March 2025),
  whose value "MUST be a Date as per Section 3.3.7 of [RFC9651]", for example
  `Deprecation: @1688169599`, plus a `deprecation` link relation pointing at the
  changelog entry.
- The response carries `Sunset` (RFC 8594) with the date the route stops
  answering. RFC 8594 requires that the sunset timestamp "MUST NOT be earlier
  than" the deprecation timestamp.
- The window is at least one minor release and at least ninety days, whichever
  is longer. That number is this product's choice; nothing cited sets one.
- One Hono middleware sets both headers. Do not set them per route.

Nothing has used this policy yet, and the three path inconsistencies that would
have been its first candidates were renamed outright instead — see [Paths and
resources](#paths-and-resources) for why a contract no third party can reach
owes nobody a window. The first real use of this policy is the first breaking
change made after SB-030 lands, and the middleware that sets both headers is
written then rather than now.

*Not checked mechanically.* Review, and there is nothing deprecated yet to test.

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
| A leg write bumps the parent transaction's version | `tests/integration/splits-audit.integration.test.ts:218` |
| A stranger's id is a 404 and never a 403 | `tests/integration/tenant-isolation.integration.test.ts` |
| The Hono security headers and the nginx ones are identical | `tests/security-header-parity.test.ts` |
| Every `/api/v1` route has a tool or a written exception, and every tool has a route | `tests/mcp-parity.test.ts`, both directions |
| The ten thousand row cap | `tests/bulk-row-cap.test.ts` |
| The route tables in this guide name every registered route and nothing else | `tests/http-route-table.test.ts` |

**Worth building, cheapest first:**

1. One code, one status. A test over the code-to-status map asserting it is a
   function and not a relation.
2. One error shape. No route builds an error body by hand outside the named
   OAuth exception.
3. `listQuerySchema` and the bulk filter schema accept the same parameter names.
   `idempotencyKeySchema`'s own bounds, the 200-character ceiling and the trim,
   which no test reaches today.
4. Every list endpoint's cursor round-trips through its filters, once the cursor
   binds them.
5. The generated OpenAPI document is checked in and CI fails when it changes
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
