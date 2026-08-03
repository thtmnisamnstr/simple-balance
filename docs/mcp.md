# MCP server

The stateless Streamable HTTP endpoint is:

```text
https://simple-balance.example.com/mcp
```

Agent clients get the same ledger validation, review workflow, duplicate
protection, and audit trail the browser gets. Nothing is relaxed for automation.

OAuth discovery is available at:

```text
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
```

The embedded Better Auth provider supports authorization-code flow, PKCE, dynamic
client registration, consent, access/refresh tokens, and protected-resource
metadata. MCP clients should discover configuration from the server rather than
hard-code authorization endpoints.

The MCP OAuth flow uses whichever interactive sign-in methods `AUTH_MODE`
enables. In the default `local` mode, the MCP client opens the browser
authorization page, the person signs in with the same email and password they
use for the web app, approves the requested scopes, and the client completes
PKCE token exchange. The token is bound to whoever signed in, and reaches their
books alone. Google credentials are not involved. In `google` mode the same browser
flow uses Google; `both` presents both methods.

Every authorization request is routed through the consent screen, including
requests from already signed-in users and clients that omit `prompt=consent`.
The server decides that approval is required. A dynamically registered client
cannot waive it.

OAuth access tokens returned to clients are RS256 JWTs with issuer, subject,
client, scope, expiry, and an audience fixed to this deployment's `/mcp` resource.
The public key is exposed at the discovery document's `jwks_uri`. Signing keys
persist in PostgreSQL, so tokens remain valid across container restarts. After JWT
verification, the server also checks Better Auth's revocable access-token record
and whether the user still has an authentication method enabled by the current
`AUTH_MODE` before a tool can run.

## Scopes

- `ledger:read`: accounts, categories, payees, transactions, staging,
  summaries, CSV export, and audit history.
- `ledger:stage`: read access plus staged transaction and CSV-stage mutations.
- `ledger:write`: every ledger operation, including direct and staged commits.

Tools an agent has no scope for are left out of discovery entirely, so it never
sees a tool it cannot call. Every tool returns both `structuredContent.result`
and the same thing as JSON text.

Money is always a decimal string, never a JSON number, because binary floating
point cannot hold these values exactly. Dates are `YYYY-MM-DD`. Writes take an
idempotency key you choose: send the same key again and you get the original
result back rather than a second transaction. Fields carry descriptions, so an
agent reading the schema learns the conventions that matter, including the one
that catches people out: a credit card or loan opens at a negative balance,
because that is money owed.

## Changing many rows at once

There are two ways to say which rows you mean. An explicit selection lists each
id with the `expectedVersion` you last saw, so a row someone else changed makes
the request stale instead of silently taking your value. A filter selection says
"everything matching this", and starts with
`preview_bulk_transaction_selection`, which returns a count and a fingerprint of
the exact `id:version` set that matched. Send that fingerprint back with the
change. If anything in the set moved in between, the request is refused rather
than quietly covering a different set of rows than you were shown.

`bulk_edit_transactions` changes the date, payee, category, account,
description, notes, or deposit/withdrawal type. Fields you leave out stay as
they are. Transfers accept only the shared text, date, and category fields, and
moving a transaction to another account cannot change its currency. Duplicate
checks run against the final state of the whole selection before a single row is
written.

`bulk_delete_transactions` takes the same two selection shapes. Deleting posts
the reversal rather than erasing anything, so a deleted transaction stops
counting toward balances and reports while the record of it remains.

Either one covers at most 10,000 rows per request. Split larger work across
calls; each stands or falls on its own.

Pass `dryRun: true` to `bulk_edit_transactions`, `bulk_delete_transactions`,
`stage_csv`, or `commit_staged_transactions` to find out what a change would do
without doing it.

## Paging and ordering

Lists page two ways. A `cursor` walks forward through a stable keyset, which is
what you want for reading a whole ledger. A `page` number jumps straight to a
page and comes back with the total row count, which is what the browser uses.
Send both and the cursor wins.

Lists also take `sort` and `direction`. A cursor belongs to the ordering it was
issued under and is refused if you change the ordering underneath it, because
resuming a keyset walk in a different order silently skips and repeats rows.
Ordering by account or category cannot be resumed that way at all, so those
return no cursor and you page them by number.

## Payees

`list_payees`, `list_duplicate_payees`, and `merge_payees`. There is no payee
record to fetch: payees are canonical text read out of committed and staged
transactions, so MCP and the browser share one spelling and one audit trail.

## CSV

`stage_csv` accepts the same payload the browser import does, bounded by
`CSV_MAX_BYTES` and `CSV_MAX_ROWS`. The MCP request envelope allows extra room
for JSON string escaping, while the decoded CSV is still measured against the
real limits.

`ALLOWED_EMAILS` governs who may register, not who may keep signing in.
Removing an address does not revoke the tokens or sessions of an account that
already exists, over MCP or over the web. Deleting the account does, and takes
its data with it.

Turning a sign-in method off does revoke it. An account that only ever had
Google loses both web and MCP access when `AUTH_MODE` drops to `local`, and an
account that also set a local password keeps working through that.
