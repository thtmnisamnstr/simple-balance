# Ralph guardrails

This file is append-only. Ralph must preserve these durable constraints and may
append new ones.

- Never convert boundary money strings to JavaScript numbers for calculations.
- Every finance query must include the authenticated actor's user ID even when an
  entity ID is globally unique.
- A failed iteration keeps its working tree and logs; later iterations diagnose
  and continue instead of resetting.
- Network access stays disabled unless both the PRD story allows it and the
  operator passes `--network`.
- The outer runner, not the isolated Codex iteration, owns commits and PRD status.
- Better Auth MCP access tokens are wrapped in persistent RS256 JWTs. Preserve
  the audience check, public-only JWKS response, and underlying Better Auth
  expiry/revocation lookup.
- `AUTH_MODE=local` is the zero-Google production default. Require Google
  credentials and a normalized allowlist only in `google` or `both` mode.
- A ledger owner may authenticate through a credential account, a permitted
  linked Google account, or both. Never create a second ledger user when adding
  the other method; use explicit account linking.
- Keep first-owner local registration serialized by a PostgreSQL advisory lock
  and closed after the first Better Auth user exists.
- Do not hold a main-pool connection while Better Auth needs that pool. Owner
  registration uses one dedicated lock connection plus `pg_try_advisory_lock`.
- Keep Better Auth's Drizzle adapter transactions enabled. A user row without
  its credential/provider account must never close first-owner registration.
- Production local owner creation requires the startup-log setup code (or an
  operator-provided `SETUP_TOKEN`) until the first user exists.
- Never rewrite a released migration. Add a forward-only migration with
  deterministic data backfills and a preceding-release upgrade test. Startup
  remains the production migration path.

## Multi-tenant registration (supersedes the single-owner entries above)

The deployment is no longer one person's. Where the entries above say "owner",
read "the account being created", and where they describe registration closing
after the first user, read the following instead. Nothing above is deleted; the
constraints below win where they disagree.

- One deployment holds many accounts. Each has its own books and its own
  server-owned counter-accounts. Never let a query, a report, or a total reach
  across `user_id`, and never accept a `userId` from the caller.
- `ALLOWED_EMAILS` decides who may create an account. It applies on every
  sign-up path, local and Google alike. It applies nowhere else: not to signing
  in, not to keeping a session, not to linking a second method to an account
  that already exists. The variable is optional, so treating it as a sign-in
  gate would lock every user out of a deployment that never set one.
- An unset `ALLOWED_EMAILS` admits nobody. That is what keeps an unconfigured
  deployment private, and it is what an upgrading single-owner deployment
  expects.
- The startup setup code covers exactly one gap: an unclaimed deployment whose
  rule admits nobody. An address the rule already admits registers without a
  code, including the first one. Keep the claim serialized by the advisory lock;
  ordinary sign-ups must not touch that lock.
- Registration decisions inside a Better Auth database hook must be answerable
  from configuration and the request alone. The hook runs inside the sign-up
  transaction, and querying from it deadlocks a one-connection pool.
- Every PostgreSQL advisory lock id lives in `src/server/db/advisory-locks.ts`.
  They share one namespace, so a duplicate silently merges two unrelated locks.

## Optional mail

- SMTP_HOST plus MAIL_FROM turn on password reset and address verification
  together, and their absence turns both off. Neither may become mandatory: a
  deployment with no mail server is a supported deployment.
- An account created while no mail server was configured is created verified.
  Otherwise the day an operator sets SMTP_HOST is the day everyone who signed up
  before it loses access. The same applies to the setup-code claim, which proves
  control of the server rather than of an inbox.
- Sending never blocks a request and never throws to the caller. A reset that
  answered differently for a known and an unknown address would be a way to ask
  the server who has an account.
- A password is never sent over an unencrypted connection. SMTP_SSL=true is
  encrypted from the first byte; with SMTP_SSL false and credentials set, the
  STARTTLS upgrade is required rather than attempted. Only a connection with
  nothing to authenticate may proceed unencrypted.
