# Security

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability
reporting](https://github.com/thtmnisamnstr/simple-balance/security/advisories/new).
Please do not open a public issue for anything that would let somebody reach
another person's ledger.

Say what you did, what happened, and which image tag you were running. The
version is not shown in the app anywhere by design: it is the tag you pulled,
and the MCP server is the only thing that announces it.

## Which versions get the fix

The newest release. This is a 0.x product with no backports: a fix ships in the
next release and its upgrade note says what to do, which is the compatibility
contract while the major version is 0.

## In scope

Anything that lets one account read or write another's data. Anything that gets
around sign-in, the scopes a person granted an agent, or `ALLOWED_EMAILS` at
sign-up. Anything that lets an unauthenticated caller reach `/api/v1` or `/mcp`.
Anything that claims an unclaimed deployment without its setup code, or races
another visitor for it. And anything that lets an MCP token delete an account or
set a sign-in password, which are reachable from a session and never from a
token.

## Out of scope

A deployment reached over plain HTTP: this server expects TLS terminated in
front of it, and [deployment](docs/deployment.md) says how. Anything that
already requires the operator's own database credentials or their `SETUP_TOKEN`,
as opposed to getting around them. A finding against an unmodified dependency
belongs upstream.

## What the server already guarantees

Every finance read and write is scoped to the authenticated actor, and a record
belonging to somebody else comes back as not found rather than as forbidden,
because forbidden confirms the id exists. [Architecture](docs/architecture.md)
covers tenancy and MCP tokens, [the MCP standard](docs/standards/mcp.md) covers
what that surface owns, and [the HTTP standard](docs/standards/http.md) covers
headers, CORS and caching.
