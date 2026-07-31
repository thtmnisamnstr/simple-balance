# MCP server

The stateless Streamable HTTP endpoint is:

```text
https://simple-balance.example.com/mcp
```

It is designed for AI and agent clients, with the same ledger validation, review
workflow, duplicate protections, and audit trail used by the browser.

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
authorization page, the owner signs in with the same email and password used by
the web app, approves the requested scopes, and the client completes PKCE token
exchange. Google credentials are not involved. In `google` mode the same browser
flow uses Google; `both` presents both methods.

Every authorization request is routed through the consent screen, including
requests from already signed-in users and clients that omit `prompt=consent`.
The server—not the dynamically registered client—decides that approval is
required.

OAuth access tokens returned to clients are RS256 JWTs with issuer, subject,
client, scope, expiry, and an audience fixed to this deployment's `/mcp` resource.
The public key is exposed at the discovery document's `jwks_uri`. Signing keys
persist in PostgreSQL, so tokens remain valid across container restarts. After JWT
verification, the server also checks Better Auth's revocable access-token record
and whether the user still has an authentication method enabled by the current
`AUTH_MODE` before a tool can run.

## Scopes

- `ledger:read` — accounts, categories, transactions, staging, summaries, CSV
  export, and audit history.
- `ledger:stage` — read access plus staged transaction and CSV-stage mutations.
- `ledger:write` — all ledger operations, including direct commits and staged
  commits.

Tools are omitted from discovery when the token lacks their scope. All tools
return both `structuredContent.result` and equivalent JSON text. Money is always a
decimal string, bulk operations require explicit IDs, and concurrency-sensitive
operations require `expectedVersion`.

Use `dryRun: true` on `stage_csv` and `commit_staged_transactions` to validate a
planned mutation without changing the ledger.

`stage_csv` accepts the same configured `CSV_MAX_BYTES` payload as the browser
import workflow. The HTTP MCP request envelope is bounded to accommodate JSON
string escaping while the decoded CSV is still checked against the exact byte
and row limits.

Removing a Google-only user from `ALLOWED_EMAILS` blocks subsequent web and MCP
use even if that user is already signed in. A user who also configured a
local password remains eligible through local authentication while local mode is
enabled.
